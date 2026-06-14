<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# components

## Purpose
Reusable UI widgets and layout primitives for the terminal interface.

## Key Files
| File | Description |
|------|-------------|
| `ascii-art.ts` | Cellular evolution graphics |
| `autocomplete.ts` | Brief description of purpose |
| `autopilot-status.ts` | Brief description of purpose |
| `capability.ts` | Brief description of purpose |
| `category-index.ts` | Brief description of purpose |
| `code-view.ts` | Brief description of purpose |
| `color.ts` | Brief description of purpose |
| `config-panel.ts` | Brief description of purpose |
| `duration.ts` | Brief description of purpose |
| `evolution.ts` | Brief description of purpose |
| `footer.ts` | Brief description of purpose |
| `forge.ts` | Formats the boxed tool execution outputs |
| `hints.ts` | Brief description of purpose |
| `hud.ts` | Brief description of purpose |
| `index.ts` | Brief description of purpose |
| `input-box.ts` | Brief description of purpose |
| `layout.ts` | Low-level padding, boxing, and alignment math |
| `live-model-picker.ts` | Brief description of purpose |
| `markdown-table.ts` | Brief description of purpose |
| `markdown-text.ts` | Brief description of purpose |
| `meter.ts` | Brief description of purpose |
| `model-picker.ts` | Brief description of purpose |
| `provider-picker.ts` | Brief description of purpose |
| `section.ts` | Shadcn-inspired card layout and spacing tokens |
| `select-list.ts` | Brief description of purpose |
| `skill-picker.ts` | Brief description of purpose |
| `slash.ts` | Brief description of purpose |
| `spinner.ts` | Brief description of purpose |
| `status.ts` | The `[STEP]` / `[STATUS]` / `[TOOL]` HUD lines |
| `step-timeline.ts` | Brief description of purpose |
| `stream.ts` | Brief description of purpose |
| `themes.ts` | Brief description of purpose |
| `todo-card.ts` | Brief description of purpose |
| `tool-list.ts` | Brief description of purpose |
| `transcript.ts` | Brief description of purpose |
| `update-box.ts` | Brief description of purpose |
| `welcome.ts` | Brief description of purpose |
| `width.ts` | Brief description of purpose |

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
