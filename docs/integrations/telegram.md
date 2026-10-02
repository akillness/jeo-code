# Telegram Integration & Remote Subagent Control

`jeo` features a zero-dependency, production-grade Telegram integration designed for real-time remote monitoring, subagent steering, and session mirroring right from your phone or desktop Telegram client.

---

## Key Highlights

- **Edge-Triggered Notifications**: Alerts fire only when a subagent transitions state (`started` → `completed` / `failed` / `cancelled`). No spammy "still running" periodic pings.
- **Remote Steering**: Send live prompt steering commands (`/steer`) into running subagents while away from your terminal.
- **One-Click Cancel**: Inline keyboard buttons (⏹ Cancel) are automatically attached to running subagent messages.
- **Per-Session Forum Topics**: Group sessions cleanly in Telegram Supergroups with forum topics enabled.
- **Zero Internet Attack Surface**: Interactive turns communicate with the notification daemon via local loopback WebSockets (`127.0.0.1`). Only the daemon reaches outbound to `api.telegram.org`.
- **Singleton Process Safety**: Enforced via PID + start-time lock files to prevent multiple long-pollers on the same bot token.

---

## 1. Create Your Telegram Bot

1. Open Telegram and search for the official [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the instructions:
   - Provide a friendly name (e.g., `My Jeo Agent`).
   - Provide a unique username ending in `bot` (e.g., `my_jeo_agent_bot`).
3. BotFather will provide an HTTP API token:
   ```
   Use this token to access the HTTP API:
   1234567890:ABCdef_YOUR_BOT_TOKEN_HERE
   ```
4. Keep this token private.

---

## 2. Pairing with jeo (`jeo notify setup`)

### Interactive Pairing (Recommended)

Run the interactive setup command in your terminal:
```bash
jeo notify setup
```

The CLI will prompt you:
```
=== jeo notify setup (Telegram) ===
Create a bot with @BotFather (https://core.telegram.org/bots/features#botfather), then paste its token below.

Telegram BotFather token: 1234567890:ABCdef_YOUR_BOT_TOKEN_HERE
Bot verified: @my_jeo_agent_bot

Message @my_jeo_agent_bot from your Telegram account now (any text). Waiting...
```

Open Telegram, send any message (e.g. `hi`) to `@my_jeo_agent_bot`. The setup tool detects your chat and pairs it automatically:
```
Paired private chat id 987654321.

Notifications enabled. botToken=1234567890:ABC...xyZ chatId=987654321
Start the daemon with 'jeo daemon start', then run a detached subagent (task {detached:true}) to see it appear in Telegram.
```

### Non-Interactive Pairing (CI / Scripted)

If you already know your chat ID, pair without terminal prompts:
```bash
jeo notify setup --token "1234567890:ABCdef_YOUR_BOT_TOKEN_HERE" --chat-id "987654321"
```

### Check Notification Status

Inspect the current configuration and daemon state:
```bash
jeo notify status
```
Output:
```text
enabled=true
botToken=1234567890:ABC...xyZ
chatId=987654321
```

---

## 3. Daemon Lifecycle Management

The Telegram daemon runs as a single background worker per machine.

| Command | Action | Description |
| :--- | :--- | :--- |
| `jeo daemon start` | Start daemon | Spawns a background process and acquires `<jeoHome>/notifications/daemon.lock`. |
| `jeo daemon status` | Inspect state | Shows PID, start timestamp, and verified owner status. Detects stale locks. |
| `jeo daemon stop` | Graceful stop | Sends `SIGTERM` to the verified daemon PID and cleans up the lock file. |
| `jeo daemon reload` | Refresh | Gracefully stops the current daemon and restarts with the latest config. |

### Example Lifecycle:
```bash
$ jeo daemon start
daemon started (pid 41209)

$ jeo daemon status
running (pid 41209, started 2026-06-14T08:30:00.000Z)

$ jeo daemon stop
daemon stopped (pid 41209)
```

---

## 4. Remote Control Commands

All inbound Telegram messages are strictly authorized to your paired `chatId`. Unauthorized messages from any other Telegram user are silently discarded.

| Telegram Command | Arguments | Description |
| :--- | :--- | :--- |
| `/subagents` | *(none)* | Lists all currently active and recently finished subagents across all live sessions. |
| `/steer` | `<sessionId> <subagentId> <message>` | Injects live steering instructions directly into the specified running subagent turn. |
| `/cancel` | `<sessionId> <subagentId>` | Immediately requests cancellation of the targeted subagent task. |
| `/help` | *(none)* | Displays the command syntax reference and active options. |

### Inline Keyboard Action
When a subagent starts, `jeo` sends an alert with an attached inline keyboard button:
```
[🚀 subagent started]
ID: sub_4b8f1e
Goal: Refactor database connection pool
---------------------------------------
[ ⏹ Cancel Subagent ]
```
Tapping **Cancel Subagent** immediately emits a `callback_query` to the daemon, stopping the task without typing any command.

---

## 5. Supergroup Forum Topics & Per-Session Mirroring

If you run multiple long-running tasks or coordinate across projects, you can direct alerts to a Telegram Supergroup with **Forum Topics** enabled.

### Static Topic Routing
Set a default forum topic ID:
```json
{
  "notifications": {
    "enabled": true,
    "telegram": {
      "botToken": "1234567890:ABC...",
      "chatId": "-1001234567890",
      "topicId": 42
    }
  }
}
```

### Dynamic Per-Session Topics (`perSessionTopics`)
Enable automatic creation of a dedicated forum topic for each `jeo` session:
```json
{
  "notifications": {
    "enabled": true,
    "telegram": {
      "botToken": "1234567890:ABC...",
      "chatId": "-1001234567890",
      "perSessionTopics": true
    }
  }
}
```

When enabled:
1. `jeo` creates a dedicated topic named after your active project and goal.
2. The interactive turn stream (`turn_stream` frames formatted as clean Telegram HTML) streams directly into that topic.
3. Replying directly to messages in that topic forwards your text as a `user_message` to steer the agent!
4. In-thread settings commands can be used on the fly:
   - `/verbose` or `/verbosity verbose` — Deliver detailed tool call arguments and raw outputs.
   - `/lean` or `/verbosity lean` — Deliver compact summaries only.
   - `/redact on|off` — Mask sensitive file paths and keys in delivered messages.

---

## 6. Image & Artifact Delivery

When a subagent captures a screenshot (e.g. via browser tools) or produces an image artifact:
1. The session pushes a `{ type: "photo", path: "/path/to/screenshot.png" }` frame.
2. The daemon converts it to Telegram's `sendPhoto` API.
3. The image renders directly in your Telegram chat with an accompanying caption and action buttons.

---

## 7. Rate Limiting & Reliability

Telegram enforces strict rate limits (e.g. ~30 messages/second global, ~1 message/second per chat).
`jeo` implements a built-in `RateLimitPool`:
- **Token Bucket Algorithm**: Smooths message bursts.
- **Priority Queuing**: `ask` (human intervention needed) > `finalized` (task completed) > `live` (status update) > `idle`.
- **Coalescing**: Unsent intermediate progress frames coalesce so you never receive delayed spam.
- **Exponential Backoff**: Transient Telegram API failures or network drops double backoff intervals from 1s up to 10s maximum.

---

## 8. Configuration File Reference

Global configuration lives at `~/.jeo/config.json`:

```json
{
  "notifications": {
    "enabled": true,
    "telegram": {
      "botToken": "1234567890:ABCdef_YOUR_BOT_TOKEN_HERE",
      "chatId": "987654321",
      "topicId": 105,
      "perSessionTopics": false
    }
  }
}
```

---

## 9. Troubleshooting

### `Telegram getMe failed: invalid token`
- Verify that you copied the complete token from `@BotFather` without trailing spaces.
- Test manually with `curl https://api.telegram.org/bot<TOKEN>/getMe`.

### `stale — a lock file exists but its pid is dead`
- This occurs if your machine rebooted or the previous process was forcefully killed (`SIGKILL`).
- Simply run `jeo daemon start`. `jeo` automatically reclaims the stale lock.

### `Timed out waiting for a private message`
- You must send a direct message to the bot username from your personal account within 120 seconds of running `jeo notify setup`.
- Make sure you clicked **Start** or sent a non-empty text message.

### Messages not sending in non-interactive / CI runs
- In version 0.11.1+, non-interactive runs (`jeo -p "..."` or scripts) gracefully detach notification connections upon exit and never hang.
