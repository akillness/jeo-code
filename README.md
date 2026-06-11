<p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

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

A Bun-based AI coding-agent CLI. Run `jeo` inside a repository and it reads files, edits them, runs commands, and drives the task to completion.
While it works, the live turn renders as a gjc-style flat inline stack: completed work flushes into scrollback as glyph-led `✓/✗` ledger lines and bordered tool cards (bash is a single merged card — `✗ Bash` title, `$ command` echo, an `Output` divider, the output body, and a trailing `Command exited with code N`; read/find/search stay single-line `✓ Read path:lines`), followed by one spinner status line showing the real in-flight target plus compact turn stats (step · elapsed · tokens · live `$` cost), the `Todos` checklist, a `◆ hud` line, and a bg-tinted model status bar (model (provider) · thinking / `branch ?N` dirty flag / cwd · output-token rate `⤴ N/s` · `ctx%`); assistant replies render GFM tables as box-drawn tables, and typing `/` in the input box (`> Type your message...`, theme-accent border, model bar pinned above) reveals a command preview below (with an `(i/total)` position counter).

The status line shows **what it is actually doing right now** (the in-flight file/command, the active plan step, plan progress, and during rate-limit backoff a `rate limited (HTTP 429) — auto-retry #2 in 4s` countdown) together with the current step's elapsed time — instead of decorative text that churns every tick. The model's response **streams live**: its reasoning shows as a dim `💭` row while the JSON tool call forms, then flushes once into scrollback as a `jeo · …` line — press **Ctrl+O** to dump the full last response (untruncated, tables rendered) into scrollback as a detail view. The inline turn keeps the evolution identity to a single final `Evolved to: …` summary line (the ASCII art header remains in the legacy `JEO_TUI_ALT_SCREEN=1` boxed mode). Progress of **subagents delegated via `task`** (the assignment, `step N/M`, the real target of nested tool calls — `read src/x.ts`, `bash: …` — and the result summary) is streamed live, just like gjc.


**Clipboard image paste**: press **Ctrl+V** in the input box to attach a copied image (screenshot, browser right-click copy) to the next message — an `[image #N]` tag lands at the caret, the box shows a `⧉ N image(s) attached` hint, and the attachment is sent as real multimodal input on every provider (Anthropic content blocks, OpenAI data URLs, Codex `input_image`, Gemini/Antigravity `inlineData`, Ollama `images[]`). macOS uses `pngpaste` when installed (else an AppleScript fallback); Linux uses `wl-paste`/`xclip`. The input box itself renders with a two-tone depth cue — lit top/left edge, shaded bottom/right edge — so it reads as a raised panel instead of a flat outline.

**Two-tone panel depth**: every bordered panel — the JEO forge welcome box, the live status box, tool/forge cards, the outer alt-screen frame, and the input box — renders with a lit top/left edge (theme accent) against a shaded bottom/right edge (dimmed accent), with bold titles for contrast, so boxes read as raised panels instead of flat outlines.

**Defaults follow your latest pick, in every session**: choosing a model or provider (`/model …`, `/provider <name> …`, pickers) persists immediately to `~/.joc/config.json` — the newest pick becomes `defaultModel` for every future session and `recentModels` keeps the MRU rotation (newest first) that `/model` lists back to you.
Running a one-shot request as a command argument — `jeo "request"` — still brings up the same live TUI on a TTY; in `--no-tui`/pipe mode the `[step N/M] <tool target>` plus result lines are streamed so the full flow stays visible.

The TUI renders the live turn **inline in the main terminal buffer** (gjc-style): each completed progress line (tool result, subagent event, reasoning) and each finished tool card is flushed into normal scrollback as it happens, so **tmux / terminal mouse-wheel can scroll back through earlier progress mid-turn** while the compact live frame keeps repainting at the bottom. Erases are line-by-line (`ESC[2K`, never a scrollback-flooding `ESC[0J`) and each flush+repaint is wrapped in a **DECSET 2026 synchronized update** so there is no flicker; `JEO_TUI_ALT_SCREEN=1` reverts to the legacy scroll-isolated alt-screen turn. Width math is **CJK/emoji-aware** end to end, so wide-character input and boxes never overflow their borders. The stream/tool list is a **fixed-size ring buffer**, so memory and per-frame render cost stay flat across long sessions (even if the summarizer LLM fails, history is compacted deterministically — with tokenizer-accurate budgeting — and never grows unbounded). When the screen is too short to fit every section, the live frame is clipped from the top so the **status line, Todos, hud, and model bar are always visible**.

Forge boxes are bordered, so they are shown **only when a whole box fits** (most-recent first) and never rendered as half a box.

## Install

Requirement: Bun `1.3.14+`

```bash
bun install -g jeo-code
```

Verify the install:

```bash
jeo --version
```

## Basic usage

```bash
# Run the interactive coding agent
jeo

# Run a single request immediately
jeo "Tidy up the README and run the tests"

# Check current config and model connectivity (probed via the real call path: Anthropic=GET /v1/models, OpenAI OAuth=Codex backend, Gemini OAuth=Cloud Code Assist loadCodeAssist)
jeo doctor

# Configure API keys / OAuth / local models
jeo setup
```

## Interactive slash commands

Commands available in the `jeo` REPL input box (`<Tab>` autocompletion supported).

| Command | Description |
| --- | --- |
| `/model [id\|#N\|save]` | Set the model (live `#N` selection · fuzzy match). **Every pick persists automatically** — the newest selection becomes the default for all future sessions, and `recentModels` keeps the newest-first rotation (`/model` with no args shows it). `save` remains as an explicit alias |
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
jeo launch --list
jeo launch --resume

# Run inside a tmux session — an independent session per run (launching several times in the same dir/branch splits into base, base-2, base-3 …)
jeo --tmux
jeo --tmux --model gemini-2.5-flash --thinking high
jeo --tmux --models --catalog gpt

# Run in a separate worktree
jeo --tmux --worktree ../jeo-work

# List models
jeo models

# GJC-style model catalog (static capability)
jeo --list-models=gemini
jeo --models --catalog gpt

# Specify model/provider/thinking budget on launch
jeo --model gemini-2.5-flash --thinking high "Analyze this code"
jeo --provider gemini --plan "Draft an implementation plan"
# Slash-command palette
# Typing a prefix like "/" or "/m" in the REPL lists commands/options by category.
# Subagent setup is supported via /agents and /model subagent <role> ...

# Auth management
jeo auth login anthropic
jeo auth status
```

## Spec-first workflow

Use this to clarify requirements first, then plan, execute, and verify. The stages are carried through state (`.joc/state/`) and gated: deep-interview first **confirms the top-level topology**, preserves the input language (Korean/English/Japanese/Chinese) when writing questions, evaluations and acceptance criteria, and for brownfield requests collects **repo markers + path evidence**; then it must **freeze the seed** (ambiguity ≤ 20%; `--auto`/non-TTY cannot bypass this gate, and the seed is not frozen if the bar is not met) before MutationGuard allows code edits and ralplan proceeds → ralplan builds an **approval-pending** plan via **Planner→Architect→Critic consensus** (a 3-stage chained pass, with schema self-validation/repair) → it must be approved with `jeo approve <plan>` → team executes (corrupt team state is rejected rather than ignored, unknown subagent roles are rejected before execution, identical task names are routed to the correct role by step index, and execution stops immediately if a planner/architect/critic report breaks its contract or architect returns `BLOCK`/`REQUEST CHANGES` or critic returns `[REJECT]`/`[ITERATE]`) → ultragoal verifies the team execution.

```bash
jeo deep-interview "Describe the feature you want to build"
jeo ralplan
jeo approve <plan-path>
jeo team
jeo ultragoal
```

## Using local models

With Ollama you can run locally without an API key.

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor
jeo
```

## Configuration files

- Global config: `~/.joc/config.json`
- Model picks are MRU-persisted: `defaultModel` is always the newest selection, `recentModels` keeps up to 10 recent ids (newest first)
- Project state/sessions: `<project>/.joc/`

Key environment variables:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic        # TUI theme (cosmic/matrix/solar/red-claw/blue-crab/mono)
JEO_TUI_ALT_SCREEN=1        # Revert to the legacy alt-screen live turn (default: main-buffer inline + tmux wheel scrollback)
JEO_STEP_BASE=24            # Dynamic step budget: rolling base (the `step N/M` seed)
JEO_STEP_EXTENSIONS=2       # Bound extensions per turn (default: unlimited while progressing; 0 = legacy fixed counter)
JEO_STEP_EXTENSION_SIZE=10  # Steps granted per extension (default: half the base, min 4)
JEO_STEP_HARD_CAP=75        # Absolute step ceiling (default: 600 — a termination guarantee, not a task stop)
JEO_STEP_WINDOW=8           # Recent tool-call window scored for progress
JEO_TMUX_MOUSE=0            # Opt out of tmux mouse mode in jeo-owned sessions (default on: wheel-up enters copy-mode over real scrollback)
JEO_TMUX_PROFILE=0          # Opt out of the extra tmux profile (clipboard integration + readable copy-mode selection)
```

```jsonc
{
  "retry": {
    "requestMaxRetries": 4,
    "streamMaxRetries": 2,
    "maxDelayMs": 8000,
    "rateLimitRetries": 6,
    "rateLimitMinDelayMs": 2000,
    "failFastStatuses": [503],
    "failFastPatterns": ["model not found", "context length exceeded"]
  }
}
```

### Step budget (dynamic retry flow)

A turn's step limit is a flexible **budget**, not a hardcoded counter. By default the budget is **dynamic**: it starts from a rolling base (`JEO_STEP_BASE`, default 24) and keeps extending itself for as long as the recent tool-call window shows real, novel progress (≥ 50% of recent calls succeeding, ≥ 2 distinct targets, and at least one never-seen call since the last extension) — there is no fixed per-task stop; `JEO_STEP_HARD_CAP` (default 600) exists only as a termination guarantee against pathological spins. Each extension leaves a `↻ step budget extended to M` ledger line and updates the live `step N/M` denominator. A stalled window (mostly failures, or cycling through already-seen calls) declines the extension and the loop **consolidates** instead: one final no-tools model call wraps up what was accomplished, the key findings, and what remains — with the refusal reason named in the message. Passing an explicit `--max-steps N` restores the bounded flow (base N + capped extensions). The existing guards (3× identical call, 5 consecutive failures, parse-bounce salvage) are unchanged, and subagent delegation (`task`, `jeo team`) keeps an exact step contract — extensions are disabled there and the parent owns retries.

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as `NPM_TOKEN`.
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.
