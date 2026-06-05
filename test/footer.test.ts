import { test, expect } from "bun:test";
import { renderFooter } from "../src/tui/components/footer";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("footer appends a compact evolution-stage tag when step+maxSteps known", () => {
  const out = stripAnsi(renderFooter({ model: "m1", step: 1, maxSteps: 50 }));
  expect(out).toContain("step 1/50");
  expect(out).toContain("\u25cf\u25cf\u25cb\u25cb\u25cb Double Helix (DNA) [2/5]"); // 1/50 → ratio 0.02 → stage 1
});

test("footer stage tag tracks the evolution stage", () => {
  expect(stripAnsi(renderFooter({ model: "m", step: 0, maxSteps: 100 }))).toContain("\u25cf\u25cb\u25cb\u25cb\u25cb Primordial Cell [1/5]");
  expect(stripAnsi(renderFooter({ model: "m", step: 50, maxSteps: 100 }))).toContain("\u25cf\u25cf\u25cf\u25cb\u25cb Tool User (Homo Habilis) [3/5]");
  expect(stripAnsi(renderFooter({ model: "m", step: 100, maxSteps: 100 }))).toContain("\u25cf\u25cf\u25cf\u25cf\u25cf Super intelligence (Singularity) [5/5]");
});

test("footer omits the stage tag when showStage:false or step/maxSteps missing", () => {
  expect(stripAnsi(renderFooter({ model: "m", step: 1, maxSteps: 50, showStage: false }))).not.toContain("[2/5]");
  expect(stripAnsi(renderFooter({ model: "m" }))).not.toContain("[");
  expect(stripAnsi(renderFooter({ model: "m", step: 3 }))).not.toContain("["); // no maxSteps
});

test("footer joins segments with ' · ' and leads with the model", () => {
  const out = stripAnsi(renderFooter({ model: "m1", step: 2, maxSteps: 10, sessionId: "abcd1234efgh" }));
  expect(out.startsWith("m1 · ")).toBe(true);
  expect(out).toContain("abcd1234");
});
