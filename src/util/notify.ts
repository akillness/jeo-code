/**
 * Terminal-bell notifications (gajae-code 0.7.8 parity).
 *
 * Emits an ASCII BEL (`\x07`) to the controlling terminal at notable
 * interaction points so a backgrounded `jeo` session pings the user when it
 * finishes a turn or stops to ask for input. Off by default; opt in through
 * `config.notify.bell` (or force with `JEO_NOTIFY_BELL=1`).
 *
 * The decision logic (`shouldBell`) is pure and env-injectable so it is unit
 * testable without a real terminal; `emitBell` is the only side effect.
 */

export type NotifyEvent = "complete" | "ask" | "approval";

export interface NotifyConfig {
  /** Master toggle — no bell fires unless this is true (or the env override is set). */
  bell?: boolean;
  /** Bell when an agent turn finishes (default: on when the master toggle is on). */
  onComplete?: boolean;
  /** Bell when an ask / approval prompt awaits the user (default: on when master on). */
  onAsk?: boolean;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Decide whether a terminal bell should fire for `event`.
 *
 * Precedence: `JEO_NOTIFY_BELL` env force-overrides the config master toggle
 * (`1`/`true` forces on, `0`/`false` forces off). When the master toggle is on,
 * each event is enabled unless its per-event flag is explicitly `false`.
 */
export function shouldBell(
  event: NotifyEvent,
  config: NotifyConfig | undefined,
  env: EnvLike = {},
): boolean {
  const raw = env.JEO_NOTIFY_BELL;
  const envForceOn = raw === "1" || raw === "true";
  const envForceOff = raw === "0" || raw === "false";
  const masterOn = envForceOn || (!envForceOff && config?.bell === true);
  if (!masterOn) return false;
  switch (event) {
    case "complete":
      return config?.onComplete !== false;
    case "ask":
    case "approval":
      return config?.onAsk !== false;
    default:
      return false;
  }
}

/** Write a single ASCII BEL to `write` (best-effort; a dead terminal never throws). */
export function emitBell(write: (s: string) => void): void {
  try {
    write("\x07");
  } catch {
    /* terminal gone — a courtesy bell must never crash a turn */
  }
}

/** Convenience: emit a bell for `event` iff `shouldBell` allows it. */
export function maybeBell(
  event: NotifyEvent,
  config: NotifyConfig | undefined,
  write: (s: string) => void,
  env: EnvLike = {},
): boolean {
  if (!shouldBell(event, config, env)) return false;
  emitBell(write);
  return true;
}
