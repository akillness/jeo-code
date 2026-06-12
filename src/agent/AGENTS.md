<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# agent

## Purpose
The core runtime loop, tool registry, session management, and state persistence for the `jeo-code` agent.

## Key Files
| File | Description |
|------|-------------|
| `loop.ts` | The primary execution loop orchestrating model calls and tool execution |
| `tools.ts` | Built-in tool definitions (bash, read, write, edit, etc.) |
| `state.ts` | File-backed state and session persistence (`.jeo/state/`) |
| `session.ts` | Session context building, compaction, and history management |
| `plan.ts` | Subagent planning structures and validation |
| `step-budget.ts` | gjc-style flexible step budgeting: progress-scored extensions, hard cap, fail-fast |
| `subagents.ts` / `task-tool.ts` | Delegation mechanisms and background execution of task subagents |

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
