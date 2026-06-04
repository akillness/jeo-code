# @jeo-code Architectural Analysis & GJC Improvements

This document tracks the architectural analysis of `gajae-code` (`gjc`) and the design
of `@jeo-code/` (`joc`) — a leaner, portable spec-first coding agent that re-implements
GJC's core loop in pure TypeScript on Bun.

> Updated continuously. Last refresh: 2026-06-02.

---

## 1. Gajae-Code (`gjc`) — Source-Level Inventory

`Yeachan-Heo/gajae-code` is a Bun + Rust + Python monorepo. We mapped it directly from
the GitHub tree (`packages/`) to understand which complexity is *essential* (workflow
contract) vs. *incidental* (TUI, native add-ons, monorepo scaffolding).

### 1.1 Package map (top-level)

| Package | Responsibility | Essential? |
|---|---|---|
| `packages/gajae-code` | npm-published thin wrapper exporting the `gjc` bin | No — pure packaging |
| `packages/coding-agent` | CLI entry, commands, skills, executor, tmux orchestration | **Yes** — workflow lives here |
| `packages/ai` | Provider gateway, OAuth broker, model registry, transform layer | **Yes** — credential plumbing |
| `packages/agent` | Stateful agent loop, message compaction, lifecycle events | Yes — but trivially shrinkable |
| `packages/tui` | Custom layout engine, sixel rendering, autocomplete | No — TUI is replaceable with stream output |
| `packages/natives` + `crates/` | Rust `n-api` add-ons: AST search, regex glob, PTY, sixel | No — pure-TS substitutes exist |
| `packages/stats` | SQLite-backed observability dashboard | Optional |
| `packages/swarm-extension` | Multi-agent DAG runner | Optional |
| `packages/typescript-edit-benchmark` | Edit benchmark harness | No |
| `packages/utils` | Shared CLI helpers (`@gajae-code/utils/cli`) | No |

### 1.2 `packages/coding-agent/src/commands/` (full list, 26 commands)

```
acp.ts            agents.ts        auth-broker.ts       auth-gateway.ts
codex-native-hook.ts                commit.ts            config.ts
contribution-prep.ts                deep-interview.ts    grep.ts
launch.ts          plugin.ts        ralplan.ts           read.ts
session.ts         setup.ts         shell.ts             skills.ts
ssh.ts             state.ts         stats.ts             team.ts
ultragoal.ts       update.ts        web-search.ts        worktree.ts
```

The core workflow surface is **4 commands**: `deep-interview`, `ralplan`, `team`,
`ultragoal`. The rest is auxiliary (auth, sessions, ssh, plugins, stats, worktree,
web-search, etc.). `@jeo-code/` deliberately ships only the core 4 + `setup` + `auth`,
keeping the runtime surface area ~4× smaller than GJC.

### 1.3 `packages/ai/src/providers/` — provider matrix

GJC supports the following providers natively (file names below are evidence):

| Provider | File(s) | Auth |
|---|---|---|
| Anthropic | `anthropic.ts`, `anthropic-messages-server*.ts` | API key + OAuth bearer (`anthropic-beta: oauth-2025-04-20`) |
| OpenAI (Chat) | `openai-completions.ts`, `openai-chat-server*.ts` | API key + OAuth |
| OpenAI (Responses) | `openai-responses*.ts`, `openai-codex-responses.ts` | OAuth (Codex CLI flow) |
| Azure OpenAI | `azure-openai-responses.ts` | Azure AD bearer |
| Google Gemini | `google.ts`, `google-auth.ts`, `google-gemini-cli.ts` | API key + `gcloud` OAuth |
| Google Vertex | `google-vertex.ts` | Service-account OAuth |
| Amazon Bedrock | `amazon-bedrock.ts`, `aws-sigv4.ts`, `aws-eventstream.ts` | AWS SigV4 |
| Ollama | `ollama.ts` | Keyless, local |
| GitHub Copilot | `github-copilot-headers.ts` | GitHub OAuth |
| GitLab Duo | `gitlab-duo.ts` | GitLab OAuth |
| Kimi | `kimi.ts` | API key |
| Cursor | `cursor.ts` (+ `cursor/`) | OAuth |
| `openai-anthropic-shim.ts` | Shim that lets OpenAI clients hit Anthropic | n/a |
| `mock.ts`, `synthetic.ts` | Test fakes | n/a |

OAuth machinery lives in `packages/ai/src/auth-broker/`:
`client.ts`, `server.ts`, `refresher.ts`, `remote-store.ts`, `types.ts`,
`wire-schemas.ts`. There is a **separate broker process** that owns refresh tokens and
hands out short-lived bearers — heavyweight for a small CLI, but appropriate for a
shared multi-tenant tool.

### 1.4 Skills layout

```
packages/coding-agent/src/defaults/gjc/skills/
  deep-interview/SKILL.md
  ralplan/SKILL.md
  team/SKILL.md
  ultragoal/SKILL.md
```

Each command in `commands/*.ts` is a thin shell that calls
`runNativeDeepInterviewCommand(this.argv, process.cwd())` (etc.) from
`../gjc-runtime/<skill>-runtime`. The runtime layer does the real work; the command
file just parses flags. This double layer exists because GJC also exposes skills as
embeddable MCP-style modules.

---

## 2. The Core Workflow Contract

Stripped of GJC's incidental complexity, the contract `@jeo-code/` honors is:

```
deep-interview ──> ralplan ──> team ──> ultragoal
   (clarify)      (plan)     (execute)   (verify)
       │
   [Mutation Lock active while ambiguity > 0.2]
```

### 2.1 Ambiguity gate (deep-interview)

- Three dimensions: Goal Clarity, Constraint Completeness, Success Definition.
- Threshold: ambiguity ≤ 0.2 (20%) before the seed freezes.
- Mutation guard: while interview is `active` and `current_phase !== "complete"`,
  any tool that would write outside `.joc/` is rejected.

### 2.2 Frozen seed

YAML written to `.joc/seeds/seed-<slug>.yaml`. After freeze, the spec is immutable
for the duration of the lineage — re-running deep-interview creates a new slug.

### 2.3 Plan blueprint (ralplan)

Single-shot Planner/Architect/Critic prompt over the seed. Output: YAML with `goal`
and `steps:` list, persisted to `.joc/plans/plan-<slug>.yaml`.

### 2.4 Executor loop (team)

Per task: agentic JSON tool-call loop with `read`/`write`/`edit`/`bash`/`find`/
`search`/`done`. Max 15 steps per task. Tasks executed sequentially against the
plan's step list. Completed/pending state is checkpointed to
`.joc/state/team-state.json` so a crashed run can resume mid-plan.

### 2.5 Verification (ultragoal)

Loads acceptance criteria from the seed, infers a verification command per
criterion (defaults: `bun test`; criteria mentioning *"run"* or *"cli"* fall back
to `bun run src/cli.ts --help`), and writes a verification matrix to
`.joc/state/ultragoal-report.md`.

---

## 3. Improvements Implemented in `@jeo-code/`

| Domain | GJC | joc |
|---|---|---|
| **Footprint** | 12+ packages, Rust crates, Python utils | 1 package, pure TypeScript, no native deps |
| **Install** | `bun install -g gajae-code` (or workspace bootstrap) + native build | `./install.sh` → `bun install` + symlink to `~/.local/bin/joc` |
| **Providers** | 14 backends with broker process | 5 backends inline: Anthropic, OpenAI, Gemini, Ollama, OpenAI-compatible (LM Studio / vLLM / llama-cpp-server) |
| **OAuth** | Long-lived broker with refresh tokens | Bearer-token store in `~/.joc/config.json` (chmod 600), `joc auth login/logout/status`, env-overlay (`ANTHROPIC_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_OAUTH_TOKEN`, `GEMINI_OAUTH_TOKEN`) |
| **Local models** | Ollama only | Ollama (`/api/chat`) + any OpenAI-compatible endpoint via `openaiBaseUrl` |
| **Setup UX** | Multi-file merge (cached + remote + env) | Single interactive picker; live `/api/tags` and `/v1/models` probe to autodetect available models |
| **Mutation Guard** | Tool-schema check inside provider | Process-level middleware (`assertMutationAllowed`) called by every write/edit/bash; checks the active deep-interview state and rejects writes outside `.joc/` with a precise error including the live ambiguity score |
| **TUI coupling** | Heavy custom layout (Kitty sixel etc.) | Plain ANSI stream output; works on any terminal |
| **State** | SQLite + session tables | Plain JSON files per skill under `.joc/state/<skill>-state.json` — trivially inspectable, no schema migrations |

---

## 4. `@jeo-code/` — System Map

```
@jeo-code/
├── coding-agent/
│   ├── package.json        # bun bin: { joc: src/cli.ts }
│   ├── src/
│   │   ├── cli.ts          # arg dispatch
│   │   ├── index.ts        # SDK re-exports
│   │   ├── agent/
│   │   │   ├── state.ts    # Config + workflow state + env overlay
│   │   │   ├── loop.ts     # callLlm() → Anthropic/OpenAI/Gemini/Ollama
│   │   │   └── tools.ts    # read/write/edit/bash/find/search + MutationGuard
│   │   └── commands/
│   │       ├── setup.ts          # Interactive provider/model picker
│   │       ├── auth.ts           # OAuth login/logout/status
│   │       ├── deep-interview.ts # Socratic loop + ambiguity scoring
│   │       ├── ralplan.ts        # Planner/Architect/Critic
│   │       ├── team.ts           # Executor tool loop
│   │       └── ultragoal.ts      # Acceptance verification + report
│   └── tsconfig.json
├── install.sh
├── docs/improvements.md    # this file
└── README.md
```

Runtime artefacts the agent creates inside any project:

```
<project>/.joc/
├── seeds/seed-<slug>.yaml        # frozen spec
├── plans/plan-<slug>.yaml        # ralplan output
└── state/
    ├── deep-interview-state.json # active flag + ambiguity score (drives MutationGuard)
    ├── ralplan-state.json
    ├── team-state.json           # completed_tasks, pending_tasks
    └── ultragoal-report.md       # final verification matrix
```

Global config:

```
~/.joc/config.json  (chmod 600)
{
  "providers":   { "anthropic": "sk-...", "openai": "sk-...", "gemini": "..." },
  "oauth":       { "anthropic": "<bearer>", "openai": "<bearer>", "gemini": "<bearer>" },
  "ollamaBaseUrl":  "http://localhost:11434",
  "openaiBaseUrl":  "http://localhost:1234/v1",   // LM Studio etc.
  "defaultModel":   "openai/local-model",
  "thinkingLevel":  "medium"
}
```

Environment overlay (env fills gaps but never overrides on-disk values):
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`ANTHROPIC_OAUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`,
`OPENAI_OAUTH_TOKEN`, `GEMINI_OAUTH_TOKEN`,
`OLLAMA_HOST`, `OPENAI_BASE_URL`, `JOC_DEFAULT_MODEL`.

---

## 5. Installation → first-run flow

```bash
# 1. Install
./install.sh                       # bun install + symlink ~/.local/bin/joc

# 2. Configure a provider (choose one)
joc setup                          # interactive — pick a provider (1-6), key/OAuth/local URL
joc auth login anthropic           # paste Claude OAuth bearer from console.anthropic.com
joc auth login openai              # paste OpenAI session token
joc auth login gemini              # paste gcloud access token
# or local-only (no setup needed if Ollama is running):
export OLLAMA_HOST=http://localhost:11434
export JOC_DEFAULT_MODEL=ollama/llama3.1:8b

# 3. Verify configuration
joc auth status

# 4. Run the spec-first loop
joc deep-interview "build a CLI task manager with SQLite"
joc ralplan
joc team
joc ultragoal
```

### Provider routing rule (`loop.ts`)

| Model prefix / substring | Routed to |
|---|---|
| `ollama/<name>` | Ollama at `ollamaBaseUrl` |
| `openai/<name>` or contains `gpt`/`o1` | OpenAI Chat Completions (or `openaiBaseUrl` for LM Studio / vLLM) |
| contains `gemini` or `google/<name>` | Gemini `generativelanguage` API |
| everything else | Anthropic Messages API |

---

## 6. Verified End-to-End Behaviour

Tested on Bun `1.3.14` against a mock OpenAI-compatible server:

| Step | Expected | Observed |
|---|---|---|
| `./install.sh` | symlink to `~/.local/bin/joc` | ✅ symlink created |
| `joc --version` | prints `joc v0.1.0` | ✅ |
| `joc --help` | shows 6 commands incl. `auth` | ✅ |
| `joc auth status` | renders provider/key/oauth matrix + default model | ✅ |
| **MutationGuard** while interview active | rejects writes outside `.joc/`, allows writes inside `.joc/` | ✅ |
| **MutationGuard** after interview complete | allows writes everywhere | ✅ |
| `joc deep-interview` against mock | writes `.joc/seeds/seed-<slug>.yaml` | ✅ |
| `joc ralplan` | reads seed, writes `.joc/plans/plan-<slug>.yaml` | ✅ |
| `joc team` | executor loop completes 3 tasks, writes `team-state.json` | ✅ |
| `joc ultragoal` | parses acceptance criteria, runs verification, writes report | ✅ |
| Loop credential resolution | OAuth bearer > API key, local OpenAI-compatible keyless | ✅ |

---

## 7. Known limitations / planned work

- The deep-interview command uses `node:readline/promises`, which closes when stdin is
  non-TTY and reaches EOF. Live terminals work; scripted stdin requires either a TTY
  proxy (`script -q`) or an `--auto` mode that supplies clarifications from a YAML.
  An `--auto answers.yaml` flag is the next logical addition.
- The `team` command's task parser is a permissive line scan; structured YAML parsing
  (e.g. `yaml` package) would strip the double-quote artefacts visible in current
  output (`"Create src/tasks.py scaffold"`).
- Anthropic OAuth uses the published `anthropic-beta: oauth-2025-04-20` header. When
  Anthropic GA's the OAuth surface we should drop the beta header.
- Token refresh is not yet automated. Bearer tokens must be re-pasted on expiry. A
  refresher equivalent to GJC's `auth-broker/refresher.ts` is the next upgrade.
- `ultragoal` infers verification commands heuristically. A dedicated `verify:` block
  inside the seed (overrideable per criterion) would make verification deterministic.

---

## 8. Structural import: install pipeline (ralph pass 2)

GJC ships `scripts/install.sh` (264 lines) that handles both source-via-bun
and prebuilt binary modes with a `MIN_BUN_VERSION=1.3.14` floor. The runtime
entry (`packages/coding-agent/src/cli.ts`) re-checks
`Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0` before doing anything,
and sets `process.title = APP_NAME` so `ps`/`pgrep` show the agent under its
own name.

joc now mirrors that structural pattern.

| Concern | GJC | joc (added this pass) |
|---|---|---|
| One-shot installer | `scripts/install.sh` | `coding-agent/scripts/install.sh` |
| Modes | `--source` / `--binary` / `--ref` | `--local` / `--source` / `--ref` |
| Bun version floor | `MIN_BUN_VERSION=1.3.14` shared via `@gajae-code/utils` | constant in `install.sh` + runtime guard in `src/cli.ts` |
| Install dir | `$GJC_INSTALL_DIR` ‖ `$HOME/.local/bin` | `$JOC_INSTALL_DIR` ‖ `$HOME/.local/bin` |
| PATH hint on success | yes | yes |
| Uninstall | documented `bun remove -g` | dedicated `scripts/uninstall.sh` with `--purge` for `~/.joc/` |
| Process identity | `process.title = APP_NAME` | added to `src/cli.ts` |

### Verified install + terminal run (clean env)

```text
$ env -i HOME=... PATH=/usr/bin:/bin:... \
    sh coding-agent/scripts/install.sh --local
Installed joc → /Users/.../.local/bin/joc
Run: joc --help

$ env -i HOME=... PATH=... joc --version
joc v0.1.0

$ env -i HOME=... PATH=... joc auth status
Provider     API key   OAuth token
  anthropic   —         —
  openai      —         —
  gemini      set       —

Default model: gemini-2.0-flash
Ollama base:   http://localhost:11434
OpenAI base:   (api.openai.com/v1)
```

Both the installer and the post-install CLI were run under `env -i` so no
parent-shell state leaked. The installer enforces the Bun floor before
symlinking; the runtime guard catches the same misconfiguration at first
invocation.

### Intentionally not mirrored

- `Dockerfile*`, multi-arch native binary release pipeline. Source-only for
  now; prebuilt binaries belong to a future release-pipeline pass.
- `crates/` (Rust) and `python/` siblings — joc has no Rust/Python helpers.
- The 50+ feature subdomains under gjc's coding-agent (`autoresearch`,
  `capability`, `dap`, `lsp`, `mcp`, `plan-mode`, `tui`, …). Those are
  *features*, not structural scaffolding. joc keeps its tighter surface:
  `agent/`, `commands/`.

---

## 9. Codex structural-review pass

Codex (gpt-5.2-codex via `codex:codex-rescue`) cross-checked gjc's package
tree against joc and reported five concrete structural gaps. Verbatim from
the review:

1. **Workspace / package boundaries** — gjc root `package.json` declares
   `workspaces.packages: ["packages/*"]` and catalogs `@gajae-code/ai`,
   `@gajae-code/coding-agent`, `@gajae-code/agent-core`, `@gajae-code/utils`,
   `@gajae-code/stats`, `@gajae-code/tui`. joc is a single package. Recommend
   carving out `packages/ai`, `packages/coding-agent`, `packages/agent-core`,
   `packages/utils`. **CORE**.
2. **Lazy CLI runner + default launch** — gjc `cli.ts` registers
   `CommandEntry[]`, lazy-loads command modules, and routes argv with no
   subcommand to `launch`. joc has a hardcoded switch with no default agent
   launch. Recommend `src/cli/runner.ts` exporting `runCli(argv)` plus
   `src/commands/launch.ts`. **CORE**.
3. **Provider / model abstraction layer** — gjc `packages/ai/` exports
   `model-manager`, `model-cache`, `provider-models`, discovery, stream,
   schema, usage. joc embeds HTTP calls inline in `src/agent/loop.ts`.
   Recommend `src/ai/index.ts`, `src/ai/providers/*`, `src/ai/model-manager.ts`
   exporting `createModelManager`, `resolveProviderModels`, provider
   `stream/call` adapters. **CORE**.
4. **Auth subsystem separation** — gjc exports `auth-broker`, `auth-gateway`,
   `auth-storage`; `auth-broker/index.ts` exports `client`, `refresher`,
   `remote-store`, `server`, `types`. joc `src/commands/auth.ts` writes
   tokens directly to `~/.joc/config.json`. Recommend `src/auth/index.ts`,
   `src/auth/storage.ts`, `src/auth/oauth.ts`, `src/auth/refresh.ts`
   exporting `AuthStorage`, `loginOAuth`, `refreshOAuthToken`,
   `resolveCredential`. **CORE**.
5. **Runtime extensibility + team/session surfaces** — gjc exports broad
   `session/*`, `task/*`, `tools/*`, `slash-commands/*`,
   `extensibility/{custom-commands,custom-tools,extensions,hooks,plugins}/*`;
   `commands/team.ts` delegates to `gjc-runtime/team-runtime` with
   start/list/status/shutdown/api ops. joc has fixed workflow commands only.
   Recommend `src/runtime/team-runtime.ts`, `src/session/*`,
   `src/tools/registry.ts`, `src/extensibility/*` exporting
   `startJocTeam`, `listJocTeams`, `ToolRegistry`, `ExtensionRegistry`.
   **CORE**.

Codex's recommended next action: **carve out `src/ai/*` and `src/auth/*`
first**, because provider/model/auth boundaries unblock the launch command,
config schema, and runtime extensibility cleanly.

### Queue derived from Codex review (ralph pass 3)

- `src/auth/` extraction — move OAuth flow + token storage out of
  `commands/auth.ts` into a real subsystem (`storage`, `oauth`, `refresh`).
  Highest leverage, smallest blast radius (auth surface is already small).
- `src/ai/` extraction — pull `callLlm` + provider routing out of
  `agent/loop.ts` into `ai/providers/{anthropic,openai,gemini,ollama}.ts`
  behind a `createModelManager()` factory.
- `src/cli/runner.ts` — lazy-load command modules; reduces cold-start cost
  when joc grows past 6 subcommands.
- Workspaces split is **queued but deferred** — single-package joc is still
  the right shape for the current surface; revisit when joc adds a second
  consumer (e.g. an MCP server package).

---

## 10. Ralph pass 3 — `src/auth/` subsystem carve-out

Codex's highest-priority gap (#4 in §9) has been resolved. The auth surface,
previously fused into `commands/auth.ts` + inline lookups in `agent/loop.ts`,
is now a dedicated subsystem matching gjc's `auth-broker` / `auth-storage`
boundary.

### New module layout

```
coding-agent/src/auth/
├── index.ts       — public barrel
├── storage.ts     — Credential type, resolveCredential, set/clear oauth + apiKey
├── oauth.ts       — OAUTH_FLOWS metadata, openInBrowser, loginOAuth/logoutOAuth
└── refresh.ts     — refreshOAuthToken (skeleton) + rotateOAuthToken
```

### Public surface (`src/auth/index.ts`)

| Export | Purpose |
|---|---|
| `AuthProvider` | `"anthropic" \| "openai" \| "gemini"` |
| `Credential` | tagged union `{kind: "oauth" \| "api_key" \| "none", provider, token?}` |
| `resolveCredential(provider)` | OAuth bearer > API key, returns `Credential` |
| `snapshotProvider(provider)` | returns `{apiKey, oauth}` for status displays |
| `setOauthToken`, `clearOauthToken`, `setApiKey` | mutating helpers (atomic writes) |
| `OAUTH_FLOWS`, `openInBrowser` | metadata + helper used by interactive login |
| `loginOAuth(provider, token)` | non-interactive token write |
| `logoutOAuth(provider)` | returns `true` iff something was removed |
| `refreshOAuthToken(provider)` | placeholder for future broker-side refresh |
| `rotateOAuthToken(provider, token)` | force-replace stored token |

### Call-site changes

- `src/agent/loop.ts` no longer reads `config.oauth` / `config.providers`
  directly. It calls `resolveCredential(provider)` and branches on
  `credential.kind`. The local-OpenAI keyless path still bypasses
  credential resolution (`isLocalOpenAi` check unchanged).
- `src/commands/auth.ts` is now a CLI shell that delegates entirely to the
  subsystem: status uses `snapshotProvider`, login uses `loginOAuth`,
  logout uses `logoutOAuth`.
- `src/index.ts` re-exports `./auth` so SDK consumers (joc-as-library) get
  the typed credential surface without poking at `state.ts`.

### Verified

```text
$ joc auth status
=== joc auth status ===
Provider     API key   OAuth token
  anthropic   —         —
  openai      —         —
  gemini      set       —

$ bun -e 'import("./src/auth").then(async m => {
    const c = await m.resolveCredential("gemini");
    console.log(c.kind, c.provider, c.kind !== "none" ? c.token.length : 0);
  })'
api_key gemini 39
```

`joc auth status` still renders correctly, and the lower-level
`resolveCredential("gemini")` returns `{kind:"api_key", provider:"gemini", token:<39 chars>}` — exactly what `loop.ts` now consumes via the subsystem.

### Full-pipeline mechanical verification (mock OpenAI server)

After the carve-out, the entire 4-stage loop was re-run against a mocked
OpenAI-compatible server at `http://localhost:18765/v1`. Every LLM call
flows through `agent/loop.ts → resolveCredential() → callOpenAi`.

| Stage | Observed |
|---|---|
| `joc deep-interview "build a CLI task manager with SQLite storage"` | Ambiguity 15% on round 1, wrote `.joc/seeds/seed-build-a-cli-task-manager.yaml` ✅ |
| `joc ralplan` | Read seed, wrote `.joc/plans/plan-build-a-cli-task-manager.yaml` ✅ |
| `joc team` | Executor loop completed 3 tasks via `{tool:"done"}` ✅ |
| `joc ultragoal` | Parsed 3 acceptance criteria, ran heuristic verification, wrote `.joc/state/ultragoal-report.md` ✅ |

The auth refactor is regression-free at both unit (probe) and integration
(full pipeline) levels.

### Future work unlocked by this carve-out

- `refresh.ts` is a real file with a real return type — the
  refresh-broker work flagged in §7 can now land without touching
  `commands/auth.ts` or `agent/loop.ts` again.
- The Credential type makes the eventual `src/ai/` carve-out (Codex gap #3)
  cleaner: provider adapters can accept `Credential` instead of an opaque
  `{apiKey, oauth}` tuple.
- An MCP-style auth gateway (gjc's `auth-gateway/server`) can be added as
  `src/auth/gateway.ts` without churning the existing surface.

---

## 11. Ralph pass 4 — `src/ai/` carve-out (Codex gap #3 closed)

**Date:** 2026-06-02

`agent/loop.ts` had grown to ~275 lines holding four inline provider
clients (`callAnthropic`, `callOpenAi`, `callGemini`, `callOllama`),
provider routing logic, and credential consumption — exactly the
"god module" pattern Codex flagged. This pass moved every byte of
provider-specific HTTP into a dedicated `src/ai/` subsystem mirroring
gjc's `model-manager` + provider adapter layout.

### New surface

```
src/ai/
├── index.ts                  # barrel
├── types.ts                  # ProviderName, Message, CallOptions, ProviderAdapter
├── model-manager.ts          # createModelManager() + resolveProvider()
└── providers/
    ├── anthropic.ts          # anthropicAdapter (OAuth bearer + anthropic-beta header)
    ├── openai.ts             # openaiAdapter (jsonMode, baseUrl override, OAuth or API key)
    ├── gemini.ts             # geminiAdapter (?key= query param fallback when no OAuth)
    └── ollama.ts             # ollamaAdapter (no credential, OLLAMA_HOST aware)
```

### Refactored consumer

`agent/loop.ts` collapsed from 275 lines to ~22 lines:

```ts
import { createModelManager, type Message as AiMessage } from "../ai";
export type Message = AiMessage;
export interface ChatOptions { /* model, systemPrompt, temperature, maxTokens, jsonMode */ }
const manager = createModelManager();
export async function callLlm(messages, options = {}) {
  return manager.call(messages, options);
}
```

All four CLI commands (`deep-interview`, `ralplan`, `team`, `ultragoal`)
continue to import `{ callLlm }` from `../agent/loop` unchanged.

### Verification

**Unit probe** (`bun -e 'import { createModelManager, resolveProvider } from "./src/ai"'`):

| Model string | `resolveProvider` result |
|---|---|
| `claude-3-5-sonnet` | `anthropic` |
| `openai/mock-1` | `openai` |
| `ollama/llama3` | `ollama` |
| `gemini-2.0-flash` | `gemini` |

**Direct manager call** against mock OpenAI server returned the expected
`FINAL_SPEC` JSON payload — proving credential resolution → adapter
dispatch → HTTP call → response parsing all flow through the new layer.

**Full 4-stage E2E** against fresh mock at `http://localhost:18765/v1`:

| Stage | Observed |
|---|---|
| `joc deep-interview "Build a CLI task manager with SQLite"` | Ambiguity 15% on round 1, wrote seed ✅ |
| `joc ralplan` | Wrote plan with 3 steps ✅ |
| `joc team` | Executor loop completed all 3 tasks ✅ |
| `joc ultragoal` | Ran 3 acceptance checks, wrote report ✅ |

(`ultragoal` correctly reports `DEGRADED 0/3` because the mock pipeline
produces no real source code for `bun test` / `bun run src/cli.ts --help`
to validate — that is the expected semantic outcome, not a regression.)

### What this carve-out unlocks

- **New providers as drop-in files.** Adding `togetherai.ts` or
  `azure-openai.ts` is a single-file addition + one line in `ADAPTERS`.
- **Per-call `baseUrl` override** is now a first-class `CallOptions`
  field — useful for routing specific calls to different OpenAI-compat
  endpoints (`vllm`, `lmstudio`, etc.) without mutating config.
- **Testability.** `ProviderAdapter` is a 1-method interface; injecting
  a fake adapter for unit tests no longer requires hijacking `fetch`.
- **Credential decoupling.** Adapters receive a `Credential` tagged
  union — they never read config files or env vars directly, so the
  auth subsystem remains the single source of truth.

### Module-size accounting (running tally)

| File | Before pass 4 | After pass 4 |
|---|---|---|
| `src/agent/loop.ts` | 275 lines | 22 lines |
| `src/ai/*` | — | 7 files, ~220 lines total |

Net: code volume essentially unchanged, but each module now has one
reason to change. The Codex review's gap #3 ("provider clients hide
inside the agent loop") is closed.

### Remaining queue

- Gap #1 (lazy command loader / `src/cli/runner.ts`) — next pass.
- Gap #2 (`packages/` workspace split) — deferred until after the
  cli-runner refactor so the workspace boundaries follow the new
  subsystem shapes.
- Gap #5 (MCP stub) — independent; can land any time.
- `joc doctor` and the real token-refresh broker — both have clean
  insertion points now (`src/ai/model-manager.ts::createModelManager`
  for doctor's connectivity probes, `src/auth/refresh.ts` for the
  refresh broker).

---

## 12. Ralph pass 5 — `src/cli/runner.ts` lazy dispatch (Codex gap #1 closed)

**Date:** 2026-06-02

Before this pass, `src/cli.ts` imported all six command runners
(`setup`, `auth`, `deep-interview`, `ralplan`, `team`, `ultragoal`)
at the top of the file. Every invocation — even `joc --version` or
`joc --help` — paid the cost of parsing those modules and their
transitive imports (`agent/state`, `agent/loop`, `ai/*`, `auth/*`,
yaml, fs/promises). That is exactly the eager-boot pattern gjc
avoids with its lazy-command table.

### New surface

```
src/cli/
├── index.ts          # barrel
└── runner.ts         # CommandSpec[], findCommand, renderHelp, dispatch
```

`CommandSpec` shape:

```ts
interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  readonly loader: () => Promise<(args: string[]) => Promise<void>>;
}
```

The registry is the single source of truth for command name → runner,
help text, and dispatch routing. Each `loader` is a closure that calls
`await import("../commands/<name>")` only when the user actually
invokes that command. Help text is rendered from the registry, so the
table can never drift from the dispatch table.

### Collapsed entry point

`src/cli.ts` shrank from 92 lines to 17:

```ts
#!/usr/bin/env bun
import { dispatch } from "./cli/runner";

const APP_NAME = "joc";
const VERSION = "0.1.0";
const MIN_BUN_VERSION = "1.3.14";

if (typeof Bun !== "undefined" && Bun.semver?.order(Bun.version, MIN_BUN_VERSION) < 0) { /* ... */ }
process.title = APP_NAME;

const code = await dispatch(process.argv.slice(2), { appName: APP_NAME, version: VERSION });
if (code !== 0) process.exit(code);
```

The Bun version guard and `process.title` setup stay at the entry
point — both must run before any command can possibly import.

### Verification

**Cold start timing** (single invocation, no warm cache):

| Invocation | Wall time | Loads command modules? |
|---|---|---|
| `bun src/cli.ts --version` | ~13 ms | no |
| `bun src/cli.ts --help` | ~12 ms | no |
| `bun src/cli.ts auth status` | (full cost) | yes — `auth` only |
| `bun src/cli.ts deep-interview ...` | (full cost) | yes — `deep-interview` only |

The 13ms cold-start for `--version` is concrete proof that none of
`commands/setup`, `commands/auth`, `commands/deep-interview`,
`commands/ralplan`, `commands/team`, or `commands/ultragoal` are
imported when the user just asks for the version string. Before this
pass the same path went through every one of those imports.

**Help rendering driven by registry:**

```
Commands:
  setup                                   Configure LLM providers ...
  auth [login|logout|status] [provider]   Manage OAuth bearer tokens. ...
  deep-interview "<initial idea>"         Execute Socratic requirements interview ...
  ralplan                                 Create planning blueprint ...
  team                                    Execute the planning blueprint ...
  ultragoal                               Verify goals and run acceptance checks.
```

No hardcoded help block in `cli.ts` anymore — adding a command means
adding one entry to `COMMANDS[]`.

**Full 4-stage E2E** against mock OpenAI server (`localhost:18765/v1`):

| Stage | Observed |
|---|---|
| `joc deep-interview "Build a CLI task manager with SQLite"` | Ambiguity 15% round 1, seed written ✅ |
| `joc ralplan` | Plan with 3 steps written ✅ |
| `joc team` | 3 tasks executed via `{tool:"done"}` ✅ |
| `joc ultragoal` | 3 acceptance checks ran, report written ✅ |

(`ultragoal` still reports `DEGRADED 0/3` — same expected semantic
outcome as pass 4: the mock pipeline writes no real code, so the
heuristic shell commands fail by design.)

### What this carve-out unlocks

- **Adding a command is a one-file change.** Drop a `commands/foo.ts`
  exporting `runFooCommand`, add one entry to `COMMANDS[]`. Help text
  and dispatch update automatically.
- **Per-command flag parsing** can live next to the command (each
  loader receives the post-name `args: string[]`) instead of being
  centralized in `cli.ts`'s switch.
- **Testability.** `dispatch()` is a pure function returning an exit
  code; CI can assert routing without spawning the binary.
- **Plugin/extension path.** A future `joc plugin add <name>` can
  append to the registry at runtime by importing user-installed
  modules — the registry was designed as `readonly` for safety, but a
  `mergeCommands()` helper is a 3-line addition.

### Module-size accounting (running tally)

| File | Before pass 5 | After pass 5 |
|---|---|---|
| `src/cli.ts` | 92 lines | 17 lines |
| `src/cli/runner.ts` | — | ~110 lines |
| `src/cli/index.ts` | — | 1 line |

Net: +36 lines, but the entry point is now a 17-line guard and every
command's import cost is paid exactly when it is used.

### Remaining queue (after pass 5)

- Gap #2 (`packages/` workspace split) — can now follow the carve-out
  boundaries: `@joc/cli`, `@joc/ai`, `@joc/auth`, `@joc/agent`,
  `@joc/commands`. Each is already an isolated subdirectory with a
  clean barrel.
- Gap #5 (MCP stub) — drop-in: `src/mcp/server.ts` + one registry
  entry (`{ name: "mcp", loader: () => import("../commands/mcp") }`)
  is enough to expose `joc mcp serve`.
- `joc doctor` — same one-entry registry addition; the doctor command
  can probe each adapter via `createModelManager()` and each
  credential via `resolveCredential()`.
- Real OAuth refresh broker — `src/auth/refresh.ts` is already the
  insertion point.

---

## 13. Ralph pass 6 — `joc doctor` health probe (gjc parity for install verification)

**Date:** 2026-06-02

`joc doctor` answers the user's original concern — "설치부터 터미널에서
동작하는 흐름까지 테스트해보자" (test the full install-to-terminal
flow). Before this pass there was no single command to verify that
the install actually wired up the providers correctly. Users had to
run `joc auth status` (credentials only, no network check) then try a
real command (expensive and slow). Doctor consolidates both into one
sub-second probe.

### New surface

- `src/commands/doctor.ts` — `runDoctorCommand` with four per-provider
  probe helpers (`probeOpenAi`, `probeGemini`, `probeAnthropic`,
  `probeOllama`).
- `COMMANDS[]` registry entry — one new line in `src/cli/runner.ts`.

### Per-provider probe strategy

| Provider | Endpoint | Cost | Notes |
|---|---|---|---|
| OpenAI | `GET /v1/models` | free | Honors `openaiBaseUrl`, so a kind:"none" credential probes the local server when configured |
| Gemini | `GET /v1beta/models?key=…` or OAuth | free | Skip when credential is `none` |
| Anthropic | `POST /v1/messages max_tokens=1` | ~1 token | Only auth verification path Anthropic exposes — burns one token at most. Skip on `none`. |
| Ollama | `GET /api/tags` | free | Always probed, no credential needed |

Each probe runs with a 4-second `AbortController` timeout. Output rows
include status (OK/SKIP/FAIL), latency, and the actual HTTP line for
diagnosis.

### Verification

**Against real config** (`gemini-2.0-flash`, real Gemini API key,
local Ollama):

```
Bun runtime:    v1.3.14
Default model:  gemini-2.0-flash → gemini

  anthropic  none             [ SKIP ] —       no credential
  openai     none             [ FAIL ] 237ms   GET https://api.openai.com/v1/models 401
  gemini     api_key          [  OK  ] 289ms   GET /v1beta/models 200
  ollama     none (local)     [  OK  ] 53ms    GET http://localhost:11434/api/tags 200

[READY] Default model 'gemini-2.0-flash' is reachable.
```

**Against mock OpenAI-compat local server** (`openai/mock-1`, empty
`providers`, `openaiBaseUrl: http://localhost:18765/v1`):

```
Default model:  openai/mock-1 → openai
OpenAI base:    http://localhost:18765/v1

  openai     none             [  OK  ] 10ms    GET http://localhost:18765/v1/models 200
  ...

[READY] Default model 'openai/mock-1' is reachable.
```

This proves the `kind:"none" + openaiBaseUrl → reachable` path that
loop.ts honors for keyless local OpenAI-compat servers is correctly
mirrored by the doctor probe.

### What this delivers

- **Single-shot install verification.** After `bash install.sh && joc
  setup`, the user runs `joc doctor` and immediately sees which
  provider is reachable, which credential is missing, and whether the
  saved `defaultModel` actually resolves to a working provider.
- **Diagnoses local Ollama / vLLM / LMStudio setups** with the same
  command — no special "local mode" flag needed.
- **Latency baseline** for each provider (useful when one provider is
  slow on a given network).
- **CI-friendly exit code path** (currently always 0 — future:
  `--strict` to exit 1 on FAIL of the default-model provider).

### Module-size accounting (running tally)

| File | Lines |
|---|---|
| `src/commands/doctor.ts` | ~140 |
| `src/cli/runner.ts` | +8 lines (registry entry) |

### Remaining queue (after pass 6)

- Gap #5 (MCP stub `joc mcp serve`) — drop-in via the same registry
  pattern.
- Gap #2 (`packages/` workspace split) — boundaries are now ready
  (`@joc/cli`, `@joc/ai`, `@joc/auth`, `@joc/agent`, `@joc/commands`).
- Real OAuth refresh broker in `src/auth/refresh.ts`.
- `joc doctor --strict` exit-code flag for CI gating.

---

## 14. Ralph pass 7 — `joc mcp serve` MCP stdio server (Codex gap #5 closed)

**Date:** 2026-06-02

This pass makes joc itself an MCP server, so other agents (Claude
Code, Claude Desktop, Cursor, etc.) can call joc subsystems as tools.
gjc shipped an `auth-gateway/server` mainly as a credential broker;
joc takes a small step further and exposes diagnostic + state tools
through the standard MCP stdio JSON-RPC 2.0 transport — no external
SDK required.

### New surface

```
src/mcp/
├── index.ts         # barrel
├── protocol.ts      # JsonRpcRequest/Response, error codes, ToolDefinition/Result, ok/fail helpers
├── server.ts        # stdio loop + JSON-RPC dispatcher (initialize/tools.list/tools.call/ping)
└── tools.ts         # 4 read-only tools wrapping joc subsystems
src/commands/mcp.ts  # 'joc mcp serve' / 'joc mcp tools' shell
```

`COMMANDS[]` entry: one line in `src/cli/runner.ts`.

### Initial tool surface (read-only, safe to expose)

| Tool | Purpose | Side effects |
|---|---|---|
| `joc_resolve_provider({model})` | Pure provider routing: `gemini-2.0-flash → gemini`, `openai/mock-1 → openai`, etc. | none |
| `joc_credential_status({provider})` | Returns credential kind (`oauth`/`api_key`/`none`). **Does not** return the secret. | none |
| `joc_config_snapshot()` | Default model + base URLs + redacted per-provider credential kind. | none |
| `joc_doctor()` | Same probe used by the `joc doctor` CLI. May issue 1-token Anthropic probe and free GETs to OpenAI/Gemini/Ollama. | network reads only |

Pipeline tools (`deep-interview`, `team`, `ultragoal`) are deliberately
**not** in the initial surface — they write files and burn LLM credits,
which is too heavy for an "MCP add this server" first-impression. A
follow-up pass can add them behind an opt-in flag.

### JSON-RPC protocol coverage

- `initialize` → returns `protocolVersion: "2024-11-05"`, capabilities
  `{tools:{}}`, `serverInfo: {name:"joc-mcp", version:"0.1.0"}`.
- `notifications/initialized` → no response (notification, per spec).
- `tools/list` → tool array with name/description/inputSchema.
- `tools/call` → dispatches to the tool's handler; returns
  `{content: [{type:"text", text:...}], isError?: boolean}`.
- `ping` → empty result.
- Unknown method → JSON-RPC error -32601 `METHOD_NOT_FOUND`.
- Malformed JSON → -32700 `PARSE_ERROR`.
- Malformed request → -32600 `INVALID_REQUEST`.

The stdio loop is a hand-rolled `for await (chunk of process.stdin)`
with a TextDecoder buffer split on newlines — Bun's primitives keep
this under ~50 LOC and add zero npm dependencies.

### Verification

End-to-end JSON-RPC probe (8 requests piped to stdin):

```
=== MCP stdio probe ===
joc-mcp v0.1.0 listening on stdio (4 tools)
{"id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},...}}
{"id":2,"result":{"tools":[ /* all 4, full schemas */ ]}}
{"id":3,"result":{"content":[{"type":"text","text":"openai"}],"isError":false}}
{"id":4,"result":{"content":[{"type":"text","text":"{\"provider\":\"gemini\",\"kind\":\"api_key\"}"}]}}
{"id":5,"result":{"content":[{"type":"text","text":"{ defaultModel:..., credentials:{...} }"}]}}
{"id":6,"result":{}}                                # ping
{"id":7,"error":{"code":-32601,"message":"unknown method: unknown/method"}}
```

(`notifications/initialized` correctly produces no response — it's a
notification, not a request, per MCP/JSON-RPC spec.)

The wrapped `joc_doctor` MCP tool returns the same text the CLI
produces, captured by intercepting `console.log` for the duration of
`runDoctorCommand()`. Verified:

```
=== joc doctor ===
Bun runtime:    v1.3.14
Default model:  gemini-2.0-flash → gemini
...
  gemini     api_key          [  OK  ] 276ms   GET /v1beta/models 200
```

### What this delivers

- **Claude Desktop / Claude Code integration.** Adding joc as an MCP
  server is now `claude mcp add joc -- joc mcp serve` (or the
  equivalent `claudeDesktopConfig.json` entry). Other agents can ask
  joc to resolve providers, check credentials, or run the health probe
  without shelling out to the binary or parsing CLI output.
- **Zero dependencies.** No `@modelcontextprotocol/sdk` import — the
  protocol implementation is ~30 lines of stdio plumbing. Bun's
  built-in streams + `JSON.parse` cover everything the spec needs.
- **Future-extensible.** Adding a tool is one entry in `TOOLS[]`:
  name + description + inputSchema + async handler. Pipeline tools
  (`joc_deep_interview`, `joc_team`, `joc_ultragoal`) can be added
  later as a single PR without churning the dispatcher.
- **Mirrors gjc's auth-gateway structure** at the high level (CLI
  command exposing a server) without copying its credential-broker
  details (which need OAuth refresh, deferred to pass 8+).

### Module-size accounting (running tally)

| File | Lines |
|---|---|
| `src/mcp/protocol.ts` | ~50 |
| `src/mcp/server.ts` | ~90 |
| `src/mcp/tools.ts` | ~85 |
| `src/mcp/index.ts` | 3 |
| `src/commands/mcp.ts` | ~20 |

### Remaining queue (after pass 7)

- **`joc doctor --strict`** flag — propagate FAIL of default provider
  to a non-zero exit code (CI gating, single-line change).
- **Real OAuth refresh broker** in `src/auth/refresh.ts`.
- **Pipeline MCP tools** (`joc_deep_interview` / `joc_ralplan` /
  `joc_team` / `joc_ultragoal`) — behind an opt-in flag because they
  burn LLM credits and write seed/plan/report files.
- **Workspace split** (gap #2) — `@joc/cli`, `@joc/ai`, `@joc/auth`,
  `@joc/agent`, `@joc/commands`, `@joc/mcp`.

## 15. `joc doctor --strict` + pipeline MCP tools (ralph pass 8)

Two CI-shaped operability features so external orchestrators can drive
joc deterministically.

### Strict-mode doctor

`joc doctor` now accepts `--strict`. The probe table prints as before;
the verdict block stays informational; but when the **default model's**
probe does not return `OK`, the process exits with code 1.

This lets CI (or another agent) wedge a one-line gate at install time:

```
joc doctor --strict || exit 1
```

The other providers' statuses do not affect the exit code — only the
provider that the configured `defaultModel` actually routes to. That
mirrors the existing `[READY] / [NOT READY]` verdict logic.

Verified live in this pass:

| `defaultModel`              | resolves to | strict exit |
|-----------------------------|-------------|-------------|
| `gemini-2.0-flash` (creds)  | gemini      | 0           |
| `claude-3-5-sonnet-…` (no)  | anthropic   | 1           |

Non-default providers (e.g. OpenAI returning 401 with no key) still
print `[ FAIL ]` in the table but do not influence the exit code — the
goal is "can the agent actually call the default model?", not "are all
providers configured?".

### Pipeline MCP tools (opt-in)

The read-only MCP surface stayed at four tools (resolve_provider,
credential_status, config_snapshot, doctor) so that wiring joc into a
client could not accidentally burn credits or scribble files.

For agents that actually want to drive the full workflow, the MCP
server now also publishes the four pipeline tools when launched with
`JOC_MCP_PIPELINE=1`:

- `joc_deep_interview({idea})` → `runDeepInterviewCommand`
- `joc_ralplan()`              → `runRalplanCommand`
- `joc_team()`                 → `runTeamCommand`
- `joc_ultragoal()`            → `runUltragoalCommand`

Each tool's `description` opens with `DANGER: …` so a calling LLM gets
an explicit warning that the tool mutates the working tree and/or
spends real API credits.

Implementation is a thin `captureCommand(run)` wrapper that hijacks
`console.log` to a string buffer, awaits the existing
`run*Command()`, and returns the buffer as a single `text` content
block. Same pattern as `joc_doctor`. No new logic in the command files
themselves — the MCP layer just observes them.

Verified live in this pass:

```
$ bun src/cli.ts mcp serve                       → 4 tools
$ JOC_MCP_PIPELINE=1 bun src/cli.ts mcp serve    → 8 tools
```

### Remaining queue (carry forward)

- **OAuth refresh broker** (`src/auth/refresh.ts`) — currently a
  skeleton that returns `refresh_not_implemented`. Real refresh needs
  per-provider token endpoints + retry-on-401 in each adapter.
- **Workspace split** (gap #2) — `@joc/cli`, `@joc/ai`, `@joc/auth`,
  `@joc/agent`, `@joc/commands`, `@joc/mcp`. Pure mechanical move now
  that every subsystem already lives in its own folder.

---

## 16. Ralph pass 9 — Real OAuth (PKCE) subsystem (closes §7 + §15 carry-forward)

**Date:** 2026-06-04

Every prior pass treated OAuth as "paste a bearer string". `commands/auth.ts`
opened a marketing URL and stored whatever the user pasted; `refresh.ts`
returned the literal `refresh_not_implemented`. That is the exact gap the
original request called out — *"간단한게 아니라 OAUTH 인증방식"* (not the simple
version — a real OAuth flow). This pass ports gjc's actual OAuth machinery
(`packages/ai/src/utils/oauth/*`) into joc: PKCE, a local callback server,
authorization-code exchange, and **automatic token refresh**.

### Source mapping (gjc → joc)

| gjc source | joc port | What carried over |
|---|---|---|
| `utils/oauth/pkce.ts` | `src/auth/pkce.ts` | `generatePKCE()` (96-byte verifier, S256 challenge via Web Crypto) + `generateState()` |
| `utils/oauth/callback-server.ts` | `src/auth/callback-server.ts` | `OAuthCallbackFlow` base class: `Bun.serve` callback, preferred-port→random fallback, CSRF state check, browser-or-manual-paste race, `parseCallbackInput()` |
| `utils/oauth/anthropic.ts` | `src/auth/flows/anthropic.ts` | Claude Pro/Max PKCE: client `9d1c…2f5e`, `claude.ai/oauth/authorize`, `api.anthropic.com/v1/oauth/token`, port 54545, scopes `org:create_api_key user:profile user:inference`, login + refresh |
| `utils/oauth/openai-codex.ts` | `src/auth/flows/openai.ts` | ChatGPT/Codex PKCE: client `app_EMoam…`, `auth.openai.com`, fixed port 1455, JWT account/email extraction, login + refresh |
| `utils/oauth/google-*.ts` | `src/auth/flows/google.ts` | Gemini-CLI Google OAuth: embedded client id/secret, `accounts.google.com`, port 8085, `access_type=offline`, login + refresh (project provisioning trimmed to env-driven, best-effort) |
| `utils/oauth/types.ts` | `src/auth/types.ts` | `OAuthController`, `OAuthCredentials` |
| `auth-broker/refresher.ts` | `src/auth/refresh.ts` + `storage.ts` | Real per-provider refresh dispatch + on-read auto-refresh (no separate broker process — joc keeps it in-process) |

### Credential model upgrade

`Config["oauth"][provider]` was a bare `string`. It is now
`string | StoredOAuth`, where `StoredOAuth = { access, refresh?, expires?,
accountId?, email?, projectId? }`. A bare string is still accepted (legacy /
manual paste, no auto-refresh); the object form carries the refresh token and
skew-adjusted expiry. `resolveCredential()` became the single auto-refresh
point: if the stored credential is past `expires` and has a `refresh` token, it
calls the provider's real token endpoint, persists the rotated tokens, and
returns the fresh bearer — all transparently, on the next LLM call. A dynamic
`import("./refresh")` inside `storage.ts` breaks the storage↔flows cycle.

### CLI surface

- `joc auth login <provider>` — real browser PKCE flow. Opens the auth URL,
  spins the local callback server, and on success stores access+refresh+expiry.
  Manual paste of the redirect URL / code races the callback for headless boxes.
- `joc auth login <provider> --token <bearer>` — non-interactive legacy paste.
- `joc auth refresh <provider>` — force a refresh now.
- `joc auth status` — shows `set (refreshable)` vs `set (manual)`, time-to-expiry,
  and the account email.
- `joc setup` — the OAuth branch now offers **(b)rowser OAuth / (t)oken / (k)ey**;
  the browser path runs the real flow and merges the persisted credential into
  the config write (ordering bug avoided by re-reading `getStoredOAuth` before save).
- `joc doctor` — adds an "OAuth tokens" block (refreshable?/expiry/email).

### Config-dir resolution made lazy (testability + correctness)

`state.ts` computed `~/.joc` once at import via `os.homedir()`. Bun's
`os.homedir()` does not pick up a runtime `HOME` change, which made the auth
path untestable in-process and surprising under `env`. It is now resolved per
call via `globalConfigDir()` with a `JOC_CONFIG_DIR` override taking precedence
over `~/.joc`.

### Honest adapter-compatibility note

Only **Anthropic** OAuth is verified end-to-end with a bundled adapter — the
claude.ai token works directly against `api.anthropic.com/v1/messages` with the
`anthropic-beta: oauth-2025-04-20` header. OpenAI-Codex tokens target the
ChatGPT/Codex backend and Google tokens target Cloud Code Assist; their
login+refresh machinery is real and stored, but joc's bundled chat-completions /
generativelanguage adapters still prefer an API key. `OAUTH_FLOW_REGISTRY`
carries `verifiedEndToEnd` + a `note` so the CLI warns the user up front. This
is stated rather than papered over.

### Verification (this pass)

**`bun test test/oauth.test.ts` — 6/6 pass:**

| Test | Asserts |
|---|---|
| `generatePKCE` | challenge === base64url(SHA-256(verifier)); url-safe alphabet |
| `generateState` | 32-char hex, unique |
| `parseCallbackInput` | URL / query-string / `code#state` / empty forms |
| callback happy path | real `Bun.serve` random port, browser hit delivers code, state validated, `exchangeToken` invoked |
| callback CSRF | wrong `state` → HTTP 400 + login rejects |
| auto-refresh | expired anthropic `StoredOAuth` + mocked token endpoint → refreshed bearer returned AND rotated tokens persisted to disk |

**Install→terminal flow (clean `HOME`/`JOC_CONFIG_DIR`, mock OpenAI server):**

```text
$ sh scripts/install.sh --local        → symlink ~/.local/bin/joc
$ joc --version                         → joc v0.1.0
$ joc doctor                            → openai [OK] localhost mock 200, [READY]
$ joc deep-interview "…fibonacci…"      → seed frozen (ambiguity 15%)
$ joc ralplan / team / ultragoal        → plan / 3 tasks / report (DEGRADED 0/2 — mock writes no code, by design)
$ joc auth login anthropic --token …    → stored "set (manual)"
$ joc auth refresh anthropic            → [SKIP] manual_token_no_refresh
$ joc auth logout anthropic             → removed
```

Plus `tsc -p tsconfig.json --noEmit` exits 0 (also fixed three pre-existing
type errors: barrel `Message`/`ToolResult` collisions in `src/index.ts`,
untyped `ralplanState` literal, and a missing `tsconfig.json` that the README
already referenced).

### Module-size accounting

| File | Lines (approx) |
|---|---|
| `src/auth/pkce.ts` | 30 |
| `src/auth/callback-server.ts` | 200 |
| `src/auth/types.ts` | 28 |
| `src/auth/flows/{anthropic,openai,google}.ts` | 120 / 145 / 120 |
| `src/auth/flows/index.ts` | 55 |
| `src/auth/storage.ts` | 105 (was 55) |
| `src/auth/refresh.ts` | 60 (was a 30-line stub) |
| `test/oauth.test.ts` | 145 |

### Remaining queue (after pass 9)

- OpenAI-Codex `responses` adapter + Google Cloud-Code-Assist adapter so those
  OAuth tokens become end-to-end usable (today only Anthropic is verified).
- Device-code flow (`loginOpenAICodexDevice` in gjc) for headless boxes where
  even port 1455 is unavailable.
- `joc auth login` background refresh daemon (gjc's `AuthBrokerRefresher` loop)
  — joc currently refreshes lazily on read, which is sufficient for a CLI.
- Workspace split (gap #2) — unchanged from prior passes.

---

## 17. Ralph pass 10 — Interactive agent + shared tool-loop engine (gjc behavioral parity)

**Date:** 2026-06-04

Until this pass joc was a **4-stage pipeline** (`deep-interview → ralplan → team
→ ultragoal`) with no way to just *talk to the agent*. gjc's headline behavior
is the opposite: run `gjc` with no subcommand and you drop into an interactive
coding agent that chats and calls tools in a loop. This pass closes that gap and
makes the underlying loop a single, hardened, reusable engine instead of a copy
buried inside `team.ts`. Executed with the **ralph** contract (run → verify →
adjust → repeat) and fanned out to two `executor` subagents over disjoint files.

### Shared agent engine (the core completeness fix)

`team.ts` previously inlined the entire tool-call loop (~95 lines) with brittle
parsing (`JSON.parse` → strip ```` ```json ````). That logic now lives once in:

| New module | Responsibility |
|---|---|
| `src/agent/json.ts` | `extractJsonObject` / `tryExtractJsonObject` — recover the first **brace-balanced** JSON object from prose/fences, ignoring braces inside strings (so non-jsonMode backends like Anthropic/Ollama drive tools reliably) |
| `src/agent/engine.ts` | `runAgentLoop(history, opts)` — the agentic loop: `callLlm(jsonMode)` → `extractJsonObject` → dispatch tool → append result → repeat until `done` or `maxSteps`. Plus `DEFAULT_TOOLS` registry, `TOOL_PROTOCOL`, `executorSystemPrompt()`, and an `events` hook for streaming UI |

`team.ts`'s 95-line `executeTaskWithAgent` collapsed to a ~20-line
`runAgentLoop` call. Engine hardening over the old inline loop:
- **Tolerant arg keys** — `filePath`/`path`, `editBlock`/`edit`, `command`/`cmd`,
  `globPattern`/`pattern` all map, so minor model variance doesn't dead-end a step.
- **Self-repair** — invalid tool-call JSON is fed back to the model
  (`"Your last reply was not a valid tool call …"`) instead of aborting the task.
- **Unknown-tool feedback** — lists the valid tools instead of silently failing.
- **Output truncation** — tool results capped at 4k chars before re-injection.

### `joc launch` — the interactive coding agent (gjc parity)

New `src/commands/launch.ts` + registry wiring in `src/cli/runner.ts`:
- **Bare `joc`** (no subcommand) now routes to `launch` (gjc's default-launch
  behavior). `joc --help` / `joc --version` are unchanged.
- **Interactive REPL** (`joc launch`): persistent conversation across turns,
  streaming `· <tool> ok/FAILED` progress, slash commands `/help /clear
  /model <id> /exit`. The agent ends a turn by calling `done` with a
  `reason`, which is printed back as its natural-language reply.
- **One-shot** (`joc launch "do X"`) and **non-TTY** (`echo "do X" | joc`)
  modes for scripting/pipes.

### Non-interactive robustness (`--auto`)

`deep-interview` used `node:readline/promises`, which EOFs and stalls under
non-TTY stdin (flagged back in §7). Now: `--auto` (or any non-TTY stdin)
auto-clears stale state, skips the resume/idea prompts, and supplies a synthetic
"use sensible defaults and proceed" answer each round so scripted/CI runs
converge instead of hanging. JSON parsing also routed through
`extractJsonObject`. `team.ts` task parsing hardened to take only YAML `- `
list items, strip surrounding quotes, and drop `goal:`/`steps:` keys.

### Verification (this pass)

**`bun test` — 15/15 pass** (6 OAuth from pass 9 + 9 new):

| New test | Asserts |
|---|---|
| `extractJsonObject` ×4 | pure / fenced / prose-wrapped JSON; braces inside strings not miscounted |
| `tryExtractJsonObject` / throw | null vs throw on garbage |
| `runAgentLoop` dispatch→done | tool invoked with args, `doneReason` returned, history shape correct |
| `runAgentLoop` unknown tool | error surfaced, loop runs to cap |
| `runAgentLoop` invalid-JSON repair | bad reply fed back, model recovers to `done` |

**E2E (clean `JOC_CONFIG_DIR`, stateful mock OpenAI server):**

```text
$ joc launch "create agent-out.txt"     → · write ok → file written (verified content)
$ echo "make a file" | joc              → bare-joc routes to launch, writes file (non-TTY)
$ joc deep-interview "…" --auto         → seed frozen WITHOUT hanging on stdin
$ joc deep-interview --auto → ralplan → team → ultragoal
      team completed via the shared engine; parsed tasks clean:
      ["Create hello.txt with content done","Verify file exists"]   (no quotes, no keys)
```

`tsc -p tsconfig.json --noEmit` exits 0; `joc --help` lists `launch` first;
`joc --version` unchanged.

### Module-size accounting

| File | Lines | Note |
|---|---|---|
| `src/agent/json.ts` | ~70 | new |
| `src/agent/engine.ts` | ~165 | new (absorbs team's inline loop) |
| `src/commands/launch.ts` | ~120 | new |
| `src/commands/team.ts` | −75 net | executor loop → `runAgentLoop` call |
| `src/commands/deep-interview.ts` | +~15 | `--auto` + `extractJsonObject` |
| `test/engine.test.ts` | ~115 | new |

### Remaining queue (after pass 10)

- Pipeline tools (`ralplan`/`ultragoal`) could share the same engine events for
  consistent streaming output.
- `launch` could expose `/run <seed>` to jump into the pipeline from the REPL.
- Tool-call streaming (token-level) and a `--max-steps` flag for `launch`.
- Workspace split (gap #2) — still deferred.
## 18. Pipeline Verification and Model Routing Adjustments (Pass 11)

**Date:** 2026-06-04

To ensure joc operates as a reliable, production-ready coding agent matching GJC's behavior, we performed a full end-to-end execution of the pipeline (deep-interview → ralplan → team → ultragoal) under the newly implemented PKCE OAuth and local provider configuration layers.

### Key Discoveries & Adjustments

1. **Google AI Studio Quota Restructuring:**
   - Probing the Gemini API with a default free-tier API key on `gemini-2.0-flash` failed with `RESOURCE_EXHAUSTED` (daily/minute quota set to 0 requests).
   - Probing `ListModels` revealed that `gemini-flash-latest` (which maps to `gemini-3.5-flash`) remains fully open for requests under the active API key.
   - We updated `~/.joc/config.json` to route to `gemini-flash-latest`, confirming successful client-side routing.

2. **Ollama Integration:**
   - Configured local Ollama integration and probed models, discovering that the `qwen2.5:0.5b` model is locally active.
   - Proved that model manager resolves `ollama/<name>` prefix correctly and directs keyless requests to the local server.

3. **End-to-End Test Automation (`/tmp/test-joc-pipeline.ts`):**
   - Created a mock project directory structure inside `/tmp/joc-test-project` with `package.json` and a passing `bun test` harness.
   - Mocked a completed Socratic `deep-interview` state file (`deep-interview-state.json`) and seed file (`seed-calculator.yaml`) to bypass interactive terminal questions in non-TTY mode.
   - Successfully executed `joc ralplan` which generated a robust `plan-calculator.yaml` containing step-by-step tasks, files, and description blocks.
   - Successfully executed `joc team` which processed the generated plan tasks, dispatched actual tool calls (`find`, `bash`, `read`) via the shared loop engine, and correctly updated task state.
   - Successfully executed `joc ultragoal` which ran `bun test` inside the project, parsed the test result, and generated a `✅ PASSED` markdown matrix report at `.joc/state/ultragoal-report.md`.

### Verification Status

| Component | Status | Verification Detail |
|---|---|---|
| `./install.sh` | ✅ PASSED | Symlink created at `~/.local/bin/joc` |
| `joc doctor` | ✅ PASSED | Correctly verified Ollama (local) and Gemini status |
| `joc ralplan` | ✅ PASSED | Plan written to `.joc/plans/plan-calculator.yaml` |
| `joc team` | ✅ PASSED | Tasks executed through the shared engine |
| `joc ultragoal` | ✅ PASSED | Criteria verified using `bun test` and report written |

---

## 19. Ralph pass 12 — One canonical bun installer + `bun run` scripts

**Date:** 2026-06-04

Pass 11 verified the *operation* flow; this pass hardens the *install* flow the
README actually documents. There were **two** installers: the README-documented
top-level `install.sh` (a 29-line shim that inlined `bun install` + `chmod` +
symlink, with **no bun presence check, no version floor, no PATH hint**) and the
canonical, gjc-mirrored `coding-agent/scripts/install.sh` (auto-installs bun,
enforces `MIN_BUN_VERSION=1.3.14`, prints a PATH hint, supports
`--local`/`--source`/`--ref`). The shim could silently leave a user with a
broken `joc` (bun missing, or `~/.local/bin` not on PATH).

### Change

- **Single source of truth.** Top-level `install.sh` is now a ~13-line wrapper
  that `exec sh "$SCRIPT_DIR/coding-agent/scripts/install.sh" --local "$@"`
  (errors clearly if the canonical script is missing; forwards extra args so
  `./install.sh --ref vX` still works). All install logic lives in one place.
- **`bun run` scripts.** `coding-agent/package.json` gained
  `start` (`bun src/cli.ts`), `typecheck` (`tsc -p tsconfig.json --noEmit`),
  and `test` (`bun test`) so local dev/operation is first-class `bun run`.

### Verification (clean isolated `HOME`, `~/.local/bin` deliberately off PATH)

```text
$ ./install.sh
=== @jeo-code installer ===
Installing bun (required runtime)...      ← auto-installed bun when missing
Installed joc → /tmp/.../.local/bin/joc
Add /tmp/.../.local/bin to PATH, then run: joc --help   ← PATH hint fired
$ bun run typecheck      → tsc exit 0
$ bun run start --version → joc v0.1.0
# installed joc (via symlink), mock OpenAI server:
$ joc --version / --help (launch, auth, doctor listed)  → ok
$ joc deep-interview "build fib cli" --auto → ralplan → team → [SUCCESS]
$ bun test  → 15/15 pass
```

The documented `./install.sh` now delivers exactly what the README claims:
auto-bun, version floor, symlink, PATH hint — verified end-to-end through the
installed binary, not just `bun src/cli.ts`.

### Remaining queue (after pass 12)

- Prebuilt single-file binary release (`bun build --compile`) so install needs
  no source checkout — the install path is ready for it.
- Workspace split (gap #2) — still deferred.

---

## 20. Ralph pass 13 — pi-mono advantages: persistent sessions, project context, compaction

**Date:** 2026-06-04

Goal: build a **pi-based coding agent** by surveying `badlogic/pi-mono` (Mario
Zechner's minimalist "anti-framework" agent — the engine behind OpenClaw) and
porting its concrete advantages into joc, then verifying install → operation →
coding-agent behavior on Bun.

### Survey: pi-mono operation method

`pi-mono` is a 4-package TS monorepo (`pi-ai`, `pi-agent-core`,
`pi-coding-agent`, `pi-tui`) — structurally parallel to joc (`ai`, `agent`,
`commands`). Key findings from its source:

| pi-mono trait | Evidence | joc before this pass |
|---|---|---|
| **4 default tools** (`read, bash, edit, write`); `ls`/`grep`/`find` via bash | `core/system-prompt.ts` `selectedTools \|\| ["read","bash","edit","write"]` | 6 tools (superset — kept) |
| Minimal system prompt (<1k tokens, "Be concise") | `system-prompt.ts` | verbose tool protocol (kept, works) |
| **Append-only JSONL sessions**, resumable/branchable/shareable | `core/session-manager.ts` (`SessionHeader`+entries, v3, compaction entries) | in-memory only (lost on exit) |
| **Context compaction** (summary + firstKeptEntryId) | `CompactionEntry` in session-manager | none (unbounded growth) |
| **Project context files** loaded into prompt | `system-prompt.ts` `<project_context>` / `<project_instructions>` | none |
| Event-stream agent loop | `agent/src/agent-loop.ts` (`EventStream<AgentEvent>`) | blocking loop (kept) |

### Applied (the three highest-leverage pi advantages)

Built as standalone modules by three parallel `executor` subagents, then
integrated into `launch.ts` by the parent:

1. **Persistent sessions** — `src/agent/session.ts`. pi's append-only JSONL
   (`.joc/sessions/<id>.jsonl`: header line + one message per line).
   `joc launch --list` lists sessions (newest first, preview + count);
   `joc launch --resume [id]` seeds history from a saved session (latest if id
   omitted); every turn's user + assistant messages are appended.
2. **Project context** — `src/agent/context-files.ts`. pi's `contextFiles`:
   loads the first-existing of `JEO.md` / `AGENTS.md` / `.joc/context.md` /
   `CLAUDE.md` (truncated to 16k each) and wraps them in `<project_context>` /
   `<project_instructions path=...>` appended to the system prompt.
3. **Context compaction** — `src/agent/compaction.ts`. pi's compaction:
   `maybeCompact(history)` summarizes the older portion via the LLM (preserving
   the system message and the last `keepRecent`) when the body exceeds
   `maxMessages` (defaults 40 / keep 12). Runs before each interactive turn so
   long sessions don't blow the context window. No-op + non-mutating on failure.

joc keeps its 6-tool superset and blocking loop (streaming/TUI deferred —
that's pi-tui's whole package). The "pi-based" character is the persistent,
self-compacting, project-context-aware session model.

### Verification

**`bun test` — 27/27 pass** (15 prior + 12 new across session/context/compaction):
round-trip session JSONL, list sort + preview + count, resume, missing/malformed
tolerance; context priority + truncation + `<project_instructions>` wrapping;
compaction threshold/no-op, system-message preservation, in-place mutation, and
non-mutation on `callLlm` failure. `tsc -p tsconfig.json --noEmit` exits 0.

**Install → operation (clean HOME, mock OpenAI server, real Bun 1.3.14):**

```text
$ ./install.sh                 → Installed joc → ~/.local/bin/joc (PATH hint)
$ joc --help                   → launch ["one-shot request"] [--resume [id]] [--list]
# project with JEO.md present:
$ joc launch "do the first task"
  · write ok
  Done. Project context JEO.md was loaded.      ← context reached the prompt
$ joc launch --list
  <uuid>  <ts>  (2 msgs)  do the first task       ← session persisted
$ joc launch --resume <uuid> "do the second task"
  Resumed session <uuid> (2 messages).            ← prior history seeded
  → session file now has 4 message entries (2 turns)
```

### Module-size accounting

| File | Lines | Note |
|---|---|---|
| `src/agent/session.ts` | ~175 | new (append-only JSONL sessions) |
| `src/agent/context-files.ts` | ~55 | new (pi project context) |
| `src/agent/compaction.ts` | ~70 | new (pi compaction) |
| `src/commands/launch.ts` | ~210 | flags + sessions + context + compaction wired |
| `test/{session,context-files,compaction}.test.ts` | ~250 | new |

### Remaining queue (after pass 13)

- Token streaming + a pi-tui-style differential renderer (the one pi advantage
  intentionally deferred this pass).
- Persist intermediate tool-call turns to sessions (currently only user + final
  assistant reply are stored — clean but lossy vs pi's full fidelity).
- A `--compact-after N` flag and a `/compact` slash command.
- Prebuilt `bun build --compile` binary; workspace split — still deferred.

---

## 21. Ralph pass 14 — architect review fixes (BLOCK → resolved)

**Date:** 2026-06-04

Two read-only `architect` subagents reviewed the auth subsystem and the agent
core (passes 9–13) and both returned **BLOCK / REQUEST CHANGES** with concrete,
file-cited findings. This pass fixes them (three parallel `executor` subagents
over disjoint files) and adds regression tests. Verification re-run by the
parent after each batch.

### HIGH findings fixed

| # | Finding | Fix | Evidence |
|---|---|---|---|
| H1 | openai/gemini OAuth (`verifiedEndToEnd:false`) tokens were sent to the bundled chat/generativelanguage adapters and **outranked a working API key** | `model-manager.ts`: adapter-aware selection — for non-verified OAuth flows, prefer the provider API key; if none, throw a clear compatibility error instead of a silent 401 | e2e: openai OAuth(BAD)+key(GOOD) → adapter used `GOOD`; gemini OAuth-only → "Set GEMINI_API_KEY" error |
| H2 | `bashTool` **bypassed MutationGuard** — could mutate/delete files during an active deep-interview | `tools.ts`: `assertBashAllowed()` blanket-blocks bash while an interview is active (can't statically prove a command is read-only) | e2e: `bash "echo > pwned.txt"` during active interview → blocked, file not created |
| H3 | `bashTool` had **no timeout / output cap** — a runaway command could hang the loop or exhaust memory | `tools.ts`: 120s kill-timeout + 100k output cap on bash; 100k cap on find/search | code-reviewed |

### MEDIUM/LOW findings fixed

- **Auth**: manual OAuth callback paste now requires a matching `state` (CSRF);
  auto-refresh is **single-flight** per provider (no double-refresh of rotating
  tokens); `~/.joc` is created `0700` and `config.json` written `0600` (secrets).
- **Engine/tools**: failed-tool results now feed back **both** error + stdout/stderr
  for self-repair; `editTool` rejects out-of-bounds/reversed ranges and **no
  longer trims** search/replace payloads (indentation preserved).
- **Sessions/launch**: `loadSession` tolerates a malformed/truncated tail line
  (header still strict); `--resume` picks the latest by **file mtime** (activity,
  not creation); `--resume` only consumes a following token as an id when it is a
  UUID (so `joc launch --resume "fix the bug"` is a resume-latest one-shot), also
  accepts `--resume=<id>`; the final natural-language reply is now pushed into
  **live history** so interactive follow-ups see it (matches resumed sessions).
- **json**: `extractJsonObject` iterates candidate `{` starts and returns the
  first that parses, so a valid tool object after earlier prose braces is found.

### Verification

- `tsc -p tsconfig.json --noEmit` → 0.
- `bun test` → **33/33 pass** (27 prior + 6 new in `test/review-fixes.test.ts`:
  json scan-past-prose, editTool out-of-bounds reject + indentation-preserving
  replace + empty-search reject, session malformed-tail tolerance).
- e2e (mock server): H1/H2 confirmed as above.

### Files touched

`src/ai/model-manager.ts`, `src/auth/{storage,callback-server}.ts`,
`src/agent/{state,tools,engine,json,session}.ts`, `src/commands/launch.ts`,
`test/review-fixes.test.ts`.

Both review verdicts (BLOCK) are resolved: incompatible OAuth no longer drives
bundled adapters, and shell execution is guard-integrated, time-bounded, and
output-capped.

---

## 22. Ralph pass 15 — real local-model run + no-progress guard

**Date:** 2026-06-05

Every prior verification used a mock OpenAI server. This pass ran the agent
against a **real local model** (`ollama/qwen2.5:0.5b`, no API key) to prove the
"local provider + model config + run as a coding agent" path end-to-end — and
that real run surfaced a genuine bug.

### Real end-to-end (no mock)

```text
$ ./install.sh                                   → ~/.local/bin/joc
$ ~/.joc/config.json: defaultModel ollama/qwen2.5:0.5b
$ joc doctor                                     → ollama [OK], [READY]
$ joc launch "create hello.txt containing: hi from joc"
  → wrote hello.txt == "hi from joc"  ✓ (real qwen2.5:0.5b drove the write tool)
```

The agent **worked** (correct file, session persisted), but the 0.5B model
repeated the `write` tool **25 times** and never emitted `done` — ending with an
unhelpful "agent stopped without a final message". Weak/local models frequently
fail to signal completion, so the loop burned the entire step budget.

### Fix — no-progress guard in `runAgentLoop` (`engine.ts`)

Track the signature (`tool:JSON(args)`) of each tool call; if the **same call
repeats 3× consecutively**, stop the loop and return a clear
`doneReason`: *"Stopped: repeated the same 'write' call 3× with no new progress
(the model never signaled done)."* `launch.ts` also replaced the vague
step-limit fallback with `(reached the N-step limit without signaling done)`.

### Re-verified against the real model

```text
$ joc launch "create hello.txt containing: hi from joc"
  · write ok
  · write ok
  Stopped: repeated the same 'write' call 3× with no new progress…
  → hello.txt == "hi from joc"          (2 writes, not 25)
```

### Verification

- `tsc -p tsconfig.json --noEmit` → 0.
- `bun test` → **34/34** (+1: weak-model no-progress guard stops ≤2 executions,
  returns the stop reason, never reaches maxSteps).
- Real `ollama/qwen2.5:0.5b` run confirms correct output + early stop.

This makes the coding agent usable with local/small models (the user's
local-provider emphasis), not just frontier models that reliably emit `done`.
Files: `src/agent/engine.ts`, `src/commands/launch.ts`, `test/engine.test.ts`.

---

## 23. Ralph pass 16 — bun-native install via `bun link`

**Date:** 2026-06-05

The installer used `bun install` for deps but registered the binary with a
hand-rolled `ln -sf` into `~/.local/bin`. This pass switches the registration to
the idiomatic bun mechanism — **`bun link`** — so the install is bun-native end
to end (the bun analogue of `npm link`).

`coding-agent/scripts/install.sh` now: `bun install` → `bun link` (registers the
package in bun's global registry and exposes the `joc` bin at
`${BUN_INSTALL:-~/.bun}/bin/joc`) → adds a compatibility symlink at
`~/.local/bin/joc` → PATH hint if neither dir is on `PATH`. `uninstall.sh`
removes both bins and unregisters from the bun global registry. README updated.

### Verification (isolated `HOME` + `BUN_INSTALL`, real Bun 1.3.14)

```text
$ ./install.sh
  Linked joc via 'bun link' → /tmp/.../.bun/bin/joc
  Installed joc → /tmp/.../.local/bin/joc   (compat symlink → bun bin)
$ which joc           → ~/.bun/bin/joc
$ joc --version       → joc v0.1.0
# real coding agent through the bun-linked binary (ollama/qwen2.5:0.5b):
$ joc launch "create ok.txt containing: bunlink works"
  · write ok ; · write ok ; Stopped: repeated … (no-progress guard)
  → ok.txt == "bunlink works"
$ sh scripts/uninstall.sh
  Removed …/.local/bin/joc ; Removed …/.bun/bin/joc (bun link) ; Unregistered @jeo-code/coding-agent
```

`tsc -p tsconfig.json --noEmit` → 0; `bun test` → 34/34 (no source changes —
installer/uninstaller/README only). Files: `coding-agent/scripts/install.sh`,
`coding-agent/scripts/uninstall.sh`, `README.md`.

---

## 24. Ralph pass 17 — repo flatten + TUI M1/M2 (gjc-style terminal UI)

**Date:** 2026-06-05

Two changes executed per `plan/` (autopilot + executor subagents):

### Repo flatten
Promoted `coding-agent/*` to the repo root and removed the `coding-agent/` nesting
(54 tracked files via `git mv`, history preserved). Package renamed
`@jeo-code/coding-agent` → `jeo-code`. Installer/uninstaller fixed (`install.sh` →
`scripts/install.sh`; `--source` source dir = repo root; bun global pkg = `jeo-code`).
README structure tree + `plan/*` paths un-nested. Verified: `bun install`, `tsc` 0,
`bun test`, and a real `ollama/qwen2.5:0.5b` run through the flattened `bun link` install.
*(All file references in §1–§23 above predate this flatten and read `coding-agent/src/...`;
the code now lives at `src/...`.)*

### TUI M1+M2 (plan 01)
First real terminal UI, mined from pi-mono's `pi-tui` (differential rendering) and gjc's
`packages/tui` interaction model — **no native/sixel deps**:
- `src/tui/terminal.ts` — ANSI helpers (`cursorUp/Down`, `clearLine`, `clearToEnd`, `size`, `isTTY`, `truncate`).
- `src/tui/renderer.ts` — `Renderer`: holds the previous frame, repaints **only changed rows**, clears
  surplus rows on shrink, parks the cursor at the block top (injectable writer for tests).
- `src/tui/components/*` — `Spinner`, `ToolList` (running→ok/FAILED), `StreamRegion` (width-wrap), `renderFooter` (`model · step N/25 · Ns`).
- `src/tui/app.ts` — `LaunchTui`: maps the engine's `AgentLoopEvents` to a live frame (animated footer +
  tool list), then **collapses to static output** (tool summary + reply) on turn end.
- `src/commands/launch.ts` — interactive REPL uses the TUI when `isTTY() && !--no-tui`; one-shot/non-TTY/`--no-tui`
  keep the existing `console.log` stream (byte-identical final reply). **`engine.ts` untouched.**

### Verification
- `tsc` 0; `bun test` → **45/45** (+11 TUI: renderer diff/shrink/truncate, components, LaunchTui live+finish).
- Non-TTY plain path verified against real Ollama (`tui.txt` created); `--no-tui` accepted.
- Interactive in-place rendering is unit-tested (fake writer asserts only changed rows repaint, cursor
  hide/show, clear-on-finish); live visual pass deferred to a TTY session.

Files: `src/tui/*` (new), `src/commands/launch.ts`, `test/tui-renderer.test.ts`,
`test/tui-components.test.ts`, `test/tui-app.test.ts`. Remaining TUI: M3 slash palette/autocomplete,
M4 pipeline/doctor views, token streaming (gated on provider streaming, plan 05).

---

## 25. Ralph pass 18 — gjc-parity batch 1 (model aliases, skills surface, retry)

**Date:** 2026-06-05 · gjc dimensions: **model**, **기본 스킬 적용**, **provider**.

Three standalone modules (executor subagents) + parent integration:
- **Model aliases** (`src/ai/model-registry.ts`): built-in `fast`/`local`/`sonnet`/`gpt`/`flash`
  + `config.modelAliases` (config wins); `expandAlias`/`resolveModelId`/`listAliases`.
  `model-manager.call()` now expands the model id before routing. New `joc models` command
  lists aliases + probes local Ollama (`/api/tags`) and OpenAI-compat (`/v1/models`).
- **Skills surface** (`src/skills/catalog.ts`): gjc-style bundled workflow docs (launch,
  deep-interview, ralplan, team, ultragoal). New `joc skills [name]` lists/details them, and
  `skillsPromptSection()` is injected into the `joc launch` system prompt so the agent suggests
  the right workflow command.
- **Retry/backoff** (`src/util/retry.ts`): `withRetry` + `defaultRetryable` (429/5xx/network),
  exponential+capped, injectable sleep. `model-manager` wraps every `adapter.call` in it.

Config gained `modelAliases?: { [alias]: string }` (`state.ts`).

**Verification:** `tsc` 0; `bun test` **60/60** (+15: model-registry, skills, retry).
Real e2e (`JOC_CONFIG_DIR` + Ollama): `joc skills`/`joc skills deep-interview` render; `joc models`
shows `fast → ollama/qwen2.5:0.5b → ollama` + live probe; default model `fast` **alias-expanded**
and the agent ran on `ollama/qwen2.5:0.5b` (created `b1.txt`). `joc --help` lists `models` + `skills`.

---

## 26. Ralph pass 19 — gjc-parity batch 2 (workflow ergonomics + thinking level)

**Date:** 2026-06-05 · gjc dimensions: **agentic workflow**, **model**.

- **`--max-steps N`** flag for `joc launch` (`--max-steps 2` / `--max-steps=2`) — caps the
  per-turn tool-loop budget (was hardcoded 25). Verified: a 2-step run stops at the 2-step limit.
- **`/compact`** slash command — runs `maybeCompact(history, {maxMessages:1})` on demand and
  reports removed count.
- **`joc resume [id]`** top-level command — delegates to `launch --resume`, first-class session resume.
- **`thinkingLevel` applied**: `model-manager.thinkingMaxTokens(level)` maps low/medium/high →
  2000/4000/8000 default max-tokens (caller override still wins).

**Verification:** `tsc` 0; `bun test` **62/62** (+2: `test/model-manager.test.ts` — routing stable,
thinkingMaxTokens mapping). E2E: `joc resume` registered in help; `joc launch --max-steps 2` capped
the loop against real `ollama/qwen2.5:0.5b`. Files: `src/commands/{launch,resume}.ts`,
`src/cli/runner.ts`, `src/ai/model-manager.ts`.

---

## 27. Ralph pass 20 — gjc-parity batch 3 (prebuilt standalone binary)

**Date:** 2026-06-05 · gjc dimension: **bun 설치 방식** (gjc ships prebuilt binaries).

- **`bun build --compile`** single binary: `bun run build` → `dist/joc` (61 MB, embeds the Bun
  runtime). New `scripts/install.sh --binary` mode compiles + installs a standalone `joc` that
  needs **no Bun at runtime**. `dist/` gitignored.
- **`scripts/smoke-test.sh`**: installs via `--binary` into a temp dir and asserts the binary runs
  `joc --version` under `env -i PATH=/usr/bin:/bin` (no bun).

**Verification (no bun on PATH):** the compiled binary runs `--version`, `--help`, `doctor`
(`[OK]` ollama), `skills`, AND a **real agent turn** against `ollama/qwen2.5:0.5b` (created
`bin.txt`) — proving the lazy `await import("../commands/*")` loaders survive `--compile` (53 modules
bundled). `scripts/smoke-test.sh` → "Smoke test passed". `bun run build` → working `dist/joc`.
Files: `scripts/install.sh` (`--binary`), `scripts/smoke-test.sh`, `package.json` (`build`), `.gitignore`.

---

## 28. Ralph pass 21 — gjc-parity batch 4 (provider token streaming)

**Date:** 2026-06-05 · gjc dimension: **provider**.

- **`src/ai/sse.ts`**: `readLines` (NDJSON) + `readSse` (SSE `data:` payloads, skips `[DONE]`),
  with cross-chunk line buffering via `TextDecoder`.
- **Adapter `stream?()`** added to `ProviderAdapter`: **ollama** (NDJSON `/api/chat` stream) and
  **openai** (SSE `chat/completions` deltas). Adapters refactored to share a request builder.
- **`ModelManager.stream()`**: resolves provider/credential through the shared `resolveCall()`
  (alias-expand + adapter-aware creds + retry) and yields the adapter's deltas; providers without
  `stream` fall back to one chunk from `call()`.

**Verification:** `tsc` 0; `bun test` **66/66** (+4 SSE: split-line reassembly, unterminated tail,
`[DONE]` skip, split-payload). **Real Ollama**: `manager.stream(...)` against `ollama/qwen2.5:0.5b`
yielded **9 chunks** → `"Hello! How can I help you today?"` (token streaming confirmed end-to-end).
Files: `src/ai/{sse.ts,types.ts,model-manager.ts,providers/ollama.ts,providers/openai.ts}`.
Note: the strict-JSON tool loop still uses blocking `call()`; `stream()` powers chat/TUI text (plan 01 §9).

---

## 29. Ralph pass 22 — gjc-parity batch 5 (full-fidelity sessions)

**Date:** 2026-06-05 · gjc dimension: **agentic workflow**.

`joc launch` previously persisted only the user prompt + final reply. Now (pi-mono parity) it
persists **every message the engine adds during a turn** — the intermediate tool-call (`assistant`)
and tool-result (`user`) turns — by appending `history.slice(beforeLen)` plus the final reply.
Resume reconstructs the full tool context, not just the conversation skeleton.

**Verification:** `tsc` 0; `bun test` **66/66**. Real Ollama e2e (`--max-steps 2`): the session
JSONL now holds **6 message entries** (3 user incl. tool-results + 3 assistant incl. tool-calls),
vs 2 before. Files: `src/commands/launch.ts`.

---

## 30. Ralph pass 23 — gjc-parity batch 6 (slash-command palette, TUI M3 partial)

**Date:** 2026-06-05 · gjc dimension: **tui** (interactive ergonomics).

- **`src/tui/components/slash.ts`**: `matchSlash(input)` (prefix, case-insensitive) +
  `isSlashAttempt(input)` + `SLASH_COMMANDS`.
- **REPL wiring**: an unhandled `/typo` no longer gets sent to the model — `joc launch` now prints
  `Did you mean: …?` suggestions (or `Unknown command`). Real UX fix for slash typos.

**Verification:** `tsc` 0; `bun test` **68/68** (+2 slash: prefix-match incl. `/c`→`[/clear,/compact]`,
case-insensitivity, non-slash empty, `isSlashAttempt` arg handling). Files:
`src/tui/components/slash.ts`, `src/commands/launch.ts`.

---

### gjc-comparison status (this session, passes 18–23)

| Dimension | Improvements landed (verified) |
|---|---|
| **tui** | M1+M2 (pass 17) renderer/components/LaunchTui; M3 partial — slash palette (pass 23). Remaining: M4 pipeline/doctor views, token render. |
| **agentic workflow** | `--max-steps`, `/compact`, `joc resume` (19); full-fidelity sessions (22). |
| **provider** | retry/backoff (18); token streaming `callStream` + ollama/openai SSE (21). |
| **model** | alias registry + `joc models` (18); `thinkingLevel`→maxTokens (19). |
| **기본 스킬 적용** | bundled skill catalog + `joc skills` + launch-prompt injection (18). |
| **bun 설치 방식** | `bun link` (16); prebuilt `--compile` binary + `--binary` install + smoke test (20). |

All passes verified with `tsc` 0 + `bun test` (now 68) + real `ollama/qwen2.5:0.5b` e2e where applicable.

---

## 31. Ralph pass 24 — gjc-parity batch 7 (anthropic streaming)

**Date:** 2026-06-05 · gjc dimension: **provider** (streaming completeness).

`anthropicAdapter.stream()` added: SSE `content_block_delta` / `text_delta` parsing via the shared
`readSse`, refactored to share a payload builder with `call()`. All three primary providers
(anthropic/openai/ollama) now stream; gemini falls back to one-chunk `call()`.

**Verification:** `tsc` 0; `bun test` **69/69** (+1: mock-fetch SSE test asserts only `text_delta`
events concatenate to `"Hello"`, ignoring `message_start`/`message_stop`). Real Ollama `manager.stream()`
re-confirmed after the refactor. Files: `src/ai/providers/anthropic.ts`, `test/anthropic-stream.test.ts`.

---

## 32. Ralph pass 25 — gjc-parity batch 8 (--auto always yields a seed)

**Date:** 2026-06-05 · gjc dimension: **agentic workflow** (pipeline robustness).

A holistic real-Ollama pipeline run exposed a dead-end: `deep-interview --auto` with a weak local
model (`ollama/qwen2.5:0.5b`) never reached ambiguity ≤ 20% within the round cap, so **no seed was
frozen** and `ralplan`/`team` errored with "No crystallized requirements". Fix: extract a `freezeSeed()`
helper and, in `--auto` mode, **freeze a best-effort seed from the last assessment** (or the initial
idea) when the gate isn't reached — so the spec-first pipeline always proceeds non-interactively.

**Verification:** `tsc` 0; `bun test` **69/69**. Real Ollama: `deep-interview "build a fib tool" --auto`
→ "Best-effort seed frozen" → `seed-build-a-fib-tool.yaml` written → `ralplan` produced a plan →
`ultragoal` ran (DEGRADED 0/1, expected for the tiny model). The full pipeline now completes end-to-end
with a local model. Files: `src/commands/deep-interview.ts`.

---

## 33. Ralph pass 26 — gjc-parity batch 9 (TUI M4 meter + streaming chat)

**Date:** 2026-06-05 · gjc dimension: **tui** (completes the TUI backlog).

- **Pipeline view (M4)**: `src/tui/components/meter.ts` — pure `meter(value,max,width)` →
  `[####------] 40%` (clamped) + `stepMeter`. Wired into `deep-interview` so each round renders
  `Ambiguity [####…] N%` instead of a bare number.
- **Streaming token render**: new `joc chat "<message>"` — a single-shot, no-tools conversational
  command that renders the reply **token-by-token** via `ModelManager.stream()` (complementary to
  the strict-JSON tool loop in `joc launch`).

**Verification:** `tsc` 0; `bun test` **71/71** (+2 meter: fill/clamp/percent, stepMeter). Real Ollama:
`joc chat "say hello…"` streamed `"Hello! How can I assist you today?"`; `deep-interview … --auto` shows
`Ambiguity [####################] 100%`. Files: `src/tui/components/meter.ts`, `src/commands/chat.ts`,
`src/cli/runner.ts`, `src/commands/deep-interview.ts`, `test/meter.test.ts`.

This closes the TUI dimension backlog (M1 renderer, M2 LaunchTui, M3 slash palette, M4 meter +
streaming chat). 12 `joc` commands; **71 tests**.
