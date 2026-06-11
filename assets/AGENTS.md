<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-11 -->

# assets

## Purpose
Static binary assets (images) used for project branding, documentation, and TUI/ASCII presentation. These files are referenced by README documentation and supporting Python helper scripts; they contain no executable logic.

## Key Files
| File | Description |
|------|-------------|
| `hero.png` | Primary hero/banner image for documentation |
| `character.png` | Mascot/character artwork used in branding and helper scripts |

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
