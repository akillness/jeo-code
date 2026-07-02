<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# assets

## Purpose
Static binary assets (images) used for project branding, documentation, and TUI/ASCII presentation. These files are referenced by README documentation and supporting Python helper scripts; they contain no executable logic.

## Key Files
| File | Description |
|------|-------------|
| `character.png` | Static source render of the red crayfish coding-wizard mascot: cyan/red glasses, crimson shell shifting through magenta/violet/purple, and floating jeopi-inspired plush companions |
| `character.gif` | Animated README mascot derived from the PerfectPixel-style sprite sheet; idle hover loop with pulsing glasses, antenna glow, and orbiting plush companions |
| `hero.png` | Primary hero/banner image for documentation (autonomous coding-agent scene) |
| `icon.png` | Project icon (mascot face, 1024×1024) shown in README headers |
| `icon-master.png` | Full-resolution source for the generated project icon |
| `apple-touch-icon.png` | 180×180 touch icon derived from `icon.png` |
| `favicon.ico` | Multi-size favicon (16–256px) derived from the project icon |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `oauth/` | Source assets for the OAuth callback pages (`src/auth/callback-server.ts`); `jeo-wordmark.png` is the 480×480 source render, `jeo-wordmark.webp` is the optimized (~5KB) version whose base64 is inlined as a data URI in `callback-server.ts` (no static-asset serving) |


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
<!-- MANUAL: oauth/jeo-wordmark.{png,webp} was generated via the god-tibo-imagen
     skill (gti CLI, Codex/ChatGPT image backend) as a bold-forged-monospace
     "jeo" wordmark on the mascot's blue→violet→pink synthwave gradient, styled
     after jeo-pi's hero-wordmark typographic treatment. Regenerate with `gti`
     if the brand palette changes, then re-export a small webp (`cwebp -q 82`)
     and re-inline its base64 into `JEO_WORDMARK_DATA_URI` in callback-server.ts. -->
