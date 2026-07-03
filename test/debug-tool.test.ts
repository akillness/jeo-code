import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { debugSession } from "../src/agent/debug-session";
import { createDebugTool } from "../src/agent/debug-tool";

const hasNode = !!Bun.which("node");

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-debug-"));
}

afterEach(async () => {
  await debugSession.terminate();
});

const FIXTURE = `function add(a, b) {
  const sum = a + b;
  console.log("sum is", sum);
  return sum;
}
let total = 0;
for (let i = 0; i < 3; i++) {
  total = add(total, i);
}
console.log("total", total);
`;

test.skipIf(!hasNode)("debug: launch pauses at program start, breakpoint hits, evaluate/variables work, then terminate", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "target.js"), FIXTURE);
  const tool = createDebugTool();

  const launchRes = await tool({ action: "launch", program: "target.js" }, cwd);
  expect(launchRes.success).toBe(true);
  expect(launchRes.output).toContain("Paused at program start");

  const bp = await tool({ action: "set_breakpoint", file: "target.js", line: 2 }, cwd);
  expect(bp.success).toBe(true);
  expect(bp.output).toContain("target.js:2");

  const cont = await tool({ action: "continue" }, cwd);
  expect(cont.success).toBe(true);
  expect(cont.output).toContain("Paused");
  expect(cont.output).toContain("add (");

  const trace = await tool({ action: "stack_trace" }, cwd);
  expect(trace.success).toBe(true);
  expect(trace.output).toContain("add (");

  const evalRes = await tool({ action: "evaluate", expression: "a + b" }, cwd);
  expect(evalRes.success).toBe(true);
  expect(evalRes.output).toBe("0");

  const scopesRes = await tool({ action: "scopes" }, cwd);
  expect(scopesRes.success).toBe(true);
  expect(scopesRes.output).toContain("local:");

  const objectIdMatch = /local:\s*(\S+)/.exec(scopesRes.output);
  expect(objectIdMatch).toBeTruthy();
  const varsRes = await tool({ action: "variables", object_id: objectIdMatch![1] }, cwd);
  expect(varsRes.success).toBe(true);
  expect(varsRes.output).toContain("a =");
  expect(varsRes.output).toContain("b =");

  const term = await tool({ action: "terminate" }, cwd);
  expect(term.success).toBe(true);
  expect(term.output).toContain("terminated");
});

test.skipIf(!hasNode)("debug: continue past the last breakpoint reports program completion instead of hanging", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "target.js"), 'console.log("hi");\n');
  const tool = createDebugTool();

  await tool({ action: "launch", program: "target.js" }, cwd);
  const cont = await tool({ action: "continue" }, cwd);
  expect(cont.success).toBe(true);
  expect(cont.output).toContain("Program finished");
});

test.skipIf(!hasNode)("debug: launching a script that errors before an inspector connection is reported clearly", async () => {
  const cwd = await tmpDir();
  const tool = createDebugTool();
  const res = await tool({ action: "launch", program: "does-not-exist.js" }, cwd);
  // node itself will exit quickly with a MODULE_NOT_FOUND error before ever pausing.
  expect(res.success).toBe(false);
});

test("debug: actions requiring an active session fail clearly when none exists", async () => {
  const tool = createDebugTool();
  const cwd = await tmpDir();
  expect((await tool({ action: "set_breakpoint", file: "x.js", line: 1 }, cwd)).success).toBe(false);
  expect((await tool({ action: "continue" }, cwd)).success).toBe(false);
  expect((await tool({ action: "evaluate", expression: "1+1" }, cwd)).success).toBe(false);
  const term = await tool({ action: "terminate" }, cwd);
  expect(term.success).toBe(true);
  expect(term.output).toContain("No active debug session");
});

test("debug: launch requires a non-empty program", async () => {
  const tool = createDebugTool();
  const res = await tool({ action: "launch" }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("program");
});

test("debug: set_breakpoint requires file and a positive line", async () => {
  const tool = createDebugTool();
  const cwd = await tmpDir();
  expect((await tool({ action: "set_breakpoint", line: 1 }, cwd)).success).toBe(false);
  expect((await tool({ action: "set_breakpoint", file: "x.js", line: 0 }, cwd)).success).toBe(false);
});

test("debug: rejects an unknown action", async () => {
  const tool = createDebugTool();
  const res = await tool({ action: "bogus" }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("Unknown debug action");
});
