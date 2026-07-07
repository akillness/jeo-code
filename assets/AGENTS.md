<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# assets

## Purpose
Static binary assets (images) used for project branding, documentation, and TUI/ASCII presentation. These files are referenced by README documentation and supporting Python helper scripts; they contain no executable logic.

## Key Files
| File | Description |
|------|-------------|
| `character.png` | Static source render of the red crayfish coding-wizard mascot: cyan/red glasses, crimson shell shifting through magenta/violet/purple, and floating jeopi-inspired plush companions |
| `character.gif` | Animated README mascot generated via the god-tibo-imagen skill (`gti` CLI, Codex/ChatGPT image backend): 4-frame narrative loop showing the mascot performing smart prompt routing — evaluating provider paths on a holographic dispatch panel, selecting the cheapest/most-efficient path (highlighted green), gold coins streaming in as savings, settling into a satisfied glow. Same crimson-shell/cyan-magenta-glasses/purple-DNA-robe identity as `character.png`, same dark-navy/cyan-grid backdrop |
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
<!-- MANUAL: character.gif (v0.8.0) was generated via the god-tibo-imagen skill
     (gti CLI, Codex/ChatGPT image backend, model gpt-5.4) — NOT via ppgen/
     PerfectPixel, since ppgen's actual provider set (gemini/openai/openrouter/
     fal/byteplus) has no god-tibo-imagen backend and no API key was available
     for its gemini/openai providers. 4 keyframes generated with `gti --image`
     chained off assets/character.png then off each new frame (for identity
     consistency across calls), depicting a scan -> decide/save -> transition ->
     settle narrative: a branching routing diagram with the cheapest/fastest
     path highlighted green, gold coins flowing in as the "money saver" visual
     motif for jeo's opt-in `routing.crossProviderPool` feature (v0.7.57/0.7.58).
     Assembled to 320x320 with a SHARED palette across all 4 frames (quantize
     the combined strip together, not per-frame) to avoid color-flicker in the
     loop; frame durations 200/180/140/220ms. Regenerate by re-running `gti`
     with assets/character.gif's first frame as the `--image` reference to
     preserve identity, then re-run the same shared-palette assembly. -->
