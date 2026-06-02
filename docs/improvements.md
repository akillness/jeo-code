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
