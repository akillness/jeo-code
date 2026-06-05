# jeo-code (`joc`)

[![Bun Version](https://img.shields.io/badge/Bun-%3E%3D%201.3.14-blue?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen)]()
[![Tests Status](https://img.shields.io/badge/Tests-306%20Passed-brightgreen)]()

> An interactive AI coding agent **and** a disciplined spec-first pipeline — one
> lean, pure-TypeScript CLI on Bun.
`jeo-code` is a single-package coding agent (binary `joc`) that you can use two ways:

- **Interactive agent** — run bare `joc` to chat with an agent that reads, writes,
  edits, and runs commands in a loop until your request is done (with a live TUI).
- **Spec-first pipeline** — `deep-interview → ralplan → team → ultragoal`: crystallize
  requirements before any code changes, plan, execute, then verify against acceptance criteria.

It re-implements the [`gajae-code`](https://github.com/Yeachan-Heo/gajae-code) (`gjc`)
workflow contract and adopts [`pi-mono`](https://github.com/badlogic/pi-mono) runtime
ergonomics (minimal tool loop, persistent sessions, compaction, project context) — with
**no native deps**: just Bun + TypeScript.

```text
joc                      →  interactive coding agent (TUI: live tools + status footer)

joc deep-interview → joc ralplan → joc approve → joc team → joc ultragoal
 (Socratic clarify)   (blueprint)    (gate)        (execute)   (verify)
        │
  [Mutation Lock] — file edits blocked until ambiguity ≤ 20%
```

---

## Quick start

Install `joc` the same way you install `gjc` — a single Bun global install — then
launch it from whatever repository you want it to operate on:

```bash
# 1. Install (gjc parity: one bun global install)
bun install -g jeo-code                                      # npm registry (once published)
bun install -g github:akillness/jeo-code                     # GitHub shorthand
bun install -g git+https://github.com/akillness/jeo-code.git # explicit Git URL
#   …or bootstrap Bun + install from the Git URL in one shot:
curl -fsSL https://raw.githubusercontent.com/akillness/jeo-code/main/scripts/install.sh | sh

# 2. Configure a provider + default model (interactive)
joc setup
#    …or go fully local with Ollama, no key:
ollama pull qwen2.5:0.5b
export JOC_DEFAULT_MODEL=ollama/qwen2.5:0.5b

# 3. Verify the setup is reachable
joc doctor

# 4. Launch from the target repo (gjc-style entrypoints)
joc                                   # interactive agent in the current checkout
joc --tmux                            # create/attach a joc-managed tmux session
joc --tmux --worktree ../joc-feature  # isolate work in a dedicated git worktree
joc "add a /health route to server.ts and run the tests"  # one-shot request
```

**Requirements:** Bun `v1.3.14+` (the installer auto-installs it if missing; the CLI re-checks at startup).

---

## Installation

`joc` installs exactly like `gjc`: a single Bun global install that registers the
`joc` binary in `~/.bun/bin`. The installer also drops a compatibility symlink at
`~/.local/bin/joc` and auto-installs Bun (enforcing the `1.3.14` floor) when it is missing.

```bash
bun install -g jeo-code                                      # npm registry (gjc parity, once published)
bun install -g github:akillness/jeo-code                     # GitHub shorthand
bun install -g git+https://github.com/akillness/jeo-code.git # explicit Git URL
sh scripts/install.sh --repo https://github.com/akillness/jeo-code.git
sh scripts/install.sh --ref v0.1.0                           # global install of a specific tag
sh scripts/install.sh --binary                               # compile a standalone binary (no bun at runtime)
sh scripts/uninstall.sh [--purge]                            # remove the bin + bun registry entry (--purge also wipes ~/.joc/)
```

### Registry-aware installs

`joc` does **not** mutate your npm registry by default. Use `--registry` for a one-shot
Bun install, and add `--persist-registry` only when you intentionally want the installer
to run `npm config set ...`.

```bash
# One-shot registry for this install only
sh scripts/install.sh --npm --registry https://registry.npmjs.org/
sh scripts/install.sh --npm --registry https://npmjs.co.kr
sh scripts/install.sh --npm --registry https://your-company-registry.com

# Persist globally via npm config (official registry restore / mirror / private)
sh scripts/install.sh --npm --registry https://registry.npmjs.org/ --persist-registry
sh scripts/install.sh --npm --registry https://npmjs.co.kr --persist-registry
sh scripts/install.sh --npm --registry https://your-company-registry.com --persist-registry

# Scope-only registry (writes @my-org:registry, not the global registry)
sh scripts/install.sh --npm --scope @my-org --registry https://your-company-registry.com --persist-registry

# Project-pinned .npmrc instead of global npm config
sh scripts/install.sh --npm --registry https://registry.npmjs.org/ --project-npmrc

# Inspect / reset npm registry config
sh scripts/install.sh --print-registry
sh scripts/install.sh --delete-registry
```

From a clone, `./install.sh` performs the dev install (`bun link`) so source edits
take effect immediately; `scripts/install.sh --help` lists every mode.

```bash
./install.sh                          # dev install from this clone (= scripts/install.sh --local)
```

Local dev without installing (from the repo root):

```bash
bun run start --help     # = bun src/cli.ts --help
bun run typecheck        # tsc -p tsconfig.json --noEmit
bun test                 # unit tests (54 files, 306 tests)
```

---

## Commands

| Command | What it does |
| --- | --- |
| `joc` / `joc launch ["request"]` | Interactive coding agent (TUI REPL, one-shot, or piped). `--tmux` (create/attach a joc tmux session), `--worktree <path>` (run in a dedicated git worktree), `--resume [id]`, `--list`, `--no-tui`, `--no-session`. |
| `joc setup` | Interactive provider/model picker (API key / browser OAuth / local), with live model probing. |
| `joc auth [login\|logout\|refresh\|status] [provider] [--token <bearer>]` | Real OAuth (PKCE) login + token storage with auto-refresh. |
| `joc doctor [--strict] [--json]` | Probe provider connectivity, credentials, and OAuth expiry; report if the default model is reachable. Colorized status on a TTY. `--strict` exits non-zero when it isn't; `--json` emits a machine-readable report for CI. |
| `joc deep-interview "<idea>" [--auto]` | Socratic requirements interview; freezes a spec when ambiguity ≤ 20%. `--auto` runs non-interactively (CI/pipes). |
| `joc ralplan` | Planner/Architect/Critic blueprint from the frozen seed. |
| `joc approve <plan-path>` | Approve the active plan blueprint; gates execution (`team` refuses to run until approved). Idempotent. |
| `joc team` | Per-task executor loop (shared tool engine) against the plan. |
| `joc ultragoal` | Verify acceptance criteria and write a report. |
| `joc models [name]` | List model aliases + probe local/OpenAI-compatible models for reachability. |
| `joc skills [name]` | List bundled workflow skills; `joc skills <name>` prints details. |
| `joc resume [id]` | Resume the latest interactive session (or a specific id). |
| `joc chat "<msg>"` | Single-shot streaming chat (no tools) — renders the reply token-by-token. |
| `joc mcp [serve\|tools]` | Run `joc` as an MCP stdio server (set `JOC_MCP_PIPELINE=1` to also expose the pipeline tools). |
| `joc evolve [--step N] [--max M] [--animate] [--loop N] [--theme cosmic\|matrix\|solar\|mono] [--gradient] [--ascii] [--fit] [--width W] [--list] [--list-themes] [--json] [--no-color]` | Preview the **evolution TUI** identity — five ASCII-art stages with track + stage meter. `--gradient` truecolor (256/16/plain downgrade), `--theme` palettes, `--ascii` legacy-terminal fallback, `--fit`/`--width` terminal sizing, `--list`/`--list-themes`/`--json` for tooling. |

---

## Interactive agent

Run bare `joc` (or `joc launch`) for a conversational coding agent built on a shared,
hardened tool-call engine (`src/agent/engine.ts`). It calls `read` / `write` / `edit` /
`bash` / `find` / `search` in a loop until it signals done.

- **TUI** — on a TTY it renders a differential UI (live tool-call list, `joc thinking`
  progress status, `joc forge` tool stats, and boxed previews for `bash` / `write` /
  `read` / `edit` calls); `--no-tui`, piped input, and non-TTY fall back to a
  plain `stream:complete` / `stream:error` event stream.
- **Evolution TUI** — the live view evolves with the agent's progress through five stages
  (**Primordial Cell → Double Helix → Tool User → AI Coding Agent → Singularity**). The ASCII
  art, spinner, progress meter, and footer track all advance in lockstep from one canonical
  stage model (`src/tui/components/evolution.ts`); `finish()` records `Evolved to: <stage>`.
  Preview it any time with `joc evolve` (try `--theme matrix --gradient --fit`). On a TTY the
  live frame **fills the terminal** — art centered to the width, footer pinned to the bottom row —
  and downgrades gracefully (truecolor→256→16→plain, unicode→ASCII) per terminal capability.
- **Sessions** — every turn is appended to `.joc/sessions/<id>.jsonl`; `joc launch --list`
  and `joc launch --resume [id]` resume past conversations.
- **tmux orchestration (gjc parity)** — `joc --tmux` creates/attaches a leader session named
  `joc-<branch>`; add `--worktree <path>` to run inside a dedicated git worktree (auto-created
  on a branch named after the path) so edits and evidence stay isolated from your main checkout.
- **Project context** — the prompt auto-loads the first of `JEO.md` / `AGENTS.md` /
  `.joc/context.md` / `CLAUDE.md`.
- **Compaction** — long conversations are summarized automatically to stay within the context window.
- **Progress guards** — if a (weak/local) model repeats the same tool call 3× or racks up 5
  consecutive tool failures without signalling done, the loop stops with a clear message instead of burning steps.
- **Token usage** — each turn prints a `(N in / M out tokens)` footer; all four provider
  adapters report usage in both blocking `call` and streaming modes.

```bash
joc                                   # REPL — slash cmds: /help /clear /model /sessions /exit
joc launch "fix the failing test"     # one-shot
echo "summarize src/agent" | joc      # piped / non-TTY (plain output)
joc launch --resume                   # resume the latest session (or --resume <uuid>)
joc --tmux                            # create/attach a joc-managed tmux session (named joc-<branch>)
joc --tmux --worktree ../joc-feature  # isolate edits/evidence in a dedicated git worktree
```

---

## Spec-first pipeline

Crystallize requirements before touching code. While a `deep-interview` is active, the
**MutationGuard** blocks code-mutating tools — `write`/`edit` outside `.joc/`, and `bash`
entirely — releasing once ambiguity ≤ 20%.

1. **`joc deep-interview "<idea>"`** — Socratic loop scoring ambiguity across Goal clarity,
   Constraint completeness, and Success/Acceptance criteria. Freezes a seed to
   `.joc/seeds/seed-<slug>.yaml`.
2. **`joc ralplan`** — multi-role (Planner/Architect/Critic) blueprint → `.joc/plans/plan-<slug>.yaml`.
3. **`joc approve <plan-path>`** — approval gate: marks the plan approved so `team` will execute it.
4. **`joc team`** — executes plan tasks via the shared tool engine; checkpoints to `.joc/state/team-state.json`.
5. **`joc ultragoal`** — runs acceptance checks and writes `.joc/state/ultragoal-report.md`.

---

## Providers, OAuth & local models

Routing is inferred from the model id; credentials resolve from `~/.joc/config.json` (or env).

| Provider | Model id example | Credential |
| --- | --- | --- |
| Anthropic | `claude-3-5-sonnet` | `ANTHROPIC_API_KEY` or OAuth (`ANTHROPIC_OAUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) |
| OpenAI | `gpt-4o` / `openai/<model>` | `OPENAI_API_KEY` or `OPENAI_OAUTH_TOKEN` |
| Gemini | `gemini-2.5-flash` | `GEMINI_API_KEY` or `GEMINI_OAUTH_TOKEN` |
| Ollama (local) | `ollama/qwen2.5:0.5b` | none — offline via `OLLAMA_HOST` (default `http://localhost:11434`) |
| OpenAI-compatible (LM Studio / vLLM / llama.cpp) | `openai/<model>` | optional key; set `openaiBaseUrl` / `OPENAI_BASE_URL` |

- **Real OAuth (PKCE):** `joc auth login <anthropic|openai|gemini>` opens the provider's
  authorize URL, runs a local callback server (Anthropic `:54545`, OpenAI `:1455`,
  Google `:8085`), exchanges the code, and stores `access` + `refresh` + `expires`. Tokens
  **auto-refresh** on expiry (single-flight); `joc auth refresh <provider>` forces it. On
  headless boxes, paste the redirect URL/code when prompted, or use
  `joc auth login <provider> --token <bearer>` for a manual (non-refreshing) token.
- **Compatibility:** OAuth beats API keys for the same provider, **except** the bundled
  adapters fall back to the API key when the OAuth flow isn't end-to-end compatible.
  Anthropic OAuth is verified e2e with the Messages adapter; OpenAI/Google OAuth tokens
  target the Codex / Cloud-Code-Assist backends, so the bundled chat / generativelanguage
  adapters prefer an API key (the CLI warns you up front).
- **Local/offline:** set `JOC_DEFAULT_MODEL=ollama/<model>` after `ollama pull <model>` — no
  key required. Any OpenAI-compatible endpoint works via `openaiBaseUrl`.

---

## Configuration

| What | Where |
| --- | --- |
| Global config | `~/.joc/config.json` (dir `0700`, file `0600`); override dir with `JOC_CONFIG_DIR` |
| Per-project runtime | `<cwd>/.joc/` → `seeds/`, `plans/`, `state/`, `sessions/` |

`config.json` fields: `providers`, `oauth`, `defaultModel`, `ollamaBaseUrl`, `openaiBaseUrl`,
`thinkingLevel`, `modelAliases`, `retry`. Env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, the `*_OAUTH_TOKEN` bearers, `OLLAMA_HOST`, `OPENAI_BASE_URL`,
`JOC_DEFAULT_MODEL`) fill gaps but never override on-disk values. Verify everything with `joc doctor`.

**Provider retry budgets (gjc parity).** `retry.requestMaxRetries` sets how many times a failed
provider request is retried (the initial request is not counted); `retry.maxDelayMs` caps the
exponential backoff. `retry.streamMaxRetries` / `retry.maxRetries` are accepted for gjc-config
compatibility. Retries apply only to transient failures (network errors, `408/425/429/5xx/529`),
honoring a server `Retry-After`; auth, bad-model, and malformed-request errors stay fail-fast.

```json
{ "defaultModel": "claude-3-5-sonnet", "retry": { "requestMaxRetries": 4, "maxDelayMs": 300000 } }
```

---

## Project structure

```text
jeo-code/
├── package.json               # name: jeo-code, bin: { joc: src/cli.ts }, bun scripts
├── tsconfig.json              # strict typecheck config
├── install.sh                 # top-level shim → scripts/install.sh --local
├── src/
│   ├── cli.ts                 # entry: Bun version guard + dispatch
│   ├── cli/runner.ts          # lazy command registry (bare joc → launch)
│   ├── commands/              # launch, setup, auth, deep-interview, ralplan, approve, team, ultragoal, doctor, mcp, models, skills, resume, chat
│   ├── agent/                 # engine (tool loop), loop, json, tools (+MutationGuard), session, compaction, context-files, state
│   ├── ai/                    # provider adapters (anthropic/openai/gemini/ollama) + model-manager
│   ├── auth/                  # storage (+auto-refresh), pkce, callback-server, refresh, flows/{anthropic,openai,google}
│   ├── mcp/                   # MCP protocol + tools + stdio server
│   └── tui/                   # differential renderer + components + LaunchTui
├── scripts/                   # install.sh / uninstall.sh (bun install + bun link)
├── test/                      # 54 suites (306 tests): oauth, engine, tools-fs, retry, config-schema, cli-runner, mutation-guard, approve, team-schema, session, compaction, streaming, evolution, ascii-art, footer, evolve, meter, install, model/provider picker, tui-*
├── docs/improvements.md       # architectural analysis & changelog (ralph passes)
├── plan/                      # long-horizon work plans (TUI, features, install, model, provider)
└── README.md
```

---

## Development

```bash
bun install                                  # deps: zod (config validation), chalk (doctor colors)
bun run typecheck                            # tsc -p tsconfig.json --noEmit
bun test                                     # full suite
GEMINI_OAUTH_CLIENT_SECRET=<x> bun test      # Google OAuth flow tests need this env var
```

Design lineage and the milestone roadmap (TUI, features, install, model config, provider)
live in [`plan/`](./plan/README.md); the running changelog is [`docs/improvements.md`](./docs/improvements.md).

## License

MIT.
