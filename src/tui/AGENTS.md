<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# tui

## Purpose
Terminal User Interface logic, layout systems, and the differential renderer. Responsible for visualizing the agent's state, tools, and streams.

## Key Files
| File | Description |
|------|-------------|
| `app.ts` | High-level TUI orchestrator (`LaunchTui`) |
| `renderer.ts` | The differential, atomic terminal renderer (handles scrollback, resizing, DECSET 2026) |
| `terminal.ts` | Low-level ANSI escape codes and terminal size utilities |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `components/` | Reusable UI widgets (footer, forge boxes, timeline, layouts) (see `components/AGENTS.md`) |
| `monitoring/` | Specialized HUD views (see `monitoring/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- The differential renderer (`renderer.ts`) is critical for the "scrollback-friendly inline live turn" feature. DO NOT introduce full-screen clears (`\x1b[0J` mid-turn) as they flood tmux scrollback.
- Maintain visual parity with `gjc` design patterns (e.g., shadcn-inspired stage-grouped card layouts, muted card headers).

### Testing Requirements
- Test rendering logic using mocked stdout.
- Verify resize behavior and atomic flushes.

### Common Patterns
- Separation of UI from engine: `app.ts` listens to `AgentLoopEvents` but does not import engine loop directly.

## Dependencies

### Internal
- Driven by events from `src/agent/loop.ts`.

### External
- ANSI escape sequence management.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
