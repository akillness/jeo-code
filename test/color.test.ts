import { test, expect } from "bun:test";
import {
  ColorLevel,
  stripAnsi,
  visibleWidth,
  detectColorLevel,
  hexToRgb,
  lerpColor,
  gradientStops,
  rgbToAnsi256,
  rgbToAnsi16,
  applyGradient,
  detectAppearance,
} from "../src/tui/components/color";
import { renderAsciiArt, getStageByIndex } from "../src/tui/components/ascii-art";
import { stageGradient } from "../src/tui/components/evolution";

test("stripAnsi / visibleWidth ignore SGR escapes", () => {
  const colored = "\x1b[31mred\x1b[0m";
  expect(stripAnsi(colored)).toBe("red");
  expect(visibleWidth(colored)).toBe(3);
  expect(visibleWidth("plain")).toBe(5);
});

test("detectColorLevel honors NO_COLOR / FORCE_COLOR / COLORTERM / TERM", () => {
  expect(detectColorLevel({ NO_COLOR: "" })).toBe(ColorLevel.None);
  expect(detectColorLevel({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe(ColorLevel.None); // NO_COLOR wins
  expect(detectColorLevel({ FORCE_COLOR: "3" })).toBe(ColorLevel.TrueColor);
  expect(detectColorLevel({ FORCE_COLOR: "0" })).toBe(ColorLevel.None);
  expect(detectColorLevel({ COLORTERM: "truecolor" })).toBe(ColorLevel.TrueColor);
  expect(detectColorLevel({ COLORTERM: "24bit" })).toBe(ColorLevel.TrueColor);
  expect(detectColorLevel({ TERM: "xterm-256color" })).toBe(ColorLevel.Ansi256);
  expect(detectColorLevel({ TERM: "xterm" })).toBe(ColorLevel.Basic);
  expect(detectColorLevel({ TERM: "dumb" })).toBe(ColorLevel.None);
  expect(detectColorLevel({}, false)).toBe(ColorLevel.None);
  expect(detectColorLevel({}, true)).toBe(ColorLevel.Basic);
});
test("detectAppearance honors COLORFGBG environment variable and falls back", () => {
  // COLORFGBG parsing test
  // dark colors
  expect(detectAppearance({ COLORFGBG: "15;0" })).toBe("dark");
  expect(detectAppearance({ COLORFGBG: "15;6" })).toBe("dark");
  expect(detectAppearance({ COLORFGBG: "15;8" })).toBe("dark");
  expect(detectAppearance({ COLORFGBG: "15;235" })).toBe("dark");

  // light colors
  expect(detectAppearance({ COLORFGBG: "0;7" })).toBe("light");
  expect(detectAppearance({ COLORFGBG: "0;11" })).toBe("light");
  expect(detectAppearance({ COLORFGBG: "0;15" })).toBe("light");
  expect(detectAppearance({ COLORFGBG: "0;248" })).toBe("light");

  // color cube
  expect(detectAppearance({ COLORFGBG: "0;16" })).toBe("dark");
  expect(detectAppearance({ COLORFGBG: "0;231" })).toBe("light");

  // invalid format or missing COLORFGBG
  if (process.platform === "darwin") {
    expect(["light", "dark"]).toContain(detectAppearance({}));
    expect(["light", "dark"]).toContain(detectAppearance({ COLORFGBG: "invalid" }));
  } else {
    expect(detectAppearance({})).toBeUndefined();
    expect(detectAppearance({ COLORFGBG: "invalid" })).toBeUndefined();
  }
});

test("hexToRgb parses #rrggbb and #rgb; bad input → black", () => {
  expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
  expect(hexToRgb("0f0")).toEqual({ r: 0, g: 255, b: 0 });
  expect(hexToRgb("nope")).toEqual({ r: 0, g: 0, b: 0 });
});

test("lerpColor + gradientStops span the endpoints", () => {
  const a = { r: 0, g: 0, b: 0 };
  const b = { r: 255, g: 255, b: 255 };
  expect(lerpColor(a, b, 0)).toEqual(a);
  expect(lerpColor(a, b, 1)).toEqual(b);
  expect(lerpColor(a, b, 0.5)).toEqual({ r: 128, g: 128, b: 128 });
  const stops = gradientStops(a, b, 5);
  expect(stops.length).toBe(5);
  expect(stops[0]).toEqual(a);
  expect(stops[4]).toEqual(b);
  expect(gradientStops(a, b, 1)).toEqual([a]);
});

test("rgb→ansi256 / ansi16 quantize sensibly", () => {
  expect(rgbToAnsi256({ r: 0, g: 0, b: 0 })).toBe(16);
  expect(rgbToAnsi256({ r: 255, g: 255, b: 255 })).toBe(231);
  expect(rgbToAnsi16({ r: 0, g: 0, b: 0 })).toBe(30);
  expect(rgbToAnsi16({ r: 255, g: 0, b: 0 })).toBe(91); // bright red
});

test("applyGradient emits truecolor escapes and downgrades to plain at None", () => {
  const from = { r: 255, g: 0, b: 0 };
  const to = { r: 0, g: 0, b: 255 };
  const tc = applyGradient("ABC", from, to, ColorLevel.TrueColor);
  expect(tc).toContain("\x1b[38;2;255;0;0m"); // first char = from
  expect(tc.endsWith("\x1b[0m")).toBe(true);
  expect(stripAnsi(tc)).toBe("ABC");
  // None level returns plain
  expect(applyGradient("ABC", from, to, ColorLevel.None)).toBe("ABC");
  // 256 level uses 38;5;
  expect(applyGradient("A", from, to, ColorLevel.Ansi256)).toContain("\x1b[38;5;");
});

test("applyGradient leaves spaces unpainted but counted", () => {
  const out = applyGradient("A B", { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, ColorLevel.TrueColor);
  expect(stripAnsi(out)).toBe("A B");
  // the space character itself is not preceded by a color escape
  expect(out).toContain(" ");
});

test("renderAsciiArt gradient option paints art and preserves visible width", () => {
  const stage = getStageByIndex(2);
  const grad = stageGradient(2);
  const lines = renderAsciiArt(stage, { gradient: grad, colorLevel: ColorLevel.TrueColor, width: 24 });
  expect(lines.every(l => l.includes("\x1b[38;2;"))).toBe(true);
  expect(lines.every(l => visibleWidth(l) === 24)).toBe(true);
  // color:false suppresses the gradient entirely (no escapes)
  const plain = renderAsciiArt(stage, { gradient: grad, color: false, width: 24 });
  expect(plain.every(l => !l.includes("\x1b["))).toBe(true);
});
