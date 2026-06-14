<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# commands

## Purpose
Concrete implementations of `jeo` subcommands (e.g., launch, setup, team, ultragoal).

## Key Files
| File | Description |
|------|-------------|
| `approve.ts` | Brief description of purpose |
| `auth.ts` | Brief description of purpose |
| `chat.ts` | Brief description of purpose |
| `deep-interview.ts` | Brief description of purpose |
| `doctor.ts` | Brief description of purpose |
| `evolve-core.ts` | Brief description of purpose |
| `evolve.ts` | Brief description of purpose |
| `export.ts` | Brief description of purpose |
| `launch.ts` | The primary interactive/one-shot execution command |
| `mcp.ts` | Brief description of purpose |
| `ooo-seed.ts` | Brief description of purpose |
| `ralplan.ts` | Brief description of purpose |
| `resume.ts` | Brief description of purpose |
| `session.ts` | Brief description of purpose |
| `setup-helpers.ts` | Brief description of purpose |
| `setup.ts` | Guided configuration command |
| `skills.ts` | Brief description of purpose |
| `state.ts` | Brief description of purpose |
| `status.ts` | Brief description of purpose |
| `team.ts` | Multi-agent coordination command |
| `ultragoal.ts` | Brief description of purpose |
| `update.ts` | Brief description of purpose |

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
