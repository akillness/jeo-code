/**
 * Pure matching, trigger classification, `!orch` command parsing,
 * risky-operation detection, and failure signature hashing.
 */

import { createHash } from "node:crypto";
import type { DiscordMessage, DiscordThread, GateRunResult, OrchConfig, ProjectRoute } from "./types";

export type OrchThreadCommand =
  | { verb: "status" }
  | { verb: "pause" }
  | { verb: "resume" }
  | { verb: "stop" }
  | { verb: "retry" }
  | { verb: "approve"; gateId: string }
  | { verb: "deny"; gateId: string }
  | { verb: "help" };

export type MessageClassification =
  | { kind: "ignore"; reason: string }
  | { kind: "command"; command: OrchThreadCommand }
  | { kind: "human_trigger" }
  | { kind: "qa_fail_trigger"; marker: string };

/** Default structured markers in bot QA reports that may trigger a recursive fix cycle. */
export const DEFAULT_BOT_QA_MARKERS: readonly string[] = [
  "[QA_FAIL]",
  "[VERIFICATION_FAIL]",
  "[ORCH_RETRY]",
];

/** Regex for structured gate failures in QA bot reports (e.g. `gate_3d_albedo_10: FAIL`). */
const STRUCTURED_GATE_FAIL_RE = /\bgate_[a-z0-9_]+\s*[:=]\s*FAIL\b/i;

/**
 * Exact 64-bit Discord snowflake comparison (avoids JS float precision loss).
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareSnowflakes(a: string, b: string): -1 | 0 | 1 {
  const aa = BigInt(a);
  const bb = BigInt(b);
  if (aa < bb) return -1;
  if (aa > bb) return 1;
  return 0;
}

/**
 * Match a Discord thread against the multi-project `routes` table.
 * First enabled matching route wins (specific keyword/prefix routes should be ordered before catch-all routes).
 */
export function matchRoute(thread: Pick<DiscordThread, "parent_id" | "name">, routes: readonly ProjectRoute[]): ProjectRoute | undefined {
  const parentId = thread.parent_id ? String(thread.parent_id) : "";
  const titleLower = (thread.name || "").trim().toLowerCase();

  for (const route of routes) {
    if (!route.enabled) continue;
    if (route.parentChannelIds.length > 0 && !route.parentChannelIds.includes(parentId)) {
      continue;
    }

    const prefixes = (route.titlePrefixes ?? []).map(p => p.trim().toLowerCase()).filter(Boolean);
    const keywords = route.titleKeywords.map(k => k.trim().toLowerCase()).filter(Boolean);

    if (prefixes.length === 0 && keywords.length === 0) {
      return route;
    }

    const prefixHit = prefixes.some(p => titleLower.startsWith(p));
    const keywordHit = keywords.some(k => titleLower.includes(k));
    if (prefixHit || keywordHit) {
      return route;
    }
  }
  return undefined;
}

/** Parse `!orch <verb> [arg]` control commands inside a Discord thread. */
export function parseOrchCommand(content: string): OrchThreadCommand | undefined {
  const trimmed = content.trim();
  if (!/^!orch(?:\s|$)/i.test(trimmed)) return undefined;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const verb = (parts[1] ?? "status").toLowerCase();

  switch (verb) {
    case "status":
      return { verb: "status" };
    case "pause":
      return { verb: "pause" };
    case "resume":
      return { verb: "resume" };
    case "stop":
      return { verb: "stop" };
    case "retry":
      return { verb: "retry" };
    case "approve":
      if (parts[2]) return { verb: "approve", gateId: parts[2] };
      return { verb: "help" };
    case "deny":
      if (parts[2]) return { verb: "deny", gateId: parts[2] };
      return { verb: "help" };
    default:
      return { verb: "help" };
  }
}

/**
 * Classify a Discord thread message to decide whether it should trigger work,
 * execute a control command, or be ignored (preventing bot ping-pong loops).
 */
export function classifyMessage(
  msg: DiscordMessage,
  config: Pick<OrchConfig, "ownerUserIds">,
  route: Pick<ProjectRoute, "allowBotQaMarkers">,
  botUserId?: string,
): MessageClassification {
  const content = (msg.content ?? "").trim();
  if (!content) return { kind: "ignore", reason: "empty" };

  // Never react to our own orchestrator messages (hard self-loop invariant).
  if (botUserId && msg.author.id === botUserId) {
    return { kind: "ignore", reason: "self_message" };
  }

  // Other bot messages (e.g. messenger bridge replies) are ignored by default.

  // Only structured QA failure markers may trigger a recursive fix cycle.
  if (msg.author.bot) {
    const markers = route.allowBotQaMarkers?.length ? route.allowBotQaMarkers : DEFAULT_BOT_QA_MARKERS;
    const upper = content.toUpperCase();
    for (const marker of markers) {
      if (marker && upper.includes(marker.toUpperCase())) {
        return { kind: "qa_fail_trigger", marker };
      }
    }
    const gateMatch = content.match(STRUCTURED_GATE_FAIL_RE);
    if (gateMatch) {
      return { kind: "qa_fail_trigger", marker: gateMatch[0] };
    }
    return { kind: "ignore", reason: "bot_non_qa_message" };
  }

  // Human messages: restrict to configured ownerUserIds when set.
  if (config.ownerUserIds.length > 0 && !config.ownerUserIds.includes(msg.author.id)) {
    return { kind: "ignore", reason: "non_owner_human" };
  }

  const cmd = parseOrchCommand(content);
  if (cmd) return { kind: "command", command: cmd };

  return { kind: "human_trigger" };
}

const RISKY_RULES: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/i, reason: "Force git push (`git push --force` / `-f`)" },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~|\.\.?|\*)/i, reason: "Recursive force delete (`rm -rf`)" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "Destructive git reset (`git reset --hard`)" },
  { pattern: /\bgit\s+clean\s+-[a-z]*f[a-z]*d/i, reason: "Destructive working-tree wipe (`git clean -fd`)" },
  { pattern: /\b(?:npm|bun|pnpm|yarn)\s+publish\b/i, reason: "External package publish" },
  { pattern: /\b(?:kubectl\s+apply|terraform\s+apply|vercel\s+--prod|fly\s+deploy|wrangler\s+deploy|gh\s+release\s+create)\b/i, reason: "External production deploy / release" },
  { pattern: /(?:강제\s*푸시|대량\s*삭제|외부\s*배포|프로덕션\s*배포)/, reason: "Explicit high-risk request (강제 푸시 / 대량 삭제 / 외부 배포)" },
];

/** Detect high-risk operations that require explicit `!orch approve <gateId>` confirmation. */
export function detectRiskyOperation(text: string): { reason: string; excerpt: string } | undefined {
  for (const rule of RISKY_RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      return { reason: rule.reason, excerpt: m[0].slice(0, 120) };
    }
  }
  return undefined;
}

/**
 * Produce a normalized deterministic failure signature so two consecutive runs
 * failing on the exact same root cause trip the circuit breaker (ignoring timestamps/durations).
 */
export function hashFailureSignature(results: readonly GateRunResult[]): string {
  const failed = results
    .filter(r => !r.passed)
    .map(r => {
      const normalizedOutput = r.outputExcerpt
        .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)\b/gi, "<T>")
        .replace(/\b20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<TS>")
        .replace(/pid\s*=?\s*\d+/gi, "pid=<P>")
        .trim()
        .slice(-500);
      return `${r.name}|exit=${r.exitCode}|${normalizedOutput}`;
    })
    .sort()
    .join("\n---\n");

  return createHash("sha256").update(failed).digest("hex").slice(0, 16);
}
