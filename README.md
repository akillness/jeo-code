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
  <img src="assets/character.gif" alt="animated jeo-code red crayfish mascot smart-routing a prompt to the cheapest provider and saving coins" width="320" />
  <img src="assets/character-v2.png" alt="jeo-code red crayfish mascot piloting the computer-use desktop-automation control panel while juggling prompt-routing provider nodes" width="320" />
</p>


<p align="center">
  <b>English</b> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh.md">中文</a>
</p>

Run `jeo` inside a repository and it reads files, edits them, runs commands, and drives the task to completion — streaming every step live in an inline, scrollback-friendly TUI.

## Documentation

📖 **[Usage guide](docs/usage-guide.md)** — install, TUI controls (↑ recall, Ctrl+O, `!` shell), slash commands, `/resume`, and the spec-first workflow, with a demo video.

<video src="https://raw.githubusercontent.com/akillness/jeo-code/main/docs/jeo-code-promo.mp4" controls muted playsinline width="100%"></video>

> Demo not playing inline? ▶ [Play / download the demo video](docs/jeo-code-promo.mp4).

## Highlights

- **Prompt routing (cost-aware, credential-aware)** — every turn can auto-route to a tier-appropriate model among only the providers your configured credentials actually serve (`/route [status|on|off|why|history]`), with a live equivalent-model fallback whenever a routed provider is rate-limited, unauthenticated, unreachable, or silently times out — see `/route why` for the last decision, `/route history` for the recent ones.
- **Computer use (desktop automation)** — a fail-closed `computer` tool (screenshot/click/type/scroll/drag/batch) gated by both a config flag and an independent kill-switch/heartbeat supervisor; toggle it for the current session with `/computer [status|on|off]` without touching `~/.jeo/config.json`.
- **Multi-provider, one loop** — Anthropic / OpenAI (+Codex) / Gemini / Antigravity / Ollama / LM Studio, plus 20+ OpenAI- and Anthropic-compatible clouds (Groq, DeepSeek, Mistral, OpenRouter, xAI, Kimi, z.ai, …), all behind one uniform JSON tool loop. OAuth login happens from the input box (`/provider login`), every model pick persists as the new default, and prompt routing only auto-selects usable credentialed paths: Gemini OAuth goes through the provider-qualified `antigravity/*` agent set (Gemini 3.5 Flash tiers, Gemini 3.1 Pro, Claude Sonnet/Opus 4.6), never public `google/gemini-*` rows that require `GEMINI_API_KEY`; if a configured route points at an unready provider, jeo switches to an equivalent credentialed tier model before falling back to the default.

- **Edit integrity** — read output carries content anchors (`42ab|`); anchored edits are verified against the current file, re-mapped when lines shifted, and rejected with fresh content instead of corrupting.
- **Self-correcting verification loop** — configure a post-edit hook (tsc / eslint / tests) and the agent *sees* the diagnostics and fixes them in-loop; a red hook blocks `done` until resolved.
- **Real gates, no theater** — `ralplan` consensus is a repo-grounded critic subagent whose `[OKAY]` verdict is persisted and *required* by `jeo approve`; `ultragoal` reports honestly (a suite run is a global signal, never fabricated per-criterion passes).
- **Crash-durable, local-first** — all state under `.jeo/` with atomic writes, cross-process run locks, failed-task markers with partial-edit warnings on resume.
- **Dynamic step budget** — turns extend while the tool window shows novel progress and consolidate gracefully when stalled; subagents keep exact step contracts.
- **Inline TUI** — completed work flushes into real scrollback (tmux wheel works mid-turn), the normal query input box stays visible and editable while the agent runs, Ctrl+O toggles full detail, themes, clipboard image paste (Ctrl+V), CJK/emoji-safe width math.
- **Browser tool** — headless Chromium automation (Playwright) as a first-class agent tool: `open`/`close`/`run`/`act` on named, reused tabs, with `observe`-tagged element ids preferred over screenshots for driving pages. Requires `npx playwright install chromium` once (not bundled — jeo stays zero native deps itself, the browser binary is Playwright's separate download).
- **Remote subagent visibility (Telegram)** — pair a bot once (`jeo notify setup`), then `jeo daemon start` pushes a message on every subagent state edge (started → done/failed/cancelled) and accepts `/subagents`, `/steer <id> <subagentId> <msg>`, `/cancel <id> <subagentId>` back. Telegram Daemon now supports full `gjc` parity, including forum topics, inline keyboards, and image attachments — commands are authorized to the paired chat only.


## Install

Requires Bun `1.3.14+`.

```bash
bun install -g jeo-code
jeo --version
```

> Upgrading from a pre-rename install? A stale `joc` binary (this project's old CLI name) is now auto-removed by `scripts/install.sh` / `scripts/uninstall.sh`; to remove it manually: `rm -f ~/.local/bin/joc ~/.bun/bin/joc`.

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
| `/model` · `/provider` | Pick model/provider; `/model` shows default/role badges, Ralph-style nested Set-as-role thinking choices, and the OpenAI Codex role preset in one flow |
| `/provider login <name>` · `/logout` | OAuth login/logout from the input box |
| `/agents [role]` · `/subagent` | Per-role (executor/planner/architect/critic) model · thinking · step config |
| `/thinking [level]` | Show/set default reasoning budget (low…xhigh) |
| `/route [status\|on\|off\|why\|history [n]]` | Toggle prompt-based model routing for this session · explain the last routing decision · `history [n]` lists the last n (default 10) routing decisions this session (auto-routes each turn to a tier-appropriate model among the models your configured credentials — OAuth or API key — actually serve, and switches to an equivalent tier model when a configured route is unready) |
| `/fast [on\|off\|status]` | Toggle fast thinking mode when the active model advertises low reasoning |
| `/skill` · `$<skill> [intent]` | List/run workflow skills (`$team "task"` style) |
| `/view` · `/diff` · `/find` · `/search` | Code view, git diff, file/pattern search |
| `/new` · `/resume` · `/sessions` | Session management |
| `/history [n\|all]` · `/export` | Reprint readable worked activity history into scrollback · transcript export |
| `/retry` · `/btw <q>` | Retry last request · side question without touching history |
| `/usage` · `/context` · `/compact` | Token usage, context breakdown, manual compaction |
| `/theme` · `/config` · `/help` | Theme, runtime config, help |
| `jeo autopilot status` | Ratchet status field with score direction, keep/revert counts, and next action |

> [!CAUTION]
> **`/model <name>` locks routing for the rest of the session.** Prompt routing (`/route`) only re-evaluates per turn while no model is manually pinned. Picking a specific model via `/model <name>` freezes that choice — routing will *not* switch away from it again until you run `/model auto` (which clears the pin), or `/route on` (which *outranks* an active pin without clearing it — the pin reasserts itself the moment you run `/route off`). Missing a `roles.*` entry only guarantees a `defaultModel` fallback on the `standard` tier; the `high`/`complex` tiers otherwise scan for the strongest live-credentialed model, so they can still land on a different model each turn even when unconfigured. **Exception:** an Antigravity- or Gemini-OAuth-credentialed session re-exports Anthropic/Google/OpenAI models under one credential — `high`/`complex` there instead session-stably spread across one model per company (not necessarily the strongest), so the pick stays fixed for that session rather than varying turn to turn.

## Spec-first workflow

Requirements → plan → approval → execution → verification, carried through `.jeo/state/` with **real, blocking gates** at every handoff:

```bash
jeo deep-interview "Describe what you want to build"
jeo ralplan
jeo approve <plan-path>
jeo team
jeo ultragoal
```

```
  ┌──────────────────────┐
  │   deep-interview     │  Socratic ambiguity gate · seed frozen when concrete
  └──────────┬───────────┘
             │ .jeo/state/<seed>.json
             ▼
  ┌──────────────────────┐
  │       ralplan        │  Draft + repo-grounded critic → [OKAY] persisted
  └──────────┬───────────┘
             │ requires [OKAY] verdict
             ▼
  ┌──────────────────────┐
  │       approve        │  Schema + roles + [OKAY] — unlocks execution
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │        team          │  Serial executor · run lock · mutation audit
  └──────────┬───────────┘
             │ all tasks done
             ▼
  ┌──────────────────────┐
  │      ultragoal       │  Honest verification — suite once, no fabrication
  └──────────────────────┘
```

- **deep-interview** — Socratic loop with ambiguity scoring; freezes a seed only when criteria are concrete (vague-only criteria are refused) and the seed round-trips its own parser. A new idea never silently reuses a completed interview.
- **ralplan** — drafting passes plus a **repo-grounded critic subagent gate**: the critic reads the actual repository, must return `[OKAY]`/`[ITERATE]`/`[REJECT]`, and the verdict is persisted. Invalid plans (schema, unknown roles) are never marked complete.
- **approve** — validates the exact contract `team` executes (schema + roles) *and* requires the persisted `[OKAY]` consensus verdict.
- **team** — serial plan executor with a cross-process run lock, stale-plan reset, per-task subagent contracts, a parent-side mutation audit (a "completed" task with zero observed writes is flagged), and failed-task markers that warn about partial edits on resume.
- **ultragoal** — honest verification: the suite runs once as a global signal; criteria are recorded, never fabricated as individually passed.

## Verification hooks (self-correction)

Enable hooks once globally (`"hooks": { "enabled": true }` in `~/.jeo/config.json`), then add a post-edit check per project; the agent sees failures and fixes them before it may call `done`:

```jsonc
// .jeo/hooks.json
{
  "enabled": true,
  "hooks": [
    { "event": "post-turn", "match": { "tool": "edit|write" }, "run": "bun x tsc --noEmit" }
  ]
}
```

Non-zero hook output is appended to the tool result the model reads (deduped per batch); a still-red hook triggers a `done` pushback naming the hook.

## Memory flow

`jeo` keeps a **local-first, distilled project memory** under `.jeo/memory/` (no remote backend, zero native deps). Past sessions are distilled into an [OKF](docs/okf_mem/) concept bundle, and the next session injects only the relevant, budget-bounded slice back into the system prompt — hardened as DATA, never as instructions. Disable everything with `JEO_NO_MEMORY=1`.

**Migration (`jeo memory-migrate`, one-shot · idempotent).** A legacy single-doc `MEMORY.md` is converted losslessly into the bundle: `## heading → type`, each bullet → a typed concept, indented lines → body; `index.md`/`log.md` are rebuilt and the original is renamed to `MEMORY.md.bak`. Re-running is a no-op once the bundle has concepts. **Rollback:** `JEO_MEMORY_LEGACY=1` ignores the bundle and reads `MEMORY.md`/`.bak` through the same injection-hardening (`JEO_NO_MEMORY=1` still wins over everything).
## Works beside your existing agent or bot

| Tool or bot | Recommended jeo command | Boundary |
| ----------- | ----------------------- | -------- |
| Codex CLI | `jeo --tmux --worktree <name>` or `jeo` | `--worktree` names a jeo-managed sibling git worktree (basename → new branch); for an existing path, `cd` there first. |
| Claude Code | `jeo --tmux` or `jeo --tmux --worktree <name>` | jeo does not become a Claude Code extension. |
| OpenCode | `jeo` or `jeo --tmux` | External-runner workflow only. |
| Claw Code | `jeo --tmux --worktree <name>` | jeo does not install into or replace Claw Code. |
| External controller / bot | `jeo mcp serve` (MCP stdio server) | External controllers drive jeo over the MCP tool contract, not scrollback scraping. |

`--worktree <name>` runs jeo in an isolated sibling git worktree (reused if the path exists, else created on a branch named after the basename) so risky or reviewable work never touches your main checkout. `jeo mcp serve` exposes jeo's tools to any MCP-capable controller over stdio (`jeo mcp tools` lists them). Add `-q`/`--quiet` (or `JEO_QUIET=1`) to suppress startup banners, the welcome animation, release notes, and resume hints so jeo runs cleanly beside another agent or is driven by a bot — `-p`/`--print` implies quiet.

## Remote monitoring & control (Telegram)

```bash
jeo notify setup        # pair a BotFather bot once (getMe verification + chat-id pairing)
jeo notify status       # masked token, paired chat id, daemon state
jeo daemon start        # spawn the singleton background daemon
jeo daemon status       # check whether it's running
jeo daemon stop         # SIGTERM it
```

```
┌─────────────────────┐        ┌─────────────────────┐         ┌─────────────────────┐
│   interactive turn  │◄──ws──►│    notify daemon    │◄─poll──►│     Telegram bot    │
│   SubagentRegistry  │        │     (singleton)     │         │    (paired chat)    │
└─────────────────────┘        └─────────────────────┘         └─────────────────────┘
```

Opt-in and lazy: nothing binds until `notifications.enabled` is set AND a detached subagent (`task {detached:true}`) actually runs. The daemon scans live session discovery files, connects a loopback WebSocket per session, and pushes a message only on a subagent state *edge* (started → completed/failed/cancelled) — never a repeated "still running" ping. Telegram Daemon now supports full `gjc` parity, including forum topics, inline keyboards, and image attachments. Inbound Telegram commands are authorized to the paired chat only; anything else is dropped silently.

| Command | Effect |
| --- | --- |
| `/subagents` | List running/recent subagents across every connected session |
| `/steer <sessionId> <subagentId> <message>` | Send a live message into a running subagent |
| `/cancel <sessionId> <subagentId>` | Cancel a running subagent |
| `/help` | Show the command reference |

## Local models

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor && jeo
```

## Configuration

- Global config: `~/.jeo/config.json` (model picks are MRU-persisted)
- Project state/sessions: `<project>/.jeo/`

```bash
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...           # e.g. ollama/qwen2.5:0.5b
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic            # cosmic/matrix/solar/red-claw/blue-crab/mono/aurora/synthwave/sakura/gruvbox-dark
JEO_TUI_ALT_SCREEN=1            # legacy alt-screen turn (default: inline scrollback)
JEO_STEP_BASE=24                # dynamic step budget: rolling base
JEO_STEP_HARD_CAP=600           # absolute termination guarantee
JEO_STREAM_MAX_MS=1800000       # overall stream deadline (default 30min; bounds slow-drip streams, not active ones); 0 disables
JEO_STREAM_IDLE_MS=300000       # per-chunk idle cap (default 300s); raise for slow/local backends silent before first token
JEO_CALL_TIMEOUT_MS=1800000     # non-streaming call wall cap (default 30min; compaction/subagents/goal-verify)
JEO_TURN_MAX_MS=1800000         # turn stall budget: max time WITHOUT tool progress (default 30min); 0 disables
JEO_TOOL_OUTPUT_MAX=4000        # model-visible tool output cap (full output spills to artifacts)
```

Retry behavior is tunable via `retry` in `~/.jeo/config.json` (`requestMaxRetries`, `streamMaxRetries`, `rateLimitRetries`, `failFastStatuses`, …). The step budget is dynamic by default — it extends while recent tool calls show novel progress and consolidates with a wrap-up when stalled; `--max-steps N` restores a bounded flow.

## Skill migration and bundled skill inspection

When moving a workflow into jeo, inspect the bundled defaults before installing or overwriting anything:

```bash
jeo skills list                 # bundled + user + project skills, with discovery dirs
jeo skills read ralplan         # print one skill's full SKILL.md
jeo skills sync --check         # report drift vs ~/.jeo/skills (non-zero exit on drift)
```

`jeo skills sync` installs the bundled workflow skills (deep-interview, deep-dive, ralplan, team, ultragoal) into `~/.jeo/skills` and **preserves existing local files by default** — a differing local copy is reported as `preserved`, never clobbered. If `--check` flags a missing or different file, compare it with `jeo skills read <name>` first; use `jeo skills sync --force` only when you intentionally want to replace local default workflow skill files. Target a different dir with a trailing path argument (or `JEO_CONFIG_DIR`), and add `--json` for the structured `SkillSyncResult`.

## Development

jeo is pure TypeScript on Bun with **zero native dependencies**, so the global `jeo` command can run this checkout's source directly — no build step, hot to every edit.

```bash
bun install
bun run dev:link            # symlink `jeo` -> <repo>/src/cli.ts into ~/.local/bin
bun run dev:doctor          # report whether global `jeo` runs this source (linked/drift/missing)
```

`dev:link` refuses to proceed if another `jeo` shadows the managed link earlier on `PATH` (override the destination with `JEO_DEV_LINK_DIR`) and runs a `--version` smoke test. `dev:doctor` exits non-zero when the resolved `jeo` is a compiled binary or an installed copy rather than this source. Run from source without linking via `bun src/cli.ts --help`. Bundled workflow skills live in source at `src/prompts/skills/<name>/SKILL.md`; verify with `bun run typecheck` and `bun test`.

## Publishing


CI publishes via `.github/workflows/npm-publish.yml` — triggered by a published GitHub release, or manually with `workflow_dispatch` (optional dry-run). The workflow typechecks, tests, verifies the token (`npm whoami`), then runs `npm publish --provenance`.

Required npm token permissions (repository secret `NPM_TOKEN`):

- A **Granular Access Token** with Read/Write access to the `jeo-code` package, or a classic **Automation** token
- "**bypass 2FA** for publishing" must be allowed — Automation tokens always bypass; granular tokens need the option enabled

## Acknowledgements

Huge thanks to [gajae-code](https://github.com/Yeachan-Heo/gajae-code) for the inspiration.

## Changelog

<!-- CHANGELOG:START (auto-generated from CHANGELOG.md — run `bun run changelog:sync`) -->
- **[0.8.21]** (2026-07-10) — "반영할꺼 같은방식으로 체크하고 배포까지" — a rescan of the working tree (after the prior audit pass) turned up 15 uncommitted files: 3 genuinely distinct features left unwired by a concurrent session, partially casualty of an earlier accidental `git checkout` incident this session (disclosed in the 0.8.20 entry above). Each was independently traced from its existing plumbing, wired to a real call site, tested, and one live-verified end-to-end over a real PTY before shipping.
- **[0.8.20]** (2026-07-10) — "모든 검증 다시 리뷰하고 변경사항 모두 체크해" — 4 fresh, skeptical subagents independently re-audited every change from v0.8.17-0.8.19 (bc8768f..92c6b7d) with zero trust in prior claims: a code-correctness auditor manually traced the Antigravity routing logic against the live catalog, a test-integrity auditor mutation-tested the new tests (confirmed each one genuinely fails when its fix is reverted) and ran the suite fresh, a live-behavior verifier re-reproduced all 4 behavioral claims from scratch with self-generated data (own session ids, own mock server, own HTTP status code), and a docs-accuracy auditor cross-checked every README/CHANGELOG claim against current code in isolated git worktrees. Verdict: all core logic and tests GENUINE/CONFIRMED CORRECT — but the audit surfaced 1 real doc staleness gap, 1 changelog count error, and 2 minor precision gaps, all fixed here.
- **[0.8.19]** (2026-07-09) — "프롬프트 라우팅에 안티그라비티 프로바이더의 경우, 안티그라비티용 소넷과 오퍼스도 3.5급으로 라우팅될수있도록해줘" — Antigravity re-exports 3 distinct model families (Anthropic Claude, Google Gemini, OpenAI GPT-OSS) behind one credential, structurally unlike every other provider. `high`/`complex` tier auto-select always resolved to Google's Gemini 3.5 rows: Anthropic's real 64,000-token output ceiling lost a same-thinking-tier tie to Google's 65,536 by a margin with no practical significance, and Gemini's 1M-token context further outranked Claude's real 200K window — so `antigravity/claude-sonnet-4-6`/`antigravity/claude-opus-4-6-thinking` were NEVER reachable through auto-select, even though both were already correctly `sizeClass`-tagged into the `high`/`complex` pools.
- **[0.8.18]** (2026-07-09) — "라우팅 매 프롬프트마다 변경되는지, route why 의도대로 동작하는지 검증하고 배포할게있는지 확인해줘" — 2 parallel subagents live-verified per-prompt routing + `/route why` (including the previously-only-unit-tested post-call equivalent-model fallback path, now reproduced against a real mock 500-error server) and audited a disconnected `RouteHistory` class shipped as incomplete scaffolding in 0.8.16/0.8.17 (class + 11 tests existed, but nothing ever called it — no `/route history` subcommand, no wiring into the turn loop). Live testing also surfaced one real bug: the TUI footer's model/provider label never updated after a mid-turn fallback, staying on the pre-fallback model for the rest of that turn's render even though the backend decision (`lastRouteDecision`) was already correct.
- **[0.8.17]** (2026-07-09) — "서브에이전트 이용해. 병렬루 부가 나머지모두 개선하고 검증후 배포까지하자" — a prior 4-way parallel subagent cross-verification pass found the README `[!CAUTION]` routing-lock block (added this session for "프롬프트 라우팅이 한번 정해지면 안바뀌는데?") was directionally correct but had 2 real inaccuracies, plus a concrete test-coverage gap: every existing pin/override regression test drove the lock via the `--model` CLI startup flag, never via typing `/model <name>` as an interactive slash command mid-session, and none proved persistence across 3+ consecutive turns.

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
