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

  // A later plain render never re-emits sync sequences.
  out.length = 0;
  r.render(["frame1", "CHANGED"]);
  expect(out.join("")).not.toContain("\x1b[?2026");
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

test("Renderer coverRows: shorter render after insertAbove EL-clears the stale lower rows", () => {
  const out: string[] = [];
  const r = new Renderer(s => out.push(s), () => 40, { reserve: true });
  r.render(["a", "b", "c", "d", "e"]); // 5-row frame
  r.insertAbove("L\n");                // baseline dropped, coverRows=5
  out.length = 0;
  r.render(["x", "y"]);                // shorter frame: rows 2-4 are stale
  const repaint = out.join("");
  expect(repaint).not.toContain("\x1b[0J"); // never ED in reserve mode
  // 2 painted rows + ≥3 stale rows EL-cleared via coverRows
  expect(repaint.split(clearLine()).length - 1).toBeGreaterThanOrEqual(5);
});
