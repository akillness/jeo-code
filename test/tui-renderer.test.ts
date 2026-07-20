import { test, expect } from "bun:test";
import { truncate, clearLine } from "../src/tui/terminal";
import { Renderer } from "../src/tui/renderer";

test("truncate", () => {
  expect(truncate("hello", 3)).toBe("hel");
  expect(truncate("hi", 5)).toBe("hi");
});

test("Renderer differential render first time", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40);

  r.render(["a", "b", "c"]);
  const joined = out.join("");
  expect(joined).toContain("a");
  expect(joined).toContain("b");
  expect(joined).toContain("c");
});

test("Renderer differential render partial change", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40);

  r.render(["a", "b", "c"]);
  out.length = 0;

  r.render(["a", "B", "c"]);
  const joined = out.join("");
  expect(joined).toContain("B");
  expect(joined).not.toContain("a");
  expect(joined).not.toContain("c");
});

test("Renderer shrinking clear lines", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40);

  r.render(["a", "b", "c"]);
  out.length = 0;

  r.render(["x"]);
  const joined = out.join("");
  expect(joined).toContain("x");

  // We expect clearLine() (\x1b[2K) to be in the output for the removed lines
  const eraseCode = clearLine();
  const occurrences = joined.split(eraseCode).length - 1;
  expect(occurrences).toBeGreaterThanOrEqual(2);
});

test("Renderer reserve mode: taller frames reserve rows with real newlines before painting", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });

  // Cold start: a 3-row frame needs 2 reserved rows below the anchor, then a hop back up.
  r.render(["a", "b", "c"]);
  const first = out.join("");
  expect(first).toContain("\n\n");
  expect(first).toContain("\x1b[2A");

  // Growth 3 → 4: walk to the last occupied row (down 2), one newline, hop up 3.
  out.length = 0;
  r.render(["a", "b", "c", "d"]);
  const grown = out.join("");
  expect(grown).toContain("\x1b[2B");
  expect(grown).toContain("\n");
  expect(grown).toContain("\x1b[3A");

  // Same-height repaint reserves nothing (no newlines may leak into the diff).
  out.length = 0;
  r.render(["a", "B", "c", "d"]);
  expect(out.join("")).not.toContain("\n");
});

test("Renderer without reserve never emits newlines (alt-screen / non-TTY safety)", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40);
  r.render(["a", "b", "c"]);
  expect(out.join("")).not.toContain("\n");
});

test("Renderer.insertAbove flushes static text and forces a full repaint next render", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40);
  r.render(["frame1", "frame2"]);

  out.length = 0;
  r.insertAbove("ledger line\n");
  const flushed = out.join("");
  expect(flushed).toContain(clearLine());      // first row overwritten with per-line EL
  expect(flushed).not.toContain("\x1b[0J");    // NEVER ED: tmux pushes ED-erased rows into history
  expect(flushed).toContain("ledger line\n");  // static line headed for scrollback

  out.length = 0;
  r.render(["frame1", "frame2"]); // identical content…
  const repaint = out.join("");
  expect(repaint).toContain("frame1"); // …still repainted in full (baseline dropped)
  expect(repaint).toContain("frame2");
});

test("Renderer.insertAbove leaves no ED anywhere in the flush+repaint cycle (reserve mode)", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  r.render(["a", "b", "c"]);
  r.insertAbove("ledger\n");
  r.render(["a", "b", "c"]);
  expect(out.join("")).not.toContain("\x1b[0J");
});

test("Renderer.clear in reserve mode EL-walks the frame instead of ED-clearing", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  r.render(["a", "b", "c"]);
  out.length = 0;
  r.clear();
  const cleared = out.join("");
  expect(cleared).not.toContain("\x1b[0J"); // would push the frame into tmux history
  expect(cleared.split(clearLine()).length - 1).toBeGreaterThanOrEqual(3); // each row EL'd
});

test("Renderer.clear without reserve keeps the ED fast path (alt-screen/non-TTY)", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40);
  r.render(["a", "b"]);
  out.length = 0;
  r.clear();
  expect(out.join("")).toContain("\x1b[0J");
});

test("Renderer insertAbove opens a synchronized update; next render closes it", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  r.render(["frame1", "frame2"]);

  out.length = 0;
  r.insertAbove("ledger\n");
  expect(out.join("")).toContain("\x1b[?2026h"); // BSU opened with the flush
  expect(out.join("")).not.toContain("\x1b[?2026l");

  out.length = 0;
  r.render(["frame1", "frame2"]);
  const repaint = out.join("");
  expect(repaint).toContain("\x1b[?2026l"); // ESU closes after the full repaint
  expect(repaint.endsWith("\x1b[?2026l")).toBe(true);

  // Every render now wraps its OWN repaint in a synchronized update (atomic present),
  // so a half-painted frame can never be shown (no torn row / transient duplicate bar).
  out.length = 0;
  r.render(["frame1", "CHANGED"]);
  const plain = out.join("");
  expect(plain).toContain("\x1b[?2026h");
  expect(plain.endsWith("\x1b[?2026l")).toBe(true);
});

test("Renderer clear() closes a dangling synchronized update", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40);
  r.insertAbove("ledger\n");
  out.length = 0;
  r.clear();
  expect(out.join("")).toContain("\x1b[?2026l");
});

test("Renderer reserve mode: shrinking frames reserve nothing and clear removed rows", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  r.render(["a", "b", "c", "d"]);
  out.length = 0;
  r.render(["a", "b"]);
  const shrunk = out.join("");
  expect(shrunk).not.toContain("\n"); // no reservation on shrink
  const clears = shrunk.split(clearLine()).length - 1;
  expect(clears).toBeGreaterThanOrEqual(2); // rows 3+4 cleared
});

test("Renderer reserve mode: reset() then a shorter frame clears stale rows and does not re-reserve", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  // A tall frame is on screen (4 rows).
  r.render(["a", "b", "c", "d"]);
  // Self-heal: drop the diff baseline (tickCount % 25 resync / resize repaint).
  r.reset();
  out.length = 0;
  // The next frame is SHORTER (2 rows). Before the fix, reset() forgot the 4 physical
  // rows, so the repaint left rows 3+4 (stale model bar / border) on screen.
  r.render(["a", "b"]);
  const joined = out.join("");
  // No spurious reservation: the rows already exist physically, the frame is shorter.
  expect(joined).not.toContain("\n");
  // Rows 3 and 4 must be EL-cleared (the stale-row guarantee).
  const clears = joined.split(clearLine()).length - 1;
  expect(clears).toBeGreaterThanOrEqual(2);
});

test("Renderer reserve mode: reset() then a taller frame still reserves the extra rows", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  r.render(["a", "b"]);
  r.reset();
  out.length = 0;
  r.render(["a", "b", "c", "d"]); // grew 2 → 4 after reset
  const joined = out.join("");
  expect(joined).toContain("\n"); // reserves the 2 new rows
});

test("Renderer reserve mode: reset() then insertAbove() then render() clears the old frame's lower rows (no off-by-one drift)", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  // A 5-row frame is on screen.
  r.render(["a", "b", "c", "d", "e"]);
  // Self-heal reset drops the baseline but records occupancy via coverRows.
  r.reset();
  // A ledger line is flushed (1 written row) BEFORE the next render — the exact path
  // that previously ignored coverRows, leaving rows 2-5 stale + the cursor below anchor.
  out.length = 0;
  r.insertAbove("flushed line\n");
  const flushed = out.join("");
  // insertAbove must EL-clear the 4 rows the 1-row flush did not cover (5 occupied - 1).
  const clears = flushed.split(clearLine()).length - 1;
  expect(clears).toBeGreaterThanOrEqual(4);
  // The next render repaints cleanly with no stale rows carried over.
  out.length = 0;
  r.render(["x", "y"]);
  expect(out.join("")).toContain("x");
});
test("Renderer reserve mode: growth after insertAbove re-reserves the full frame", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  r.render(["a", "b", "c"]);
  r.insertAbove("ledger\n"); // baseline dropped → next render is a cold reserve
  out.length = 0;
  r.render(["a", "b", "c"]);
  const repaint = out.join("");
  expect(repaint).toContain("\n\n");    // 3-row frame from prev=[] → 2 reserved rows
  expect(repaint).toContain("\x1b[2A"); // hop back to the shifted anchor
});

test("Renderer reserve mode: frames taller than the viewport are not reserved", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  const rows = Math.max(1, (process.stdout.rows as number | undefined) || 24);
  r.render(Array.from({ length: rows + 5 }, (_, i) => `row${i}`));
  expect(out.join("")).not.toContain("\n"); // guard: degrade to in-place painting
});

test("Renderer insertAbove eagerly EL-clears the old frame's uncovered rows (no margin desync)", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  r.render(["a", "b", "c", "d", "e"]); // 5-row frame
  out.length = 0;
  r.insertAbove("L\n"); // 1 written row; rows 2-5 of the old frame are stale
  const flush = out.join("");
  // The flush itself clears the 4 uncovered rows (1 insert EL + 4 stale ELs)…
  expect(flush.split(clearLine()).length - 1).toBe(5);
  // …and hops back up to the row right below the insert (the next frame's anchor).
  expect(flush).toContain("\x1b[3A");
  out.length = 0;
  r.render(["x", "y"]); // shorter frame paints WITHOUT walking past its own height
  const repaint = out.join("");
  expect(repaint).not.toContain("\x1b[0J"); // never ED in reserve mode
  // Exactly the 2 frame rows are EL-painted — no deferred stale walk remains. The
  // old coverRows walk cursor-downed past the bottom margin here, where clamping
  // desynced the anchor and every later frame painted one row higher, devouring
  // the flushed ledger/card lines above (the truncated-card corruption).
  expect(repaint.split(clearLine()).length - 1).toBe(2);
});

test("Renderer clears on column or row changes", () => {
  const out: string[] = [];
  let currentCols = 40;
  const r = new Renderer(s => out.push(s), () => currentCols);

  r.render(["a", "b"]);
  out.length = 0;

  // Render with same dimensions -> no clear
  r.render(["a", "b"]);
  expect(out.join("")).not.toContain("\x1b[0J");
  out.length = 0;

  // Change columns -> should clear
  currentCols = 50;
  r.render(["a", "b"]);
  expect(out.join("")).toContain("\x1b[0J");
  out.length = 0;

  // Change rows -> should clear
  // We mock size() or process.stdout.rows. Let's temporarily mock process.stdout.rows
  const originalRows = process.stdout.rows;
  try {
    process.stdout.rows = 24;
    r.render(["a", "b"]);
    out.length = 0;

    process.stdout.rows = 30;
    r.render(["a", "b"]);
    expect(out.join("")).toContain("\x1b[0J");
  } finally {
    process.stdout.rows = originalRows;
  }
});

test("Renderer reserve mode: a resize down to a SHORTER frame never scrolls the terminal", () => {
  // Root-cause regression: render()'s resize branch used to call clear() unconditionally,
  // which zeroes coverRows/prev to 0 as an independent write — right before the SAME
  // render() call's own reserve block reads that (now-wrong) occupancy and, believing
  // NOTHING occupies the screen, spuriously inserts real "\n" characters even though the
  // new (post-resize) frame is SHORTER than the old one. Literal "\n" characters
  // genuinely SCROLL a real terminal, corrupting whatever sits above the live frame and
  // permanently desyncing every later diff's row math (reproduced live via tmux: a
  // resize-down produced progressively worse duplicate/torn footer+input-box content on
  // every subsequent keystroke). Reserve mode must repaint in place — no "\n" at all.
  const out: string[] = [];
  let cols = 80;
  const r = new Renderer(s => out.push(s), () => cols, { reserve: true });

  const wideFrame = Array.from({ length: 10 }, (_, i) => `wide row ${i} `.padEnd(70, "-"));
  r.render(wideFrame);
  expect((r as unknown as { prev: string[] }).prev.length).toBe(10);

  // Resize down: narrower AND fewer rows (mirrors app.ts dropping optional sections
  // — forge preview, right-hand welcome panel, etc. — at narrow widths).
  cols = 20;
  out.length = 0;
  r.render(["hud", "row1", "row2", "row3"]);
  const resized = out.join("");
  expect(resized).not.toContain("\n"); // the corrupting scroll must never happen
  expect(resized).toContain("hud");
  expect(resized).toContain("row3");
  // The 6 now-excess old rows (10 - 4) are still EL-cleared in place.
  expect(resized.split(clearLine()).length - 1).toBeGreaterThanOrEqual(6);

  // A SECOND render right after (same, now-settled size) must repaint cleanly too —
  // no lingering desync from the resize (the progressive-corruption symptom this fix
  // closes: each subsequent tick got WORSE, not just the first one after resize).
  out.length = 0;
  r.render(["hud", "row1-changed", "row2", "row3"]);
  const settled = out.join("");
  expect(settled).not.toContain("\n");
  expect(settled).toContain("row1-changed");
});

test("Renderer non-reserve mode still ED-clears on resize (unaffected by the reserve-mode fix)", () => {
  const out: string[] = [];
  let cols = 40;
  const r = new Renderer(s => out.push(s), () => cols);
  r.render(["a", "b"]);
  out.length = 0;
  cols = 20;
  r.render(["x"]);
  expect(out.join("")).toContain("\x1b[0J");
});