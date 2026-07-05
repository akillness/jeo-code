<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-05 -->

# notify

## Purpose
Remote subagent visibility/control over Telegram (gjc Telegram-daemon parity, deliberately scoped to jeo's subagent surface only — no forum topics, inline keyboards, or image attachments; see root `CHANGELOG.md` 0.7.34 for what jeo intentionally does not replicate from gjc's full notification stack).

## Key Files
| File | Description |
|------|-------------|
| `paths.ts` | Path helpers under `<jeoHome>/notifications` (daemon lock/log, per-session discovery files) |
| `telegram-api.ts` | Minimal, injectable-`fetch` Telegram Bot API client (`getMe`/`sendMessage`/`getUpdates`) + `maskToken` |
| `session-endpoint.ts` | Per-turn, loopback-only WebSocket server exposing ONE `SubagentRegistry` (discovery file + `snapshot`/`steer`/`cancel`/`list` protocol); lazy `ensureSessionNotifyEndpoint`/`stopSessionNotifyEndpoint` wiring, no-op unless `notifications.enabled` |
| `daemon-control.ts` | Daemon lifecycle: pid+startedAt lock singleton, `daemonInvocation` self-spawn argv (mirrors `memory.ts`'s `distillInvocation`), `startDaemon`/`stopDaemon`/`reloadDaemon`/`daemonStatus` |
| `telegram-daemon.ts` | The managed daemon (`TelegramDaemon` class + `runNotifyDaemonForeground` CLI entrypoint): scans session discovery files, connects a WS per session, pushes Telegram messages on subagent status EDGES only, and dispatches inbound `/subagents`/`/steer`/`/cancel`/`/help` commands back over the matching session's WebSocket |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- The session-side WebSocket server MUST stay loopback-only (`127.0.0.1`); the daemon-to-Telegram hop is the only internet-facing part of this feature.
- Every entrypoint here must stay a no-op (or refuse cleanly with a clear message) unless `notifications.enabled` + a stored bot token + chat id are all present — never assume the feature is configured.
- `daemon-control.ts`'s singleton lock exists because Telegram allows only ONE `getUpdates` long-poll owner per bot token; never bypass it.

### Testing Requirements
- Prefer real `Bun.serve`/`WebSocket` for `session-endpoint.ts` tests (fast, no mocking needed) and injected fakes (`WebSocketImpl`, `TelegramApi`, `readdir`/`readFile`/`unlink`/`isPidAlive`) for `telegram-daemon.ts`/`daemon-control.ts`.
- Any test touching `readGlobalConfig`/`saveConfigPatch` must isolate `JEO_CONFIG_DIR` to a temp directory (see `test/notify-daemon-control.test.ts`).

### Common Patterns
- Dependency injection for network/fs/time so daemon logic is unit-testable without a real bot token or real child processes.
- Edge-triggered (not level-triggered) status reporting: a message is sent on a TRANSITION, never on every poll tick.

## Dependencies

### Internal
- `../subagent-registry.ts` (`SubagentRegistry`, `SubagentRecord`).
- `../state.ts` (`readGlobalConfig`/`saveConfigPatch` for `notifications` settings).
- Consumed by `../task-tool.ts` (`ensureSessionNotifyEndpoint`), `../../commands/launch.ts` (`stopSessionNotifyEndpoint`), `../../commands/notify.ts`, `../../commands/daemon.ts`, and the hidden `notify-daemon-run` CLI entrypoint (`src/cli/runner.ts`).

### External
- Telegram Bot HTTP API (`https://api.telegram.org`) — the only outbound network call in this feature.
- Bun's native `Bun.serve` (WebSocket server) and global `WebSocket` (client) — zero added dependencies.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
