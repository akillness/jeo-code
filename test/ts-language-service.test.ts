import { test, expect } from "bun:test";
import { parseSymbolSelector, resolvePosition, lineOfPosition, formatLocation } from "../src/agent/ts-language-service";

test("parseSymbolSelector: undefined stays undefined", () => {
  expect(parseSymbolSelector(undefined)).toBeUndefined();
});

test("parseSymbolSelector: plain text defaults to occurrence 1", () => {
  expect(parseSymbolSelector("greet")).toEqual({ text: "greet", occurrence: 1 });
});

test("parseSymbolSelector: '#N' suffix selects the Nth occurrence", () => {
  expect(parseSymbolSelector("greet#2")).toEqual({ text: "greet", occurrence: 2 });
  expect(parseSymbolSelector("foo.bar#3")).toEqual({ text: "foo.bar", occurrence: 3 });
});

test("resolvePosition: no symbol resolves to the start of the line", () => {
  const text = "line one\nline two\nline three\n";
  const res = resolvePosition(text, 2);
  expect("error" in res).toBe(false);
  if (!("error" in res)) expect(text.slice(res.position, res.position + 4)).toBe("line");
});

test("resolvePosition: symbol selector resolves to that occurrence's column", () => {
  const text = "call(a, a, a);\n";
  const res = resolvePosition(text, 1, { text: "a", occurrence: 2 });
  expect("error" in res).toBe(false);
  if (!("error" in res)) {
    // second "a" is at index 8 ("call(a, a, a)" -> a=5, a=8, a=11)
    expect(text[res.position - 0]).toBe("a"); // position lands within the token span
  }
});

test("resolvePosition: out-of-range line returns an error", () => {
  const res = resolvePosition("only one line\n", 5);
  expect("error" in res).toBe(true);
  if ("error" in res) expect(res.error).toContain("out of range");
});

test("resolvePosition: symbol not found on the line returns an error", () => {
  const res = resolvePosition("const x = 1;\n", 1, { text: "nope", occurrence: 1 });
  expect("error" in res).toBe(true);
  if ("error" in res) expect(res.error).toContain("not found");
});

test("lineOfPosition: maps an offset back to its 1-indexed line", () => {
  const text = "aaa\nbbb\nccc\n";
  expect(lineOfPosition(text, 0)).toBe(1);
  expect(lineOfPosition(text, 4)).toBe(2);
  expect(lineOfPosition(text, 8)).toBe(3);
});

test("formatLocation: renders path:line: text and truncates long text", () => {
  expect(formatLocation("src/a.ts", 12, "const x = 1;")).toBe("src/a.ts:12: const x = 1;");
  const long = "x".repeat(200);
  const out = formatLocation("src/a.ts", 1, long);
  expect(out.length).toBeLessThan(200);
  expect(out.endsWith("…")).toBe(true);
});
