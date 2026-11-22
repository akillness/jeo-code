/**
 * Runs per-route verification gates (tests, static preflight, lint/build checks)
 * after an Orca worker completes a turn, producing a deterministic failure signature.
 */

import * as os from "node:os";
import * as path from "node:path";
import { hashFailureSignature } from "./matcher";
import type { GateRunResult, ProjectRoute, VerificationGate, VerificationSummary } from "./types";

const DEFAULT_GATE_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_EXCERPT = 1200;

export interface GateVerifier {
  verifyRoute(route: ProjectRoute): Promise<VerificationSummary>;
}

function buildGateEnv(): Record<string, string | undefined> {
  const home = process.env.HOME || os.homedir();
  const preferredDirs = [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Applications/Orca.app/Contents/Resources/bin",
    "/usr/bin",
    "/bin",
  ];
  const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...existing, ...preferredDirs])];
  return {
    ...process.env,
    PATH: merged.join(path.delimiter),
  };
}

export async function runSingleGate(gate: VerificationGate, repoPath: string): Promise<GateRunResult> {
  const cwd = gate.cwd ? path.resolve(repoPath, gate.cwd) : path.resolve(repoPath);
  const timeoutMs = gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const started = Date.now();

  // Use non-login `/bin/sh -c` with merged PATH so macOS `path_helper` or broken
  // `~/.profile` entries cannot strip `~/.local/bin` (pytest, uv, etc.) from PATH.
  const proc = Bun.spawn(["/bin/sh", "-c", gate.command], {
    cwd,
    env: buildGateEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Ignore already exited
    }
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    const excerpt = timedOut
      ? `[TIMEOUT after ${timeoutMs}ms]\n${combined.slice(-MAX_OUTPUT_EXCERPT)}`
      : combined.slice(-MAX_OUTPUT_EXCERPT);
    return {
      name: gate.name,
      command: gate.command,
      passed: !timedOut && exitCode === 0,
      exitCode: timedOut ? 124 : exitCode,
      durationMs: Date.now() - started,
      outputExcerpt: excerpt,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function formatVerificationSummary(results: readonly GateRunResult[]): string {
  if (results.length === 0) return "No verification gates configured (auto-PASS).";
  const lines = results.map(r => {
    const icon = r.passed ? "✅" : "❌";
    const sec = (r.durationMs / 1000).toFixed(1);
    const tail = !r.passed && r.outputExcerpt ? `\n   └ ${r.outputExcerpt.split("\n").slice(-3).join(" | ").slice(0, 260)}` : "";
    return `${icon} \`${r.name}\` (exit ${r.exitCode}, ${sec}s)${tail}`;
  });
  return lines.join("\n");
}

export class ShellGateVerifier implements GateVerifier {
  async verifyRoute(route: ProjectRoute): Promise<VerificationSummary> {
    const results: GateRunResult[] = [];
    for (const gate of route.verificationGates) {
      results.push(await runSingleGate(gate, route.repoPath));
    }
    const passed = results.every(r => r.passed);
    return {
      passed,
      results,
      ...(passed ? {} : { failureHash: hashFailureSignature(results) }),
      summaryText: formatVerificationSummary(results),
    };
  }
}
