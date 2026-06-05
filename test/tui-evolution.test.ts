import { test, expect } from "bun:test";
import { getEvolutionStage, renderAsciiArt, animateAsciiArt } from "../src/tui/components/ascii-art";
import { getEvolutionTip, getEvolutionStatusMessage } from "../src/tui/components/evolution";
import chalk from "chalk";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("getEvolutionStage maps steps to stages correctly", () => {
  expect(getEvolutionStage(0).name).toBe("Primordial Cell");
  expect(getEvolutionStage(2, 25).name).toBe("Double Helix (DNA)");
  expect(getEvolutionStage(10, 25).name).toBe("Tool User (Homo Habilis)");
  expect(getEvolutionStage(15, 25).name).toBe("AI Coding Agent");
  expect(getEvolutionStage(20, 25).name).toBe("Super intelligence (Singularity)");
});

test("renderAsciiArt respects options", () => {
  const stage = getEvolutionStage(0);
  const plainArt = renderAsciiArt(stage, { color: false });
  for (const line of plainArt) {
    expect(stripAnsi(line)).toBe(line); // no color
  }

  const heightArt = renderAsciiArt(stage, { color: false, height: 10 });
  expect(heightArt.length).toBe(10); // padded to height 10

  const widthArt = renderAsciiArt(stage, { color: false, width: 30 });
  for (const line of widthArt) {
    expect(line.length).toBe(30); // padded to width 30
  }
});

test("renderAsciiArt auto-scales on narrow terminal", () => {
  const stage = getEvolutionStage(20, 25); // Singularity
  const artWidth = Math.max(...stage.art.map(l => l.length));
  
  // Should render fine when terminal is wide enough
  expect(renderAsciiArt(stage, { cols: artWidth }).length).toBeGreaterThan(0);
  
  // Should return empty array when terminal is too narrow
  expect(renderAsciiArt(stage, { cols: artWidth - 1 }).length).toBe(0);
});

test("renderAsciiArt handles firing options", () => {
  const stage = getEvolutionStage(0);
  // Re-rendering with firing multiple times should occasionally add stars/sparks
  let sparkFound = false;
  for (let i = 0; i < 20; i++) {
    const art = renderAsciiArt(stage, { firing: true });
    const text = art.join("\n");
    if (text.includes("*") || text.includes(".") || text.includes("o") || text.includes("+") || text.includes("\u2727")) {
      sparkFound = true;
      break;
    }
  }
  expect(sparkFound).toBe(true);
});

test("getEvolutionTip and getEvolutionStatusMessage map correctly", () => {
  const tip0 = getEvolutionTip(0, 25);
  expect(tip0).toContain("Primordial code");
  
  const tip4 = getEvolutionTip(20, 25);
  expect(tip4).toContain("Cosmic singularity");

  const status0 = getEvolutionStatusMessage(0, 25, 0);
  expect(status0).toBe("Synthesizing primordial logic...");
  
  const status0_next = getEvolutionStatusMessage(0, 25, 1);
  expect(status0_next).toBe("Forming basic concepts...");
});

test("animateAsciiArt calls write and sleep", async () => {
  const stage = getEvolutionStage(0);
  const writes: string[] = [];
  let sleepCount = 0;
  
  await animateAsciiArt(stage, {
    delayMs: 1,
    write: s => writes.push(s),
    sleep: async () => { sleepCount++; }
  });
  
  expect(writes.length).toBe(stage.art.length);
  expect(sleepCount).toBe(stage.art.length);
});
