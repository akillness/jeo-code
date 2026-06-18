import { test, expect } from "bun:test";
import {
  EVOLUTION_STAGES,
  getEvolutionStage,
  getStageByIndex,
  renderAsciiArt,
  animateAsciiArt,
  stageHeight,
  stageWidth,
  stageCaption,
  FORGE_MARK_ART,
  FORGE_MARK_ART_ASCII,
  renderForgeMark,
} from "../src/tui/components/ascii-art";
import { ColorLevel } from "../src/tui/components/color";

test("getEvolutionStage / getStageByIndex select + clamp stages", () => {
  expect(getEvolutionStage(0, 25).name).toBe("Primordial Cell");
  expect(getEvolutionStage(25, 25).name).toBe("Super intelligence (Singularity)");
  expect(getStageByIndex(-1)).toBe(EVOLUTION_STAGES[0]);
  expect(getStageByIndex(99)).toBe(EVOLUTION_STAGES[4]);
});

test("renderAsciiArt: height padding yields a uniform block height", () => {
  const h = stageHeight();
  for (const stage of EVOLUTION_STAGES) {
    expect(renderAsciiArt(stage, { height: h }).length).toBe(h);
  }
});

test("renderAsciiArt: width normalization gives a clean right edge (color off)", () => {
  for (const stage of EVOLUTION_STAGES) {
    const lines = renderAsciiArt(stage, { color: false });
    const widths = new Set(lines.map(l => l.length));
    expect(widths.size).toBe(1); // every line padded to the same width
  }
  // explicit width override pads to the global width
  const w = stageWidth();
  const lines = renderAsciiArt(EVOLUTION_STAGES[0]!, { color: false, width: w });
  expect(lines.every(l => l.length === w)).toBe(true);
});

test("renderAsciiArt: color:false emits no ANSI escapes", () => {
  for (const stage of EVOLUTION_STAGES) {
    const text = renderAsciiArt(stage, { color: false }).join("\n");
    expect(text.includes("\u001b[")).toBe(false);
  }
});

test("stageCaption returns the bracketed caption for every stage", () => {
  for (const stage of EVOLUTION_STAGES) {
    const cap = stageCaption(stage);
    expect(cap).toBeDefined();
    expect(/\[.+\]/.test(cap!)).toBe(true);
  }
});

test("animateAsciiArt: injectable write/sleep, no real delay", async () => {
  const out: string[] = [];
  let sleeps = 0;
  await animateAsciiArt(EVOLUTION_STAGES[1]!, {
    color: false,
    delayMs: 5,
    write: s => out.push(s),
    sleep: async () => {
      sleeps++;
    },
  });
  expect(out.length).toBe(EVOLUTION_STAGES[1]!.art.length);
  expect(out.every(s => s.endsWith("\n"))).toBe(true);
  expect(sleeps).toBe(out.length);
});

test("animateAsciiArt: delayMs 0 never calls sleep", async () => {
  const out: string[] = [];
  let sleeps = 0;
  await animateAsciiArt(EVOLUTION_STAGES[0]!, {
    color: false,
    delayMs: 0,
    write: s => out.push(s),
    sleep: async () => {
      sleeps++;
    },
  });
  expect(sleeps).toBe(0);
  expect(out.length).toBeGreaterThan(0);
});

test("stage integrity: every stage has non-empty art and a synced name", async () => {
  const { EVOLUTION_STAGE_NAMES } = await import("../src/tui/components/evolution");
  EVOLUTION_STAGES.forEach((s, i) => {
    expect(s.art.length).toBeGreaterThan(0);
    expect(s.art.some(l => l.trim().length > 0)).toBe(true);
    expect(s.name).toBe(EVOLUTION_STAGE_NAMES[i]);
    expect(stageCaption(s)).toBeDefined();
  });
});

test("all stages align to a uniform global width and height when requested", () => {
  const w = stageWidth();
  const h = stageHeight();
  for (const s of EVOLUTION_STAGES) {
    const lines = renderAsciiArt(s, { color: false, width: w, height: h });
    expect(lines.length).toBe(h);
    expect(lines.every(l => l.length === w)).toBe(true);
  }
});

test("primordial cell: unicode art is width-1 per glyph (no smearing on re-center)", async () => {
  const { visibleWidth } = await import("../src/tui/components/color");
  const cell = getStageByIndex(0);
  for (let f = 0; f < (cell.frames?.length ?? 1); f++) {
    for (const line of renderAsciiArt(cell, { color: false, frame: f })) {
      // length === display width is the invariant that keeps renderAsciiArt's
      // length-based padding and app.ts/welcome.ts's visibleWidth centering in sync.
      expect(line.length).toBe(visibleWidth(line));
    }
  }
});

test("primordial cell: unicode:false degrades to a tofu-free ASCII fallback", () => {
  const cell = getStageByIndex(0);
  expect(cell.asciiArt).toBeDefined();
  expect(cell.asciiFrames && cell.asciiFrames.length).toBe(cell.frames!.length);
  const nonAscii = /[^\x00-\x7f]/;
  for (let f = 0; f < cell.frames!.length; f++) {
    const uni = renderAsciiArt(cell, { color: false, frame: f, unicode: true }).join("\n");
    const ascii = renderAsciiArt(cell, { color: false, frame: f, unicode: false }).join("\n");
    expect(nonAscii.test(uni)).toBe(true); // box-drawing / geometric glyphs present
    expect(nonAscii.test(ascii)).toBe(false); // fallback is pure ASCII
  }
  // ASCII frames stay width-uniform so the fallback never tears the welcome box.
  for (let f = 0; f < cell.asciiFrames!.length; f++) {
    const lines = renderAsciiArt(cell, { color: false, frame: f, unicode: false });
    expect(new Set(lines.map(l => l.length)).size).toBe(1);
  }
});
test("FORGE_MARK_ART: lines uniform width after render", () => {
  expect(FORGE_MARK_ART.length).toBeGreaterThan(0);
  for (const line of FORGE_MARK_ART) {
    expect(line.length).toBeLessThanOrEqual(24);
  }
  const rendered = renderForgeMark({ color: false });
  expect(rendered.length).toBe(FORGE_MARK_ART.length);
  const widthSet = new Set(rendered.map(l => l.length));
  expect(widthSet.size).toBe(1);
  expect(widthSet.values().next().value).toBeLessThanOrEqual(24);
});

test("renderForgeMark: plain (color:false) is byte-stable across phases", () => {
  const r0 = renderForgeMark({ color: false, phase: 0 });
  const r1 = renderForgeMark({ color: false, phase: 0.5 });
  expect(r0).toEqual(r1);
});

test("renderForgeMark: two different phases at TrueColor produce different escape sequences", () => {
  const r0 = renderForgeMark({ color: true, colorLevel: ColorLevel.TrueColor, phase: 0 });
  const r1 = renderForgeMark({ color: true, colorLevel: ColorLevel.TrueColor, phase: 0.5 });
  expect(r0).not.toEqual(r1);
  for (const line of r0) {
    expect(line.includes("\x1b[")).toBe(true);
  }
  for (const line of r1) {
    expect(line.includes("\x1b[")).toBe(true);
  }
});

test("renderForgeMark: ascii fallback contains no non-ASCII chars", () => {
  expect(FORGE_MARK_ART_ASCII.length).toBeGreaterThan(0);
  const nonAscii = /[^\x00-\x7f]/;
  const rendered = renderForgeMark({ unicode: false, color: false });
  for (const line of rendered) {
    expect(nonAscii.test(line)).toBe(false);
  }
});
