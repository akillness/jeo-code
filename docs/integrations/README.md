# Channel Integrations & Remote Control

Connect `jeo` and AI coding agents to **Telegram**, **Discord**, and **Slack** for real-time subagent monitoring, execution alerts, automated routine reports, and remote steering.

---

## Overview & Feature Matrix

| Feature | Telegram | Discord | Slack |
| :--- | :---: | :---: | :---: |
| **Primary Mechanism** | Built-in Singleton Daemon (`jeo daemon`) | Webhook / Discord Bot App | Incoming Webhook / Slack Bot App |
| **Subagent State Edge Alerts** | Native (Edge-triggered: start/done/fail/cancel) | Supported via Webhook / Agent Skill | Supported via Webhook / Agent Skill |
| **Interactive Turn Streaming** | Supported (HTML turn stream) | Supported (Embed messages) | Supported (Block Kit / Threads) |
| **Remote Agent Steering** | `/steer <sessionId> <subagentId> <msg>` | Supported via Bot / Agent Skill | Supported via Bot / Agent Skill |
| **Remote Subagent Cancellation** | Inline Button ⏹ / `/cancel` | Supported via Bot / Agent Skill | Supported via Interactive Buttons / Bot |
| **Subagent Discovery & Listing** | `/subagents` | Supported via Bot / Agent Skill | Supported via Bot / Agent Skill |
| **Forum Topics / Threads** | Forum Topics + Per-session topics | Forum Channels / Threads | Message Threads (`thread_ts`) |
| **Image & Artifact Relay** | Native (`sendPhoto` attachment relay) | Native (Embed attachments / URLs) | Native (`files.upload` / image blocks) |
| **Agent Skill Installation** | `channel-notify` skill | `channel-notify` skill | `channel-notify` skill |

---

## Quick Navigation

- [Telegram Integration Guide](telegram.md) — Built-in background daemon, interactive BotFather pairing, forum topics, and `/steer` commands.
- [Discord Integration Guide](discord.md) — Webhooks for instant channel updates, Discord Bot for bidirectional interactions, and embed formats.
- [Slack Integration Guide](slack.md) — Incoming Webhooks for workspace notifications, Slack App / Socket Mode for team collaboration, and Block Kit cards.
- [Agent Skills Installation Guide](agent-skills.md) — How to install Telegram/Discord/Slack capabilities as an Agent Skill into `jeo`, Claude Code, Cursor, Codex, and other AI agents via `npx skills add`.

---

## Architecture at a Glance

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AI Coding Agent (jeo)                           │
│                                                                        │
│  ┌─────────────────────────┐            ┌───────────────────────────┐  │
│  │   Interactive REPL      │            │     Detached Subagent     │  │
│  │   Turn Loop             │            │     Task Execution        │  │
│  └───────────┬─────────────┘            └─────────────┬─────────────┘  │
│              │ (WebSocket)                            │ (Discovery)    │
│              ▼                                        ▼                │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │             jeo Notification Subsystem (Loopback WS)             │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
└─────────────────────────────────────┼──────────────────────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
   ┌────────────────────┐   ┌───────────────────┐   ┌───────────────────┐
   │  Telegram Daemon   │   │  Discord Webhook  │   │   Slack Webhook   │
   │  (Singleton Poll)  │   │  / Bot Service    │   │   / Bot App       │
   └──────────┬─────────┘   └─────────┬─────────┘   └─────────┬─────────┘
              ▼                       ▼                       ▼
        Telegram Bot             Discord Server         Slack Workspace
     (Private/Forum DM)          (#dev-alerts)          (#agent-runs)
```

---

## 1. Telegram (Built-in Daemon)

`jeo` includes a zero-dependency, singleton background daemon for Telegram.

1. **Pair your bot**:
   ```bash
   jeo notify setup
   # Enter your BotFather token; send any message to your bot to pair.
   ```
2. **Start the daemon**:
   ```bash
   jeo daemon start
   jeo daemon status
   ```
3. **Control subagents from your phone**:
   - `/subagents` — List running and recent subagents across all sessions.
   - `/steer <sessionId> <subagentId> <message>` — Send guidance directly into a running subagent turn.
   - `/cancel <sessionId> <subagentId>` — Terminate a runaway task with an inline keyboard button.

See the [Telegram Integration Guide](telegram.md) for full configuration details including forum topics and rate-limit pools.

---

## 2. Discord (Webhooks & Bot)

Discord provides immediate team visibility through webhooks and rich embed cards.

1. **Quick Webhook Setup**:
   Create a Webhook in your Discord Channel Settings (`Integrations` > `Webhooks`), then export:
   ```bash
   export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
   ```
2. **Send test notification**:
   ```bash
   curl -H "Content-Type: application/json" \
     -d '{"content":"🚀 jeo subagent started: refactor-auth-flow"}' \
     "$DISCORD_WEBHOOK_URL"
   ```
3. **Use with Agent Skill**:
   Install the `channel-notify` skill to allow `jeo` and other agents to post progress and finished pull request links directly to Discord.

See the [Discord Integration Guide](discord.md) for bidirectional Discord Bot setup, embeds, and GitHub Actions routines.

---

## 3. Slack (Incoming Webhooks & Apps)

Slack connects coding agents directly to engineering team channels.

1. **Quick Incoming Webhook**:
   Enable Incoming Webhooks on your Slack App and export:
   ```bash
   export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
   ```
2. **Send structured Block Kit message**:
   ```bash
   curl -X POST -H 'Content-type: application/json' \
     --data '{"text":"✅ jeo task completed: all 47 tests passed."}' \
     "$SLACK_WEBHOOK_URL"
   ```
3. **Full Bot Integration**:
   Use OAuth Bot Token (`xoxb-...`) and Socket Mode for bi-directional thread discussions and approvals.

See the [Slack Integration Guide](slack.md) for Block Kit card templates, scopes, and interactive turn logging.

---

## 4. Install as an Agent Skill

All three channels can be packaged and consumed as an **Agent Skill** (`SKILL.md`) following the [Agent Skills standard](https://agentskills.io).

### Install into any agent repository:
```bash
# Using Vercel skills CLI
npx skills add akillness/jeo-code --skill channel-notify

# Or clone/copy directly into the standard directory:
mkdir -p .agents/skills/channel-notify
cp -r <jeo-code-path>/.agents/skills/channel-notify/* .agents/skills/channel-notify/
```

Once installed, coding agents like `jeo`, Claude Code, Cursor, and Codex will automatically detect the skill and invoke Telegram, Discord, or Slack notifications during workflows.

See the [Agent Skills Installation Guide](agent-skills.md) for detailed configuration.
