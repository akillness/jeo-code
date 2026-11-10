/**
 * Single source of truth for the Claude Code version jeo advertises on Anthropic OAuth
 * requests (User-Agent `claude-cli/<v>` + billing header `cc_version=<v>`). Anthropic gates
 * newer models on this version (HTTP 400 `claude_code_version_too_old`: "Claude Code 2.1.289
 * does not support this model; version 2.1.290 or newer is required"), so a stale constant
 * silently locks every new model out.
 *
 * Resolution order (highest wins):
 *  1. `JEO_CLAUDE_CODE_VERSION` env override — authoritative, even over a server-raised minimum.
 *  2. The highest of: DEFAULT baseline, a minimum raised at runtime from a server rejection
 *     (`raiseClaudeCodeVersion`, process-wide, one-shot retry in the providers), and the
 *     locally installed `claude --version` (detected once, never used if below the baseline).
 */
import { jeoEnv } from "../util/env";

export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.322";

let raisedMinimum: string | undefined;
let detectedVersion: string | undefined;
let detectionAttempted = false;

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function getClaudeCodeVersion(): string {
  const override = jeoEnv("CLAUDE_CODE_VERSION");
  if (override && /^\d+\.\d+\.\d+$/.test(override)) return override;

  let version = DEFAULT_CLAUDE_CODE_VERSION;
  if (raisedMinimum && compareVersions(raisedMinimum, version) > 0) version = raisedMinimum;
  if (!detectionAttempted) {
    detectionAttempted = true;
    try {
      const result = Bun.spawnSync(["claude", "--version"], { timeout: 1500, stdout: "pipe", stderr: "ignore" });
      const detected = new TextDecoder().decode(result.stdout).match(/(\d+\.\d+\.\d+)/)?.[1];
      if (detected && compareVersions(detected, DEFAULT_CLAUDE_CODE_VERSION) >= 0) detectedVersion = detected;
    } catch {
      // Claude Code is optional; version detection must never break provider requests.
    }
  }
  if (detectedVersion && compareVersions(detectedVersion, version) > 0) version = detectedVersion;
  return version;
}

export function parseRequiredClaudeCodeVersion(detail: string): string | undefined {
  if (!detail.includes("claude_code_version_too_old")) return undefined;
  return detail.match(/version\s+(\d+\.\d+\.\d+)\s+(?:or\s+newer\s+is\s+required|minimum)\b/i)?.[1];
}

export function raiseClaudeCodeVersion(minimum: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(minimum)) return false;
  const current = getClaudeCodeVersion();
  if (compareVersions(minimum, current) <= 0) return false;
  if (!raisedMinimum || compareVersions(minimum, raisedMinimum) > 0) raisedMinimum = minimum;
  return true;
}

export function _resetClaudeCodeVersionForTests(): void {
  raisedMinimum = undefined;
  detectedVersion = undefined;
  detectionAttempted = false;
}
