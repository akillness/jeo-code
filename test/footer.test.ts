import { test, expect } from "bun:test";
import { renderFooter } from "../src/tui/components/footer";

test("footer appends a compact evolution-stage tag when step+maxSteps known", () => {
  const out = renderFooter({ model: "m1", step: 1, maxSteps: 50 });
  expect(out).toContain("step 1/50");
  expect(out).toContain("evo 2/5 Double Helix (DNA)"); // 1/50 → ratio 0.02 → stage 1
});

test("footer stage tag tracks the evolution stage", () => {
  expect(renderFooter({ model: "m", step: 0, maxSteps: 100 })).toContain("evo 1/5 Primordial Cell");
  expect(renderFooter({ model: "m", step: 50, maxSteps: 100 })).toContain("evo 3/5 Tool User (Homo Habilis)");
  expect(renderFooter({ model: "m", step: 100, maxSteps: 100 })).toContain("evo 5/5 Super intelligence (Singularity)");
});

test("footer omits the stage tag when showStage:false or step/maxSteps missing", () => {
  expect(renderFooter({ model: "m", step: 1, maxSteps: 50, showStage: false })).not.toContain("evo ");
  expect(renderFooter({ model: "m" })).not.toContain("evo ");
  expect(renderFooter({ model: "m", step: 3 })).not.toContain("evo "); // no maxSteps
});

test("footer joins segments with ' · ' and leads with the model", () => {
  const out = renderFooter({ model: "m1", step: 2, maxSteps: 10, sessionId: "abcd1234efgh" });
  expect(out.startsWith("m1 · ")).toBe(true);
  expect(out).toContain("abcd1234");
});
