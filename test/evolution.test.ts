import { test, expect } from "bun:test";
import {
  EVOLUTION_STAGE_COUNT,
  EVOLUTION_STAGE_NAMES,
  EVOLUTION_SPINNER_FRAMES,
  EVOLUTION_METER_GLYPHS,
  EVOLUTION_STAGE_COLORS,
  stageIndexForStep,
  stageIndexForRatio,
  clampStageIndex,
  evolutionStageName,
  evolutionTrack,
  createStageProgress,
} from "../src/tui/components/evolution";
import { EVOLUTION_STAGES } from "../src/tui/components/ascii-art";
import { Spinner } from "../src/tui/components/spinner";

test("canonical tables are all length 5 and index-aligned", () => {
  expect(EVOLUTION_STAGE_COUNT).toBe(5);
  expect(EVOLUTION_STAGE_NAMES.length).toBe(5);
  expect(EVOLUTION_SPINNER_FRAMES.length).toBe(5);
  expect(EVOLUTION_METER_GLYPHS.length).toBe(5);
  expect(EVOLUTION_STAGE_COLORS.length).toBe(5);
  expect(EVOLUTION_STAGES.length).toBe(5);
});

test("stageIndexForStep: step 0 is primordial, quartiles thereafter", () => {
  expect(stageIndexForStep(0, 25)).toBe(0);
  expect(stageIndexForStep(1, 100)).toBe(1); // 0.01 → ≤0.25
  expect(stageIndexForStep(25, 100)).toBe(1); // 0.25 boundary → stage 1
  expect(stageIndexForStep(26, 100)).toBe(2); // >0.25
  expect(stageIndexForStep(50, 100)).toBe(2); // 0.5 boundary
  expect(stageIndexForStep(75, 100)).toBe(3); // 0.75 boundary
  expect(stageIndexForStep(100, 100)).toBe(4);
  expect(stageIndexForStep(999, 100)).toBe(4); // over budget
});

test("stageIndexForStep: guards non-positive / non-finite inputs → stage 0", () => {
  expect(stageIndexForStep(-5, 25)).toBe(0);
  expect(stageIndexForStep(10, 0)).toBe(0);
  expect(stageIndexForStep(10, -1)).toBe(0);
  expect(stageIndexForStep(NaN, 25)).toBe(0);
  expect(stageIndexForStep(10, NaN)).toBe(0);
});

test("stageIndexForRatio: five bands, clamped, NaN→0", () => {
  expect(stageIndexForRatio(0)).toBe(0);
  expect(stageIndexForRatio(0.2)).toBe(0);
  expect(stageIndexForRatio(0.21)).toBe(1);
  expect(stageIndexForRatio(0.5)).toBe(2);
  expect(stageIndexForRatio(0.8)).toBe(3);
  expect(stageIndexForRatio(1)).toBe(4);
  expect(stageIndexForRatio(5)).toBe(4); // clamp over
  expect(stageIndexForRatio(-1)).toBe(0); // clamp under
  expect(stageIndexForRatio(NaN)).toBe(0);
});

test("clampStageIndex keeps indices in range", () => {
  expect(clampStageIndex(-3)).toBe(0);
  expect(clampStageIndex(2)).toBe(2);
  expect(clampStageIndex(99)).toBe(4);
  expect(clampStageIndex(NaN)).toBe(0);
});

test("evolutionStageName matches the canonical names", () => {
  expect(evolutionStageName(0, 25)).toBe("Primordial Cell");
  expect(evolutionStageName(25, 25)).toBe("Super intelligence (Singularity)");
});

test("evolutionTrack renders 5 markers + name + [n/5], plain when color:false", () => {
  const track = evolutionTrack(2, { color: false });
  expect(track).toBe("\u25cf\u25cf\u25cf\u25cb\u25cb Tool User (Homo Habilis) [3/5]");
  // out-of-range active is clamped
  expect(evolutionTrack(99, { color: false })).toContain("[5/5]");
});

test("ascii-art stage names stay synced with the canonical names", () => {
  expect(EVOLUTION_STAGES.map(s => s.name)).toEqual([...EVOLUTION_STAGE_NAMES]);
});

test("spinner frames evolve with step and survive frame-count shrink", () => {
  const sp = new Spinner();
  sp.updateStep(0, 25); // soup (6 frames)
  expect(EVOLUTION_SPINNER_FRAMES[0]).toContain(sp.current());
  // advance index near the end of a long frame set, then shrink to a short one
  sp.setStage(3); // 10 frames
  for (let i = 0; i < 9; i++) sp.next();
  sp.setStage(2); // 4 frames — index must wrap, not overflow
  expect(EVOLUTION_SPINNER_FRAMES[2]).toContain(sp.current());
  sp.reset();
  expect(typeof sp.current()).toBe("string");
});

test("createStageProgress is monotonic (never devolves) and resettable", () => {
  const p = createStageProgress();
  expect(p.observe(100, 100)).toBe(4); // singularity
  expect(p.observe(1, 100)).toBe(4); // would be stage 1, but peak holds
  expect(p.current()).toBe(4);
  p.reset();
  expect(p.current()).toBe(0);
  expect(p.observe(50, 100)).toBe(2);
});
