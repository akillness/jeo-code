<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# agent

## Purpose
The core runtime loop, tool registry, session management, and state persistence for the `jeo-code` agent.

## Key Files
| File | Description |
|------|-------------|
| `bash-fixups.ts` | Brief description of purpose |
| `compaction.ts` | Brief description of purpose |
| `config-schema.ts` | Brief description of purpose |
| `context-files.ts` | Brief description of purpose |
| `engine.ts` | Brief description of purpose |
| `hooks.ts` | Brief description of purpose |
| `json.ts` | Brief description of purpose |
| `loop.ts` | The primary execution loop orchestrating model calls and tool execution |
| `loop-guards.ts` | Intermediate-judgment classification (gjc ultragoal-guard parity): named `GuardState` taxonomy, `GUARD_LIMITS` thresholds, and pure classifiers (`isVerificationSignal`, `repeatHint`, `classifyDoneGate` — incl. `done_stale_verification` for a passing test/build that predates the last edit) consumed by `engine.ts` |
| `memory.ts` | OKF concept-bundle memory: session distill, query-aware budget injection (failure-first `priorityOrder` + pinned-invariant reserved budget), mid-loop `recordFailedAttempt` capture, shared `upsertConceptFile` writer, legacy MEMORY.md migration (`migrateLegacyMemory`) + `JEO_MEMORY_LEGACY` rollback toggle |
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
| `subagent-registry.ts` | Brief description of purpose |
| `subagent-tool.ts` | Brief description of purpose |
| `subagents.ts` | Brief description of purpose |
| `task-tool.ts` | Brief description of purpose |
| `todo-tool.ts` | Brief description of purpose |
| `tokenizer.ts` | Brief description of purpose |
| `tool-output.ts` | Brief description of purpose |
| `tools.ts` | Built-in tool definitions (bash, read, write, edit, etc.) |
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
