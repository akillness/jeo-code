# Channel Notification Payload Templates

Reference payloads for Telegram HTML, Discord Embeds, and Slack Block Kit.

---

## 1. Telegram HTML Formatting

Telegram supports HTML parse mode (`parse_mode=HTML`).

### Supported Tags
- `<b>bold</b>`, `<strong>bold</strong>`
- `<i>italic</i>`, `<em>italic</em>`
- `<code>inline fixed-width code</code>`
- `<pre><code class="language-python">code block</code></pre>`
- `<a href="https://example.com">hyperlink</a>`

### Example
```html
<b>🚀 Task Started: Refactor Authentication</b>
<i>Repository:</i> <code>akillness/jeo-code</code>
<i>Branch:</i> <code>feat/oauth-refactor</code>

Subagent <code>sub_8a12</code> is executing the spec-first implementation loop.
```

---

## 2. Discord Embed JSON Schema

Discord embeds format cleanly in mobile and desktop clients.

### Decimal Colors
- Green (Success): `3066993` (`#2ECC71`)
- Red (Failure): `15158332` (`#E74C3C`)
- Blue (Running): `3447003` (`#3498DB`)
- Orange (Warning/Review): `15105570` (`#E67E22`)

### Example Embed Payload
```json
{
  "username": "jeo-code",
  "embeds": [
    {
      "title": "✅ Task Completed: Test Suite Green",
      "color": 3066993,
      "description": "All 32 tests passed without regression.",
      "fields": [
        { "name": "Branch", "value": "`main`", "inline": true },
        { "name": "Duration", "value": "2m 14s", "inline": true },
        { "name": "Pull Request", "value": "[#49 Open on GitHub](https://github.com/akillness/jeo-code/pull/49)", "inline": false }
      ],
      "footer": { "text": "jeo-code v0.11.1" },
      "timestamp": "2026-06-14T12:00:00.000Z"
    }
  ]
}
```

---

## 3. Slack Block Kit Schema

Slack Block Kit structures messages into modular UI blocks.

### Example Multi-Block Payload
```json
{
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "📋 Autonomous Task Report",
        "emoji": true
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Status:* ✅ *Succeeded*\n*Summary:* Refactored subagent communication protocol."
      }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Tests:*\n18 passed, 0 failed" },
        { "type": "mrkdwn", "text": "*Runtime:*\nBun 1.3.14 (mac-arm64)" }
      ]
    },
    {
      "type": "divider"
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "View Commit Diff" },
          "url": "https://github.com/akillness/jeo-code/commit/c64f062",
          "style": "primary"
        }
      ]
    }
  ]
}
```
