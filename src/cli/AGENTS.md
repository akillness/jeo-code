<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# cli

## Purpose
CLI runner registry and command dispatcher.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Exports public dispatcher function |
| `runner.ts` | Maintains the `COMMANDS` registry, Levenshtein command name suggestions, help renderer, and global flag pre-router |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- When adding a subcommand, register its summary, loader, and options in `COMMANDS` (`runner.ts`).
- Global flags (e.g. `--list-models`, `--models`) are handled here before forwarding arguments to subcommands.

## Dependencies

### Internal
- `src/commands/` (imports subcommands lazily to keep CLI startup fast)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
