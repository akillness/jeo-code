import { test, expect } from "bun:test";
import {
  stageProgressRatio,
  overallProgress,
  nextStageName,
  stepsToNextStage,
  transitionMessage,
  EVOLUTION_TRANSITION_MESSAGES,
  EVOLUTION_STAGE_COUNT,
  createStageProgress,
  evolutionTrack,
} from "../src/tui/components/evolution";

test("evolutionTrack ratio shows a half marker on the next stage when partway", () => {
  // no ratio → plain ●●●○○
  expect(evolutionTrack(2, { color: false, unicode: true })).toContain("\u25cf\u25cf\u25cf\u25cb\u25cb");
  // mid-progress → next marker is ◐ (half)
  const partial = evolutionTrack(2, { color: false, unicode: true, ratio: 0.5 });
  expect(partial).toContain("\u25cf\u25cf\u25cf\u25d0\u25cb");
  // ascii half marker is '+'
  expect(evolutionTrack(2, { color: false, unicode: false, ratio: 0.5 })).toContain("###+-");
  // ratio 0 or 1 → no half marker
  expect(evolutionTrack(2, { color: false, unicode: true, ratio: 1 })).toContain("\u25cf\u25cf\u25cf\u25cb\u25cb");
});

test("stageProgressRatio is 0 at step 0 and fills each band 0→1", () => {
  expect(stageProgressRatio(0, 100)).toBe(0);
  expect(stageProgressRatio(25, 100)).toBeCloseTo(1, 5); // end of stage-1 band
  expect(stageProgressRatio(26, 100)).toBeCloseTo((0.26 - 0.25) / 0.25, 5); // start of stage-2 band
  expect(stageProgressRatio(100, 100)).toBe(1);
  expect(stageProgressRatio(-1, 100)).toBe(0);
  expect(stageProgressRatio(10, 0)).toBe(0);
});

test("overallProgress clamps step/maxSteps to [0,1]", () => {
  expect(overallProgress(0, 25)).toBe(0);
  expect(overallProgress(5, 10)).toBe(0.5);
  expect(overallProgress(999, 10)).toBe(1);
  expect(overallProgress(NaN, 10)).toBe(0);
});

test("nextStageName advances and clamps at the final stage", () => {
  expect(nextStageName(0, 100)).toBe("Double Helix (DNA)");
  expect(nextStageName(100, 100)).toBe("Super intelligence (Singularity)"); // already final
});

test("stepsToNextStage counts whole steps to the next stage; 0 at final", () => {
  expect(stepsToNextStage(100, 100)).toBe(0); // final stage
  const n = stepsToNextStage(1, 100); // stage 1 → stage 2 boundary at step 26
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(100);
});

test("transition messages: one per stage, clamped lookup", () => {
  expect(EVOLUTION_TRANSITION_MESSAGES.length).toBe(EVOLUTION_STAGE_COUNT);
  expect(transitionMessage(1)).toBe(EVOLUTION_TRANSITION_MESSAGES[1]);
  expect(transitionMessage(99)).toBe(EVOLUTION_TRANSITION_MESSAGES[EVOLUTION_STAGE_COUNT - 1]);
  expect(transitionMessage(-5)).toBe(EVOLUTION_TRANSITION_MESSAGES[0]);
});

test("StageProgress.advanced fires only on the observe that raises the peak", () => {
  const p = createStageProgress();
  expect(p.observe(0, 100)).toBe(0);
  expect(p.advanced()).toBe(false);
  expect(p.observe(1, 100)).toBe(1); // 0 → 1
  expect(p.advanced()).toBe(true);
  expect(p.observe(2, 100)).toBe(1); // still stage 1
  expect(p.advanced()).toBe(false);
  expect(p.observe(100, 100)).toBe(4); // jump to 4
  expect(p.advanced()).toBe(true);
  p.reset();
  expect(p.advanced()).toBe(false);
});
