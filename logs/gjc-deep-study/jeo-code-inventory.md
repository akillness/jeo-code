# jeo-code Feature Inventory (CURRENT state)

> Scope: read-only inventory of `~/.superset/projects/jeo-code/src` + `package.json`, mirroring a gjc inventory so a side-by-side diff is mechanical. Binary: `joc`. Every claim cites a file.

---

## 1. RUNTIME / PERF MODEL

### Pure-TS Bun, zero native deps
- `package.json`: `"type": "module"`, `bin: { "joc": "src/cli.ts" }`, `engines.bun: ">=1.3.14"`. **Runtime deps are only `zod ^3.24.1` + `chalk ^5.3.0`**; devDeps are `@types/bun`, `typescript`. No native/compiled modules. Build path is `bun build src/cli.ts --compile --outfile dist/joc` (single-binary compile).
- `AGENTS.md` (repo root): "pure-TypeScript AI coding agent that runs on Bun with zero native dependencies".
- Markdown prompt assets are imported as text via Bun import attributes, e.g. `import executorPrompt from "../prompts/agents/executor.md" with { type: "text" }` (`src/agent/subagents.ts`), and SKILL.md files in `src/skills/catalog.ts`. Type decls: `src/md-modules.d.ts`, `src/bun-imports.d.ts`.

### Shell execution model: child_process via `Bun.spawn` (NO PTY)
- `bashTool` (`src/agent/tools.ts:376-440`) runs `Bun.spawn(["bash","-c",command], { cwd, stdout:"pipe", stderr:"pipe", env })`. Pipes (not a PTY). Timeout default 120_000ms; on timeout escalates `proc.kill()` (SIGTERM) → after 3s `proc.kill(9)` (SIGKILL). Output capped at 100_000 chars. Env is sanitized (string values only) and merged over `process.env`.
- A second helper `spawnTextWithTimeout` (`src/agent/tools.ts:444-466`) does the same SIGTERM→SIGKILL escalation for internal `find`/`search` shell-outs (default 60s).
- `git` is invoked via `Bun.spawnSync` for branch detection (`src/commands/launch.ts:679`, `symbolic-ref --quiet --short HEAD`).
- No `node-pty` / pseudo-terminal anywhere; interactive shell commands that need a TTY are not supported through the bash tool.

### TUI rendering: diff-based ANSI Renderer + inline scrollback (pass-888/889 work)
- `src/tui/renderer.ts` — `Renderer` class: keeps `prev: string[]`, diffs against `next` line-by-line, emits only changed rows with `cursorUp/cursorDown/toColumn/clearLine` (per-line EL `\x1b[2K`, never clear-to-end in reserve mode). Wraps frames in DECSET 2026 synchronized update (`\x1b[?2026h`/`\x1b[?2026l`) so insertAbove + repaint present atomically (tmux ≥3.4 supported; unsupported terminals ignore + time out ~150ms).
- **Inline (main-buffer) mode** (`reserve: true`, default on TTY): before painting a taller frame it reserves missing rows with real `\n` (scrolls older content up into normal scrollback). `insertAbove(text)` flushes completed ledger lines into scrollback ABOVE the live frame via EL-overwrite + baseline drop, so tmux / mouse-wheel can review progress mid-turn. This is the recent gjc-parity work: per comments in `src/tui/app.ts` (lines ~141-154, 244-248 "gjc-parity glyph-first ledger line", 269-279, 370-377, 642-647) ledger lines are flushed live with a leading `✔/✗` glyph; the in-frame StreamRegion tail is suppressed in inline mode to avoid double-render on wheel-scroll.
- Legacy alternate-screen turn (`enterAltScreen`/`leaveAltScreen` in `src/tui/terminal.ts`) is opt-in via `JOC_TUI_ALT_SCREEN=1` (scroll-isolated, no mid-turn scrollback).
- `src/tui/terminal.ts`: cursor/EL primitives, `size()` (cols/rows from `process.stdout`), `isTTY()`, and a width-aware `truncate()` that copies SGR escapes verbatim (sticky regex), counts only visible columns, and appends `\x1b[0m` on a mid-color cut.

---

## 2. WORKFLOW SURFACE

### Workflows exist BOTH as native `joc` subcommands AND as bundled prompt skills
Native subcommands (`src/cli/runner.ts` `COMMANDS` list, lines 8-209):
`launch, setup, auth, export, deep-interview, ralplan, approve, team, ultragoal, doctor, mcp, models, skills, resume, chat, evolve, state, session, update, gjc, ooo-seed, status, evolve-core`.

The four workflow skills are present as **both** native commands and as in-prompt SKILL.md guidance (`src/skills/catalog.ts:1-29`): `deep-interview`, `ralplan`, `team`, `ultragoal`, plus a fifth `gjc` skill. SKILL.md sources live in `src/prompts/skills/<name>/SKILL.md`.

Workflow command implementations:
- `deep-interview` → `src/commands/deep-interview.ts` (Socratic interview; locks mutation tools while ambiguity > 20% — see `assertMutationAllowed` in `tools.ts:72-91`).
- `ralplan` → `src/commands/ralplan.ts` (Planner/Architect/Critic blueprint; ends "NOT yet approved" handoff → `joc approve` then `joc team`, lines 174-178). Role-gate verdict parsing (`ARCHITECT_STATUS_VALUES = CLEAR/WATCH/BLOCK`, `ARCHITECT_REVIEW_VALUES = APPROVE/COMMENT/REQUEST CHANGES`) lives in `src/commands/team.ts:101-154`.
- `team` → `src/commands/team.ts` (`runTeamEngine` + `executeTaskWithAgent`; ooo-ralph subagent loop over an immutable plan's pending_tasks — `buildRalphSubagentPrompt` lines 78-93).
- `ultragoal` → `src/commands/ultragoal.ts` (`runUltragoalEngine` — verify goals / acceptance checks).
- `approve` → `src/commands/approve.ts`; `state` → `src/commands/state.ts` ("gjc-state parity" receipts under `.joc/state`, verbs read|write|clear|handoff for deep-interview|ralplan|team|ultragoal).

### The 4 role agents (executor / planner / architect / critic)
- `src/agent/subagents.ts` `SUBAGENT_ROLES`: **executor** (readOnly=false, maxSteps 15, the only mutating role; done markers `Summary:`/`Changed Files:`/`Verification:`), **planner** (readOnly, 10 steps; 8 done markers incl. In Scope/Sequencing/Acceptance Criteria/Risks), **architect** (readOnly, 10 steps; markers incl. `Architectural Status:`/`Code Review Recommendation:`), **critic** (readOnly, 8 steps; must start with `[OKAY]|[ITERATE]|[REJECT]` + `Justification:`).
- Read-only roles get a mutation-free toolset via `subagentToolset()` which strips `write`, `edit`, `bash` from `DEFAULT_TOOLS`. Per-role model/maxSteps overrides resolved by `resolveSubagentModel` / `resolveSubagentMaxSteps` from config; role prompts come from `src/prompts/agents/{executor,planner,architect,critic}.md`.

### Subagent dispatch (`src/agent/task-tool.ts`)
- `createTaskTool` builds the `task` ToolHandler accepting `{ role?, task|prompt|assignment, context? }`; protocol line: `task {role, task|tasks[], context?}` (`TASK_TOOL_PROTOCOL_LINE`, lines 56-59). Fan-out: pass `tasks[]` — read-only roles run in parallel up to `MAX_FANOUT = 4`, executor runs serially.
- Each subagent is the shared executor tool-loop (`runAgentLoop` from `engine.ts`) driven with the role's system prompt/toolset/model/step budget. Done-reason is validated against `requiredDoneMarkers` (`validateSubagentDoneReason`) and echoed back fenced (`<<<subagent-report ... >>>`, `fenceSubagentReport`). Lifecycle events (`TaskSubEvent`) are surfaced live in the parent TUI.

---

## 3. FEATURE SURFACE

### Agent loop + tools (enumerated from `src/agent/tools.ts` + `engine.ts` + `tool-registry.ts`)
Core loop: `src/agent/engine.ts` `runAgentLoop()` — JSON tool-call protocol (model replies `{ "tool":"<name>", "arguments":{...} }`), with fuzzy unknown-tool recovery (`nearestToolName`, edit-distance ≤2), tool-output truncation (`truncateToolOutput`, 4000-char head+tail) and spill-to-artifact (`spillToolResult` → `.joc/artifacts/tool-results/`, keep newest `MAX_TOOL_ARTIFACTS=50`). `src/agent/loop.ts` exposes `callLlm()` over the model manager.

**Tool names actually registered** in `DEFAULT_TOOLS` (`src/agent/engine.ts` and duplicate in `src/agent/tool-registry.ts`):

| Tool | Args | Source fn |
|------|------|-----------|
| `read` | `{filePath, lineRange?, raw?}` | `readTool` (tools.ts:145) — line-selector ranges `a-b,a-,a,a+n,a-b,c-d` via `parseLineSelector` |
| `write` | `{filePath, content}` | `writeTool` (tools.ts:214) |
| `edit` | `{filePath, editBlock}` | `editTool` (tools.ts:261) — `<<<<<<< SEARCH/=======/>>>>>>>` hunks via `parseEditHunks` |
| `bash` | `{command, timeoutMs?, cwd?, env?}` | `bashTool` (tools.ts:376) |
| `find` | `{globPattern}` | `findTool` (tools.ts:468) |
| `search` | `{pattern, globPattern?, ignoreCase?, context?, maxMatches?}` | `searchTool` (tools.ts:543) |
| `ls` | `{dirPath}` | `lsTool` (tools.ts:594) |
| `done` | `{reason?}` | loop terminator (protocol only) |

Two additional tools are wired in only for the interactive launch loop (`src/commands/launch.ts`): `KNOWN_TOOLS = {read, write, edit, bash, find, search, ls, task, todo}` (line 791):
- `task` → `createTaskTool` (subagent delegation, §2).
- `todo` → `createTodoTool` (`src/agent/todo-tool.ts`) — structured task plan `{todos:[{title,status}]}`, status pending|in_progress|done, surfaced live as a TUI checklist via `tui.setTodos`. Mirrors gjc `todo_write`.

Read-only protocol (`READONLY_TOOL_PROTOCOL`) advertises only read/find/search/ls/done. Tool-list filtering: `--tools`/`--no-tools` flags + `filterToolMap` + `buildToolProtocol` (`launch.ts:583-619`, `TOOL_DESCRIPTIONS:595`).

Mutation guards: `assertMutationAllowed` blocks write/edit (except under `.joc/`) and `assertBashAllowed` blocks bash while a deep-interview lock is active and ambiguity not frozen (`tools.ts:67-102`); `IGNORED_DIRS` + `.gitignore` parsing keep find/search clean (`tools.ts:25-65`).

### MCP server (`src/mcp/`)
- `joc mcp [serve|tools]` (`src/commands/mcp.ts`). `src/mcp/server.ts` — JSON-RPC 2.0 over stdio, protocol version `2024-11-05`, serverInfo `joc-mcp` v0.1.0; methods `initialize`, `tools/list`, `tools/call`, `ping`.
- Tools (`src/mcp/tools.ts` `TOOLS`): `joc_resolve_provider`, `joc_credential_status`, `joc_config_snapshot`, `joc_doctor`. Behind `JOC_MCP_PIPELINE=1` it appends DANGER pipeline tools: `joc_deep_interview`, `joc_ralplan`, `joc_team`, `joc_ultragoal`.

### Model catalog / discovery / providers (`src/ai/`)
- Providers registered in `src/ai/model-manager.ts:19-23`: **anthropic, openai, gemini, antigravity, ollama** (adapters in `src/ai/providers/{anthropic,openai,openai-responses,gemini,ollama,antigravity}.ts`; errors.ts). `provider-registry.ts` is the decoupled registry.
- Routing: `resolveProvider(model)` (model-manager.ts:26-38) — catalog-authoritative then heuristic (`ollama/`, `antigravity/`, `gpt`/`o\d`→openai, `gemini`→gemini, else anthropic). `qualifyModelId` prefixes mis-routing live ids.
- Static catalog/enrichment: `model-catalog.ts`, `model-catalog-compat.ts`, `model-enrich.ts`, `model-registry.ts` (aliases `expandAlias`/`resolveModelId`), `model-picker.ts`.
- **Live discovery**: `src/ai/model-discovery.ts` queries each provider's `models` endpoint with the resolved credential (OAuth bearer or API key), 5s timeout, limit 100, falls back to static catalog on failure (`fallback` flag). Powers `/models` `/model` `/provider` and `joc models`. Antigravity uses `…fetchAvailableModels` with a denylist. `provider-status.ts` reports per-provider connectivity.
- SSE streaming helper: `src/ai/sse.ts`. Retry/backoff: `src/util/retry.ts` (`withRetry`, `defaultRetryable`), `onRetry` hook in ChatOptions.

### Auth flows (`src/auth/`)
- OAuth registry `OAUTH_FLOW_REGISTRY` (`src/auth/flows/index.ts`) for **anthropic** (Claude Pro/Max, works with bundled Messages adapter), **openai** (ChatGPT/Codex via `chatgpt.com/backend-api/codex/responses`; OPENAI_API_KEY takes precedence), **gemini/google** (Cloud Code Assist `cloudcode-pa.googleapis.com` with auto-discovered project; GEMINI_API_KEY precedence), **antigravity** (desktop-app OAuth client, Cloud Code Assist, projectId auto-discovered). All `verifiedEndToEnd: true`.
- PKCE (`src/auth/pkce.ts`), local callback server (`src/auth/callback-server.ts`), token storage + auto-refresh (`src/auth/storage.ts`, `src/auth/refresh.ts`, `src/auth/oauth.ts`). CLI: `joc auth [login|logout|refresh|status]` (`src/commands/auth.ts`); MCP `AUTH_PROVIDERS` = anthropic/openai/gemini/antigravity. ollama is keyless (no OAuth flow).

### Sessions / resume / compaction / hooks / team-tmux / ooo-seed
- **Sessions**: `src/agent/session.ts` — JSONL session log (`SessionHeader`/`SessionEntry`/`CompactionEntry`), `crypto.randomUUID()` ids, version 1, stored under local `.joc` dir. CLI `joc resume [id]`, `joc session [list|attach|rm]`, `joc export [--json|--system]`. REPL `/resume /new /drop /sessions /rename /export /dump`.
- **Compaction**: `src/agent/compaction.ts` — `maybeCompact()` token-budget driven (`DEFAULT_MAX_TOKENS=30_000`, summary input 20_000), LLM-summarizes older turns with deterministic placeholder fallback on failure; auto-detects already-compacted; footer shows `ctx %` with `(auto)`. REPL `/compact /context`.
- **Hooks**: `src/agent/hooks.ts` — `loadHooks` from config; `runPreToolHooks` (can VETO a tool call), `runPostTurnHooks`, `runPostImplementationHooks`; 30s timeout, abort-signal aware.
- **Team / tmux**: `joc --tmux` (`launch.ts` `tmuxSessionName`/`allocateTmuxSession`, keyed on cwd+branch) + `joc session` manages joc-owned tmux sessions; `joc team` runs the ooo-ralph executor loop.
- **ooo-seed**: `joc ooo-seed` (`src/commands/ooo-seed.ts`) → `syncSpecificationToSeed` (`src/agent/dev/spec-automation.ts`), syncs `.specify/specification.md` to an immutable ooo seed. Dev-mode self-evolution sits under `src/agent/dev/` (`self-analysis.ts`, `self-improve.ts`, `evolution-bridge.ts`, `evolution-logger.ts`, `advanced-analyzer.ts`) feeding `joc evolve-core` / `joc status`.

---

## 4. TUI / UX

### Controller + layers
- `src/tui/app.ts` `LaunchTui` — coordinates tool streams, evolution state, footer, todo checklist; never imports the engine (caller passes `tui.events()` into `runAgentLoop`). `DEFAULT_MAX_STEPS=25`. Caches per-stage art/track for the 120ms spinner tick.
- `src/tui/renderer.ts` (diff renderer, §1), `src/tui/terminal.ts` (primitives, §1), `src/tui/index.ts` (exports).

### components/ (each `src/tui/components/<file>` — one-line role)
- `ascii-art.ts` — ASCII animation frames per evolution stage (forge/identity art).
- `evolution.ts` — canonical 5-stage model (names, colors, spinner/meter glyphs, track) — single source of truth.
- `themes.ts` — selectable evolution palettes (see themes below).
- `forge.ts` — the signature "forge box" framing for the evolution identity.
- `footer.ts` — status HUD line assembly (`renderFooter`).
- `hud.ts` — HUD phase resolver (planning/reporting/etc).
- `spinner.ts` — stage-aware progress spinner.
- `status.ts` — status badges / status bar.
- `step-timeline.ts` — numbered colored horizontal/vertical process timeline.
- `stream.ts` — bounded ring buffer of streamed output lines (flat memory/render cost).
- `tool-list.ts` — live tool-call list rendering.
- `meter.ts` — progress-bar meter glyph renderer.
- `welcome.ts` — startup/welcome banner.
- `update-box.ts` — "newer release available" notice box.
- `input-box.ts` — boxed REPL input with placeholder `"Type a request, /help, or @path"`.
- `autocomplete.ts` — interactive autocomplete completer + keypress listener.
- `slash.ts` — slash command registry + live preview builder.
- `select-list.ts` — generic keyboard-navigable selection list + viewport.
- `model-picker.ts` / `live-model-picker.ts` / `provider-picker.ts` — static-catalog / live-discovered / provider selection lists.
- `skill-picker.ts` — workflow skill picker.
- `config-panel.ts` — effective config / alias / subagents panels.
- `code-view.ts` — syntax-highlight code formatter + line-range slicer (`/view`).
- `color.ts` — color-level + appearance (light/dark) + unicode capability detection.
- `layout.ts` — layout/box helpers.
- `capability.ts` — capability indicator badges.
- `category-index.ts` — category/status badges (`categoryBadge`).
- `hints.ts` — input hints.
- `duration.ts` — human duration formatting.
- `section.ts` — section header rendering.

### Themes (`src/tui/components/themes.ts` `THEMES`)
`cosmic` (default), `matrix`, `solar`, `red-claw` (dark crimson), `blue-crab` (light-bg ocean blue), `mono` (colorless / NO_COLOR fallback). Resolution order: `JOC_TUI_THEME` env → config (`theme`/`tuiTheme`/`tui.theme`) → auto (NO_COLOR→mono, light appearance→blue-crab, else cosmic). REPL `/theme [name]`.

### Footer / status HUD fields (`renderFooter`, `FooterData`)
`model (provider)` · `cwd (branch)` (home `~`-collapsed, middle-truncated to 32) · `step N/M` · `Ns` elapsed · `eta Ns` (opt-in, needs ≥1 completed step) · `evo NN% → <next stage> in K` (opt-in) · `ctx NN%/<max>` (+`(auto)`, red ≥85% / yellow ≥60%) · short session id · evolution-stage track tag `●●●○○ Tool User (Homo Habilis) [3/5]`.

### Evolution art / stages
- 5 stages (`EVOLUTION_STAGE_COUNT=5`, `src/tui/components/evolution.ts`): **Primordial Cell → Double Helix (DNA) → Tool User (Homo Habilis) → AI Coding Agent → Super intelligence (Singularity)**, per-stage chalk accent (cyan/green/yellow/magenta/blue), per-stage spinner frame sets (+ ASCII fallbacks) and meter glyphs. Stage index derives from step/maxSteps progress; all surfaces (art, spinner, meter, footer track) read from this one module. Preview: `joc evolve [--step N] [--max M] [--animate]`.

### Inline scrollback turn
- On a TTY the live turn renders in the MAIN buffer (`reserve` mode): each completed step's ledger line is flushed into normal scrollback as it happens (glyph-first `✔/✗` + category/status badges), so tmux / mouse-wheel can scroll back through progress mid-turn (`app.ts` appendLedger → `renderer.insertAbove`). The in-frame tool list + forge boxes keep live activity visible; on turn end the live region collapses to a single static record. `JOC_TUI_ALT_SCREEN=1` restores the legacy scroll-isolated alt-screen turn.

### Slash commands (`src/tui/components/slash.ts` `SLASH_COMMAND_DETAILS`)
system: `/help /usage /context /tools /hotkeys /theme /settings /evolve /exit /quit`; session: `/clear /new /drop /session /rename /resume /retry /export /dump /btw /compact /sessions`; models: `/model /models /provider /logout /login /config /roles /thinking`; subagents: `/agents`; code: `/view /diff /find /search`; skills: `/skill` and `/skill:<name>` (GJC-style entrypoint).

---

## 5. KNOWN GAPS / TODOs

- **No PTY** for shell exec — `bashTool` is pipe-based `Bun.spawn`; interactive/TTY-requiring commands won't work (`src/agent/tools.ts:393`).
- **Compaction fallback is lossy** — when the LLM summary call fails, history is replaced by a deterministic placeholder `[Earlier conversation omitted: N messages — summary unavailable]` (`compaction.ts:241-253`, `summaryFailed` flag).
- **OAuth adapter caveats surfaced in code** (`src/auth/flows/index.ts` notes): OpenAI OAuth must use the Codex Responses backend (api.openai.com only with an API key); Gemini OAuth needs Cloud Code Assist (an OAuth-only login the bundled adapter can't serve reports `kind:"none"` — `src/mcp/tools.ts` `effectiveKind`). `doctor.ts:39` probes with a deliberately-unsupported model to confirm connectivity without burning credit.
- **Mutation gate during deep-interview** — write/edit/bash are hard-blocked outside `.joc/` until the requirements seed is frozen (ambiguity ≤ threshold) (`tools.ts:84-88` `[MutationGuard Blocked]`).
- **Bash output cap 100_000 chars / tool-result spill at 4000 chars** — large outputs are truncated head+tail and spilled to artifacts; the model only sees a window (`engine.ts` `truncateToolOutput`/`TOOL_SPILL_THRESHOLD`).
- **MCP pipeline tools are gated + DANGER-flagged** — `joc_deep_interview/ralplan/team/ultragoal` only register when `JOC_MCP_PIPELINE=1` (`src/mcp/tools.ts`), reflecting they write files / burn credits.
- **Antigravity model denylist is hard-coded** in `model-discovery.ts:48` (placeholder/internal enum ids must never surface) — maintenance burden as Antigravity's catalog shifts.
- No explicit `TODO/FIXME/stub/not implemented` markers were found in `src/` (search across `src` returned only "open TODOs" prompt copy and TodoStatus type literals), i.e. no obvious abandoned stubs; the gaps above are design constraints, not dead code.
- AGENTS.md still references V2 `.specify`/`.ouroboros` integration and `provider-registry` as the headline V2 components; verification is `bun test` + `bun run typecheck` (repo-root `AGENTS.md`).
