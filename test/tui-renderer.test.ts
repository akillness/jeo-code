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
