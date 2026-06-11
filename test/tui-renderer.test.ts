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
  expect(flushed).toContain("\x1b[0J");        // frame cleared from the anchor
  expect(flushed).toContain("ledger line\n");  // static line headed for scrollback

  out.length = 0;
  r.render(["frame1", "frame2"]); // identical content…
  const repaint = out.join("");
  expect(repaint).toContain("frame1"); // …still repainted in full (baseline dropped)
  expect(repaint).toContain("frame2");
});
