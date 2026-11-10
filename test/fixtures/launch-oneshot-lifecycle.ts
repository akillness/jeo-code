import { expect, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentLoopOptions } from "../../src/agent/engine";

// This worker intentionally mocks the engine before loading launch; static imports
// would bind launch to the real engine before the mock is installed.
const realEngine = { ...(await import("../../src/agent/engine")) };
let turnAction: (options: AgentLoopOptions) => void = () => {};
mock.module("../../src/agent/engine", () => ({
  ...realEngine,
  runAgentLoop: mock(async (_history: unknown, options: AgentLoopOptions) => {
    turnAction(options);
    return { done: true, steps: 1, doneReason: "ok" };
  }),
}));

async function runMockOneShot(isTTY: boolean, action: (options: AgentLoopOptions) => void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oneshot-lifecycle-"));
  const savedConfig = process.env.JEO_CONFIG_DIR;
  const savedTTY = process.stdin.isTTY;
  const savedLog = console.log;
  try {
    process.env.JEO_CONFIG_DIR = dir;
    process.stdin.isTTY = isTTY;
    console.log = () => {};
    turnAction = action;
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ providers: { groq: "test-key" }, defaultModel: "groq/llama-3.3-70b-versatile", routing: { enabled: false } }));
    const { runLaunchCommand } = await import("../../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", "--no-skills", "-p", "test prompt"]);
  } finally {
    console.log = savedLog;
    process.stdin.isTTY = savedTTY;
    if (savedConfig === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedConfig;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const scenario = process.argv[2];
if (scenario === "completion") {
  const pause = spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
  let calls = 0;
  try {
    await runMockOneShot(true, () => { calls++; });
    expect(calls).toBe(1);
    expect(pause).toHaveBeenCalledTimes(1);
    pause.mockClear();
    await runMockOneShot(false, () => { calls++; });
    expect(calls).toBe(2);
    expect(pause).toHaveBeenCalledTimes(0);
  } finally { pause.mockRestore(); }
} else if (scenario === "failure") {
  const pause = spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
  const before = process.listenerCount("SIGINT");
  let called = false;
  try {
    await runMockOneShot(true, () => { called = true; throw new Error("simulated turn failure"); });
    expect(called).toBe(true);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  } finally { pause.mockRestore(); }
} else if (scenario === "sigint") {
  const prior = new Set(process.listeners("SIGINT"));
  const exit = spyOn(process, "exit").mockImplementation((() => { throw new Error("exit intercepted"); }) as typeof process.exit);
  let called = false;
  let aborted = false;
  try {
    await runMockOneShot(false, options => {
      called = true;
      const listener = process.listeners("SIGINT").find(fn => !prior.has(fn));
      expect(listener).toBeDefined();
      try { listener!(); } finally { aborted = options.signal?.aborted ?? false; }
    });
    expect(called).toBe(true);
    expect(aborted).toBe(true);
    expect(exit).toHaveBeenCalledWith(130);
    expect(process.listeners("SIGINT").filter(fn => !prior.has(fn))).toHaveLength(0);
  } finally { exit.mockRestore(); }
} else {
  throw new Error(`Unknown one-shot lifecycle scenario: ${scenario}`);
}
