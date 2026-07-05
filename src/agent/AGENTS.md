<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# agent

## Purpose
The core runtime loop, tool registry, session management, and state persistence for the `jeo-code` agent.

## Key Files
| File | Description |
|------|-------------|
| `ast-match.ts` | Structural AST metavariable matcher for TypeScript/JavaScript (gjc `ast_grep`/`ast_edit` parity) — `$NAME`/`$_`/`$$$NAME`/`$$$` pattern matching over the `typescript` compiler API's AST, plus replacement-template rendering |
| `ast-file-scan.ts` | Shared file targeting (files/dirs/globs, gitignore + ignored-dir aware) for `ast_grep`/`ast_edit` |
| `ast-grep-tool.ts` | `ast_grep` tool — read-only structural code search using `ast-match.ts` |
| `ts-language-service.ts` | Cached in-process `ts.LanguageService` per project root (gjc `lsp` parity, TS/JS only) — tsconfig-aware root file discovery with a whole-tree fallback, live file-version tracking via stat, and position/selector resolution helpers shared by `lsp-tool.ts`/`lsp-rename-tool.ts` |
| `lsp-tool.ts` | `lsp` tool — read-only definition/references/hover/symbols/diagnostics via `ts-language-service.ts` |
| `debug-session.ts` | In-process CDP (V8 Inspector Protocol) client driving a spawned `node --inspect-brk` process (gjc `debug` parity, Node.js only — not Bun, whose inspector speaks a different WebKit dialect); one active session, singleton |
| `debug-tool.ts` | `debug` tool — launch/set_breakpoint/continue/step/evaluate/stack_trace/scopes/variables/threads/output/terminate via `debug-session.ts`; mutating (runs arbitrary code), excluded from read-only roles |
| `lsp-rename-tool.ts` | `lsp_rename` tool — cross-file TypeScript/JavaScript rename; mutating, writes via `writeTool`, kept separate from `lsp` so read-only roles can't reach it |
| `browser-session.ts` | Named-tab headless-Chromium session registry (gjc `browser` parity, via Playwright — already a jeo-code dependency) — one shared browser instance launched lazily, tabs reused by name across calls |
| `browser-tab.ts` | Per-tab helpers (`observe`/`click`/`type`/`fill`/`select`/`press`/`scroll`/`goto`/`back`/`extract`/`screenshot`/`evaluate`) — `observe()` tags interactive elements with stable numeric ids instead of returning a raw DOM dump or requiring a screenshot |
| `browser-tool.ts` | `browser` tool — open/close/run/act actions; mutating (drives a real browser, `run` executes arbitrary host JS), excluded from read-only roles |
| `ast-edit-tool.ts` | `ast_edit` tool — structural codemod using `ast-match.ts`; mutating, writes via `writeTool` |
| `bash-fixups.ts` | Brief description of purpose |
| `compaction.ts` | Brief description of purpose |
| `config-schema.ts` | Brief description of purpose |
| `context-files.ts` | Brief description of purpose |
| `engine.ts` | Brief description of purpose |
| `hooks.ts` | Brief description of purpose |
| `json.ts` | Brief description of purpose |
| `loop.ts` | The primary execution loop orchestrating model calls and tool execution |
| `loop-guards.ts` | Intermediate-judgment classification (gjc ultragoal-guard parity): named `GuardState` taxonomy, `GUARD_LIMITS` thresholds, and pure classifiers (`isVerificationSignal`, `repeatHint`, `classifyDoneGate` — incl. `done_stale_verification` for a passing test/build that predates the last edit) consumed by `engine.ts` |
| `memory.ts` | OKF concept-bundle memory: session distill, query-aware budget injection with a **hybrid reranker ported from memsearch** — `priorityOrder` fuses two ranked channels via `reciprocalRankFusion` (RRF, k=60): lexical IDF relevance (`buildCorpusStats`/`scoreConcept`, the sparse/BM25 channel so rare discriminating terms steer retrieval) ⊕ graph proximity (`graphProximityOrder`, the local dense/semantic-neighbour channel — a hub linked from multiple query hits surfaces even with no keyword of its own); all embedding-free, deterministic, atop the failure-first tier + pinned-invariant reserved budget. Plus mid-loop `recordFailedAttempt` capture, shared `upsertConceptFile` writer, legacy MEMORY.md migration (`migrateLegacyMemory`) + `JEO_MEMORY_LEGACY` rollback toggle |
| `memory-okf.ts` | OKF v0.1 format layer: frontmatter parse/serialize, concept IDs, conformance validation |
| `memory-graph.ts` | Concept cross-link graph: build/expand (1-hop search), broken-link-tolerant lint, optional graphify detection |
| `model-recency.ts` | Brief description of purpose |
| `output-minimizer.ts` | Brief description of purpose |
| `output-util.ts` | Brief description of purpose |
| `plan.ts` | Subagent planning structures and validation |
| `process-reaper.ts` | Background-process reaper: spawns bash in its own process group (POSIX detached) so backgrounded grandchildren (`next dev &`, daemons) are reaped by group at turn end instead of orphaning and accumulating (`JEO_KEEP_BACKGROUND=1` opts out, `JEO_REAP_INTERVAL_MS` tunes the periodic safety-net sweep) |
| `seed.ts` | Brief description of purpose |
| `session.ts` | Session context building, compaction, and history management |
| `state.ts` | File-backed state and session persistence (`.jeo/state/`) |
| `step-budget.ts` | gjc-style flexible step budgeting: progress-scored extensions, hard cap, fail-fast |
| `irc-tool.ts` | `irc` tool — parent/peer live messaging into running DETACHED subagents (list peers, send to one id or "all"); built entirely on `SubagentRegistry.steer()`, gjc `irc` parity |
| `approve-tool.ts` | `approve` tool — lets the agent flip a `jeo ralplan` plan's `approved` flag itself (wraps `src/commands/approve.ts`'s `approvePlan` content gate: schema shape, known roles, persisted [OKAY] consensus, hash-vs-consensus match). 2026-07: the prior human-only identity gate (only `jeo approve` run by a human could approve) was removed per explicit user direction; launch.ts-only (main interactive session), not part of `DEFAULT_TOOLS`/`subagentToolset`, same as `goal`/`irc` |
| `job-registry.ts` | In-process registry for BACKGROUND shell processes spawned via `job {action:"start"}` — real parallel OS processes (not just concurrent JS), bounded output buffer, list/tail/awaitIds/cancel, gjc `job`/async-bash parity |
| `job-tool.ts` | `job` control tool — start/list/tail/await/cancel background shell processes tracked by `job-registry.ts` |
| `subagent-registry.ts` | Brief description of purpose |
| `subagent-tool.ts` | Brief description of purpose |
| `subagents.ts` | Brief description of purpose |
| `task-tool.ts` | `task` tool (single/fan-out/detached delegation) — exports `runSubagentOnce`, the single subagent execution core (history/runAgentLoop/contract validation/mutation audit/fenced report) shared with `jeo team`'s executor in `src/commands/team.ts` |
| `todo-tool.ts` | Brief description of purpose |
| `tokenizer.ts` | Brief description of purpose |
| `tool-output.ts` | Brief description of purpose |
| `tools.ts` | Built-in tool definitions (bash, read, write, edit, etc.). 2026-07: the disk-staleness clobber guard (rejecting a write/edit when the file changed on disk since the agent's last read) was removed per explicit user direction — writes always win now. The distinct blind-edit guard (`readThisSession`/`markRead`: a no-anchor line-range `edit` still requires having read the file THIS session at least once) is unchanged |
| `web-search.ts` | Brief description of purpose |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `dev/` | Developer-specific agent tooling and spec automation (see `dev/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Modifications here affect the fundamental capabilities of the agent. Proceed with extreme caution.
- Ensure state writes are atomic and safe for concurrent execution.
- Tool schemas must remain strict and well-documented.

### Testing Requirements
- Extensive unit testing required. Use mock tools to test the loop logic without side effects.
- Verify session compaction does not lose critical context.

### Common Patterns
- Tool results are fenced properly to prevent prompt injection.
- The loop is decoupled from the UI (events are emitted to be consumed by the TUI).

## Dependencies

### Internal
- `src/ai/` for model inference.
- `src/tui/` consumes events emitted by the loop.

### External
- System APIs (fs, child_process) via Bun.

<!-- MANUAL: -->
