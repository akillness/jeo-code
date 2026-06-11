import { test, expect } from "bun:test";
import {
  padLineTo,
  alignBlock,
  centerBlock,
  padBlockToHeight,
  fillScreen,
  boxBlock,
  BOX_ASCII,
} from "../src/tui/components/layout";
import { visibleWidth } from "../src/tui/components/color";

test("padLineTo fills to width by alignment, ANSI-aware", () => {
  expect(padLineTo("ab", 5, "left")).toBe("ab   ");
  expect(padLineTo("ab", 5, "right")).toBe("   ab");
  expect(padLineTo("ab", 5, "center")).toBe(" ab  ");
  // colored content counts only visible width
  const colored = "\x1b[31mab\x1b[0m";
  expect(visibleWidth(padLineTo(colored, 6, "center"))).toBe(6);
});

test("alignBlock pads every line to width", () => {
  const out = alignBlock(["a", "bbb"], 5, "center");
  expect(out.every(l => visibleWidth(l) === 5)).toBe(true);
});

test("centerBlock left-pads by half the slack of the widest line", () => {
  const out = centerBlock(["xx", "y"], 10); // block width 2, slack 8 → left 4
  expect(out[0]).toBe("    xx");
  expect(out[1]).toBe("    y");
  // narrower than block → unchanged
  expect(centerBlock(["xxxxx"], 3)).toEqual(["xxxxx"]);
});

test("padBlockToHeight grows to rows without truncating", () => {
  expect(padBlockToHeight(["a"], 3, "top")).toEqual(["a", "", ""]);
  expect(padBlockToHeight(["a"], 3, "bottom")).toEqual(["", "", "a"]);
  expect(padBlockToHeight(["a"], 3, "center")).toEqual(["", "a", ""]);
  // already tall enough → unchanged (never clipped)
  expect(padBlockToHeight(["a", "b", "c", "d"], 2)).toEqual(["a", "b", "c", "d"]);
});

test("fillScreen pins footer to the bottom row, blank-filling the gap", () => {
  const frame = fillScreen(["H"], ["B"], ["F"], 6);
  expect(frame.length).toBe(6);
  expect(frame[0]).toBe("H");
  expect(frame[1]).toBe("B");
  expect(frame[5]).toBe("F"); // footer is the last line
  expect(frame.slice(2, 5)).toEqual(["", "", ""]); // filler
  // content already overflowing rows → not clipped
  expect(fillScreen(["a", "b"], ["c"], ["f"], 1)).toEqual(["a", "b", "c", "f"]);
});

test("boxBlock draws a bordered, centered panel of the given width", () => {
  const box = boxBlock(["hi"], 8, { glyphs: BOX_ASCII });
  expect(box[0]).toBe("+------+");
  expect(box[box.length - 1]).toBe("+------+");
  expect(box[1]!.startsWith("|")).toBe(true);
  expect(box[1]!.endsWith("|")).toBe(true);
  expect(visibleWidth(box[1]!)).toBe(8);
});
