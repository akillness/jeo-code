<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# components

## Purpose
TUI view components. It formats, lays out, and displays terminal elements including ASCII evolution animations, code syntax highlighting, autocomplete selectors, and capability tables.

## Key Files
| File | Description |
|------|-------------|
| `select-list.ts` | The generic keyboard-navigable selection list controller and viewport renderer |
| `live-model-picker.ts` | Displays live discovered models in a SelectItem list with capability annotations |
| `model-picker.ts` / `provider-picker.ts` | Builds select lists from the static model catalog and provider statuses |
| `autocomplete.ts` | Interactive autocomplete completer and line keypress listener |
| `slash.ts` | Slash command registry and live previews builder |
| `config-panel.ts` | Panel formatters for effective configuration, alias lists, and subagents panels |
| `code-view.ts` | Syntax highlighting code formatter and line range slicer |
| `step-timeline.ts` | Numbered, colored horizontal/vertical process timeline indicator |
| `ascii-art.ts` | Renders ASCII animation frames for evolution stages |
| `evolution.ts` | Canonical 5-stage evolution progress model |
| `footer.ts` / `spinner.ts` / `status.ts` / `tool-list.ts` / `meter.ts` | Status bars and animation components |
| `color.ts` / `themes.ts` / `layout.ts` | Color palettes, layouts, and Unicode capability utilities |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- All printed lines must fit terminal dimensions; truncate strings to column size to prevent screen corruption.
- Keep components pure and decouple UI rendering from network/file I/O.

## Dependencies

### Internal
- `src/tui/` (the main renderer renders these components)
- `src/ai/` (queries model metadata for capability indicator badges)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
