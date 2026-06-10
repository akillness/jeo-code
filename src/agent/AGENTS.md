<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# agent

## Purpose
Agent runtime loop and tool-use executor layer. It manages agent state, tool execution, session messages persistence, and message compaction.

## Key Files
| File | Description |
|------|-------------|
| `engine.ts` | The core `runAgentLoop` function which polls LLM and executes JSON tool calls |
| `tools.ts` | Implementation of the 6 default tools (read, write, edit, bash, find, search) + MutationGuard |
| `state.ts` | Config files I/O, config merging with environment, and active workflow state parser |
| `config-schema.ts` | Zod validation schemas for global `config.json` |
| `subagents.ts` | Subagent role system prompts and toolsets definitions |
| `compaction.ts` | Summarizes older conversation history to fit within context limits |
| `session.ts` | Session directory file writer (saves messages as JSONL) |
| `context-files.ts` | Detects and loads workspace context files (JEO.md, AGENTS.md, CLAUDE.md) |
| `loop.ts` | Small wrapper to call the LLM manager |
| `json.ts` | Safe JSON parsing utilities |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- `tools.ts` enforces the MutationGuard (prevents modifications when ambiguity > 20%).
- Read-only subagents must not have mutating tools in their toolsets; define their toolsets in `subagents.ts`.
- Maintain atomic JSON tool-call schema (`{ tool, arguments }`) in `engine.ts`.

## Dependencies

### Internal
- `src/ai/` (uses the model manager to call the LLM)
- `src/tui/` (sends tool-execution hooks to update TUI logs/footer)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
