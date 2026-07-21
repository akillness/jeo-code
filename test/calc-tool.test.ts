import { test, expect } from "bun:test";
import { calcTool, evaluateExpression, tokenizeExpression } from "../src/agent/calc-tool";
import { DEFAULT_TOOLS, TOOL_PROTOCOL, READONLY_TOOL_PROTOCOL } from "../src/agent/engine";
import { nativeToolSchemasFor } from "../src/agent/tool-schemas";

// gjc parity (packages/coding-agent/src/tools/calculator.ts): a faithful port of the
// tokenizer/recursive-descent parser/evaluator, verified directly against the real,
// public gajae-code source (not inferred).

test("evaluateExpression: standard arithmetic with correct precedence", () => {
  expect(evaluateExpression("2 + 3 * 4")).toBe(14);
  expect(evaluateExpression("(2 + 3) * 4")).toBe(20);
  expect(evaluateExpression("10 - 2 - 3")).toBe(5); // left-associative: (10-2)-3
  expect(evaluateExpression("8 / 4 / 2")).toBe(1); // left-associative: (8/4)/2
  expect(evaluateExpression("10 % 3")).toBe(1);
});

test("evaluateExpression: exponentiation is right-associative", () => {
  expect(evaluateExpression("2 ** 3 ** 2")).toBe(512); // 2 ** (3 ** 2), not (2**3)**2 = 64
});

test("evaluateExpression: unary operators, including chained", () => {
  expect(evaluateExpression("-5 + 3")).toBe(-2);
  expect(evaluateExpression("--5")).toBe(5);
  expect(evaluateExpression("+-5")).toBe(-5);
});

test("evaluateExpression: hex, binary, octal, and scientific-notation literals", () => {
  expect(evaluateExpression("0xFF")).toBe(255);
  expect(evaluateExpression("0b1010")).toBe(10);
  expect(evaluateExpression("0o755")).toBe(493);
  expect(evaluateExpression("1e3")).toBe(1000);
  expect(evaluateExpression("2.5E-2")).toBeCloseTo(0.025);
  expect(evaluateExpression(".5 + .5")).toBe(1);
});

test("evaluateExpression: -0 normalizes to 0", () => {
  expect(Object.is(evaluateExpression("0 * -1"), 0)).toBe(true);
});

test("evaluateExpression: throws on syntax errors, empty input, and non-finite results", () => {
  expect(() => evaluateExpression("")).toThrow("empty");
  expect(() => evaluateExpression("2 +")).toThrow();
  expect(() => evaluateExpression("(2 + 3")).toThrow("closing parenthesis");
  expect(() => evaluateExpression("2 $ 3")).toThrow("Invalid character");
  expect(() => evaluateExpression("1 / 0")).toThrow("not a finite number");
});

test("tokenizeExpression: recognizes ** before a single *", () => {
  const tokens = tokenizeExpression("2**3");
  expect(tokens).toEqual([
    { type: "number", value: 2, raw: "2" },
    { type: "operator", value: "**" },
    { type: "number", value: 3, raw: "3" },
  ]);
});

test("calcTool: evaluates multiple expressions with prefix/suffix, one result per line", async () => {
  const res = await calcTool([
    { expression: "3 * 7", prefix: "total: " },
    { expression: "100 / 4", suffix: " USD" },
  ]);
  expect(res.success).toBe(true);
  expect(res.output).toBe("total: 21\n25 USD");
});

test("calcTool: a bad expression fails the WHOLE call with a clear error (fail-fast, not partial)", async () => {
  const res = await calcTool([{ expression: "2 + 2" }, { expression: "2 +++ (" }]);
  expect(res.success).toBe(false);
  expect(res.error).toContain("calc:");
});

test("calcTool: rejects an empty/non-array calculations list", async () => {
  expect((await calcTool([])).success).toBe(false);
  expect((await calcTool(undefined as never)).success).toBe(false);
});

test("calc is wired into DEFAULT_TOOLS, the native schema registry, and both tool-protocol texts", async () => {
  expect(typeof DEFAULT_TOOLS.calc).toBe("function");
  const r = await DEFAULT_TOOLS.calc!({ calculations: [{ expression: "1 + 1" }] }, process.cwd());
  expect(r.success).toBe(true);
  expect(r.output).toBe("2");

  const schemas = nativeToolSchemasFor(["calc"]);
  const calcSchema = schemas.find(s => s.name === "calc");
  expect(calcSchema).toBeTruthy();
  expect(calcSchema!.parameters.required).toContain("calculations");

  expect(TOOL_PROTOCOL).toContain("calc  {calculations");
  expect(READONLY_TOOL_PROTOCOL).toContain("calc   {calculations");
});

test("calc is treated as read-only (no side effects) and survives read-only subagent filtering", async () => {
  const { subagentToolset } = await import("../src/agent/subagents");
  const { getSubagentRole } = await import("../src/agent/subagents");
  const planner = subagentToolset(getSubagentRole("planner")!);
  expect(Object.keys(planner)).toContain("calc");
});
