/**
 * Runs per-route verification gates (tests, static preflight, lint/build checks)
 * after an Orca worker completes a turn, producing a deterministic failure signature.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { hashFailureSignature } from "./matcher";
import type { GateRunResult, ProjectRoute, VerificationGate, VerificationSummary } from "./types";

const DEFAULT_GATE_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_EXCERPT = 1200;

export interface GateVerifier {
  verifyRoute(route: ProjectRoute, dispatchId?: string): Promise<VerificationSummary>;
}

function buildGateEnv(dispatchId?: string): Record<string, string | undefined> {
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
    JEO_ORCH_DISPATCH_ID: dispatchId ?? "",
  };
}

export async function runSingleGate(gate: VerificationGate, repoPath: string, dispatchId?: string): Promise<GateRunResult> {
  const timeoutMs = gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const started = Date.now();
  const result = (exitCode: number, outputExcerpt: string): GateRunResult => ({
    name: gate.name,
    command: gate.command,
    passed: exitCode === 0,
    exitCode,
    durationMs: Date.now() - started,
    outputExcerpt,
  });
  if (!gate.name.trim() || !gate.command.trim()) {
    return result(125, "[INVALID GATE] A name and a non-empty command are required.");
  }

  const grouped = process.platform !== "win32";
  return new Promise<GateRunResult>(resolve => {
    // Non-login shell keeps the merged PATH. Use a process group so a timed-out
    // check cannot keep its output pipes open through a descendant of the shell.
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("/bin/sh", ["-c", gate.command], {
        cwd: path.resolve(repoPath, gate.cwd ?? "."),
        env: buildGateEnv(dispatchId),
        detached: grouped,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(result(125, `[GATE EXECUTION ERROR] ${String(error)}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number, detail = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const excerpt = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").slice(-MAX_OUTPUT_EXCERPT);
      resolve(result(exitCode, [detail, excerpt].filter(Boolean).join("\n")));
    };
    const stop = () => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The process or group may already have exited.
      }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      finish(124, `[TIMEOUT after ${timeoutMs}ms]`);
      stop();
    }, timeoutMs);
    const fail = (error: Error) => {
      if (settled) return;
      finish(125, `[GATE EXECUTION ERROR] ${error.message}`);
      stop();
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-MAX_OUTPUT_EXCERPT);
    }).on("error", fail);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT_EXCERPT);
    }).on("error", fail);
    child.on("error", fail);
    child.on("close", (exitCode, signal) => {
      finish(exitCode ?? 125, signal ? `[GATE TERMINATED BY ${signal}]` : "");
    });
  });
}

export function formatVerificationSummary(results: readonly GateRunResult[]): string {
  if (results.length === 0) return "No verification gates configured; add a check that proves the requested work before marking it verified.";
  const lines = results.map(r => {
    const icon = r.passed ? "✅" : "❌";
    const sec = (r.durationMs / 1000).toFixed(1);
    const tail = !r.passed && r.outputExcerpt ? `\n   └ ${r.outputExcerpt.split("\n").slice(-3).join(" | ").slice(0, 260)}` : "";
    return `${icon} \`${r.name}\` (exit ${r.exitCode}, ${sec}s)${tail}`;
  });
  return lines.join("\n");
}

export class ShellGateVerifier implements GateVerifier {
  async verifyRoute(route: ProjectRoute, dispatchId?: string): Promise<VerificationSummary> {
    const results: GateRunResult[] = [];
    const worktreePath = route.orcaWorktreePath ?? route.repoPath;
    for (const gate of route.verificationGates) {
      results.push(await runSingleGate(gate, worktreePath, dispatchId));
    }
    const passed = results.length > 0 && results.every(r => r.passed);
    return {
      passed,
      results,
      ...(!passed && results.length > 0 ? { failureHash: hashFailureSignature(results) } : {}),
      summaryText: formatVerificationSummary(results),
    };
  }
}
