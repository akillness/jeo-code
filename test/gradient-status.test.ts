import { test, expect } from "bun:test";
import { animatedGradientText, ColorLevel, stripAnsi } from "../src/tui/components/color";

test("animatedGradientText returns input unchanged at colorLevel 0", () => {
  const text = "Hello World";
  const palette = ["#ff0000", "#00ff00"];
  const out = animatedGradientText(text, palette, 0, { colorLevel: ColorLevel.None });
  expect(out).toBe(text);
});

test("animatedGradientText at colorLevel 3 contains ANSI 38;2; codes and strips back to the original text", () => {
  const text = "Hello World";
  const palette = ["#ff0000", "#00ff00"];
  const out = animatedGradientText(text, palette, 0, { colorLevel: ColorLevel.TrueColor });
  
  // Checks it contains truecolor ANSI escapes (38;2;r;g;bm)
  expect(out).toContain("\x1b[38;2;");
  // Checks it ends with reset escape
  expect(out.endsWith("\x1b[0m")).toBe(true);
  // Checks it strips back to the original text using the stripAnsi helper from color.ts
  expect(stripAnsi(out)).toBe(text);
});

test("animatedGradientText with phase 0 vs 0.5 produces different byte sequences for the same text", () => {
  const text = "Hello World";
  const palette = ["#ff0000", "#00ff00"];
  const out0 = animatedGradientText(text, palette, 0, { colorLevel: ColorLevel.TrueColor });
  const out05 = animatedGradientText(text, palette, 0.5, { colorLevel: ColorLevel.TrueColor });
  
  expect(out0).not.toBe(out05);
  expect(stripAnsi(out0)).toBe(text);
  expect(stripAnsi(out05)).toBe(text);
});
