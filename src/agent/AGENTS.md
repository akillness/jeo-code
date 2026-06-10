<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# agent

## Purpose
Agent runtime loop and tool-use executor layer. V2 features a refactored Lean Loop.

## Key Files
| File | Description |
|------|-------------|
| `engine.ts` | **Lean Loop**: Core `runAgentLoop` function; handles polling and dispatch only. |
| `tool-registry.ts` | Centralized tool definitions and protocols. |
| `output-util.ts` | Utilities for output truncation, spilling, and performance logging. |
| `tools.ts` | Implementation of default tools + MutationGuard. |
| `dev/` | Evolution and self-analysis tools (V2 components). |

## For AI Agents
- Maintain the separation between tool registration (`tool-registry.ts`) and loop logic (`engine.ts`).
- Use `src/agent/dev/` components for evolution-related tasks.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
