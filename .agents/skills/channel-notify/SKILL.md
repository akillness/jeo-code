---
name: channel-notify
description: >
  Send task progress, subagent status, build alerts, or completion reports to
  Telegram, Discord, and Slack channels. Inspects TELEGRAM_BOT_TOKEN/CHAT_ID,
  DISCORD_WEBHOOK_URL, and SLACK_WEBHOOK_URL environment variables, formats
  appropriate cards/embeds/messages, and posts updates safely. Use when an agent
  finishes a critical task, fails a build, opens a pull request, or needs human review.
allowed-tools: Bash Read
argument-hint: "<message-or-status-summary>"
compatibility: "Cross-platform Agent Skill usable by jeo, Claude Code, Cursor, Codex, OpenCode"
metadata:
  author: "jeo-code"
  version: "1.0.0"
  tags: telegram, discord, slack, notifications, alerts, subagents, webhooks
---

# Channel Notification Skill (Telegram, Discord, Slack)

## User Input

```text
$ARGUMENTS
```

## Purpose

Deliver structured notifications, subagent milestones, build results, or review alerts to the user's configured team channels across **Telegram**, **Discord**, and **Slack**.

---

## Pre-Execution Check: Identify Configured Channels

Before sending, verify which notification targets are available in the current environment:

1. **Telegram**:
   - Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
   - Alternatively, inspect `~/.jeo/config.json` for `notifications.telegram.botToken` and `notifications.telegram.chatId`.
2. **Discord**:
   - Check `DISCORD_WEBHOOK_URL`.
3. **Slack**:
   - Check `SLACK_WEBHOOK_URL`.

*If none of these variables are set, inform the user with instructions on how to set at least one channel URL or token.*

---

## Notification Workflow

### 1. Formulate the Message Content

Structure the message into:
- **Title / Status**: `[Started]`, `[Success]`, `[Failed]`, or `[Needs Review]`
- **Summary**: Concise 1-3 line description of what changed or was accomplished
- **Metadata Fields**:
  - Repository / Project name
  - Git branch or commit SHA (if available)
  - Key modified files
  - Test outcomes (e.g. `18/18 tests passed`)
  - Pull Request URL (if created)

---

### 2. Deliver to Telegram

If Telegram credentials exist, send a clean HTML-formatted message via the Telegram Bot API:

```bash
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(node -e 'try{console.log(require(process.env.HOME+"/.jeo/config.json").notifications.telegram.botToken||"")}catch{console.log("")}')}"
CHAT_ID="${TELEGRAM_CHAT_ID:-$(node -e 'try{console.log(require(process.env.HOME+"/.jeo/config.json").notifications.telegram.chatId||"")}catch{console.log("")}')}"

if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
  TEXT="<b>🦞 jeo Agent Notification</b>%0A%0A$ARGUMENTS"
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "parse_mode=HTML" \
    -d "text=${TEXT}" > /dev/null
fi
```

---

### 3. Deliver to Discord

If `DISCORD_WEBHOOK_URL` is set, send a Discord Embed card:

```bash
if [ -n "$DISCORD_WEBHOOK_URL" ]; then
  PAYLOAD=$(cat <<EOF
{
  "username": "jeo-agent",
  "avatar_url": "https://raw.githubusercontent.com/akillness/jeo-code/main/assets/character-v2.png",
  "embeds": [
    {
      "title": "🦞 jeo Task Status Update",
      "description": $(echo "$ARGUMENTS" | jq -s -R .),
      "color": 3066993,
      "footer": { "text": "jeo-code • Agent Skills" },
      "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    }
  ]
}
EOF
)
  curl -s -H "Content-Type: application/json" -X POST -d "$PAYLOAD" "$DISCORD_WEBHOOK_URL" > /dev/null
fi
```

---

### 4. Deliver to Slack

If `SLACK_WEBHOOK_URL` is set, send a Slack Block Kit card:

```bash
if [ -n "$SLACK_WEBHOOK_URL" ]; then
  PAYLOAD=$(cat <<EOF
{
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "🦞 jeo Agent Notification",
        "emoji": true
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": $(echo "$ARGUMENTS" | jq -s -R .)
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "Reported by \`channel-notify\` Agent Skill"
        }
      ]
    }
  ]
}
EOF
)
  curl -s -X POST -H 'Content-type: application/json' -d "$PAYLOAD" "$SLACK_WEBHOOK_URL" > /dev/null
fi
```

---

## Output Expectations

When complete, output a brief confirmation listing:
- Which channel(s) were notified (Telegram, Discord, Slack)
- The exact message that was broadcast
- Any skipped channels due to missing configuration
