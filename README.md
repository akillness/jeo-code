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
  <img src="assets/character.gif" alt="animated jeo-code red crayfish mascot" width="320" />
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

- **Multi-provider, one loop** — Anthropic / OpenAI (+Codex) / Gemini / Antigravity / Ollama / LM Studio, plus 20+ OpenAI- and Anthropic-compatible clouds (Groq, DeepSeek, Mistral, OpenRouter, xAI, Kimi, z.ai, …), all behind one uniform JSON tool loop. OAuth login from the input box (`/provider login`), every model pick persists as the new default.
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
| `/thinking [level]` | Show/set default reasoning budget (minimal…xhigh) |
| `/fast [on|off|status]` | Toggle fast thinking mode when the active model advertises minimal/low reasoning |
| `/skill` · `$<skill> [intent]` | List/run workflow skills (`$team "task"` style) |
| `/view` · `/diff` · `/find` · `/search` | Code view, git diff, file/pattern search |
| `/new` · `/resume` · `/sessions` | Session management |
| `/history [n|all]` · `/export` | Reprint readable worked activity history into scrollback · transcript export |
| `/retry` · `/btw <q>` | Retry last request · side question without touching history |
| `/usage` · `/context` · `/compact` | Token usage, context breakdown, manual compaction |
| `/theme` · `/config` · `/help` | Theme, runtime config, help |
| `jeo autopilot status` | Ratchet status field with score direction, keep/revert counts, and next action |

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
JEO_STREAM_MAX_MS=300000        # opt-in overall stream deadline (default off; bounds slow-drip streams)
JEO_STREAM_IDLE_MS=300000       # per-chunk idle cap (default 300s); raise for slow/local backends silent before first token
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
- **[0.7.48]** (2026-07-06) — gjc Telegram-daemon parity, phase 2 (follow-up to 0.7.37/0.7.38's baseline subagent-visibility daemon, which deliberately scoped OUT forum topics, inline keyboards, and image attachments — see that entry): the daemon now speaks gjc's richer notification surface instead of the plain-text-only baseline.
- **[0.7.47]** (2026-07-06) — PromptRouter (gjc-inspired, jeo-native design — NOT a port of katanemo/plano, whose always-on proxy-orchestrator architecture doesn't fit an interactive CLI's per-turn latency budget): jeo already had static, role-based model mapping (`resolveSubagentModel`/`resolveRoleModel`) but zero logic that varied the model by what THIS turn's prompt actually asks for. Adds an opt-in (default OFF), heuristic-first, fail-open per-turn router: a bilingual regex classifier scores a prompt into trivial/standard/complex, escalating to one cheap LLM call ONLY when the heuristic is genuinely ambiguous (confidence below a configurable threshold — most turns never escalate), and an explicit `/model` pin always wins over routing. No new plumbing: reuses `resolveRoleModel`, `callLlm`, `jsonMode`, `catalogMetadata`, `tryExtractJsonObject`, and the existing `onNotice` transparency pattern.
- **[0.7.46]** (2026-07-06) — Registry-only correction: `npm publish` packs the working-tree filesystem, not the git commit — a concurrent, unrelated, uncommitted feature-in-progress from another session sharing this checkout (`src/agent/prompt-router.ts`, `src/commands/launch/route-slash.ts`, and edits to `config-schema.ts`/`state.ts`/`launch.ts`/`slash.ts`) was physically present on disk during the 0.7.45 `npm publish` and got bundled into that tarball even though it was never committed to git and is absent from the `0.7.45` git tag/branch. Unpublished `jeo-code@0.7.45` from the registry within minutes (npm then permanently blocks republishing that exact version number, hence the bump to 0.7.46) and republished from a verified-clean working tree (`git stash` of the foreign files, `npm pack --dry-run` confirmed their absence, then restored the stash afterward so the other session's in-progress work was never touched or lost). No functional change versus the intended 0.7.45 content — see that entry below.
- **[0.7.45]** (2026-07-06) — gjc parity: jeo's subagent `task {tasks:[...]}` fan-out batches now visibly run as PARALLEL processes the way gjc's own task tool does, instead of quietly forcing the mutating executor role to serialize. Two compounding bugs made a batch of independent subagent tasks look and behave sequential even though the read-only roles were already technically concurrent: (1) the executor role's fan-out was hard-coded to concurrency 1 regardless of batch size, and (2) the TUI's live status line tracked ONE shared string clobbered by whichever worker's event landed last — worse, ANY single worker reaching "done" cleared the whole `(sub)` marker even while its siblings were still actively running.
- **[0.7.44]** (2026-07-06) — Root-caused a real production hang reported from `jeo`'s OpenAI Codex OAuth subagent path: after roughly 20-30 minutes of active streamed traffic, `chatgpt.com`'s backend severs the live SSE connection mid-response (an infra connection-duration cap, not a broken network) and Bun's fetch/undici surfaces it as `Error: The socket connection was closed unexpectedly …`. `retryableStream` (model-manager.ts) only auto-retries losing the FIRST streamed chunk — once any chunk had reached the caller it deliberately stopped retrying (a full re-call would replay already-emitted content) — so this class of drop propagated straight out of the engine as a raw, unretried turn-ending error every time, even though nothing had been committed to history yet and a plain resend is exactly as safe as a fresh call.

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
