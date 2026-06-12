<p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  A Bun-based AI coding-agent CLI — interviews, reviewed plans, gated execution, honest verification.
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

Run `jeo` inside a repository and it reads files, edits them, runs commands, and drives the task to completion — streaming every step live in an inline, scrollback-friendly TUI.

## Highlights

- **Multi-provider, one loop** — Anthropic / OpenAI (+Codex) / Gemini / Antigravity / Ollama behind a uniform JSON tool loop. OAuth login from the input box (`/provider login`), every model pick persists as the new default.
- **Edit integrity** — read output carries content anchors (`42ab|`); anchored edits are verified against the current file, re-mapped when lines shifted, and rejected with fresh content instead of corrupting.
- **Self-correcting verification loop** — configure a post-edit hook (tsc / eslint / tests) and the agent *sees* the diagnostics and fixes them in-loop; a red hook blocks `done` until resolved.
- **Real gates, no theater** — `ralplan` consensus is a repo-grounded critic subagent whose `[OKAY]` verdict is persisted and *required* by `jeo approve`; `ultragoal` reports honestly (a suite run is a global signal, never fabricated per-criterion passes).
- **Crash-durable, local-first** — all state under `.joc/` with atomic writes, cross-process run locks, failed-task markers with partial-edit warnings on resume.
- **Dynamic step budget** — turns extend while the tool window shows novel progress and consolidate gracefully when stalled; subagents keep exact step contracts.
- **Inline TUI** — completed work flushes into real scrollback (tmux wheel works mid-turn), live status shows the actual in-flight target, themes, clipboard image paste (Ctrl+V), CJK/emoji-safe width math.

## Install

Requires Bun `1.3.14+`.

```bash
bun install -g jeo-code
jeo --version
```

## Quick start

```bash
jeo                      # interactive agent in the current repo
jeo "Tidy the README and run the tests"   # one-shot request
jeo doctor               # config + live model connectivity check
jeo setup                # API keys / OAuth / local models
jeo --tmux               # run inside an isolated tmux session
```

## Slash commands

Inside the `jeo` REPL (Tab autocompletes; `/` opens the palette).

| Command | Description |
| --- | --- |
| `/model` · `/models` · `/provider` | Pick model/provider (3-step: model → apply-target → reasoning); picks persist |
| `/provider login <name>` · `/logout` | OAuth login/logout from the input box |
| `/agents [role]` · `/subagent` | Per-role (executor/planner/architect/critic) model · thinking · step config |
| `/thinking [level]` | Reasoning budget (minimal…xhigh) |
| `/skill` · `$<skill> [intent]` | List/run workflow skills (`$team "task"` style) |
| `/view` · `/diff` · `/find` · `/search` | Code view, git diff, file/pattern search |
| `/new` · `/resume` · `/sessions` · `/export` | Session management & transcript export |
| `/retry` · `/btw <q>` | Retry last request · side question without touching history |
| `/usage` · `/context` · `/compact` | Token usage, context breakdown, manual compaction |
| `/theme` · `/config` · `/help` | Theme, runtime config, help |

## Spec-first workflow

Requirements → plan → approval → execution → verification, carried through `.joc/state/` with **real, blocking gates** at every handoff:

```bash
jeo deep-interview "Describe what you want to build"
jeo ralplan
jeo approve <plan-path>
jeo team
jeo ultragoal
```

- **deep-interview** — Socratic loop with ambiguity scoring; freezes a seed only when criteria are concrete (vague-only criteria are refused) and the seed round-trips its own parser. A new idea never silently reuses a completed interview.
- **ralplan** — drafting passes plus a **repo-grounded critic subagent gate**: the critic reads the actual repository, must return `[OKAY]`/`[ITERATE]`/`[REJECT]`, and the verdict is persisted. Invalid plans (schema, unknown roles) are never marked complete.
- **approve** — validates the exact contract `team` executes (schema + roles) *and* requires the persisted `[OKAY]` consensus verdict.
- **team** — serial plan executor with a cross-process run lock, stale-plan reset, per-task subagent contracts, a parent-side mutation audit (a "completed" task with zero observed writes is flagged), and failed-task markers that warn about partial edits on resume.
- **ultragoal** — honest verification: the suite runs once as a global signal; criteria are recorded, never fabricated as individually passed.

## Verification hooks (self-correction)

Enable hooks once globally (`"hooks": { "enabled": true }` in `~/.joc/config.json`), then add a post-edit check per project; the agent sees failures and fixes them before it may call `done`:

```jsonc
// .joc/hooks.json
{
  "enabled": true,
  "hooks": [
    { "event": "post-turn", "match": { "tool": "edit|write" }, "run": "bun x tsc --noEmit" }
  ]
}
```

Non-zero hook output is appended to the tool result the model reads (deduped per batch); a still-red hook triggers a `done` pushback naming the hook.

## Local models

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor && jeo
```

## Configuration

- Global config: `~/.joc/config.json` (model picks are MRU-persisted)
- Project state/sessions: `<project>/.joc/`

```bash
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...           # e.g. ollama/qwen2.5:0.5b
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic            # cosmic/matrix/solar/red-claw/blue-crab/mono/aurora/synthwave/sakura
JEO_TUI_ALT_SCREEN=1            # legacy alt-screen turn (default: inline scrollback)
JEO_STEP_BASE=24                # dynamic step budget: rolling base
JEO_STEP_HARD_CAP=600           # absolute termination guarantee
JEO_STREAM_MAX_MS=300000        # opt-in overall stream deadline (default off; bounds slow-drip streams)
JEO_TOOL_OUTPUT_MAX=4000        # model-visible tool output cap (full output spills to artifacts)
```

Retry behavior is tunable via `retry` in `~/.joc/config.json` (`requestMaxRetries`, `streamMaxRetries`, `rateLimitRetries`, `failFastStatuses`, …). The step budget is dynamic by default — it extends while recent tool calls show novel progress and consolidates with a wrap-up when stalled; `--max-steps N` restores a bounded flow. Legacy `JOC_*` env names remain supported.

## Publishing

Required npm token permissions: a **Granular Access Token** stored as `NPM_TOKEN`, type **Automation**, with the package allowing the publish workflow to **bypass 2FA**.
