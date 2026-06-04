# @jeo-code — Socratic Spec-First AI Coding Agent

> Stop prompting. Start specifying. Deliver with absolute confidence.

`@jeo-code` is a lightweight, pure TypeScript coding agent CLI (`joc`) built for Bun. Run bare `joc` for an **interactive coding agent** (chat + tools), or use the disciplined Ouroboros **spec-first pipeline** to guarantee requirements are fully crystallized before a single line of codebase code is modified.

```text
joc                      →  interactive coding agent (chat + read/write/edit/bash/find/search)

joc deep-interview ──> joc ralplan ──> joc team ──> joc ultragoal
(Socratic Interview)     (Blueprint)     (Execution)   (Verification)
        │
  [Mutation Lock]
(Code edits blocked while ambiguity > 20%)
```

---

## 🌟 Key Architecture & Highlights

### 1. Socratic Ambiguity Gate (`joc deep-interview`)
Instead of jumping straight to implementation, `@jeo-code` initiates a structured Socratic requirements loop. The agent measures ambiguity across three dimensions:
1. **Goal Clarity**
2. **Constraints Completeness**
3. **Success/Acceptance Criteria Definition**

The interview loops interactively with the user until the **Ambiguity Score drops to ≤ 20%**. Once resolved, a frozen requirement seed is saved to `.joc/seeds/seed-[slug].yaml`.

### 2. Secure Codebase Mutation Guard (Strict Lock)
To prevent the model from implementing incomplete or ambiguous features, the **MutationGuard middleware** dynamically blocks codebase-modifying tools (`write`, `edit`) while a Socratic interview is active.
- Only spec/planning modifications inside the `.joc/` runtime directory are permitted.
- The lock dynamically releases once the Ambiguity Score falls to `≤ 20%` and requirements are successfully crystallized.

### 3. Critiqued Planning Blueprint (`joc ralplan`)
The requirements seed (`seed.yaml`) is parsed and fed to a multi-role (Planner, Architect, Critic) agent system. It maps codebase structures and creates a step-by-step implementation sequence stored in `.joc/plans/plan-[slug].yaml`.

### 4. Bounded Executor Subagent (`joc team`)
Expose the plan to parallel or sequential executor sessions. The executor uses a highly secure toolset (`read`, `write`, `edit`, `bash`, `find`, `search`) and operates until tasks are successfully implemented.

### 5. Durable Checkpoint Verification (`joc ultragoal`)
Continuously measures the execution status against the acceptance criteria, running tests via bash and producing a final report in `.joc/state/ultragoal-report.md`.

### 6. Interactive Coding Agent (`joc launch` / bare `joc`)
A shared, hardened tool-call engine (`src/agent/engine.ts`) powers both `team` and the interactive REPL. Run bare `joc` to chat with the agent — it calls `read`/`write`/`edit`/`bash`/`find`/`search` in a loop until your request is done. Supports one-shot (`joc launch "..."`) and piped/non-TTY use.

### 7. Real OAuth + Local Providers (`joc auth`, `joc doctor`)
Real PKCE OAuth (`joc auth login`) with a local callback server and automatic token refresh, plus API keys, Ollama, and any OpenAI-compatible endpoint. `joc doctor` probes connectivity, credentials, and OAuth token expiry. `joc mcp serve` exposes joc as an MCP stdio server.

---

## 🚀 Installation & Onboarding

### Requirements
- **Bun Runtime** `v1.3.14+`

### Installation
Run the automated installer from the workspace root. It delegates to the
canonical `coding-agent/scripts/install.sh` (single source of truth), which
auto-installs Bun if missing, enforces the `v1.3.14+` floor, symlinks the `joc`
binary to `~/.local/bin/joc`, and prints a PATH hint if needed:
```bash
chmod +x ./install.sh
./install.sh                       # delegates to scripts/install.sh --local
# advanced (clone + install a tag): sh coding-agent/scripts/install.sh --ref v0.1.0
```
Local dev without installing (run from `coding-agent/`):
```bash
bun run start --help               # = bun src/cli.ts --help
bun run typecheck                  # tsc -p tsconfig.json --noEmit
bun test                           # unit tests (oauth + engine/json)
```
Uninstall: `sh coding-agent/scripts/uninstall.sh [--purge]`.

### 🔑 Interactive Setup
Setup your LLM provider API keys (Gemini, Anthropic, or OpenAI) and default model:
```bash
joc setup
```
Configuration is stored securely under `~/.joc/config.json`.

### Providers, OAuth & local models
Model routing is inferred from the model id, and credentials resolve from `~/.joc/config.json` or env:

| Provider | Model id example | Credential |
| --- | --- | --- |
| Anthropic | `claude-3-5-sonnet` | `ANTHROPIC_API_KEY` or OAuth (`ANTHROPIC_OAUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) |
| OpenAI | `gpt-4o` | `OPENAI_API_KEY` or `OPENAI_OAUTH_TOKEN` |
| Gemini | `gemini-2.5-flash` | `GEMINI_API_KEY` or `GEMINI_OAUTH_TOKEN` |
| Ollama (local) | `ollama/qwen2.5:0.5b` | none — runs offline via `OLLAMA_HOST` (default `http://localhost:11434`) |

- **Real OAuth (PKCE)**: `joc auth login <anthropic|openai|gemini>` runs a real
  browser PKCE flow — it opens the provider's authorize URL, runs a local
  callback server (Anthropic `:54545`, OpenAI `:1455`, Google `:8085`), exchanges
  the code, and stores `access` + `refresh` + `expires`. Tokens **auto-refresh**
  on the next call when expired; `joc auth refresh <provider>` forces it now.
  On headless boxes, paste the redirect URL / code when prompted, or use
  `joc auth login <provider> --token <bearer>` for a manual (non-refreshing) token.
- **OAuth precedence & verification**: OAuth beats API keys for the same provider.
  Anthropic OAuth is verified end-to-end with the bundled Messages adapter
  (`Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`). OpenAI/Google
  OAuth login+refresh work, but those tokens target the Codex / Cloud-Code-Assist
  backends — the bundled chat/generativelanguage adapters prefer an API key
  (the CLI warns you up front). Env bearers (`ANTHROPIC_OAUTH_TOKEN` /
  `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_OAUTH_TOKEN`, `GEMINI_OAUTH_TOKEN`) still work.
- **Local/offline**: set the default model to `ollama/<model>` (e.g. `JOC_DEFAULT_MODEL=ollama/qwen2.5:0.5b`) after `ollama pull <model>` — no key required. Any OpenAI-compatible server (LM Studio / vLLM / llama-cpp) works via `openaiBaseUrl`.
- **Config location**: `~/.joc/config.json` by default; override with `JOC_CONFIG_DIR`. Verify everything with `joc doctor` (probes connectivity + shows OAuth token expiry).

---

## 💻 Workflow Commands

### Interactive agent (default)
Run `joc` with no subcommand to drop into the interactive coding agent — it
chats and calls tools (`read`/`write`/`edit`/`bash`/`find`/`search`) in a loop
until your request is done:
```bash
joc                         # interactive REPL (slash cmds: /help /clear /model <id> /exit)
joc launch "add a /health route to server.ts and run the tests"   # one-shot
echo "fix the failing test" | joc                                 # piped / non-TTY
```

For the disciplined spec-first pipeline, use the four workflow commands below.
`joc deep-interview --auto` runs the interview non-interactively (CI/pipes) by
supplying sensible default answers instead of blocking on stdin.

### Step 1: Crystallize Requirements
```bash
joc deep-interview "Create a python CLI tool to calculate Fibonacci numbers"
```
*Note: Any attempt to modify code files will be blocked by the MutationGuard during this active phase.*

### Step 2: Generate Planning Blueprint
```bash
joc ralplan
```

### Step 3: Run Team Execution
```bash
joc team
```

### Step 4: Verify Acceptance Criteria
```bash
joc ultragoal
```

---

## 🛠️ Codebase Structure

```text
@jeo-code/
├── docs/
│   └── improvements.md            # Architectural analysis & ralph passes
├── coding-agent/
│   ├── package.json               # Bun bin: { joc: src/cli.ts }
│   ├── tsconfig.json              # strict typecheck config
│   ├── src/
│   │   ├── cli.ts                 # Entry: Bun version guard + dispatch
│   │   ├── index.ts               # SDK barrel
│   │   ├── cli/
│   │   │   └── runner.ts          # Lazy command registry + dispatch (bare joc → launch)
│   │   ├── commands/
│   │   │   ├── launch.ts          # Interactive coding agent (REPL / one-shot)
│   │   │   ├── setup.ts           # Provider/model config (API key / browser OAuth / local)
│   │   │   ├── auth.ts            # OAuth login/logout/refresh/status
│   │   │   ├── deep-interview.ts  # Socratic interview + ambiguity gate (--auto)
│   │   │   ├── ralplan.ts         # Planner/Architect/Critic plan generator
│   │   │   ├── team.ts            # Per-task executor (runs on the shared engine)
│   │   │   ├── ultragoal.ts       # Acceptance verification + report
│   │   │   ├── doctor.ts          # Connectivity + credential health probe
│   │   │   └── mcp.ts             # joc as an MCP stdio server
│   │   ├── agent/
│   │   │   ├── state.ts           # Config (~/.joc, JOC_CONFIG_DIR) + workflow state
│   │   │   ├── loop.ts            # callLlm() → model-manager
│   │   │   ├── engine.ts          # runAgentLoop() shared tool-call loop
│   │   │   ├── json.ts            # Robust JSON-from-LLM extraction
│   │   │   └── tools.ts           # read/write/edit/bash/find/search + MutationGuard
│   │   ├── ai/                    # Provider adapters + model-manager
│   │   ├── auth/                  # Credentials + real OAuth
│   │   │   ├── storage.ts         # Credential resolution + auto-refresh
│   │   │   ├── pkce.ts            # PKCE verifier/challenge
│   │   │   ├── callback-server.ts # Local OAuth callback server
│   │   │   ├── refresh.ts         # Per-provider token refresh dispatch
│   │   │   └── flows/             # anthropic / openai / google OAuth flows
│   │   └── mcp/                   # MCP protocol + tools + server
│   ├── scripts/                   # install.sh / uninstall.sh
│   └── test/                      # oauth + engine/json unit tests
├── install.sh                     # Top-level installer shim
└── README.md
```
