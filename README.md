<p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code (joc)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  A Bun-based AI coding-agent CLI — interviews, reviewed plans, tmux-native execution, durable verification.
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="zero native deps" src="https://img.shields.io/badge/native%20deps-0-blue?style=flat-square">
</p>

<p align="center">
  <img src="assets/character.png" alt="jeo-code character mascot" width="320" />
</p>

<p align="center">
  <b>English</b> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh.md">中文</a>
</p>

A Bun-based AI coding-agent CLI. Run `joc` inside a repository and it reads files, edits them, runs commands, and drives the task to completion.
While it works, a single screen shows the ASCII evolution art, the step timeline, tool forge boxes (bash/read/write/edit/task), and a live status footer; typing `/` in the input box reveals a command preview below.

The `[STEP] joc thinking` line shows **what it is actually doing right now** (the in-flight file/command, the active plan step, plan progress, and during rate-limit backoff a `rate limited (HTTP 429) — auto-retry #2 in 4s` countdown) together with the current step's elapsed time and the per-step average — instead of decorative text that churns every tick. The evolution-stage track is shown in exactly **one place each** (the center header and the footer tag) so copies never drift out of sync. Progress of **subagents delegated via `task`** (the assignment, `step N/M`, the real target of nested tool calls — `read src/x.ts`, `bash: …` — and the result summary) is streamed live, just like gjc.

Running a one-shot request as a command argument — `joc "request"` — still brings up the same live TUI on a TTY; in `--no-tui`/pipe mode the `[step N/M] <tool target>` plus result lines are streamed so the full flow stays visible.

The TUI uses a **differential renderer** that updates the screen in place without growing the scrollback (only one final record per turn); on a resize it repaints fully when the width changes and re-syncs the footer region even at an idle prompt. The stream/tool list is a **fixed-size ring buffer**, so memory and per-frame render cost stay flat across long sessions (even if the summarizer LLM fails, history is compacted deterministically and never grows unbounded), and the evolution art is cached per animation frame so it is not re-rendered every tick. When the screen is too short to fit every section, the **bottom status/key-hints/footer (the live progress: step · ETA · spinner) is always reserved first**, and lower-value content is shed in order (decorative ASCII art → forge detail boxes → stream) — the footer is never clipped off-screen.

Forge boxes are bordered, so they are shown **only when a whole box fits** (most-recent first) and never rendered as half a box.

## Install

Requirement: Bun `1.3.14+`

```bash
bun install -g jeo-code
```

Verify the install:

```bash
joc --version
```

## Basic usage

```bash
# Run the interactive coding agent
joc

# Run a single request immediately
joc "Tidy up the README and run the tests"

# Check current config and model connectivity (probed via the real call path: Anthropic=GET /v1/models, OpenAI OAuth=Codex backend, Gemini OAuth=Cloud Code Assist loadCodeAssist)
joc doctor

# Configure API keys / OAuth / local models
joc setup
```

## Interactive slash commands

Commands available in the `joc` REPL input box (`<Tab>` autocompletion supported).

| Command | Description |
| --- | --- |
| `/model [id\|#N\|save]` | Set the session model (live `#N` selection · fuzzy match · save as default; lists/status annotate the company — Anthropic/OpenAI/Google/Antigravity/Ollama) |
| `/models [refresh\|caps\|catalog]` | List logged-in OAuth/API models (+capability/catalog table) |
| `/provider [name] [model\|#N]` | Provider credentials/switching, and the provider's live model list (with company name) |
| `/provider login <name>` | **OAuth login straight from the input box** (anthropic/openai/gemini/antigravity; antigravity recommended, gemini as fallback) |
| `/login [name]` · `/logout <name>` | OAuth login alias (`/provider login`) · remove a stored OAuth token |
| `/agents [role] [model\|#N]` · `/agents <role> provider <name> [model]` · `/model subagent <role> [model\|#N]` | Set the model/provider for subagent roles (executor/planner/architect/critic) — applied to the current session's `task` delegation immediately on save; a role target can be prepared even while selecting a model |
| `/roles [tier model]` | Show/set model role tiers (smol/slow/plan) |
| `/thinking [level]` | Thinking budget (minimal/low/medium/high/xhigh) |
| `/config` | Show the current runtime configuration |
| `/skill [name [intent]]` · `$<skill> [intent]` · `/speckit.plan`, etc. | List/show/run workflow skills — call directly with **`$<skill>`** like `$team "task"` (Codex/gjc style, Tab autocompletion) (user SKILL.md runs **only on explicit invocation**) |
| `/view <file> [a-b]` · `/diff [file]` · `/find <glob>` · `/search <pat>` | Code view / git diff / file & pattern search |
| `/new` · `/drop` · `/session [info\|delete]` · `/rename <title>` · `/resume [id]` | Start/delete/info/rename/resume a session (gjc parity) |
| `/retry` · `/btw <question>` | Retry the last request · ask a side question without touching history |
| `/export [path] [json]` · `/dump` | Export the session transcript to a file · copy to clipboard |
| `/usage` · `/context` · `/tools` · `/hotkeys` | Cumulative token usage · context-token breakdown · exposed tool list · shortcuts |
| `/theme [name]` · `/settings` | TUI theme (cosmic/matrix/solar/red-claw/blue-crab/mono) · runtime settings (=`/config`) |
| `/sessions` · `/compact` · `/clear` · `/help` · `/exit` | Session/context management |

## Common commands

```bash
# View / resume saved sessions
joc launch --list
joc launch --resume

# Run inside a tmux session — an independent session per run (launching several times in the same dir/branch splits into base, base-2, base-3 …)
joc --tmux
joc --tmux --model gemini-2.5-flash --thinking high
joc --tmux --models --catalog gpt

# Run in a separate worktree
joc --tmux --worktree ../joc-work

# List models
joc models

# GJC-style model catalog (static capability)
joc --list-models=gemini
joc --models --catalog gpt

# Specify model/provider/thinking budget on launch
joc --model gemini-2.5-flash --thinking high "Analyze this code"
joc --provider gemini --plan "Draft an implementation plan"
# Slash-command palette
# Typing a prefix like "/" or "/m" in the REPL lists commands/options by category.
# Subagent setup is supported via /agents and /model subagent <role> ...

# Auth management
joc auth login anthropic
joc auth status
```

## Spec-first workflow

Use this to clarify requirements first, then plan, execute, and verify. The stages are carried through state (`.joc/state/`) and gated: deep-interview first **confirms the top-level topology**, preserves the input language (Korean/English/Japanese/Chinese) when writing questions, evaluations and acceptance criteria, and for brownfield requests collects **repo markers + path evidence**; then it must **freeze the seed** (ambiguity ≤ 20%; `--auto`/non-TTY cannot bypass this gate, and the seed is not frozen if the bar is not met) before MutationGuard allows code edits and ralplan proceeds → ralplan builds an **approval-pending** plan via **Planner→Architect→Critic consensus** (a 3-stage chained pass, with schema self-validation/repair) → it must be approved with `joc approve <plan>` → team executes (corrupt team state is rejected rather than ignored, unknown subagent roles are rejected before execution, identical task names are routed to the correct role by step index, and execution stops immediately if a planner/architect/critic report breaks its contract or architect returns `BLOCK`/`REQUEST CHANGES` or critic returns `[REJECT]`/`[ITERATE]`) → ultragoal verifies the team execution.

```bash
joc deep-interview "Describe the feature you want to build"
joc ralplan
joc approve <plan-path>
joc team
joc ultragoal
```

## Using local models

With Ollama you can run locally without an API key.

```bash
ollama pull qwen2.5:0.5b
export JOC_DEFAULT_MODEL=ollama/qwen2.5:0.5b
joc doctor
joc
```

## Configuration files

- Global config: `~/.joc/config.json`
- Project state/sessions: `<project>/.joc/`

Key environment variables:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JOC_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
JOC_TUI_THEME=cosmic        # TUI theme (cosmic/matrix/solar/red-claw/blue-crab/mono)
JOC_TUI_ALT_SCREEN=1        # Revert to the legacy alt-screen live turn (default: main-buffer inline + tmux wheel scrollback)
```

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as `NPM_TOKEN`.
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.
