<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# components

## Purpose
Reusable UI widgets and layout primitives for the terminal interface.

## Key Files
| File | Description |
|------|-------------|
| `forge.ts` | Formats the boxed tool execution outputs |
| `status.ts` | The `[STEP]` / `[STATUS]` / `[TOOL]` HUD lines |
| `section.ts` | Shadcn-inspired card layout and spacing tokens |
| `layout.ts` | Low-level padding, boxing, and alignment math |
| `ascii-art.ts` | Cellular evolution graphics |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Prioritize deterministic width/height calculations.
- Always strip ANSI codes (`\x1b[...m`) before measuring string lengths.
- Components should return string arrays (`string[]`) representing lines, not perform direct stdout writes.

### Testing Requirements
- Snapshot or exact string matching in unit tests.

### Common Patterns
- Theming via `themes.ts` and `chalk`.

## Dependencies

### Internal
- Consumed by `src/tui/app.ts`.

### External
*(None)*

<!-- MANUAL: -->
