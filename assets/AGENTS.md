<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# assets

## Purpose
Static binary assets (images) used for project branding, documentation, and TUI/ASCII presentation. These files are referenced by README documentation and supporting Python helper scripts; they contain no executable logic.

## Key Files
| File | Description |
|------|-------------|
| `character.png` | Neon-lens coding-agent mascot (blue lens → violet gown → pink lens) holding a glowing terminal; the brand's synthwave identity, used in README branding and helper scripts |
| `hero.png` | Primary hero/banner image for documentation (autonomous coding-agent scene) |
| `icon.png` | Project icon (mascot face, 1024×1024) shown in README headers |
| `icon-master.png` | Full-resolution source for the generated project icon |
| `apple-touch-icon.png` | 180×180 touch icon derived from `icon.png` |
| `favicon.ico` | Multi-size favicon (16–256px) derived from the project icon |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Treat contents as binary assets; do not attempt to edit images as text.
- Keep filenames stable, since `README.md` and root-level Python scripts (e.g., `analyze_image.py`, `describe_character.py`) reference them by path.
- Optimize image size before committing new assets.

### Testing Requirements
- N/A (binary assets). Verify referencing docs/scripts still resolve paths after any rename.

### Common Patterns
- Flat directory of PNG assets referenced by relative path.

## Dependencies

### Internal
- Referenced by `README.md` and root helper scripts.

### External
*(None)*

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
