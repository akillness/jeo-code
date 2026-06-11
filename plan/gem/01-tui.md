# 01 — TUI Plan (gjc-style terminal UI for gem)

> A pure-TypeScript differential terminal renderer for `gem`, implementing the gjc-style
> red-claw/blue-crab visual identity, live status footers, slash palettes, and real-time
> token-level streaming.

**Status:** `planned` · **Owner:** Agent · **Last updated:** 2026-06-05 · **Tracking pass:** `docs/improvements.md §M1-M3`

---

## 1. Goal
Provide a responsive, visually appealing terminal interface for `gem` that matches `gjc`'s interactive feel. This includes differential line-level repainting, a live spinner and tool list, real-time token streaming, a slash-command palette with autocomplete, and a theme engine that switches between `red-claw` (dark) and `blue-crab` (light) automatically based on terminal appearance.

## 2. Current State (cite evidence)
- `jeo-code/coding-agent/src/commands/launch.ts` handles basic REPL input using `node:readline/promises` and streams output using standard `console.log`.
- `jeo-code/coding-agent/src/agent/engine.ts` emits lifecycle events but prints tool calls and progress inline.
- Output during Socratic interview (`jeo-code/coding-agent/src/commands/deep-interview.ts`) and team execution is printed textually, causing terminal scroll spam on large tasks.
- No thematic support or differential screen repainting exists in the base repository.

## 3. Target State (gjc / pi-mono parity)
- **gjc** (`packages/tui`): Exposes a rich layout manager, multi-theme support (red-claw for dark, blue-crab for light), and Sixel graphics.
- **pi-mono** (`pi-tui`): Exposes a clean, pure-TS differential terminal renderer that calculates changes between frames and writes only the diffs to stdout.
- **gem** decision: Combine `pi-tui`'s differential rendering approach with `gjc`'s thematic identity (crustacean colors, status footers, slash command palette, and ambiguity meters). Skip Sixel graphics to avoid native dependency bloat.

## 4. Design & Architecture
The TUI package resides in `src/tui/`:
```
src/tui/
├── index.ts          # Exports
├── terminal.ts       # Raw ANSI escaping, window size query, TTY guards
├── renderer.ts       # Differential Renderer (string[] frame comparison)
├── theme.ts          # Color palettes: red-claw (dark), blue-crab (light)
├── components/
│   ├── footer.ts     # Status: model · step · elapsed · token cost
│   ├── spinner.ts    # Spin animation frame ticker
│   ├── tool-list.ts  # Running / completed tool status
│   └── meter.ts      # Visual Socratic ambiguity bar
└── app.ts            # Layout orchestrator, maps engine events to UI
```

Control Flow:
```
[Agent Engine] ────(Events)────▶ [TUI App] ────▶ [Components]
                                    │
                                 (Render)
                                    ▼
                             [Diff Renderer]
                                    │ (Write ANSI Diff)
                                    ▼
                              [TTY Terminal]
```

Theme details:
- **red-claw (Dark):** Bold red (`chalk.red`) accents, dark grey backgrounds, bright white text.
- **blue-crab (Light):** Bright blue (`chalk.blue`) accents, light grey backgrounds, dark slate text.

## 5. Implementation Steps
- **Slice 1 — ANSI Terminal & Diff Renderer** (`src/tui/terminal.ts`, `src/tui/renderer.ts`, `test/tui-renderer.test.ts`):
  Write ANSI cursors and clean differential repainter. Unit test must assert that updating 1 line in a 10-line frame only issues ANSI sequences for that single line.
- **Slice 2 — Themes & Component Set** (`src/tui/theme.ts`, `src/tui/components/*`):
  Implement `red-claw`/`blue-crab` colors and export `footer`, `spinner`, `tool-list`, and `meter` widgets.
- **Slice 3 — TUI Application Loop** (`src/tui/app.ts`, `src/tui/index.ts`, edit `src/commands/launch.ts`):
  Wire `runAgentLoop` events to the layout. Prevent input conflicts by pausing redraws while the `readline` input prompt is active.

## 6. Acceptance Criteria (testable)
- [ ] `terminal.ts` accurately queries rows/columns and handles `SIGWINCH` resize events.
- [ ] Changing a single line in a multi-line output does not cause full-screen flashes.
- [ ] Running in `--no-tui` or redirection (`joc launch < task.txt`) bypasses TUI and falls back to clean, plain text stream.
- [ ] Theme changes dynamically according to the `~/.gem/config.json` setting (`defaultTheme: "red-claw" | "blue-crab"`).

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| Readline and TUI rendering fight over cursor positioning | High | Pause the background differential renderer loop when waiting for user input (`rl.question`). |
| Screen resize breaks diff coordinates | Medium | Bind to `process.stdout.on('resize')`, query width, and force a complete frame redraw. |
| Colors unreadable in custom terminal setups | Low | Enable strict color fallback modes and support `--no-color`. |

## 8. Verification Steps
```bash
bun x tsc -p tsconfig.json --noEmit
bun test test/tui-renderer.test.ts
# Manual verify
gem launch "write a fibonacci function in python" # Observe live spinner + footer
gem launch --no-tui "say hello"                   # Verify fallback output
```

## 9. Long-term / Future
- Add inline markdown syntax highlighting inside the streaming assistant component.
- Integrate Sixel image output as an optional native add-on for vision model analysis.

## 10. Changelog
- 2026-06-05 — Plan drafted.
