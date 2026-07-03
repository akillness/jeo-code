import { test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { writeFileSync } from "node:fs";
import * as stateMod from "../src/agent/state";
import { computerSupervisor } from "../src/agent/computer-supervisor";

// Same isolation discipline as test/computer.test.ts: preserve every other
// export of state.ts so this mock does not blank the module for the shared
// bun:test process, and always restore it afterwards.
const realState = { ...stateMod };
let mockComputerEnabled = true;

mock.module("../src/agent/state", () => ({
  ...realState,
  readGlobalConfig: async () => ({ computer: { enabled: mockComputerEnabled } }),
}));

afterAll(() => {
  mock.module("../src/agent/state", () => realState);
});

beforeEach(() => {
  mockComputerEnabled = true;
  // Deliberately NOT pre-arming the supervisor here — the whole point of this
  // suite is that the `computer` DEFAULT_TOOLS handler arms it itself.
  computerSupervisor.setKillSwitchLive(false);
});

afterEach(() => {
  computerSupervisor.setKillSwitchLive(false);
});

test("KNOWN_TOOLS/allowedTools gap: 'computer' is present in DEFAULT_TOOLS (the interactive tool map)", async () => {
  const { DEFAULT_TOOLS } = await import("../src/agent/engine");
  expect(typeof DEFAULT_TOOLS.computer).toBe("function");
});

test("DEFAULT_TOOLS.computer arms the supervisor itself — a mutating action succeeds without the caller pre-arming it", async () => {
  const { DEFAULT_TOOLS } = await import("../src/agent/engine");
  expect(computerSupervisor.inputAllowed).toBe(false); // not armed yet

  const originalSpawn = Bun.spawn;
  let spawnedCmd: string[] = [];
  Bun.spawn = ((cmd: string[]) => {
    spawnedCmd = cmd;
    return {
      exited: Promise.resolve(),
      exitCode: 0,
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
    };
  }) as any;

  const res = await DEFAULT_TOOLS.computer!({ action: "click", x: 5, y: 9 }, process.cwd());
  Bun.spawn = originalSpawn;

  expect(res.success).toBe(true);
  expect(res.output).toContain("Clicked at (5, 9)");
  expect(spawnedCmd.length).toBeGreaterThan(0);
});

test("DEFAULT_TOOLS.computer still respects the read-only bypass (screenshot works even 'unarmed' beforehand)", async () => {
  const { DEFAULT_TOOLS } = await import("../src/agent/engine");
  const originalSpawn = Bun.spawn;
  Bun.spawn = ((cmd: string[]) => {
    writeFileSync(cmd[cmd.length - 1]!, Buffer.from("dummy"));
    return {
      exited: Promise.resolve(),
      exitCode: 0,
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
    };
  }) as any;

  const res = await DEFAULT_TOOLS.computer!({ action: "screenshot" }, process.cwd());
  Bun.spawn = originalSpawn;

  expect(res.success).toBe(true);
  expect(res.output).toBe(Buffer.from("dummy").toString("base64"));
});

test("DEFAULT_TOOLS.computer still fails closed when computer.enabled is false in config", async () => {
  mockComputerEnabled = false;
  const { DEFAULT_TOOLS } = await import("../src/agent/engine");
  const res = await DEFAULT_TOOLS.computer!({ action: "click", x: 1, y: 1 }, process.cwd());
  expect(res.success).toBe(false);
  expect(res.error).toContain("disabled");
});

test("read-only subagent toolset (subagentToolset) excludes 'computer'", async () => {
  const { subagentToolset, getSubagentRole } = await import("../src/agent/subagents");
  const planner = getSubagentRole("planner")!;
  expect(planner.readOnly).toBe(true);
  const toolset = subagentToolset(planner);
  expect(toolset.computer).toBeUndefined();
});

test("launch's KNOWN_TOOLS advertises 'computer' so --tools computer is accepted", async () => {
  // launch.ts's KNOWN_TOOLS is not exported (module-local); assert the contract at
  // the source-text level instead of re-implementing CLI arg parsing here.
  const src = await Bun.file("src/commands/launch.ts").text();
  const m = /const KNOWN_TOOLS = new Set\(\[([^\]]+)\]\);/.exec(src);
  expect(m).toBeTruthy();
  expect(m![1]).toContain('"computer"');
});
