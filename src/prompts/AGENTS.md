<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# prompts

## Purpose
Bundled system prompts, role definitions, and workflow skill documentation for the agent.

## Key Files
| File | Description |
|------|-------------|
| `system.md` | Core system prompt template |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `agents/` | Role-specific prompts (executor, planner, architect, critic) (see `agents/AGENTS.md`) |
| `skills/` | Bundled workflow skills (deep-interview, ralplan, etc.) (see `skills/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Prompts should be clear, concise, and definitive.
- Updates here directly alter the AI's behavior and personality.
- Do not remove existing constraints without explicit reason.

### Testing Requirements
- Prompt changes should be verified via end-to-end testing or `bun run run-evolution.sh`.

### Common Patterns
- XML-like tags for structural organization within prompts.

## Dependencies

### Internal
- Injected by `src/agent/session.ts` and `src/skills/`.

### External
*(None)*

<!-- MANUAL: -->
