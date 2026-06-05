# jeo-code (`joc`)

[![Bun Version](https://img.shields.io/badge/Bun-%3E%3D%201.3.14-blue?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen)]()
[![Tests Status](https://img.shields.io/badge/Tests-79%20Passed-brightgreen)]()

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

joc deep-interview ──> joc ralplan ──> joc team ──> joc ultragoal
 (Socratic clarify)      (blueprint)    (execute)     (verify)
        │
  [Mutation Lock] — file edits blocked until ambiguity ≤ 20%
```

---

## Quick start

```bash
# 1. Install (bun-native: bun install + bun link)
chmod +x ./install.sh && ./install.sh

# 2. Configure a provider + default model (interactive)
joc setup
#    …or go fully local with Ollama, no key:
ollama pull qwen2.5:0.5b
export JOC_DEFAULT_MODEL=ollama/qwen2.5:0.5b

# 3. Verify the setup is reachable
joc doctor

# 4a. Talk to the agent
joc launch "add a /health route to server.ts and run the tests"   # bare `joc` opens the REPL

# 4b. …or run the spec-first pipeline
joc deep-interview "build a CLI task manager with SQLite" && joc ralplan && joc team && joc ultragoal
```

**Requirements:** Bun `v1.3.14+` (the installer auto-installs it if missing; the CLI re-checks at startup).

---

## Installation

The top-level `install.sh` delegates to the canonical `scripts/install.sh` (single source
of truth). It auto-installs Bun if missing, enforces the version floor, and registers the
`joc` binary the **bun-native way via `bun link`** — exposing it at `~/.bun/bin/joc` and
adding a compatibility symlink at `~/.local/bin/joc`. A PATH hint is printed if needed.

```bash
./install.sh                          # = bun install + bun link (scripts/install.sh --local)
sh scripts/install.sh --ref v0.1.0    # advanced: clone + install a specific tag
sh scripts/uninstall.sh [--purge]     # remove the bin + bun registry entry (--purge also wipes ~/.joc/)
```

Local dev without installing (from the repo root):

```bash
bun run start --help     # = bun src/cli.ts --help
bun run typecheck        # tsc -p tsconfig.json --noEmit
bun test                 # unit tests (20 files, 79 tests)
```

---

## Commands

| Command | What it does |
| --- | --- |
| `joc` / `joc launch ["request"]` | Interactive coding agent (TUI REPL, one-shot, or piped). `--resume [id]`, `--list`, `--no-tui`, `--no-session`. |
| `joc setup` | Interactive provider/model picker (API key / browser OAuth / local), with live model probing. |
| `joc auth [login\|logout\|refresh\|status] [provider] [--token <bearer>]` | Real OAuth (PKCE) login + token storage with auto-refresh. |
| `joc doctor [--strict]` | Probe provider connectivity, credentials, and OAuth expiry; report if the default model is reachable. `--strict` exits non-zero when it isn't. |
| `joc deep-interview "<idea>" [--auto]` | Socratic requirements interview; freezes a spec when ambiguity ≤ 20%. `--auto` runs non-interactively (CI/pipes). |
| `joc ralplan` | Planner/Architect/Critic blueprint from the frozen seed. |
| `joc team` | Per-task executor loop (shared tool engine) against the plan. |
| `joc ultragoal` | Verify acceptance criteria and write a report. |
| `joc models [name]` | List model aliases + probe local/OpenAI-compatible models for reachability. |
| `joc skills [name]` | List bundled workflow skills; `joc skills <name>` prints details. |
| `joc resume [id]` | Resume the latest interactive session (or a specific id). |
| `joc chat "<msg>"` | Single-shot streaming chat (no tools) — renders the reply token-by-token. |
| `joc mcp [serve\|tools]` | Run `joc` as an MCP stdio server (set `JOC_MCP_PIPELINE=1` to also expose the pipeline tools). |

---

## Interactive agent

Run bare `joc` (or `joc launch`) for a conversational coding agent built on a shared,
hardened tool-call engine (`src/agent/engine.ts`). It calls `read` / `write` / `edit` /
`bash` / `find` / `search` in a loop until it signals done.

- **TUI** — on a TTY it renders a differential UI (live tool-call list + in-place status
  footer); `--no-tui`, piped input, and non-TTY fall back to a plain stream.
- **Sessions** — every turn is appended to `.joc/sessions/<id>.jsonl`; `joc launch --list`
  and `joc launch --resume [id]` resume past conversations.
- **Project context** — the prompt auto-loads the first of `JEO.md` / `AGENTS.md` /
  `.joc/context.md` / `CLAUDE.md`.
- **Compaction** — long conversations are summarized automatically to stay within the context window.
- **No-progress guard** — if a (weak/local) model repeats the same tool call 3× without
  signalling done, the loop stops with a clear message instead of burning steps.
- **Token usage** — each turn prints a `(N in / M out tokens)` footer; all four provider
  adapters report usage in both blocking `call` and streaming modes.

```bash
joc                                   # REPL — slash cmds: /help /clear /model /sessions /exit
joc launch "fix the failing test"     # one-shot
echo "summarize src/agent" | joc      # piped / non-TTY (plain output)
joc launch --resume                   # resume the latest session (or --resume <uuid>)
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
3. **`joc team`** — executes plan tasks via the shared tool engine; checkpoints to `.joc/state/team-state.json`.
4. **`joc ultragoal`** — runs acceptance checks and writes `.joc/state/ultragoal-report.md`.

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
`thinkingLevel`. Env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, the
`*_OAUTH_TOKEN` bearers, `OLLAMA_HOST`, `OPENAI_BASE_URL`, `JOC_DEFAULT_MODEL`) fill gaps but
never override on-disk values. Verify everything with `joc doctor`.

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
│   ├── commands/              # launch, setup, auth, deep-interview, ralplan, team, ultragoal, doctor, mcp
│   ├── agent/                 # engine (tool loop), loop, json, tools (+MutationGuard), session, compaction, context-files, state
│   ├── ai/                    # provider adapters (anthropic/openai/gemini/ollama) + model-manager
│   ├── auth/                  # storage (+auto-refresh), pkce, callback-server, refresh, flows/{anthropic,openai,google}
│   ├── mcp/                   # MCP protocol + tools + stdio server
│   └── tui/                   # differential renderer + components + LaunchTui
├── scripts/                   # install.sh / uninstall.sh (bun install + bun link)
├── test/                      # 20 suites (79 tests): oauth, engine, json, session, context-files, compaction, streaming, tui-*
├── docs/improvements.md       # architectural analysis & changelog (ralph passes)
├── plan/                      # long-horizon work plans (TUI, features, install, model, provider)
└── README.md
```

---

## Development

```bash
bun install                                  # deps (zod, chalk)
bun run typecheck                            # tsc -p tsconfig.json --noEmit
bun test                                     # full suite
GEMINI_OAUTH_CLIENT_SECRET=<x> bun test      # Google OAuth flow tests need this env var
```

Design lineage and the milestone roadmap (TUI, features, install, model config, provider)
live in [`plan/`](./plan/README.md); the running changelog is [`docs/improvements.md`](./docs/improvements.md).

## License

MIT.
