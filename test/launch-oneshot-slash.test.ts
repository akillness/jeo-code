import { test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");

/** Spawn the real CLI with `-p <cmd>` (one-shot path, no piped stdin needed).
 *  Mirrors the helper in test/launch-repl-eof.test.ts. Real spawn is required
 *  here (rather than importing runLaunchCommand) because the one-shot control
 *  commands under test (/config, /usage, /context, /tools, /hotkeys, /theme,
 *  /wiki, /evolve) are pure/local — no network/model call — so a full process
 *  spawn is cheap and gives byte-for-byte real CLI behavior instead of mocked
 *  approximations. */
async function runOneShot(arg: string, timeoutMs = 20_000): Promise<{ code: number | "timeout"; stdout: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-oneshot-"));
  const proc = Bun.spawn([process.execPath, CLI, "--no-tui", "--no-session", "--no-skills", "-p", arg], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // JEO_CONFIG_DIR: the spawned CLI must NEVER touch the real ~/.jeo (one-shot
    // /theme, /wiki etc. persist config) — sandbox it in this run's temp dir.
    env: { ...process.env, NO_COLOR: "1", JEO_CONFIG_DIR: path.join(dir, ".jeo") },
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const result = await Promise.race([
    proc.exited,
    new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);
  if (result === "timeout") proc.kill();
  const stdout = await stdoutPromise;
  await stderrPromise;
  await fs.rm(dir, { recursive: true, force: true });
  return { code: result, stdout };
}

// Regression: one-shot (`-p`/piped) slash control commands were only special-cased
// for /exit, /quit, /clear, /session, and /help — every other documented control
// command (`/config`, `/usage`, `/context`, `/tools`, `/hotkeys`, `/theme`, `/wiki`,
// `/evolve`, `/settings`) fell through to `runTurn(...)` and was sent to the LLM as
// a literal chat prompt. Asserting the absence of `[step ` proves no agent turn ran
// (no model call); asserting a command-specific marker proves the real handler ran.
test("one-shot /config prints the config panel, does not hit the model", async () => {
  const { code, stdout } = await runOneShot("/config", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout).toContain("Effective runtime config:");
  expect(stdout).not.toContain("[step ");
}, 35_000);

test("one-shot /settings is an alias for /config", async () => {
  const { code, stdout } = await runOneShot("/settings", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout).toContain("Effective runtime config:");
  expect(stdout).not.toContain("[step ");
}, 35_000);

test("one-shot /usage prints the usage panel, does not hit the model", async () => {
  const { code, stdout } = await runOneShot("/usage", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout.length).toBeGreaterThan(0);
  expect(stdout).not.toContain("[step ");
  expect(stdout).not.toContain("I don't have a");
}, 35_000);

test("one-shot /context prints the context panel, does not hit the model", async () => {
  const { code, stdout } = await runOneShot("/context", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout.length).toBeGreaterThan(0);
  expect(stdout).not.toContain("[step ");
  expect(stdout).not.toContain("I don't have a");
}, 35_000);

test("one-shot /tools prints the tool protocol panel, does not hit the model", async () => {
  const { code, stdout } = await runOneShot("/tools", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout).toContain("Tools visible to the agent:");
  expect(stdout).not.toContain("[step ");
}, 35_000);

test("one-shot /hotkeys prints the hotkeys panel, does not hit the model", async () => {
  const { code, stdout } = await runOneShot("/hotkeys", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout.length).toBeGreaterThan(0);
  expect(stdout).not.toContain("[step ");
  expect(stdout).not.toContain("I don't have a");
}, 35_000);

test("one-shot /theme (no arg) lists themes, does not hit the model", async () => {
  const { code, stdout } = await runOneShot("/theme", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout).toContain("TUI themes");
  expect(stdout).not.toContain("[step ");
}, 35_000);

test("one-shot /theme <unknown> reports the error, does not hit the model", async () => {
  const { code, stdout } = await runOneShot("/theme not-a-real-theme", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout).toContain("Unknown theme");
  expect(stdout).not.toContain("[step ");
}, 35_000);

test("one-shot /wiki prints the wiki status, does not hit the model", async () => {
  const { code, stdout } = await runOneShot("/wiki", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout.length).toBeGreaterThan(0);
  expect(stdout).not.toContain("[step ");
  expect(stdout).not.toContain("I don't have a");
}, 35_000);

test("one-shot /evolve runs the evolution animation, does not hit the model", async () => {
  const { code, stdout } = await runOneShot("/evolve", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout).toContain("Initiating Evolutionary Simulation");
  expect(stdout).toContain("Evolved to Singularity");
  expect(stdout).not.toContain("[step ");
}, 35_000);

// ---- /compact --no-session reporting fix -----------------------------------
// Regression: `maybeCompact` mutates `history` in place whenever `res.compacted`
// is true, regardless of `sessionId` — but the interactive handler used to gate
// the success message on `sessionId` too (needed only for the `appendCompaction`
// persistence call). In `--no-session` mode a real compaction silently happened
// while the user was told "(nothing to compact)". Drive the interactive REPL
// (via readline mock, following test/launch-skill-native.test.ts's pattern) with
// a mocked `maybeCompact` that reports a successful compaction, and assert the
// compacted-message branch fires even though `sessionId` is undefined.
const realCompaction = { ...(await import("../src/agent/compaction")) };
const mockMaybeCompact = mock(async () => ({
  compacted: true,
  removed: 3,
  replacesThrough: undefined as number | undefined,
  touchedFiles: [] as string[],
  summary: undefined as string | undefined,
  error: undefined as string | undefined,
}));
mock.module("../src/agent/compaction", () => ({
  maybeCompact: mockMaybeCompact,
  historyTokens: realCompaction.historyTokens,
}));

let mockQuestions: string[] = [];
let mockQuestionIndex = 0;
const realReadline = { ...(await import("node:readline/promises")) };
mock.module("node:readline/promises", () => ({
  createInterface: () => ({
    question: mock(async () => {
      if (mockQuestionIndex < mockQuestions.length) return mockQuestions[mockQuestionIndex++];
      return "/exit";
    }),
    close: mock(() => {}),
    on: mock(() => {}),
    pause: mock(() => {}),
    resume: mock(() => {}),
  }),
}));

let originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  mockQuestions = [];
  mockQuestionIndex = 0;
  mockMaybeCompact.mockClear();
});

afterEach(() => {
  process.stdin.isTTY = originalIsTTY;
});

afterAll(() => {
  mock.module("../src/agent/compaction", () => realCompaction);
  mock.module("node:readline/promises", () => realReadline);
});

test("/compact reports the compacted-message branch even with sessionId undefined (--no-session)", async () => {
  mockQuestions = ["/compact", "/exit"];
  const logs: string[] = [];
  const logSpy = mock((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  const originalLog = console.log;
  console.log = logSpy as unknown as typeof console.log;
  try {
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);
  } finally {
    console.log = originalLog;
  }
  expect(mockMaybeCompact).toHaveBeenCalled();
  const joined = logs.join("\n");
  expect(joined).toContain("(compacted 3 older messages)");
  expect(joined).not.toContain("(nothing to compact)");
});
