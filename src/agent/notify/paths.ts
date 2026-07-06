/**
 * Path helpers for the local Telegram notification daemon (gjc `notifications/`
 * daemon-paths parity, scoped to jeo's single daemon kind). Everything lives under
 * `<jeoHome>/notifications` — the SAME root `~/.jeo` (or `JEO_CONFIG_DIR`) used by
 * `state.ts` for `config.json`, so one override env var moves both.
 */
import * as path from "node:path";
import * as os from "node:os";
import { jeoEnv } from "../../util/env";

/** Root directory for all local jeo state, resolved at call time (not import
 *  time) so a `JEO_CONFIG_DIR` override or runtime `HOME` change is honored. */
export function jeoHomeDir(): string {
  return jeoEnv("CONFIG_DIR") || path.join(os.homedir(), ".jeo");
}

/** Notification/daemon state root. */
export function notifyDir(): string {
  return path.join(jeoHomeDir(), "notifications");
}

/** Per-process session discovery files live here; the daemon scans this directory
 *  for live sessions (`<sessionId>.json`), same shape as gjc's `readEndpoint`/
 *  `scanRoots` (a loopback WebSocket URL + auth token per session). */
export function notifySessionsDir(): string {
  return path.join(notifyDir(), "sessions");
}

export function notifySessionEndpointPath(sessionId: string): string {
  return path.join(notifySessionsDir(), `${sessionId}.json`);
}

/** Persisted per-session forum-topic map (`sessionId -> {topicId, name, createdAt}`),
 *  survives daemon restarts (gjc `telegram-topics.json` parity). Only written/read
 *  when `notifications.telegram.perSessionTopics` is enabled. */
export function notifyTopicsPath(): string {
  return path.join(notifyDir(), "telegram-topics.json");
}

/** Singleton lock for the daemon process (Telegram allows only one `getUpdates`
 *  long-poll owner per bot token — gjc's rationale for a daemon lock/state file). */
export function notifyDaemonLockPath(): string {
  return path.join(notifyDir(), "daemon.lock");
}

export function notifyDaemonLogPath(): string {
  return path.join(notifyDir(), "daemon.log");
}
