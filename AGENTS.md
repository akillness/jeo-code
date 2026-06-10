<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# jeo-code

## Purpose
`jeo-code` (binary `joc`) is a pure-TypeScript AI coding agent that runs on Bun with zero native dependencies. It re-implements the `gajae-code` (`gjc`) spec-first workflow contract and adopts `pi-mono` runtime ergonomics.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Project dependencies, scripts, and publication metadata |
| `tsconfig.json` | TypeScript configuration enabling strict types and Bun imports |
| `bun.lock` | Lockfile for Bun package dependencies |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Application source code containing CLI, agent engine, AI providers, auth, TUI, MCP, and skills (see `src/AGENTS.md`) |
| `test/` | Flat directory containing full `bun:test` unit and integration test suites (see `test/AGENTS.md`) |
| `docs/` | Project documentation and architectural changelog improvements (see `docs/AGENTS.md`) |
| `scripts/` | Shell scripts for installation, uninstallation, and local checks (see `scripts/AGENTS.md`) |
| `plan/` | Implementation planning blueprints and milestones (see `plan/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Use TypeScript strict mode and strict ESM patterns.
- Do not add external native or runtime dependencies (keep it zero-dependency, Bun-only).
- Maintain compatibility with Bun versions >= 1.3.14.

### Testing Requirements
- Run `bun test` to execute all tests (must be all green).
- Run `bun run typecheck` to ensure no TypeScript compilation issues.

### Common Patterns
- Free functions over classes for command/CLI registry handlers.
- Safe tool error handling (return `ToolResult` instead of throwing exceptions).

## Dependencies

### External
- Bun >= 1.3.14 (Runtime & Test Runner)
- Zod (Runtime config validation)
- Chalk (Doctor connectivity reporting colors)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Repository Guidelines

## Project Overview

`jeo-code` (binary **`joc`**) is a pure-TypeScript AI coding agent that runs on **Bun** with
**zero native dependencies**. It re-implements the `gajae-code` (`gjc`) spec-first workflow
contract and adopts `pi-mono` runtime ergonomics. Two surfaces:

- **Interactive agent** — bare `joc` / `joc launch` drives a `read/write/edit/bash/find/search`
  tool loop until the request is done (live TUI on a TTY, plain stream otherwise).
- **Spec-first pipeline** — `deep-interview → ralplan → team → ultragoal`: clarify requirements,
  plan, execute, verify. A **MutationGuard** blocks code writes until ambiguity ≤ 20%.

## Architecture & Data Flow

Layered, mostly free functions; classes are rare (`LaunchTui`, `Renderer`, `ProviderHttpError`,
OAuth callback flow).

```
src/cli.ts (Bun version guard ≥1.3.14)
  → src/cli/runner.ts  (COMMANDS registry, lazy import per command, suggestCommands)
    → src/commands/<cmd>.ts        (runXCommand(args))
      → src/agent/engine.ts        (runAgentLoop: JSON tool-call loop, shared by launch + team)
        → src/agent/tools.ts       (read/write/edit/bash/find/search → ToolResult)
        → src/agent/loop.ts        (callLlm) → src/ai/model-manager.ts
          → resolveProvider(modelId) → src/ai/providers/{anthropic,openai,gemini,ollama}.ts
            → src/auth/* (resolveCredential: OAuth bearer / API key / none)
```

A turn: command builds a `Message[]` history (system prompt + project context + skills section) →
`runAgentLoop` asks the model for **one** strict-JSON tool call per step
(`{ "tool": "...", "arguments": {...} }`), dispatches it, appends the truncated result, repeats
until the model calls `done` or a guard/step-cap fires. Provider adapters expose `call` and
`stream`; both report token `usage` via an `onUsage` sink.

Guards in `runAgentLoop` (`src/agent/engine.ts`): **no-progress** (stop after 3 identical calls),
**consecutive-failure** (stop after 5 failing calls), step cap (`--max-steps`, default 25 in
launch / 15 in team), and `AbortSignal` (Ctrl-C cancels the in-flight turn).

## Key Directories

| Path | Purpose |
| --- | --- |
| `src/agent/` | Tool engine (`engine.ts`), tools + MutationGuard (`tools.ts`), `loop.ts`, `json.ts`, `session.ts`, `compaction.ts`, `context-files.ts`, `state.ts` |
| `src/ai/` | `model-manager.ts` (catalog-authoritative routing/credentials + `describeModelDetailed`), `model-registry.ts` (aliases + reverse-alias/validation), `model-catalog.ts` (curated models: provider/context/reasoning/recommended + fuzzy `suggestModels`), `provider-status.ts` (credential readiness), `types.ts`, `sse.ts`, `providers/{anthropic,openai,gemini,ollama,errors}.ts` |
| `src/auth/` | OAuth PKCE, callback-server, token storage + auto-refresh, `flows/{anthropic,openai,google}` |
| `src/commands/` | `launch, setup, auth, deep-interview, ralplan, approve, team, ultragoal, doctor, mcp, models, skills, resume, chat, evolve` (15) |
| `src/tui/` | `app.ts` (`LaunchTui`, fills terminal width+height on a TTY), `renderer.ts` (differential ANSI), `terminal.ts` (ANSI-aware `truncate`), `components/` (`evolution.ts` = canonical 5-stage model + sub-stage/transition helpers, `color.ts` = capability + truecolor gradient, `capability.ts` = unicode detection, `layout.ts` = fit/center/box, `themes.ts` = cosmic/matrix/solar/mono, `select-list.ts` = keyboard-navigable picker, `model-picker.ts`/`provider-picker.ts` = catalog-driven choosers, `autocomplete.ts` = `<Tab>` completion (slash names + live model/provider/role args), `config-panel.ts` = `/model`·`/provider`·`/config` formatters, footer, meter+sparkline, ascii-art (+frames), tool-list, spinner, stream, slash) |
| `src/mcp/` | MCP stdio server (`server.ts`, `tools.ts`, `protocol.ts`); set `JOC_MCP_PIPELINE=1` to expose pipeline tools |
| `src/skills/` | `catalog.ts` — `SKILLS` docs + `skillsPromptSection()` injected into the launch prompt |
| `test/` | 82 `bun:test` suites |
| `scripts/` | `install.sh` (canonical), `uninstall.sh`, `smoke-test.sh` |
| `plan/`, `docs/improvements.md` | Roadmap + ralph-pass changelog (changes are logged here) |

## Development Commands

```bash
bun install                  # deps: zod (config validation), chalk (doctor colors)
bun run start --help         # = bun src/cli.ts --help
bun run typecheck            # tsc -p tsconfig.json --noEmit   (must be 0)
bun test                     # full suite (82 files)
bun test test/engine.test.ts # single suite
bun run build                # bun build src/cli.ts --compile --outfile dist/joc
```

There is **no linter/formatter** configured — `bun run typecheck` + `bun test` are the gates.
Google OAuth ships a bundled gemini-cli installed-app client secret; `GEMINI_OAUTH_CLIENT_SECRET` only overrides it for self-provisioned clients.

## Code Conventions & Common Patterns

- **TypeScript strict + ESM only.** `tsconfig.json`: `strict`, `verbatimModuleSyntax`,
  `moduleResolution: bundler`, `allowImportingTsExtensions`, `types: ["bun"]`, `noEmit`. Imports
  may include `.ts` extensions; no `.js` rewriting.
- **Free functions over classes.** Commands export `runXCommand(args: string[]): Promise<void>`;
  registered lazily in `src/cli/runner.ts`.
- **Tool error model:** tools return `ToolResult { success: boolean; output: string; error?: string }`
  — never throw to the loop. The MutationGuard throws inside the tool, which is caught and mapped to
  `{ success: false, error }`.
- **Async/await everywhere;** providers use `fetch` + `AsyncGenerator` SSE (`src/ai/sse.ts`).
  Pass `options.signal` through to `fetch` for cancellation.
- **Provider errors carry status:** throw `ProviderHttpError(provider, status, detail)`
  (`src/ai/providers/errors.ts`); `src/util/retry.ts` `withRetry`/`defaultRetryable` retries
  `408/425/429/5xx/529` with exponential backoff.
- **Model routing** (`resolveProvider`, `src/ai/model-manager.ts`): `ollama/*`→ollama;
  `openai/*` | `gpt*` | `/(^|\/)o\d/`→openai; `google/*` | `*gemini*`→gemini; else anthropic.
  Aliases (`fast`, `local`, `sonnet`, `gpt`, `flash`) expand via `model-registry.ts`; use
  `describeModel(id)` for alias→resolved→provider.
- **State is plain JSON, validated, env never overrides disk.** `readGlobalConfig()`
  (`src/agent/state.ts`) reads `~/.joc/config.json`, validates it via `parseConfig`
  (`src/agent/config-schema.ts`, zod) — on a bad config it warns and falls back to env defaults — then
  overlays env vars only for gaps. Workflow state is `.joc/state/<skill>-state.json`.
- **Provider retry budgets (gjc parity):** `config.retry.requestMaxRetries` (retries, excluding
  the initial request) and `retry.maxDelayMs` (backoff cap) feed `resolveRetryOptions`
  (`src/ai/model-manager.ts`) → `withRetry` (`src/util/retry.ts`) at both `call`/`stream` sites;
  `streamMaxRetries`/`maxRetries` are accepted for gjc-config compatibility. Only transient
  errors retry (`defaultRetryable`); auth/bad-model/malformed stay fail-fast.
- **`edit` tool patch syntax** (`src/agent/tools.ts`): `≔A..B` replace lines, `≔A+` insert after line
  A (`≔0+` prepends), `≔$` append to EOF, or a `<<<<<<< SEARCH/=======/>>>>>>>` block. Keep
  `TOOL_PROTOCOL` (`src/agent/engine.ts`) in sync when changing it.
- **Dependency injection for tests:** functions accept injectable sinks (`onUsage`, `write`,
  `sleep`, `tools`, `cwd`, `timeoutMs`) and `callLlm` is `mock.module`-able.
- **Search hygiene:** `find`/`search` prune `IGNORED_DIRS` (`node_modules`, `.git`, `dist`,
  `build`, `.joc`, `vendor`, …). New default tools/aliases go in `src/agent/engine.ts`
  (`DEFAULT_TOOLS`, `TOOL_PROTOCOL`) and `src/ai/model-registry.ts`.
- **Log the work:** append a numbered "ralph pass" entry to `docs/improvements.md` for notable
  changes, and keep README counts/feature rows in sync.

## Important Files

- `src/cli.ts` — entry; enforces `MIN_BUN_VERSION = "1.3.14"`, sets `process.title`, calls `dispatch`.
- `src/cli/runner.ts` — `COMMANDS` registry, `dispatch`, `renderHelp`, `suggestCommands` (typo "did you mean").
- `src/agent/engine.ts` — `runAgentLoop`, `DEFAULT_TOOLS`, `TOOL_PROTOCOL`, `truncateToolOutput` (head+tail).
- `src/agent/tools.ts` — the six tools + `assertMutationAllowed` / `assertBashAllowed`.
- `src/agent/state.ts` — `Config`, `WorkflowState`, config/state I/O, `JOC_CONFIG_DIR`.
- `src/ai/model-manager.ts` / `model-registry.ts` — routing, credentials, aliases.
- `src/commands/launch.ts` — interactive REPL + slash commands (`/help /clear /compact /model /sessions /exit`).
- `package.json` / `tsconfig.json` — scripts + strict ESM config.

## Runtime/Tooling Preferences

- **Bun only** (≥ `1.3.14`); not Node.js. Use `Bun.spawn`, `Bun.file`, `bun:test`, `bun build`.
- **Package manager: Bun** (`bun install`, `bun.lock`). Install is a single bun global install
  (gjc parity: `bun install -g gajae-code`), which exposes `joc` at `~/.bun/bin/joc` plus a
  compatibility symlink at `~/.local/bin/joc`:
  ```bash
  bun install -g jeo-code                                      # npm registry (once published)
  bun install -g github:akillness/jeo-code                     # GitHub shorthand
  bun install -g git+https://github.com/akillness/jeo-code.git # explicit Git URL
  sh scripts/install.sh --registry https://registry.npmjs.org/ # one-shot registry, no npm config mutation
  sh scripts/install.sh --ref v0.1.0                           # global install of a tag (--binary for a compiled bin)
  ./install.sh                                # dev install from a clone (= scripts/install.sh --local, bun link)
  sh scripts/uninstall.sh --purge            # remove bin + ~/.joc/
  ```
- **Run entrypoints (gjc parity):** bare `joc` (current checkout), `joc --tmux`
  (create/attach a directory-scoped `joc-<branch>-<dir>-<hash>` tmux leader, so different
  projects/worktrees on the same branch do not collide), `joc --tmux --worktree <path>` (run in a
  dedicated git worktree). `dispatch` routes a bare call or any leading `--flag` to `launch`;
  `--worktree` is stripped from the inner tmux command since the session cwd is the worktree.
- Runtime config: global `~/.joc/config.json` (dir `0700`, file `0600`; override dir with
  `JOC_CONFIG_DIR`); per-project `<cwd>/.joc/` (`seeds/`, `plans/`, `state/`, `sessions/`).
  Env: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `*_OAUTH_TOKEN`, `OLLAMA_HOST`,
  `OPENAI_BASE_URL`, `JOC_DEFAULT_MODEL`.
- Local/offline default works with no key: `ollama pull qwen2.5:0.5b` + `JOC_DEFAULT_MODEL=fast`.
  Verify reachability with `joc doctor` (`--json` for CI, `--strict` exits non-zero if not ready).

## Testing & QA

- **Runner:** `bun:test` — `import { test, expect, mock, beforeAll, afterAll } from "bun:test"`.
- **Patterns:** `mock.module("../src/agent/loop", …)` to stub `callLlm`; `fs.mkdtemp` temp dirs for
  fs/state tests; reassign `console.log` to capture output; inject `write`/`sleep`/`timeoutMs`
  sinks; set `JOC_CONFIG_DIR` / `JOC_DEFAULT_MODEL` to isolate config.
- **Coverage focus:** test observable behavior, edge values, branch/guard conditions, and error
  paths — not defaults or tautologies. Co-locate a focused test with each change
  (e.g. `test/engine.test.ts`, `test/tools-fs.test.ts`, `test/provider-errors.test.ts`,
  `test/cli-runner.test.ts`, `test/mutation-guard.test.ts`).
- **Gate before yielding:** `bun run typecheck` → 0 and `bun test` → all green. For agent/provider
  changes, prefer a real local check (e.g. `JOC_DEFAULT_MODEL=fast joc launch --no-tui --max-steps 4 "…"`
  against Ollama) over claims.
