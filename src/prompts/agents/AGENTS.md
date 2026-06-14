<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# agents

## Purpose
Role-specific system prompts defining the behavior of subagents (executor, planner, architect, critic).

## Key Files
| File | Description |
|------|-------------|
| `architect.md` | Read-only agent for structural review |
| `critic.md` | Read-only agent for plan critique |
| `executor.md` | Mutating agent for executing bounded tasks |
| `planner.md` | Read-only agent for sequencing tasks |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Prompts must define strict output contracts (e.g., specific `done.reason` JSON structures).
- Non-mutating agents MUST NOT be given mutating tools.

### Testing Requirements
- N/A (Plaintext files)

### Common Patterns
*(None)*

## Dependencies

### Internal
{References to other parts of the codebase this depends on}

### External
{Key external packages/libraries used}

<!-- MANUAL: -->
