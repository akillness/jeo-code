<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-06 -->

# notify

## Purpose
Remote subagent visibility/control AND main-session mirroring over Telegram (gjc parity).
Tier 1 (shipped v0.7.43–v0.7.48): inline images, a static forum topic, inline keyboards
(per-subagent ⏹ Cancel buttons + `callback_query` handling), image attachments (`sendPhoto`,
relayed from a session `{type:"photo"}` frame). Tier 2 (this pass): a dynamic, PER-SESSION
forum topic (opt-in via `notifications.telegram.perSessionTopics`) that mirrors that session's
OWN activity (`identity_header`/`context_update`/`turn_stream` frames), accepts free-text
replies that steer that session directly (`user_message`, routed through `handleRemoteUserMessage`
in `../../commands/launch.ts`), in-thread `/verbose`/`/lean`/`/redact` config commands scoped to
that one session, and a shared `RateLimitPool` (burst/steady-rate protection across every
session sharing one bot token). The flat/global `topicId` path is UNCHANGED when
`perSessionTopics` is off — zero regression risk for existing setups.

## Key Files
| File | Description |
|------|-------------|
| `paths.ts` | Path helpers under `<jeoHome>/notifications` (daemon lock/log, per-session discovery files, `notifyTopicsPath()` for the per-session topic map) |
| `telegram-api.ts` | Minimal, injectable-`fetch` Telegram Bot API client: `getMe`/`sendMessage`(+`parseMode`)/`sendPhoto`/`answerCallbackQuery`/`getUpdates` (Tier 1) plus `createForumTopic`/`editForumTopic`/`getFile`/`downloadFile`(path-traversal-guarded)/`getChat`/`setMessageReaction` (Tier 2) + `maskToken` |
| `telegram-html.ts` | Bounded markdown→Telegram-HTML converter (`markdownToTelegramHtml`) + safe truncate/split (`truncateTelegramHtml`/`splitTelegramHtml`, never break a tag/entity) — renders `turn_stream` frames |
| `topic-registry.ts` | Pure, injectable-create `TopicRegistry`: one forum-topic record per session (numeric `topicId`, rename-dedup via `applyName`), concurrency-guarded `getOrCreateTopic`, serializable state |
| `rate-limit-pool.ts` | Pure, injectable-clock `RateLimitPool`: token-bucket + 4 priority lanes (`ask`>`finalized`>`live`>`idle`, only `finalized` has a jeo caller today) + per-session round-robin fairness + coalescing |
| `config-commands.ts` | Pure `parseInThreadConfigCommand`: `/verbose`, `/lean`, `/verbosity lean\|verbose`, `/redact on\|off` — session-local, never persisted |
| `session-endpoint.ts` | SESSION-scoped (not per-turn) loopback WebSocket server: one per interactive REPL for its whole lifetime, `attachRegistry`/`detachRegistry` swap the live per-turn `SubagentRegistry` in/out at turn boundaries, `sendIdentity`/`sendContextUpdate`/`sendTurnStream` push main-session frames, `onUserMessage`/`onConfigCommand` receive callbacks. `startSessionNotifyEndpoint` (eager, session-scoped) is the primary entrypoint; `ensureSessionNotifyEndpoint`/`stopSessionNotifyEndpoint` (lazy, per-registry) remain as a FALLBACK for a detached subagent launched outside any interactive session |
| `daemon-control.ts` | Daemon lifecycle: pid+startedAt lock singleton, `daemonInvocation` self-spawn argv (mirrors `memory.ts`'s `distillInvocation`), `startDaemon`/`stopDaemon`/`reloadDaemon`/`daemonStatus` |
| `telegram-daemon.ts` | The managed daemon (`TelegramDaemon` class + `runNotifyDaemonForeground` CLI entrypoint): scans session discovery files, connects a WS per session, routes ALL outbound sends through the shared `RateLimitPool`, resolves each push's topic via `TopicRegistry` when `perSessionTopics` is on (else the flat `topicId`, Tier 1 behavior), renames a topic once `identity_header` arrives, downloads inbound photo/image-document attachments for relay, reacts 👀 to an accepted inbound message, and dispatches global `/subagents`/`/steer`/`/cancel`/`/help` PLUS per-session-topic inbound (config command or free-text `user_message`) |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- The session-side WebSocket server MUST stay loopback-only (`127.0.0.1`); the daemon-to-Telegram hop is the only internet-facing part of this feature.
- Every entrypoint here must stay a no-op (or refuse cleanly with a clear message) unless `notifications.enabled` + a stored bot token + chat id are all present — never assume the feature is configured.
- `daemon-control.ts`'s singleton lock exists because Telegram allows only ONE `getUpdates` long-poll owner per bot token; never bypass it.
- Telegram has NO live message editing anywhere in this feature — every delivered frame is a fresh `sendMessage`/`sendPhoto` call. `RateLimitPool` coalescing only ever drops a STALE, UNSENT queued item; it never edits an already-sent message.
- jeo's forum topics are NEVER deleted (unlike gjc) — `sessionId` persists across `--resume`, so a topic, once created, is meant to be reused indefinitely across relaunches of the same session.
- `session-endpoint.ts`'s constructor is `(cwd, sessionId?)`, NOT `(registry, cwd)` — the registry attaches/detaches after construction via `attachRegistry`/`detachRegistry`, since one endpoint now outlives many per-turn registries.

### Testing Requirements
- Prefer real `Bun.serve`/`WebSocket` for `session-endpoint.ts` tests (fast, no mocking needed) and injected fakes (`WebSocketImpl`, `TelegramApi`, `readdir`/`readFile`/`unlink`/`isPidAlive`, `loadTopicState`/`saveTopicState`, `writeTempFile`, `now`) for `telegram-daemon.ts`/`daemon-control.ts`.
- Any test touching `readGlobalConfig`/`saveConfigPatch` must isolate `JEO_CONFIG_DIR` to a temp directory (see `test/notify-daemon-control.test.ts`).
- `topic-registry.ts`/`rate-limit-pool.ts`/`config-commands.ts`/`telegram-html.ts` are pure — no network/fs/real-timer dependency, test them directly with plain inputs/outputs (inject `now`/`create` callbacks where the API takes them).

### Common Patterns
- Dependency injection for network/fs/time so daemon logic is unit-testable without a real bot token or real child processes.
- Edge-triggered (not level-triggered) status reporting: a message is sent on a TRANSITION, never on every poll tick.
- Fail-closed, not fail-open, on a per-session topic-creation failure (e.g. Threaded Mode off): the session's frames fall back to the flat/global `topicId` (or drop, if that's also unset) rather than retrying every frame or blocking delivery.

## Dependencies

### Internal
- `../subagent-registry.ts` (`SubagentRegistry`, `SubagentRecord`).
- `../state.ts` (`readGlobalConfig`/`saveConfigPatch` for `notifications` settings, incl. `verbosity`/`redact`/`telegram.perSessionTopics`).
- `../../util/file-attachment.ts` (`attachImagePaths`) — the ONE image-ingestion path a `user_message` frame's `imagePaths` (daemon-downloaded temp files) flows through on the session side, same as local drag-drop.
- Consumed by `../task-tool.ts` (`ensureSessionNotifyEndpoint`, now also threading an optional `sessionEndpoint` to attach to), `../../commands/launch.ts` (`startSessionNotifyEndpoint` at session start, `stopSessionNotifyEndpoint` fallback, `attachRegistry`/`detachRegistry` per turn, `sendIdentity`/`sendContextUpdate`/`sendTurnStream`, `onUserMessage`/`onConfigCommand` handlers), `../../commands/notify.ts`, `../../commands/daemon.ts`, and the hidden `notify-daemon-run` CLI entrypoint (`src/cli/runner.ts`).

### External
- Telegram Bot HTTP API (`https://api.telegram.org` for calls, `https://api.telegram.org/file/...` for file downloads — a DIFFERENT base path) — the only outbound network call in this feature.
- Bun's native `Bun.serve` (WebSocket server) and global `WebSocket` (client) — zero added dependencies.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
