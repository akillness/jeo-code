/**
 * `/computer` slash-command handler, mirroring `/route`'s extraction pattern
 * (see `route-slash.ts`). Handles `/computer [status|on|off]` — toggles a
 * SESSION-LOCAL override of `config.computer.enabled` (the safety-gated
 * desktop-automation tool executed by `executeComputerAction` in
 * `../computer.ts`), without requiring the user to hand-edit
 * `~/.jeo/config.json`.
 *
 * Session-level toggle only — `sessionComputerOverride` is never persisted
 * (mirrors `/route`'s `sessionRouteOverride`). Turning it on for a session
 * does NOT relax the fail-closed `computerSupervisor` kill-switch/heartbeat
 * gate inside `executeComputerAction` — it only satisfies the separate
 * `config.computer.enabled` config gate that sits in front of it. Both gates
 * must pass for any non-read-only action to actually execute.
 */

export interface ComputerSlashCtx {
  sessionComputerOverride: boolean | undefined;
  /** `turnConfig.computer?.enabled ?? false`, read fresh by the caller. */
  computerConfigEnabled: boolean;
}

export interface ComputerSlashResult {
  /** Present only when changed by "on"/"off". */
  sessionComputerOverride?: boolean | undefined;
  /** Lines to print. */
  lines: string[];
}

const USAGE = "Usage: /computer [status|on|off]";

/**
 * Handle `/computer [status|on|off]`. Extracted for the same reason as
 * `/route`: shares REPL-local computer-use state with `runTurn` via an
 * explicit ctx/result object rather than closing over it.
 */
export function runComputerSlash(input: string, ctx: ComputerSlashCtx): ComputerSlashResult {
  const rest = input.slice("/computer".length).trim();
  const [sub] = rest.split(/\s+/).filter(Boolean);
  const effective = ctx.sessionComputerOverride ?? ctx.computerConfigEnabled;

  if (!sub || sub === "status") {
    const lines = [`computer use: ${effective ? "on" : "off"} (this session)`];
    if (!effective) {
      lines.push("note: the 'computer' tool is fail-closed while off — run '/computer on' to enable it for this session, or set 'computer.enabled: true' in ~/.jeo/config.json to enable it by default.");
    } else {
      lines.push("note: the fail-closed kill-switch/heartbeat supervisor still gates every non-read-only action (screenshot/wait are exempt) independently of this toggle.");
    }
    return { lines };
  }

  if (sub === "on") {
    return { sessionComputerOverride: true, lines: ["computer use: on (this session)"] };
  }

  if (sub === "off") {
    return { sessionComputerOverride: false, lines: ["computer use: off (this session)"] };
  }

  return { lines: [`Unknown /computer subcommand: ${sub}`, USAGE] };
}
