# 01 — TUI Plan (gjc / pi-tui-style terminal UI)

> A pure-TypeScript differential terminal renderer for `joc`, so the interactive
> agent and pipeline render like gjc — live tool calls, streaming text, a status
> footer, and a slash-command palette — instead of scrolling raw `console.log`.

**Status:** `in-progress` (M1+M2 shipped; M3 slash palette + M4 pipeline views pending) · **Last updated:** 2026-06-05 · **Tracking pass:** `docs/improvements.md §24`

---

## 1. Goal
Give `joc` a real terminal UI: in-place redraw (no scroll spam), a live tool-call
list, streaming assistant text, and a persistent status footer (model · elapsed ·
step). Match gjc's interactive feel without its native (Rust/sixel) dependencies.
Must degrade cleanly to today's plain-stream output on non-TTY / `--no-tui`.

## 2. Current State (cite evidence)
- Output is **scattered `console.log`** with no render layer: `src/commands/launch.ts`
  (32 calls), `setup.ts` (28), `auth.ts` (27), `doctor.ts` (20), `team.ts` (15),
  `deep-interview.ts` (15), `ralplan.ts` (12), `ultragoal.ts` (10).
- The agent core is **already event-driven** and UI-free: `src/agent/engine.ts:runAgentLoop()`
  emits `AgentLoopEvents` (`onStep`, `onAssistant`, `onToolResult`, `onError`) and contains
  **0 `console.log`** — this is the seam a renderer plugs into.
- `src/commands/launch.ts` builds an `events` object that just `console.log`s tool results;
  the REPL uses `node:readline/promises`.
- Only dep relevant to UI is `chalk` (`package.json`); no TUI library.
- `callLlm` (`src/agent/loop.ts`) is **blocking** (returns a full string) — there is no token
  stream yet (streaming is a provider concern; see plan 05 §M6, prerequisite for true streaming text).

## 3. Target State (gjc / pi-mono parity)
- **gjc** `packages/tui`: custom layout engine + sixel image rendering + autocomplete. We adopt the
  *interaction model* (live regions, footer, autocomplete) but **skip sixel and the native engine** —
  incidental complexity for a lean CLI.
- **pi-mono** `packages/tui` (`pi-tui`): **differential rendering** terminal UI (repaint only changed
  lines), streaming output, tool-call rendering. This is the model we copy.
- **joc** decision: a ~pure-TS `src/tui/` with a diff renderer + a small component set, wired to the
  existing engine events. No native deps. `--no-tui` and non-TTY fall back to the current stream path.

## 4. Design & Architecture
New package `src/tui/`:
```
src/tui/
├── index.ts          # barrel
├── terminal.ts       # raw ANSI: cursor move/hide, clear-line, size, isTTY guard
├── renderer.ts       # Renderer: holds previous frame (string[]); render(next[]) diffs & repaints only changed rows
├── components/
│   ├── spinner.ts    # frame ticker
│   ├── tool-list.ts  # running/ok/fail rows for tool calls
│   ├── stream.ts     # append-only assistant text region (wraps to width)
│   └── footer.ts     # status line: model · provider · step/maxSteps · elapsed · session id
└── app.ts            # LaunchTui: owns layout regions, subscribes to engine events, drives readline input
```
Control flow (interactive launch):
```
user input ─▶ runAgentLoop(history, { events }) 
                   │  onStep ─────▶ footer.step++        ┐
                   │  onAssistant ▶ stream.append(...)   ├▶ renderer.render(frame)  (diff repaint)
                   │  onToolResult ▶ toolList.update(...) ┘
              done ─▶ stream.append(reply); renderer.flush()
```
- `Renderer.render(lines: string[])`: compares to previous frame, moves the cursor and rewrites only
  differing rows; tracks rendered height to clear leftovers. Width from `terminal.size()`.
- **TTY guard**: `app.ts` activates only when `process.stdout.isTTY && !flags.noTui`; otherwise the
  caller keeps the existing `events`→`console.log` adapter (zero behavior change for pipes/CI).
- **Decoupling**: the TUI consumes the *existing* `AgentLoopEvents` — `engine.ts` is untouched.

## 5. Implementation Steps
- **Slice 1 — terminal + renderer core** (`src/tui/terminal.ts`, `src/tui/renderer.ts`, `test/tui-renderer.test.ts`):
  ANSI helpers + diff renderer with a unit test asserting only changed rows are emitted (capture writes
  to a fake stream). Pure, no engine coupling. → `executor`.
- **Slice 2 — components** (`src/tui/components/*`, `test/tui-components.test.ts`): spinner, tool-list,
  stream (width-wrap), footer; each a pure `render(): string[]` returning lines. → `executor`.
- **Slice 3 — LaunchTui app + launch wiring** (`src/tui/app.ts`, `src/tui/index.ts`, edit `src/commands/launch.ts`):
  build the layout, map engine events to component updates, add `--no-tui`; keep the stream fallback. (parent-owned integration.)
- **Slice 4 — `--no-tui`/non-TTY parity test + e2e** (parent): verify identical final output in both modes.

## 6. Acceptance Criteria (testable)
- [ ] `src/tui/renderer.ts` exists; unit test proves a 1-row change repaints exactly 1 row (not the whole frame).
- [ ] `joc launch` on a TTY shows a **footer redrawn in place** with `model · step N/25 · elapsed`s (no duplicate footer lines in scrollback).
- [ ] Tool calls render as a live list: `running → ok/FAILED`, not one `console.log` per event.
- [ ] `joc launch --no-tui` and non-TTY (`echo x | joc`) produce the **same final assistant text** as today (byte-compatible final line).
- [ ] `tsc -p tsconfig.json --noEmit` → 0; `bun test` includes ≥2 new TUI tests, all green.
- [ ] No new runtime npm dependency (chalk only); engine.ts unchanged (`git diff` shows 0 lines in `src/agent/engine.ts`).

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| Diff renderer corrupts scrollback on resize | High | Re-query width each frame; on `SIGWINCH` force full repaint; cap frame height to terminal rows |
| Breaks pipes/CI (non-TTY) | High | Hard `isTTY` guard + `--no-tui`; keep the existing `console.log` adapter as default off-TTY |
| Streaming text region without token streaming looks static | Medium | M2 ships with whole-message append; true token streaming gated on plan 05 §M6 (provider streaming) |
| Scope creep toward sixel/native (gjc) | Medium | Explicitly out of scope; documented in §3; revisit only as an optional M5+ Rust fast-path |
| Readline + raw render fight over the cursor | Medium | Render above the input line; pause renderer while readline prompt is active |

## 8. Verification Steps
```bash
bun run typecheck
bun test test/tui-renderer.test.ts test/tui-components.test.ts
# TTY (manual): joc launch  → footer redraws in place; tool list updates live
echo "create a file ok.txt with text hi" | joc            # non-TTY: plain stream, unchanged
joc launch --no-tui "say hi"                               # explicit fallback parity
```

## 9. Long-term / Future
- Token-level streaming text once providers stream (plan 05 §M6) — `stream.ts` already append-based.
- Pipeline/doctor TUI views (plan 01 §M4): ambiguity meter for `deep-interview`, step progress for
  `team`, a doctor table widget.
- Optional Rust-native renderer behind the same `Renderer` interface (gjc-style speed) — deferred.

## 10. Changelog
- 2026-06-05 — plan created.
- 2026-06-05 — M1+M2 shipped: `src/tui/{terminal,renderer,app}.ts` + `src/tui/components/*`, wired into
  `joc launch` behind `isTTY() && !--no-tui` with the stream fallback preserved. 11 TUI tests; full
  suite 45/45; `docs/improvements.md §24`. Remaining: M3 (slash palette/autocomplete), M4 (pipeline/doctor views).
