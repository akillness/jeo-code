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
- **Multi-provider, one loop** — Anthropic / OpenAI (+Codex) / Gemini / Antigravity / Ollama / LM Studio, plus 20+ OpenAI- and Anthropic-compatible clouds (Groq, DeepSeek, Mistral, OpenRouter, xAI, Kimi, z.ai, …), all behind one uniform JSON tool loop — **plus any endpoint you register yourself**: `jeo provider add --id my-proxy --base-url https://…` (or `--preset litellm|vllm|sglang|azure-openai|…`) gives a LiteLLM proxy, a self-hosted vLLM box or a corporate Anthropic gateway its own routing prefix, model list and credential, instead of hijacking the built-in `openai` provider. OAuth login happens from the input box (`/provider login`), every model pick persists as the new default, and prompt routing only auto-selects usable credentialed paths: Gemini OAuth goes through the provider-qualified `antigravity/*` agent set **as the account currently serves it** (live-discovered — e.g. Gemini 3.6 Flash tiers, Gemini 3.1 Pro, Claude Sonnet/Opus 4.6; non-chat and deprecated ids filtered out, no static-catalog stand-in when the list is empty), never public `google/gemini-*` rows that require `GEMINI_API_KEY`; if a configured route points at an unready provider, jeo switches to an equivalent credentialed tier model before falling back to the default.

- **Edit integrity** — read output carries content anchors (`42ab|`); anchored edits are verified against the current file, re-mapped when lines shifted, and rejected with fresh content instead of corrupting.
- **Self-correcting verification loop** — configure a post-edit hook (tsc / eslint / tests) and the agent *sees* the diagnostics and fixes them in-loop; a red hook blocks `done` until resolved.
- **Real gates, no theater** — `ralplan` consensus is a repo-grounded critic subagent whose `[OKAY]` verdict is persisted and *required* by `jeo approve`; `ultragoal` reports honestly (a suite run is a global signal, never fabricated per-criterion passes).
- **Crash-durable, local-first** — all state under `.jeo/` with atomic writes, cross-process run locks, failed-task markers with partial-edit warnings on resume.
- **Dynamic step budget** — turns extend while the tool window shows novel progress and consolidate gracefully when stalled; subagents keep exact step contracts.
- **Inline TUI** — completed work flushes into real scrollback (tmux wheel works mid-turn), the normal query input box stays visible and editable while the agent runs, Ctrl+O toggles full detail, themes, clipboard image paste (Ctrl+V), CJK/emoji-safe width math.
- **Browser tool** — headless Chromium automation (Playwright) as a first-class agent tool: `open`/`close`/`run`/`act` on named, reused tabs, with `observe`-tagged element ids preferred over screenshots for driving pages. `act {verb:"verify", goal, ...}` closes the visual-QA loop: screenshots the page and asks an independent vision-capable model to judge it against a plain-language goal (`{verdict:"PASS"|"MISMATCH", detail}`) instead of requiring a human (or the same agent) to eyeball a saved PNG. Requires `npx playwright install chromium` once (not bundled — jeo stays zero native deps itself, the browser binary is Playwright's separate download).
- **Skills that compound** — a stalled turn now writes the dead end into the SAME skill's project-level file (`.jeo/skills/<name>.md`, seeded from the bundled skill on first write, deterministic keyword match, no LLM), so the next session's `$<skill>` invocation carries accumulated "Known Failure Modes"/"Anti-Patterns" knowledge instead of the bundled doc staying static forever. `jeo skills lesson <skill> <failure|anti-pattern> "<title>" "<detail>"` for manual entries; `jeo skills eval <skill>` runs a real LLM judgment on whether each recorded lesson is still covered by the skill's current guidance or has gone stale.
- **Cheap-tier grader routing** — the `/goal` verifier, the `critic` subagent role, and unpinned `task` fan-out batches default to a cheap credentialed model instead of silently riding the same full-price model as the work they're grading/executing (`resolveVerifierModel`, vision-capability-filtered for the browser `verify` action so a text-only cheap model never silently drops an attached screenshot).
- **`jeo routine init`** — generates a GitHub Actions workflow that runs jeo headlessly (`jeo "<prompt>" -p`) on a schedule/issue/PR trigger, on GitHub's own runners — no laptop required, and zero new attack surface inside jeo itself (no in-process scheduler or webhook listener). `--dry-run` to preview, `--no-pr` for a direct commit instead of the default PR-per-run.
- **Remote monitoring & control (Telegram, Discord, Slack)** — pair a bot once (`jeo notify setup --provider telegram|discord|slack`), then one shared `jeo daemon start` pushes a message on every subagent state edge (started → done/failed/cancelled) across every live session and accepts `/subagents`, `/steer`, `/cancel` (plus `/sessions` and `/send` on Discord/Slack) back from a human allowlist. Telegram adds forum topics, inline keyboards, and image attachments; Discord uses REST + Gateway WebSocket; Slack uses Web API + Socket Mode. Every remote control is acknowledged by the local session, never assumed executed.
- **Gates that cannot be talked around** — `approve` re-validates the exact plan digest it is approving and `team` refuses a plan whose reviewed digest changed; a `done` call is re-checked against the latest verification evidence (a later failed check invalidates an earlier pass, three correction bounces then a hard rejection); the `autopilot` ratchet records a failed rollback as `rollback_failed` and halts non-zero instead of claiming a reverted step.
- **Session-scoped async execution** — fan out independent work through the `task` tool's real `tasks` array without blocking the parent turn; detached subagents, background jobs, and line monitors remain controllable from later turns with `subagent`/`job`/`monitor` actions (`list`, `inspect`, `await`, `cancel`, `tail`). The inline TUI keeps each worker's live activity in its own slot and tears down every registry on session exit or Ctrl-C.
- **Independent verifier, actually enforced** — a plan can no longer skip its architect/critic step: `PlanSchema` rejects any plan that ends with an unverified mutation (a verifier placed BEFORE the mutation it should check doesn't count either), at both `ralplan` draft time and `team`/`approve` execution time. Every architect/critic verdict must also show real evidence — zero observed `read`/`search`/`find`/`ast_grep`/`lsp` calls blocks the verdict regardless of what the text claims.
- **Safety-boundary automatic model fallback** — an uncategorized safety refusal (a possible classifier false positive, not a genuine content-policy hit) now switches to a genuinely different-provider model instead of backing off forever on the same one — mirrors the existing rate-limit fast-fallback. A `Refusal (<category>)`-shaped deterministic hit is untouched and still hard-fails with zero fallback.
- **Memory: earned confidence** — a concept's verification date is now written only when a distillation pass is explicitly marked verified, not on every write; `isConceptStale` treats an unverified (or >30-day-stale) concept as needing re-verification instead of trusting a passive timestamp.
- **Dynamic Workflows (`eval` tool)** — write real JS control flow around subagent dispatch: `task(role, taskText, context?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, and `log(message)`, composing sequential/branching orchestration that `task`'s single-stage `tasks[]` batch can't express. Runs in an isolated Worker thread with a genuinely preemptive timeout (`worker.terminate()`, not a same-process race) — same full-process trust as `bash`, no sandbox pretense, gated by the same interview mutation lock.
- **Quiet exit on a broken output pipe** — piping jeo into a command that stops reading early (`jeo --help | head`, a vanished remote peer) no longer dumps a raw `EPIPE` stack; it exits quietly with the same code (141) a shell reports for any SIGPIPE-killed pipeline producer. A genuine crash is unaffected and still surfaces clearly.
- **macOS low file-descriptor-limit warning** — a low `ulimit -n` (BSD's 256/1024 default) risks opaque `EMFILE` failures from file watching, the browser tool, or a broad repo scan; jeo now warns once at launch (stderr only, never piped `-p` output) with concrete `ulimit`/`launchctl` guidance. Opt out with `JEO_SKIP_NOFILE_CHECK=1`.


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
| `/provider add` · `list` · `remove` · `presets` | Register OpenAI/Anthropic-compatible endpoints as first-class providers (15 gateway presets) |
| `/agents [role]` · `/subagent` | Per-role (executor/planner/architect/critic) model · thinking · step config |
| `/thinking [level]` | Show/set default reasoning budget (low…xhigh) |
| `/route [status\|on\|off\|why\|history [n]]` | Toggle prompt-based model routing for this session · explain the last routing decision · `history [n]` lists the last n (default 10) routing decisions this session (auto-routes each turn to a tier-appropriate model among the models your configured credentials — OAuth or API key — actually serve, and switches to an equivalent tier model when a configured route is unready) |
| `/fast [on\|off\|status]` | Toggle fast thinking mode when the active model advertises low reasoning |
| `/skill` · `$<skill> [intent]` | List/run workflow skills (`$team "task"` style) |
| `/view` · `/diff` · `/find` · `/search` | Code view, git diff, file/pattern search |
| `/computer [status\|on\|off]` | Toggle the fail-closed desktop-automation tool for this session |
| `/new` · `/sessions` | Start a fresh session or list saved sessions |
| `/resume [id\|gajae:<session-id>[#<leaf>]] [--any-cwd]` | Resume a Jeo session or import a read-only exact-version GJC v5 branch into a fresh Jeo session |
| `/changelog [--full]` · `/jobs [list\|tail\|await\|cancel]` | Show release notes · inspect, await, or cancel this session's background jobs |
| `/history [n\|all]` · `/export` | Reprint readable worked activity history into scrollback · transcript export |
| `/retry` · `/btw <q>` | Retry last request · side question without touching history |
| `/usage` · `/context` · `/compact` | Token usage, context breakdown, manual compaction |
| `/theme` · `/config` · `/help` | Theme, runtime config, help |

> [!CAUTION]
> **`/model <name>` locks routing for the rest of the session.** Prompt routing (`/route`) only re-evaluates per turn while no model is manually pinned. Picking a specific model via `/model <name>` freezes that choice — routing will *not* switch away from it again until you run `/model auto` (which clears the pin), or `/route on` (which *outranks* an active pin without clearing it — the pin reasserts itself the moment you run `/route off`). Missing a `roles.*` entry only guarantees a `defaultModel` fallback on the `standard` tier; the `high`/`complex` tiers otherwise scan for the strongest live-credentialed model, so they can still land on a different model each turn even when unconfigured. **Exception:** an Antigravity- or Gemini-OAuth-credentialed session re-exports Anthropic/Google/OpenAI models under one credential — `high`/`complex` there instead session-stably spread across one model per company (not necessarily the strongest), so the pick stays fixed for that session rather than varying turn to turn.

## CLI commands

`jeo --help` is the authoritative list; the ones you will reach for:

| Command | Purpose |
| --- | --- |
| `jeo [prompt] [--resume [id]] [--tmux] [--worktree <path>] [-p] [-q]` | Interactive agent (default); `-p`/`--print` for headless one-shot output, `--worktree` for an isolated sibling checkout |
| `jeo setup` · `jeo auth login\|logout\|refresh\|status [provider]` · `jeo doctor` | Providers, OAuth (PKCE) tokens with auto-refresh, live connectivity + stale-pin check |
| `jeo provider list\|add\|remove\|presets\|test` | Named custom OpenAI/Anthropic-compatible providers (same planners as `/provider`) |
| `jeo deep-interview` → `ralplan` → `approve` → `team` → `ultragoal` | Spec-first workflow (see below); `jeo state <skill> read\|write\|clear\|handoff` inspects the receipts |
| `jeo notify setup\|status\|health\|test` · `jeo daemon start\|stop\|status\|reload` | Telegram / Discord / Slack notifications and the shared control daemon |
| `jeo autopilot <subcommand>` · `jeo ledger <subcommand>` | Autonomous build loop with a score ratchet (`status` shows direction, keep/revert counts, next action) · cross-plan append-only ledger |
| `jeo routine init …` | Generate a GitHub Actions workflow that runs jeo headlessly on a schedule or repo event |
| `jeo skills list\|read\|sync\|lesson\|eval` | Bundled, user, and project skills; drift check; recorded lessons |
| `jeo mcp serve\|tools` · `jeo computer <action>` | MCP stdio server for external controllers · desktop automation actions |
| `jeo session list\|attach\|rm` · `jeo export [id]` · `jeo chat "<msg>"` | tmux session management · transcript export · tool-less streaming chat |
| `jeo update [--check]` · `jeo whats-new` · `jeo memory-migrate` | Self-update from npm · bundled release notes · legacy `MEMORY.md` → OKF bundle |

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

## Remote monitoring & control (Telegram, Discord & Slack)

Opt-in: one shared daemon watches every live `jeo` session on the machine and pushes a message on each **subagent state edge** (started → completed/failed/cancelled), plus the session identity header, turn start/finish summaries, and the finalized turn text — never repeated "still running" pings. Allowlisted humans can list, send, steer, and cancel from the chat; every control is relayed to the local session and reported as **acknowledged (accepted, not completed)** or **not acknowledged** — the daemon never claims a command ran.

```bash
jeo notify setup  [--provider telegram|discord|slack] [--token-env NAME] [--app-token-env NAME] [--chat-id ID | --channel-id ID] [--allowed-user-ids ID,ID,...]
jeo notify status [--provider …]   # masked token, destination, allowlist, daemon state (stopped / stale / initializing / initialized / pairing)
jeo notify health [--provider …]   # read-only: bot identity + destination access, nothing sent
jeo notify test   [--provider …]   # sends one real test message
jeo daemon start|stop|status|reload   # the shared daemon has no provider selector
```

| | Telegram (default) | Discord | Slack |
| --- | --- | --- | --- |
| Credentials | bot token (`JEO_TELEGRAM_BOT_TOKEN` or `--token-env`) | bot token (`JEO_DISCORD_BOT_TOKEN` or `--token-env`) + **Message Content** intent | bot `xoxb` token (`JEO_SLACK_BOT_TOKEN` or `--token-env`) + app `xapp` token (`SLACK_APP_TOKEN` or `--app-token-env`), Socket Mode enabled |
| Destination | private chat via challenge pairing (send the displayed `/start jeo_<code>` to the bot within 120 s) or explicit `--chat-id`; groups need `--allowed-user-ids` | explicit `--channel-id` (text channel, DM, announcement, or an existing thread) | explicit `--channel-id` (`C…`) the bot has joined; workspace is pinned to the token's team |
| Allowlist | optional for a private chat, required for groups | required (human user IDs; bots are ignored) | required (human user IDs) |
| Transport | direct Bot API `getUpdates` long-poll, one poll owner per bot token | REST for sends, Gateway WebSocket for inbound | Web API for sends, Socket Mode WebSocket for inbound |
| Extras | forum topics, inline cancel buttons, image attachments, optional per-session topics (`notifications.telegram.perSessionTopics`, private chat with Threaded Mode only) | reply to a session notification to send that session text (24 h) | reply in a session notification's thread to send that session text (24 h); registered Slack slash commands or `@bot /command` both work |
| Commands | `/subagents` `/steer <session> <subagent> <msg>` `/cancel <session> <subagent>` `/help` | `/sessions` `/subagents` `/send <session> <text>` `/steer …` `/cancel …` `/help` | same as Discord |

What the words mean, because they are not interchangeable:

- **Setup** validates bot identity and destination access with the official API (Telegram `getMe`, Discord bot + channel lookup, Slack `auth.test`/`bots.info`/`conversations.info` and a Socket Mode URL) and stores the result in `~/.jeo/config.json` under `notifications.<provider>` — **plaintext**; keep that file private. It does not send a message and does not open a socket.
- **`initialized`** (`jeo daemon status`) means the daemon process owns its lock and has started its transports; it is not proof of a successful Telegram poll, Discord Gateway handshake, or Slack Socket Mode connection. Use `notify health` / `notify test` for that.
- **Changing a token or destination** resets the allowlist for Discord and Slack (you must pass `--allowed-user-ids` again) and the per-session topic map for Telegram; re-running setup with the exact same credentials and destination keeps them.
- **Remote commands are literal text** (`/subagents`, …) authorized to the configured chat/channel and allowlist; Slack additionally accepts the same names as registered slash commands. Allowlisted operators effectively hold the local agent's capabilities — treat the list as a trust boundary.
- **Retries are bounded per provider**: Telegram honours a 429 `retry_after` cooldown (clamped 1 s–1 h) with separate poll backoff; Discord and Slack retry at most 3 times on 429 using the server's `Retry-After`, and never re-send a POST whose outcome is unknown (the platform may already have it).
- **Orphan recovery**: if a daemon crashes, its lock becomes `stale`; the next `jeo daemon start` reclaims it. `jeo daemon stop` refuses to signal a recycled PID when the host can report process start times, and says so when it cannot.
- **Verified so far**: Telegram end to end (real send, polling, clean shutdown). Discord and Slack are implemented behind the same daemon with offline transport/wiring tests and code, security, and type reviews; live connectivity has not been exercised against real bot/app credentials.

```
┌─────────────────────┐        ┌──────────────────┐        ┌───────────────────────────┐
│   interactive turn  │◄──ws──►│  notify daemon   │◄──────►│ Telegram Bot API (poll)   │
│  SubagentRegistry   │  (one  │   (singleton)    │        │ Discord REST + Gateway WS │
│  session endpoint   │  per   │                  │        │ Slack Web API + Socket WS │
└─────────────────────┘ session└──────────────────┘        └───────────────────────────┘
```

## Routines (GitHub Actions)

```bash
jeo routine init --trigger schedule --cron "0 7 * * *" --prompt "Re-run the eval suite and post a digest" --dry-run
jeo routine init --trigger issues --prompt "Triage this issue" --name "issue-triage"
```

Generates a GitHub Actions workflow (`.github/workflows/<name>.yml`) that installs jeo and runs it headlessly (`jeo "<prompt>" -p`) on `schedule` / `issues` / `pull_request` — always paired with `workflow_dispatch` for a manual test run — on GitHub's own hosted runners. This is jeo's "runs without your laptop" story: no in-process scheduler, no webhook listener, no code-exec sandbox inside jeo itself — GitHub's infrastructure does the triggering, jeo just runs its existing headless mode. Defaults to opening a PR with any changes (`peter-evans/create-pull-request`, a safe no-op when the diff is empty); `--no-pr` commits directly to the triggering branch instead. `--dry-run` prints the YAML without writing it; re-running `jeo routine init` at the same `--out` path refuses to overwrite without `--force`. Set the `ANTHROPIC_API_KEY` (or `--api-key-env <VAR>`) repo secret before the workflow's first real run.

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

### Custom providers

```jsonc
{
  "customProviders": {
    "my-proxy": {
      "baseUrl": "https://gateway.internal/v1",
      "protocol": "openai",          // or "anthropic" (/v1/messages wire format)
      "apiKeyEnv": "MY_PROXY_API_KEY", // default: <ID>_API_KEY
      "models": ["fast", "smart"]      // offline pick-list; live /models supersedes it
    }
  }
}
```

Manage it from the shell (`jeo provider add|list|remove|presets|test`) or the input box
(`/provider add …`). `jeo provider test <id>` probes the endpoint and reports the
credential source and endpoint health *separately*, exiting non-zero on failure so
provisioning scripts can gate on it.

### Subagent fan-out concurrency

```jsonc
{ "subagentConcurrency": 2 }   // default 4, clamped to 1..16
```

Four concurrent Anthropic streams trip a Tier-1 rate limit immediately, turning a
fan-out into a backoff storm that is *slower* than running sequentially. Lower this on a
rate-limited account; raise it when the provider has headroom. It bounds both the `task`
tool's `tasks[]` batch and the `eval` tool's `parallel`/`pipeline` helpers.

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
- **[Unreleased]**
- **[0.11.3]** (2026-10-01) — Remote control grew from one Telegram bot into one shared daemon serving Telegram, Discord, and Slack — and the workflow gates that were meant to block unverified work (`approve`/`team` plan identity, `done` re-checks, the autopilot ratchet) now actually block it.
- **[0.11.2]** (2026-09-30) — OpenAI model pickers now follow the authenticated API and Codex catalogs, including subscription-only models, without hidden or stale entries.
- **[0.11.1]** (2026-08-25) — Every non-interactive `jeo` run hung forever once Telegram notifications were configured — `echo "..." | jeo`, `jeo -p "..."` in CI, any scripted use. The work completed and the command returned; the process just never exited.
- **[0.11.0]** (2026-08-25) — One bad boundary check was corrupting agent context, subagent fan-out, and the Telegram daemon's kill safety at the same time — and none of the three looked related from the outside.

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
