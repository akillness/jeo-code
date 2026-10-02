# Installing Channel Notifications as an Agent Skill

This guide explains how to install and invoke **Telegram**, **Discord**, and **Slack** notification capabilities as a standardized **Agent Skill** (`SKILL.md`) across **jeo**, **Claude Code**, **Cursor**, **Codex**, **OpenCode**, and other AI coding agent environments.

---

## What is an Agent Skill?

An Agent Skill follows the open [Agent Skills specification](https://agentskills.io). It packages domain instructions, execution workflows, and tool calling guidance in a portable `SKILL.md` document with structured YAML frontmatter.

When installed into your workspace or user directory, an AI coding agent:
1. Automatically discovers the skill in its context window.
2. Learns the required environment variables (`DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`).
3. Invokes notifications autonomously when significant events occur (e.g. subagent finished, tests broken, long refactoring complete, or pull request created).

---

## 1. Supported Agent Runtimes & Paths

`jeo-code` and other standard coding agents scan the following directory hierarchy (from lowest to highest precedence):

| Scope | Directory Path | Target Agents |
| :--- | :--- | :--- |
| **User Global** | `~/.agents/skills/<skill-name>/` | All standard Agent Skills tools |
| **User Global** | `~/.claude/skills/<skill-name>/` | Claude Code, jeo |
| **User Global** | `~/.jeo/skills/` | jeo-code native |
| **Project Local** | `<project>/.agents/skills/<skill-name>/` | Canonical project-scoped skills |
| **Project Local** | `<project>/.claude/skills/<skill-name>/` | Claude Code, Cursor, jeo |
| **Project Local** | `<project>/.jeo/skills/` | jeo-code project-scoped |

---

## 2. Installation Methods

### Method 1: Using the `skills` CLI (`npx skills add`)

The fastest way to install the `channel-notify` skill from this repository:

#### Install into current project:
```bash
npx skills add akillness/jeo-code --skill channel-notify
```

#### Install globally for all projects:
```bash
npx skills add akillness/jeo-code --skill channel-notify -g
```

### Method 2: Manual Copy / Git Submodule

If working offline or managing repo templates directly:

```bash
# In your target repository:
mkdir -p .agents/skills/channel-notify

# Copy from jeo-code repository:
cp -r /path/to/jeo-code/.agents/skills/channel-notify/* .agents/skills/channel-notify/
```

### Method 3: Syncing jeo's Bundled Skills (`jeo skills sync`)

`jeo` includes a built-in skill synchronizer that installs and updates bundled workflow skills to `~/.jeo/skills`:

```bash
# Check for missing or drifted skills:
jeo skills sync --check

# Install missing skills:
jeo skills sync

# Overwrite modified files to latest bundled versions:
jeo skills sync --force
```

---

## 3. Environment Configuration

The `channel-notify` skill inspects your environment variables to decide which channels to send alerts to:

```bash
# Telegram
export TELEGRAM_BOT_TOKEN="1234567890:ABCdef_YOUR_BOT_TOKEN_HERE"
export TELEGRAM_CHAT_ID="987654321"

# Discord
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."

# Slack
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
```

*Note: You only need to configure the channel(s) you wish to use. If a variable is missing, the skill skips that channel gracefully.*

---

## 4. How to Use the Skill

### A. Invoking from `jeo`

In interactive mode or one-shot mode:

```bash
# Direct one-shot invocation:
jeo $channel-notify "All 47 tests passed. Ready for review."

# In interactive TUI:
jeo
> $channel-notify Deploying preview build to staging
```

### B. Invoking from Claude Code

In Claude Code, skills appear as slash commands:

```
/channel-notify "Build #108 succeeded. PR: https://github.com/..."
```

### C. Autonomous Agent Invocations

You can instruct your agent in your initial prompt:

```text
jeo "Refactor the authentication handler. When tests pass and git diff is clean, use the channel-notify skill to notify the team on Slack and Discord."
```

The agent will read `.agents/skills/channel-notify/SKILL.md`, construct the proper JSON payload, and invoke the notification via bash/curl or native fetch!

---

## 5. Verification

To verify that your agent can discover the newly installed skill:

```bash
# In jeo:
jeo --help
# Look for 'channel-notify' under Configured skills.

# Or run jeo doctor:
jeo doctor
```
