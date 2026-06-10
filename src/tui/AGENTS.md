<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# tui

## Purpose
TUI layout engine and rendering layers. Renders live step timeline meters, progress spinners, interactive selection pickers, and color gradients.

## Key Files
| File | Description |
|------|-------------|
| `app.ts` | The main `LaunchTui` controller coordinating tool streams, state evolution, and footers |
| `renderer.ts` | Differential ANSI terminal updater |
| `terminal.ts` | Truncates colored strings, shows/hides cursors, and queries terminal window size |
| `index.ts` | Standard module exports |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `components/` | Custom UI modules (ASCII art, select lists, autocomplete, capability indicators) (see `components/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Clamp all layout lines to terminal column limits using `terminal.ts` utilities to prevent wrapping bugs.
- Reset terminal scroll regions (`\x1b[r`) and restore cursors (`\x1b[?25h`) on process exit to keep TTY healthy.

## Dependencies

### Internal
- `src/util/` (uses helpers)

### External
- Chalk (for ANSI styling)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
