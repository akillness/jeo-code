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
} from "../src/tui/components/ascii-art";

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
