# GJC TUI → joc Parity Analysis

Source evidence: real `gjc` v0.4.3 captures in this directory (tmux 3.6a, 120x35; see
`observations.md` for the raw inventory, every claim there cites a capture file).
Comparison target: jeo-code `src/tui` at HEAD `539cb66` (post pass-888/888b inline
scrollback work).

## 1. Feature-by-feature comparison

| # | gjc element (evidence) | joc today | Verdict |
|---|---|---|---|
| 1 | Normal-buffer rendering, `alternate_on=0`, full mid-turn scrollback (`03-history.txt`) | Inline main-buffer live turn, EL-only erases, DECSET 2026 atomic flushes (pass 888/888b) | **Parity achieved** (this was the prior ultragoal) |
| 2 | Welcome banner: bordered header, slogan, gradient art, model/provider pills (`01-startup*.txt`) | `components/welcome.ts` boxed welcome with pills + workspace/session panels (recently landed) | Parity; do not touch (recently landed by another session) |
| 3 | Update-available gold box (`01-startup.txt` L19-22) | `components/update-box.ts` (recently landed) | Parity; out of scope |
| 4 | Tool checklist lines: `⏳ Read src/tui` → `✔ Read package.json`, glyph-first, colored tool name (`02-live-1.txt`, `05-live-2.txt`) | Ledger lines flushed as text badges `[FILE] [DONE] read src/cli.ts`; glyphs only inside the tool-list frame rows | **Gap A**: scrollback ledger lines scan slower than gjc's glyph-first style |
| 5 | Boxed tool execution block: `┌─ ✔ Bash ─┐`, `$ cmd`, `├─ Output ─┤`, metadata row (`05-live-3.txt`) | Forge boxes: `[01:CMD] bash · command` header + output body + borders | Parity in substance; cosmetic differences only |
| 6 | Status HUD above input: model, thinking, **git branch ⑂**, **cwd 📁**, **rate ⤴ tok/s**, ctx %, **cost $** (`01-startup.txt` L23, `05-live-4.txt` L29) | Footer heartbeat ALREADY renders `cwd (branch)` (`footer.ts:77-93`, branch plumbed once at startup via `git symbolic-ref`, `launch.ts:670-682`) plus model/provider/step/ETA/ctx%; `[STEP]` row shows cumulative usage only | **Gap B (rescoped)**: only the **live output-token rate (tok/s)** is genuinely absent; branch + cwd are already shown — adding them again would duplicate the footer |
| 7 | Spinner + real operation text + `⟦esc⟧` interrupt hint (`02-live-1.txt` L30) | Spinner + `[STATUS]` real activity row + hint bar `^C cancel` | Parity (hint location differs by design) |
| 8 | `user` / `gajae` labeled turns in scrollback (`04-final-ansi.txt`) | Prompt echo (readline) + `joc>` reply line | Parity in substance; labels are a theme choice, skip |
| 9 | Session resume hint on exit: `Resume this session with gjc --resume <uuid>` (`07-exit.txt` L35) | joc has `/sessions` + `/resume` + `joc launch --resume`, but the `/exit` path prints no resume pointer (`launch.ts:1774`; the only existing CLI hint lives in the `--list` handler, `launch.ts:779`) | **Gap C**: discoverability gap on exit |
| 10 | TrueColor palette discipline (observations §4) | Theme system (cosmic/matrix/solar/red-claw/blue-crab/mono) with gradients | Parity (joc richer: themeable) |

## 2. Ranked improvement candidates for joc (bounded)

1. **A — Glyph-first ledger lines** (effort S, risk low): prepend gjc-style `✔`/`✗`
   (ASCII `v`/`x` fallback) to the flushed tool-result ledger lines so mid-turn
   scrollback scans like gjc's checklist. Files: `src/tui/app.ts` (onToolResult),
   test `test/tui-app.test.ts`. Preserves badges (category info stays).
2. **B — Live token rate (tok/s)** (effort S, risk low): show gjc-style `⤴ N.N/s`
   (output tokens / elapsed) on the `[STEP]` row next to the cumulative usage,
   computed from existing `turnUsage` + `elapsedMs` — no new data sources, no
   subprocess, no duplication of the footer's existing `cwd (branch)` display.
   Files: `src/tui/components/status.ts`, `src/tui/app.ts` (plumb only),
   assertions in `test/tui-app.test.ts`.
   *(Correction note: a prior revision claimed joc lacked git branch + cwd; that was
   false — `footer.ts:77-93` already renders both. Rescoped to tok/s only.)*
3. **C — Resume hint on exit** (effort S, risk low-med): on `/exit`/`/quit` with a
   persisted session, print the existing CLI convention exactly:
   `Resume with: joc launch --resume <sessionId>` (matches `launch.ts:779`).
   File: `src/commands/launch.ts` exit path + in-scope `sessionId`.
4. *(rejected)* turn labels (`user`/`joc` headers): duplicate of readline echo +
   `joc>`; cosmetic only. *(rejected)* forge-box `$`-prefix restyle: parity already
   substantive; churn > value. *(out of scope)* welcome/update-box: just landed by a
   concurrent session.

## 3. Constraints carried into implementation

- Must preserve the pass-888b inline scrollback contract: EL-only erases mid-turn,
  DECSET 2026 pairing, no ledger duplication, `JOC_TUI_ALT_SCREEN=1` fallback.
- No edits to `welcome.ts`, `update-box.ts` (concurrent-session surface).
- No new data sources on the render path: tok/s derives from existing `turnUsage` +
  `elapsedMs`; branch/cwd stay footer-owned (already plumbed once at startup).
