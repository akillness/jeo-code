/**
 * `/route` slash-command handler extracted from launch.ts.
 *
 * Handles `/route [status|on|off|why]` (default/`status`: report the effective
 * session routing state + the last decision, if any; `on`/`off`: toggle a
 * SESSION-LOCAL override of `config.routing.enabled`; `why`: explain the last
 * routing decision in detail). This block shares mutable REPL state
 * (`sessionRouteOverride`, `lastRouteDecision`) with `runTurn`'s own routing
 * insertion, so the caller passes the current values in via an explicit
 * context object and reads back a result object instead of this function
 * closing over REPL state directly.
 *
 * Session-level toggle only — `sessionRouteOverride` is never persisted to
 * `~/.jeo/config.json` (mirrors `/thinking` being session-only vs. `/model
 * save` being the explicit opt-in for persistence). `/route` has no `save`
 * subcommand in v1.
 */

import type { RouteDecision } from "../../agent/prompt-router";

export interface RouteSlashCtx {
  sessionRouteOverride: boolean | undefined;
  /** `turnConfig.routing?.enabled ?? false`, read fresh by the caller. */
  routingConfigEnabled: boolean;
  lastRouteDecision: RouteDecision | { note: string } | null;
}

export interface RouteSlashResult {
  /** Present only when changed by "on"/"off". */
  sessionRouteOverride?: boolean | undefined;
  /** Lines to print. */
  lines: string[];
}

const USAGE = "Usage: /route [status|on|off|why]";

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
 * Handle `/route [status|on|off|why]`. Extracted for the same reason as
 * `/model`: shares REPL-local routing state with `runTurn` via an explicit
 * ctx/result object rather than closing over it.
 */
export function runRouteSlash(input: string, ctx: RouteSlashCtx): RouteSlashResult {
  const rest = input.slice("/route".length).trim();
  const [sub] = rest.split(/\s+/).filter(Boolean);
  const effective = ctx.sessionRouteOverride ?? ctx.routingConfigEnabled;

  if (!sub || sub === "status") {
    const lines = [`routing: ${effective ? "on" : "off"} (this session)`];
    if (isRealDecision(ctx.lastRouteDecision)) {
      lines.push(`last decision: ${ctx.lastRouteDecision.tier} → ${ctx.lastRouteDecision.model} (${ctx.lastRouteDecision.source}: ${ctx.lastRouteDecision.signals.join(", ") || "none"}, confidence ${ctx.lastRouteDecision.confidence.toFixed(2)})`);
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

  return { lines: [`Unknown /route subcommand: ${sub}`, USAGE] };
}
