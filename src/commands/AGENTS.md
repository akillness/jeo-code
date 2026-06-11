<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# commands

## Purpose
Concrete implementations of `jeo` subcommands (e.g., launch, setup, team, ultragoal, models).

## Key Files
| File | Description |
|------|-------------|
| `launch.ts` | The primary interactive/one-shot execution command |
| `setup.ts` | Guided configuration command |
| `team.ts` | Multi-agent coordination command |
| `status.ts` / `update.ts` | Inspection and maintenance commands |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Commands should handle their own specific setup but delegate core logic to `src/agent/` or `src/tui/`.
- Maintain clean separation between interactive (TTY) and non-interactive modes.

### Testing Requirements
- Mock standard streams (stdout/stdin) to test command outputs.

### Common Patterns
- Command handlers take parsed options, initialize context, and run the main loop or utility function.

## Dependencies

### Internal
- Connects `src/cli/` routing to `src/agent/` and `src/tui/`.

### External
*(None)*

<!-- MANUAL: -->
