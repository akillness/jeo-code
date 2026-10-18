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
    expect(res.output).toBe("Screenshot captured.");
    expect(res.images).toEqual([{ mediaType: "image/png", data: Buffer.from("dummy").toString("base64") }]);

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

  test("drag releases the mouse and scrolling uses real scroll events", async () => {
    const originalSpawn = Bun.spawn;
    const commands: string[][] = [];
    Bun.spawn = ((cmd: string[]) => {
      commands.push(cmd);
      return { exited: Promise.resolve(0), exitCode: 0,
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }) };
    }) as any;
    try {
      expect((await executeComputerAction({ action: "drag", x: 40, y: 50 })).success).toBe(true);
      expect(commands[0]).toEqual(process.platform === "darwin"
        ? ["cliclick", "dd:.", "dm:40,50", "du:40,50"]
        : ["xdotool", "mousedown", "1", "mousemove", "40", "50", "mouseup", "1"]);
      expect((await executeComputerAction({ action: "scroll", deltaY: 2, deltaX: -1 })).success).toBe(true);
      if (process.platform === "darwin") {
        expect(commands[1]![0]).toBe("/usr/bin/osascript");
        expect(commands[1]!.at(-1)).toContain("CGEventCreateScrollWheelEvent(null, 1, 2, 2, -1)");
      } else expect(commands[1]).toEqual(["xdotool", "click", "4", "click", "4", "click", "6"]);
      if (process.platform === "darwin") {
        await executeComputerAction({ action: "keypress", key: "Command+Return" });
        expect(commands[2]).toEqual(["cliclick", "kd:cmd", "kp:return", "ku:cmd"]);
      }
    } finally { Bun.spawn = originalSpawn; }
  });

  test("rejects invalid numeric inputs and skips zero scrolling without spawning", async () => {
    for (const action of [
      { action: "click", x: NaN, y: 0 },
      { action: "wait", duration: -1 },
      { action: "wait", duration: Infinity },
      { action: "wait", duration: 61 },
      { action: "scroll", deltaY: 0.5 },
      { action: "scroll", deltaX: 1001 },
    ] as const) expect((await executeComputerAction(action)).success).toBe(false);
    expect((await executeComputerAction({ action: "scroll" })).output).toContain("skipped");
  });

  test("batch screenshots keep image attachments rather than embedding base64 in text", async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = ((cmd: string[]) => {
      writeFileSync(cmd.at(-1)!, "image");
      return { exited: Promise.resolve(0), exitCode: 0,
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }) };
    }) as any;
    try {
      const result = await executeComputerAction({ action: "batch", actions: [{ action: "screenshot" }, { action: "wait", duration: 0 }] });
      expect(result.success).toBe(true);
      expect(result.images).toEqual([{ mediaType: "image/png", data: Buffer.from("image").toString("base64") }]);
      expect(result.output).toContain("Step 0: Screenshot captured.");
      expect(result.output).not.toContain(Buffer.from("image").toString("base64"));
    } finally { Bun.spawn = originalSpawn; }
  });

  test("drains child pipes before waiting for exit (avoids full-pipe deadlock)", async () => {
    const originalSpawn = Bun.spawn;
    let drained = false;
    let finish!: () => void;
    const exited = new Promise<void>(resolve => { finish = resolve; });
    Bun.spawn = (() => ({ exited, exitCode: 0,
      stdout: new ReadableStream({ pull(c) { drained = true; c.close(); finish(); } }, { highWaterMark: 0 }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
    })) as any;
    try {
      const result = await executeComputerAction({ action: "click", x: 1, y: 1 });
      expect(drained).toBe(true);
      expect(result.success).toBe(true);
    } finally { Bun.spawn = originalSpawn; }
  });
});
