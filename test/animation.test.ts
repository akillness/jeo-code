import { test, expect } from "bun:test";
import {
  EVOLUTION_STAGES,
  getStageByIndex,
  stageBlocks,
  stageFrame,
  renderAsciiArt,
  animateFrames,
  stageHeight,
  stageWidth,
} from "../src/tui/components/ascii-art";
import { visibleWidth } from "../src/tui/components/color";

test("stageBlocks returns frames when present, [art] otherwise", () => {
  const cell = getStageByIndex(0); // has frames
  expect(stageBlocks(cell).length).toBeGreaterThan(1);
  const tool = getStageByIndex(2); // no frames defined
  expect(stageBlocks(tool)).toEqual([tool.art]);
});

test("stageFrame wraps the tick and never out-of-bounds", () => {
  const dna = getStageByIndex(1);
  const n = stageBlocks(dna).length;
  expect(stageFrame(dna, 0)).toBe(stageBlocks(dna)[0]);
  expect(stageFrame(dna, n)).toBe(stageBlocks(dna)[0]); // wrap
  expect(stageFrame(dna, -1)).toBe(stageBlocks(dna)[n - 1]); // negative wraps
  expect(stageFrame(dna, NaN)).toBe(stageBlocks(dna)[0]);
});

test("every frame of every stage shares the global width+height when normalized", () => {
  const w = stageWidth();
  const h = stageHeight();
  for (const stage of EVOLUTION_STAGES) {
    for (let f = 0; f < stageBlocks(stage).length; f++) {
      const lines = renderAsciiArt(stage, { color: false, width: w, height: h, frame: f });
      expect(lines.length).toBe(h);
      expect(lines.every(l => visibleWidth(l) === w)).toBe(true);
    }
  }
});

test("renderAsciiArt frame option selects a distinct animation block", () => {
  const cell = getStageByIndex(0);
  const f0 = renderAsciiArt(cell, { color: false, frame: 0 }).join("\n");
  const f1 = renderAsciiArt(cell, { color: false, frame: 1 }).join("\n");
  expect(f0).not.toBe(f1); // the cell breathes
});

test("animateFrames draws every frame with injected write/sleep, no real delay", async () => {
  const out: string[] = [];
  let sleeps = 0;
  const dna = getStageByIndex(1);
  const drawn = await animateFrames(dna, {
    color: false,
    write: s => out.push(s),
    sleep: async () => {
      sleeps++;
    },
  });
  expect(drawn).toBe(stageBlocks(dna).length);
  expect(out.length).toBe(drawn);
  expect(sleeps).toBe(drawn - 1); // no sleep after the final frame
});
