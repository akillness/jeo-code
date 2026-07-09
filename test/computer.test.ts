import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { writeFileSync } from "node:fs";
import * as stateMod from "../src/agent/state";
import { executeComputerAction } from "../src/commands/computer";
import { computerSupervisor } from "../src/agent/computer-supervisor";

// Capture the REAL state module up front so the mock can preserve every other
// export. A bare `() => ({ readGlobalConfig })` would blank out the rest of
// state.ts for every importer in the shared test process — that leak is what
// previously broke unrelated team/oauth suites.
const realState = { ...stateMod };
let mockComputerEnabled = true;

mock.module("../src/agent/state", () => ({
  ...realState,
  readGlobalConfig: async () => ({ computer: { enabled: mockComputerEnabled } }),
}));

afterAll(() => {
  // Restore the real module so later test files see the genuine state surface.
  mock.module("../src/agent/state", () => realState);
});

describe("Computer Use Command & Actions", () => {
  beforeEach(() => {
    mockComputerEnabled = true;
    computerSupervisor.setKillSwitchLive(true);
    computerSupervisor.heartbeat();
  });

  afterEach(() => {
    computerSupervisor.setKillSwitchLive(false);
  });

  test("should fail if computer use is disabled in config", async () => {
    mockComputerEnabled = false;
    // Disabled returns early BEFORE any spawn — never touches the desktop.
    const res = await executeComputerAction({ action: "screenshot" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("disabled");
  });

  test("enabledOverride: true bypasses a disabled config (e.g. /computer on this session)", async () => {
    mockComputerEnabled = false;
    const res = await executeComputerAction({ action: "wait", duration: 0.01 }, { enabledOverride: true });
    expect(res.success).toBe(true);
  });

  test("enabledOverride: false forces disabled even when config enables it (e.g. /computer off this session)", async () => {
    mockComputerEnabled = true;
    const res = await executeComputerAction({ action: "screenshot" }, { enabledOverride: false });
    expect(res.success).toBe(false);
    expect(res.error).toContain("disabled");
  });


  test("should block side-effecting actions if supervisor is not live", async () => {
    computerSupervisor.setKillSwitchLive(false);
    const res = await executeComputerAction({ action: "click", x: 100, y: 200 });
    expect(res.success).toBe(false);
    expect(res.error).toContain("blocked by fail-closed supervisor");
  });

  test("should allow read-only actions even if supervisor is not live", async () => {
    computerSupervisor.setKillSwitchLive(false);
    const originalSpawn = Bun.spawn;
    // Emulate `screencapture`/`scrot` by writing dummy bytes to the target path
    // (last arg) so the real fs.readFile in computer.ts can read them back —
    // no readonly fs reassignment, no actual screen capture.
    Bun.spawn = ((cmd: string[]) => {
      writeFileSync(cmd[cmd.length - 1]!, Buffer.from("dummy"));
      return {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
      };
    }) as any;

    const res = await executeComputerAction({ action: "screenshot" });
    expect(res.success).toBe(true);
    expect(res.output).toBe(Buffer.from("dummy").toString("base64"));

    Bun.spawn = originalSpawn;
  });

  test("should execute click action successfully when supervisor is live", async () => {
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

    const res = await executeComputerAction({ action: "click", x: 100, y: 200 });
    expect(res.success).toBe(true);
    expect(res.output).toContain("Clicked at (100, 200)");
    expect(spawnedCmd.length).toBeGreaterThan(0);

    Bun.spawn = originalSpawn;
  });

  test("should execute type action successfully when supervisor is live", async () => {
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

    const res = await executeComputerAction({ action: "type", text: "hello" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("Typed text: hello");
    expect(spawnedCmd.length).toBeGreaterThan(0);

    Bun.spawn = originalSpawn;
  });

  test("should execute keypress action successfully when supervisor is live", async () => {
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

    const res = await executeComputerAction({ action: "keypress", key: "Return" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("Pressed key: Return");
    expect(spawnedCmd.length).toBeGreaterThan(0);

    Bun.spawn = originalSpawn;
  });

  test("should execute wait action successfully", async () => {
    const res = await executeComputerAction({ action: "wait", duration: 0.01 });
    expect(res.success).toBe(true);
    expect(res.output).toContain("Waited for 0.01 seconds");
  });

  test("should execute batch action successfully", async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = (() => {
      return {
        exited: Promise.resolve(),
        exitCode: 0,
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
      };
    }) as any;

    const res = await executeComputerAction({
      action: "batch",
      actions: [
        { action: "click", x: 10, y: 20 },
        { action: "type", text: "test" },
      ],
    });
    expect(res.success).toBe(true);
    expect(res.output).toContain("Step 0: Clicked at (10, 20)");
    expect(res.output).toContain("Step 1: Typed text: test");

    Bun.spawn = originalSpawn;
  });
});
