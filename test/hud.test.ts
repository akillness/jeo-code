import { test, expect, beforeAll, afterAll } from "bun:test";
import { renderHud, derivePhase, type JeoPhase } from "../src/tui/components/hud";
import chalk from "chalk";

let prevChalkLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = prevChalkLevel;
});

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("renderHud: correctly highlights active, shows completed, and futures (unicode)", () => {
  // Thinking active
  const thinkingActive = renderHud("thinking", { unicode: true, color: true });
  expect(stripAnsi(thinkingActive)).toBe("● thinking → ○ planning → ○ executing → ○ reporting → ○ done");
  expect(thinkingActive).toContain("\x1b[36m\x1b[1m● thinking\x1b[22m\x1b[39m"); // cyan.bold

  // Planning active
  const planningActive = renderHud("planning", { unicode: true, color: true });
  expect(stripAnsi(planningActive)).toBe("✔ thinking → ● planning → ○ executing → ○ reporting → ○ done");
  expect(planningActive).toContain("\x1b[32m✔ thinking\x1b[39m"); // green completed
  expect(planningActive).toContain("\x1b[36m\x1b[1m● planning\x1b[22m\x1b[39m");

  // Executing active
  const executingActive = renderHud("executing", { unicode: true, color: true });
  expect(stripAnsi(executingActive)).toBe("✔ thinking → ✔ planning → ● executing → ○ reporting → ○ done");

  // Reporting active
  const reportingActive = renderHud("reporting", { unicode: true, color: true });
  expect(stripAnsi(reportingActive)).toBe("✔ thinking → ✔ planning → ✔ executing → ● reporting → ○ done");

  // Done active
  const doneActive = renderHud("done", { unicode: true, color: true });
  expect(stripAnsi(doneActive)).toBe("✔ thinking → ✔ planning → ✔ executing → ✔ reporting → ● done");
});

test("renderHud: ASCII mode with no unicode", () => {
  const thinkingActive = renderHud("thinking", { unicode: false, color: true });
  expect(stripAnsi(thinkingActive)).toBe("* thinking -> o planning -> o executing -> o reporting -> o done");
  expect(thinkingActive).toContain("\x1b[36m\x1b[1m* thinking\x1b[22m\x1b[39m");

  const planningActive = renderHud("planning", { unicode: false, color: true });
  expect(stripAnsi(planningActive)).toBe("v thinking -> * planning -> o executing -> o reporting -> o done");
  expect(planningActive).toContain("\x1b[32mv thinking\x1b[39m");
  expect(planningActive).toContain("\x1b[36m\x1b[1m* planning\x1b[22m\x1b[39m");
});

test("renderHud: color: false produces zero ANSI bytes", () => {
  const resultUnicode = renderHud("planning", { unicode: true, color: false });
  expect(resultUnicode).toBe("✔ thinking → ● planning → ○ executing → ○ reporting → ○ done");
  expect(resultUnicode).not.toContain("\x1b");

  const resultAscii = renderHud("executing", { unicode: false, color: false });
  expect(resultAscii).toBe("v thinking -> v planning -> * executing -> o reporting -> o done");
  expect(resultAscii).not.toContain("\x1b");
});

test("derivePhase: truth table verification", () => {
  // Case 1: finished = true -> done
  expect(derivePhase({ finished: true, thinking: true, runningTool: true, todosActive: true })).toBe("done");
  expect(derivePhase({ finished: true, thinking: false, runningTool: false, todosActive: false })).toBe("done");

  // Case 2: finished = false, runningTool = true -> executing
  expect(derivePhase({ finished: false, thinking: true, runningTool: true, todosActive: true })).toBe("executing");
  expect(derivePhase({ finished: false, thinking: false, runningTool: true, todosActive: false })).toBe("executing");

  // Case 3: finished = false, runningTool = false, thinking = true -> thinking
  expect(derivePhase({ finished: false, thinking: true, runningTool: false, todosActive: true })).toBe("thinking");
  expect(derivePhase({ finished: false, thinking: true, runningTool: false, todosActive: false })).toBe("thinking");

  // Case 4: finished = false, runningTool = false, thinking = false, todosActive = true -> planning
  expect(derivePhase({ finished: false, thinking: false, runningTool: false, todosActive: true })).toBe("planning");

  // Case 5: finished = false, runningTool = false, thinking = false, todosActive = false -> reporting
  expect(derivePhase({ finished: false, thinking: false, runningTool: false, todosActive: false })).toBe("reporting");
});
