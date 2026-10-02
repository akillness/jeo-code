# Discord Integration & Webhook Notifications

Connect `jeo` and AI coding agents to **Discord** channels for real-time build notifications, subagent progress alerts, pull request reviews, and interactive team visibility.

---

## Highlights

- **Instant Channel Visibility**: Broadcast subagent lifecycle events to `#dev-alerts`, `#agent-runs`, or your team's dedicated Discord server.
- **Rich Embed Cards**: Color-coded status alerts (Green = Success, Red = Failed, Blue = Running) with execution metrics and file diff summaries.
- **Thread & Forum Support**: Group task runs into distinct Discord threads or forum channel topics automatically.
- **Two Flexible Integration Modes**:
  1. **Webhook Mode (Zero setup / push-only)**: Perfect for automated status broadcasts and CI routines.
  2. **Discord Bot App Mode (Interactive)**: For bi-directional chatting, slash commands, and approvals.

---

## 1. Quick Webhook Integration (Recommended)

Webhooks allow `jeo` and workflow scripts to send rich messages to a Discord channel without hosting a bot server.

### Step 1: Create a Discord Webhook

1. Open your Discord server and navigate to the desired channel (e.g. `#agent-logs`).
2. Click the **Gear icon (Edit Channel)** next to the channel name.
3. Select **Integrations** from the left sidebar, then click **Webhooks**.
4. Click **New Webhook**.
5. Customize the name (e.g., `jeo-agent`) and choose an avatar (you can use `assets/character-v2.png` from this repository).
6. Click **Copy Webhook URL**.

### Step 2: Configure Environment Variables

Add the webhook URL to your environment or `.env`:
```bash
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN"
```

### Step 3: Test Webhook Delivery

Send a test message using `curl`:
```bash
curl -H "Content-Type: application/json" \
  -X POST \
  -d '{"content": "🦞 **jeo** notification system connected successfully!"}' \
  "$DISCORD_WEBHOOK_URL"
```

---

## 2. Rich Embed Formatting

Discord embeds provide clean, readable cards for task updates.

### Subagent State Edge Notification

Here is an example payload representing a completed subagent run:

```bash
curl -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "username": "jeo-code",
    "avatar_url": "https://raw.githubusercontent.com/akillness/jeo-code/main/assets/character-v2.png",
    "embeds": [
      {
        "title": "✅ Subagent Completed: Database Migration",
        "description": "Refactored user schema to support multi-tenant isolation.",
        "color": 3066993,
        "fields": [
          { "name": "Session ID", "value": "`sess_9f2c14`", "inline": true },
          { "name": "Subagent ID", "value": "`sub_d48a12`", "inline": true },
          { "name": "Duration", "value": "1m 42s", "inline": true },
          { "name": "Files Changed", "value": "• `src/db/schema.ts`\n• `test/db.test.ts`", "inline": false }
        ],
        "footer": {
          "text": "jeo-code v0.11.1 • Spec-first Autonomous Agent"
        },
        "timestamp": "2026-06-14T08:45:00.000Z"
      }
    ]
  }' \
  "$DISCORD_WEBHOOK_URL"
```

### Recommended Status Color Codes

| State | Hex Code | Decimal Value | Meaning |
| :--- | :--- | :--- | :--- |
| **Running / Started** | `#3498DB` | `3447003` | Task commenced, turn active |
| **Success / Completed** | `#2ECC71` | `3066993` | All criteria satisfied, tests passed |
| **Failed / Error** | `#E74C3C` | `15158332` | Test failed, error thrown, aborted |
| **Cancelled** | `#95A5A6` | `9807270` | Manually cancelled by user/agent |

---

## 3. Dedicated Discord Bot App Setup

If you require two-way communication (e.g. asking for approval, reading feedback in Discord channels):

### Step 1: Create an Application in Discord Developer Portal

1. Visit the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and enter a name (e.g., `JeoAssistant`).
3. Navigate to the **Bot** tab on the left.
4. Click **Reset Token** to generate a new Bot Token. Copy and save it securely.
5. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** (required to read text messages for agent steering)

### Step 2: Invite Bot to Your Server

1. Navigate to **OAuth2** > **URL Generator**.
2. Select Scopes: `bot`, `applications.commands`.
3. Select Bot Permissions:
   - `Send Messages`
   - `Embed Links`
   - `Attach Files`
   - `Read Message History`
   - `Add Reactions`
4. Copy the generated URL, open it in your browser, and select your Discord server.

### Step 3: Configure Environment
```bash
export DISCORD_BOT_TOKEN="BotTokenGoesHere..."
export DISCORD_CHANNEL_ID="123456789012345678"
```

---

## 4. Discord Forum Channels & Automatic Threads

To avoid cluttering the main channel chat:

### Post to an Existing Thread
Append `?thread_id=<THREAD_ID>` to your webhook URL:
```bash
curl -H "Content-Type: application/json" \
  -X POST \
  -d '{"content": "New turn completed in this thread."}' \
  "${DISCORD_WEBHOOK_URL}?thread_id=112233445566778899"
```

### Automatically Create a Thread in a Forum Channel
If your Webhook points to a Forum Channel, supply `thread_name` in the payload:
```bash
curl -H "Content-Type: application/json" \
  -X POST \
  -d '{
    "thread_name": "Task: Refactor Auth API",
    "content": "Starting autonomous agent task run..."
  }' \
  "$DISCORD_WEBHOOK_URL"
```

---

## 5. Integrating with GitHub Actions Routines

When running `jeo routine init` for automated maintenance, report results to Discord:

```yaml
name: jeo-nightly-eval
on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:

jobs:
  run-agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - name: Install jeo
        run: npm install -g jeo-code
      - name: Run jeo evaluation
        id: agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          jeo "Run eval suite and check regression" -p > result.txt
      - name: Notify Discord
        if: always()
        env:
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
        run: |
          STATUS="${{ job.status }}"
          COLOR=$([ "$STATUS" = "success" ] && echo "3066993" || echo "15158332")
          curl -H "Content-Type: application/json" -X POST \
            -d "{\"embeds\":[{\"title\":\"jeo Nightly Eval: $STATUS\",\"color\":$COLOR,\"description\":\"Workflow completed on GitHub Actions.\"}]}" \
            "$DISCORD_WEBHOOK_URL"
```

---

## 6. Troubleshooting

### `HTTP 400 Bad Request`
- Check JSON structure. Discord requires valid JSON; unescaped newlines in `content` or `description` cause 400 errors.
- Ensure embed limits are respected: Title <= 256 characters, Description <= 4096 characters, Total <= 6000 characters.

### `HTTP 401 Unauthorized`
- Your Bot Token or Webhook URL has been revoked or contains a typo. Regenerate it in Discord settings.

### `HTTP 404 Not Found`
- The channel or webhook was deleted from the server. Check if the webhook still exists under Channel Settings > Integrations.

### `HTTP 429 Too Many Requests`
- Discord rate limits webhooks to 5 requests per 2 seconds per webhook.
- Check the `retry_after` response header before resending queued messages.
