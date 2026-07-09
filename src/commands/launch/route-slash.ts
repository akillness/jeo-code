/**
 * `/route` slash-command handler extracted from launch.ts.
 *
 * Handles `/route [status|on|off|why|history]` (default/`status`: report the
 * effective session routing state + the last decision, if any; `on`/`off`:
 * toggle a SESSION-LOCAL override of `config.routing.enabled`; `why`: explain
 * the last routing decision in detail; `history [n]`: print the last `n`
 * (default 10) recorded decisions, one per line). This block shares mutable
 * REPL state (`sessionRouteOverride`, `lastRouteDecision`, `routeHistory`)
 * with `runTurn`'s own routing insertion, so the caller passes the current
 * values in via an explicit context object and reads back a result object
 * instead of this function closing over REPL state directly.
 *
 * Session-level toggle only — `sessionRouteOverride` is never persisted to
 * `~/.jeo/config.json` (mirrors `/thinking` being session-only vs. `/model
 * save` being the explicit opt-in for persistence). `/route` has no `save`
 * subcommand in v1.
 */

import type { RouteDecision } from "../../agent/prompt-router";
import type { RouteHistoryEntry } from "../../agent/route-history";

export interface RouteSlashCtx {
  sessionRouteOverride: boolean | undefined;
  /** `turnConfig.routing?.enabled ?? false`, read fresh by the caller. */
  routingConfigEnabled: boolean;
  lastRouteDecision: RouteDecision | { note: string } | null;
  /** The session's explicit model pin (`sessionModel`, from `--model`/`/model`),
   *  if any. Threaded through purely for `/route status`'s visibility note below —
   *  never changes routing's actual gating logic (`!sessionModel` in launch.ts's
   *  `runTurn` stays the single source of truth for whether routing engages). */
  pinnedModel?: string;
  /** Chronological (oldest-first) snapshot of this session's `RouteHistory`
   *  (`routeHistory.getAll()`), read fresh by the caller for `/route history`. */
  routeHistory: RouteHistoryEntry[];
}



export interface RouteSlashResult {
  /** Present only when changed by "on"/"off". */
  sessionRouteOverride?: boolean | undefined;
  /** Lines to print. */
  lines: string[];
}

const USAGE = "Usage: /route [status|on|off|why|history [n]]";

function isRealDecision(decision: RouteDecision | { note: string } | null): decision is RouteDecision {
  return !!decision && "model" in decision;
}

function explainDecision(decision: RouteDecision | { note: string } | null): string[] {
  if (!isRealDecision(decision)) {
    return [decision?.note ?? "No routing decision has been made yet this session."];
  }
  const lines = [
    `tier: ${decision.tier}`,
    `model: ${decision.model}`,
    `source: ${decision.source}`,
    `confidence: ${decision.confidence.toFixed(2)}`,
    `signals: ${decision.signals.join(", ") || "none"}`,
  ];
  if (decision.thinking) lines.push(`thinking: ${decision.thinking}`);
  if (decision.warning) lines.push(`warning: ${decision.warning}`);
  return lines;
}

/**
 * Format the last `n` history entries (default 10) as one line each:
 * `turn N: tier -> model (source, confidence X.XX)`, oldest of the selected
 * window first — matches `getAll()`'s chronological ordering.
 */
function formatHistory(entries: RouteHistoryEntry[], n: number): string[] {
  if (entries.length === 0) return ["No routing decisions recorded yet this session."];
  const selected = n > 0 ? entries.slice(Math.max(0, entries.length - n)) : [];
  if (selected.length === 0) return ["No routing decisions recorded yet this session."];
  return selected.map((e) => `turn ${e.turnNumber}: ${e.tier} -> ${e.model} (${e.source}, confidence ${e.confidence.toFixed(2)})`);
}

/**
 * Handle `/route [status|on|off|why|history]`. Extracted for the same reason
 * as `/model`: shares REPL-local routing state with `runTurn` via an
 * explicit ctx/result object rather than closing over it.
 */
export function runRouteSlash(input: string, ctx: RouteSlashCtx): RouteSlashResult {
  const rest = input.slice("/route".length).trim();
  const [sub, arg] = rest.split(/\s+/).filter(Boolean);
  const effective = ctx.sessionRouteOverride ?? ctx.routingConfigEnabled;

  if (!sub || sub === "status") {
    const lines = [`routing: ${effective ? "on" : "off"} (this session)`];
    if (isRealDecision(ctx.lastRouteDecision)) {
      lines.push(`last decision: ${ctx.lastRouteDecision.tier} → ${ctx.lastRouteDecision.model} (${ctx.lastRouteDecision.source}: ${ctx.lastRouteDecision.signals.join(", ") || "none"}, confidence ${ctx.lastRouteDecision.confidence.toFixed(2)})`);
    }
    // A model pin (`--model`/`/model`) blocks routing UNLESS the user explicitly ran
    // `/route on` this session — that explicit toggle wins over a prior pin (see
    // `routeOverridesPin` in launch.ts's `runTurn`) so routing actually evaluates
    // every prompt as requested. Surface the distinction here, since "routing: on"
    // read alone would otherwise be misleading about whether it's actually pinned.
    if (ctx.pinnedModel && ctx.sessionRouteOverride !== true) {
      lines.push(`note: model pinned to '${ctx.pinnedModel}' this session — routing will not evaluate any prompt until the pin is cleared (/model auto) or you run '/route on' to override the pin`);
    } else if (ctx.pinnedModel && ctx.sessionRouteOverride === true) {
      lines.push(`note: model pinned to '${ctx.pinnedModel}', but '/route on' overrides the pin — routing will evaluate every prompt`);
    }
    return { lines };
  }



  if (sub === "on") {
    return { sessionRouteOverride: true, lines: ["routing: on (this session)"] };
  }

  if (sub === "off") {
    return { sessionRouteOverride: false, lines: ["routing: off (this session)"] };
  }

  if (sub === "why") {
    return { lines: explainDecision(ctx.lastRouteDecision) };
  }

  if (sub === "history") {
    // Only a finite POSITIVE count selects a window; 0, negatives, and
    // non-numeric args (`bogus`) all fall back to the default 10 rather than
    // silently printing the empty-history message when decisions actually
    // exist (that message must mean "nothing recorded", never "you asked for 0").
    const parsed = arg !== undefined ? Number.parseInt(arg, 10) : 10;
    const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
    return { lines: formatHistory(ctx.routeHistory, n) };
  }

  return { lines: [`Unknown /route subcommand: ${sub}`, USAGE] };
}
