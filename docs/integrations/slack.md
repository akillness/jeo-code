# Slack Integration & Block Kit Notifications

Connect `jeo` and AI coding agents to **Slack** workspaces for engineering team visibility, pull request announcements, subagent lifecycle cards, and threaded task discussions.

---

## Highlights

- **Enterprise Team Visibility**: Deliver structured agent status updates to `#engineering-alerts`, `#agent-runs`, or release channels.
- **Block Kit Visual Hierarchy**: Structured cards with clean markdown headers, metadata key-value grids, status badges, and action buttons.
- **Threaded Task Execution (`thread_ts`)**: Keep main channels uncluttered by threading all subagent updates under a single root turn announcement.
- **Dual Connection Modes**:
  1. **Incoming Webhook Mode (Push-only)**: Zero maintenance, instant setup for status reports and CI routines.
  2. **Slack App / Bot Token Mode (Bi-directional)**: Rich Slack API access, file uploads, thread replies, and Socket Mode interactions.

---

## 1. Quick Incoming Webhook Setup

Incoming Webhooks provide an authenticated HTTP URL that posts messages directly to a selected Slack channel.

### Step 1: Create a Slack App

1. Visit [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**.
2. Select **From scratch**.
3. Name your app (e.g. `jeo-agent`) and choose your Slack Workspace.

### Step 2: Enable Incoming Webhooks

1. Under the **Features** sidebar, click **Incoming Webhooks**.
2. Toggle the switch to **On**.
3. Scroll to the bottom and click **Add New Webhook to Workspace**.
4. Select the target channel (e.g. `#dev-agent-logs`) and click **Allow**.
5. Copy the generated Webhook URL:
   ```
   https://hooks.slack.com/services/YOUR_WORKSPACE_ID/YOUR_CHANNEL_ID/YOUR_SECRET_TOKEN
   ```

### Step 3: Configure Environment Variables

```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/YOUR_WORKSPACE_ID/YOUR_CHANNEL_ID/YOUR_SECRET_TOKEN"
```

### Step 4: Test Delivery

```bash
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"🦞 *jeo-code* notification channel successfully configured!"}' \
  "$SLACK_WEBHOOK_URL"
```

---

## 2. Rich Block Kit Formatting

Slack's [Block Kit](https://api.slack.com/block-kit) produces organized, responsive visual cards.

### Subagent Status Card Payload

Send a structured execution card with headers, field grids, and context footers:

```bash
curl -X POST -H 'Content-type: application/json' \
  --data '{
    "blocks": [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": "🚀 Subagent Commenced: Refactor Auth API",
          "emoji": true
        }
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "*Goal:* Migrate OAuth session token parsing to zero-copy buffer verification."
        }
      },
      {
        "type": "section",
        "fields": [
          { "type": "mrkdwn", "text": "*Session ID:*\n`sess_41a8fe`" },
          { "type": "mrkdwn", "text": "*Subagent ID:*\n`sub_09b2c1`" },
          { "type": "mrkdwn", "text": "*Model:*\n`claude-3-7-sonnet`" },
          { "type": "mrkdwn", "text": "*Target:* \n`src/auth/token.ts`" }
        ]
      },
      {
        "type": "divider"
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": "🦞 *jeo-code v0.11.1* • Host: `arm64-darwin` • Runtime: `Bun 1.3.14`"
          }
        ]
      }
    ]
  }' \
  "$SLACK_WEBHOOK_URL"
```

### Completed Task Card with Action Buttons

```bash
curl -X POST -H 'Content-type: application/json' \
  --data '{
    "blocks": [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": "✅ Autonomous Task Succeeded",
          "emoji": true
        }
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "All 18 unit tests passed. PR opened automatically on branch `feat/auth-zero-copy`."
        }
      },
      {
        "type": "actions",
        "elements": [
          {
            "type": "button",
            "text": { "type": "plain_text", "text": "View Pull Request ↗" },
            "url": "https://github.com/akillness/jeo-code/pull/48",
            "style": "primary"
          }
        ]
      }
    ]
  }' \
  "$SLACK_WEBHOOK_URL"
```

---

## 3. Slack App Bot Token Integration (`xoxb-...`)

When you need to upload generated test reports, post threaded updates, or listen for team replies:

### Step 1: Add OAuth Scopes

In your Slack App settings ([api.slack.com/apps](https://api.slack.com/apps)):
1. Navigate to **OAuth & Permissions** in the sidebar.
2. Scroll to **Bot Token Scopes** and add:
   - `chat:write` — Send messages as the bot.
   - `chat:write.public` — Send messages to public channels without being explicitly invited.
   - `files:write` — Upload test logs, images, and diff artifacts.
   - `channels:read` — Read channel names and IDs.

### Step 2: Install App to Workspace

1. Scroll to top of **OAuth & Permissions** and click **Install to Workspace**.
2. Authorize the application.
3. Copy the **Bot User OAuth Token** (starts with `xoxb-...`).

### Step 3: Invite Bot to Target Channel

In your Slack client:
```
/invite @jeo-agent
```

### Step 4: Post to a Specific Thread (`thread_ts`)

To keep channels organized, post your initial message and store its timestamp (`ts`), then post all subsequent tool calls and subagent updates as replies:

```bash
# 1. Post initial root message
ROOT_TS=$(curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C0123456789", "text": "Starting jeo task: Database Migration"}' \
  https://slack.com/api/chat.postMessage | jq -r .ts)

# 2. Post threaded subagent update
curl -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"C0123456789\", \"thread_ts\": \"$ROOT_TS\", \"text\": \"Subagent step 1/3 completed: Schema updated.\"}" \
  https://slack.com/api/chat.postMessage
```

---

## 4. GitHub Actions Routines Integration

When `jeo routine init` runs scheduled background tasks, report outcomes to Slack:

```yaml
name: jeo-routine-slack
on:
  schedule:
    - cron: '30 0 * * *'
  workflow_dispatch:

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: npm install -g jeo-code
      - name: Execute Routine
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          jeo "Audit open issues and generate triage report" -p > triage-report.md
      - name: Send Slack Report
        if: always()
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: |
          curl -X POST -H 'Content-type: application/json' \
            --data "{\"text\": \"📋 *jeo Routine Completed:* Triage pass finished with exit code $?.\"}" \
            "$SLACK_WEBHOOK_URL"
```

---

## 5. Troubleshooting

### `channel_not_found`
- The Bot has not been invited to the channel. Type `/invite @YourBotName` in the Slack channel.
- If using a private channel, verify the channel ID starts with `C` or `G`.

### `missing_scope`
- The Slack API token lacks permissions. Check the response body for `provided` vs `needed` scopes (e.g. `needed: ["chat:write"]`).
- Reinstall the Slack App after updating scopes.

### `invalid_blocks`
- Block Kit JSON contains an invalid structure, such as exceeding 50 blocks per message or having text fields longer than 3,000 characters.
- Test your payload in the [Slack Block Kit Builder](https://app.slack.com/block-kit-builder).

### `rate_limited`
- Slack enforces tier-based rate limits (typically ~1 request per second for `chat.postMessage`).
- Implement exponential backoff if handling high-volume turn streaming.
