import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listAgyModels, runAgyTurn } from "../src/agent/antigravity-cli";

const FIXTURE = join(import.meta.dir, "fixtures", "agy-fake-cli.ts");
const MODEL = "agy/gemini-4-argon-low";
const SLUG = "gemini-4-argon-low";
const dirs: string[] = [];

async function fixtureDir(config: Record<string, unknown>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "jeo-agy-runtime-"));
  dirs.push(cwd);
  await writeFile(join(cwd, "agy-fixture.json"), JSON.stringify(config));
  return cwd;
}

async function observed(cwd: string): Promise<{ args: string[]; stdin: string }> {
  return JSON.parse(await readFile(join(cwd, "agy-observed.json"), "utf8")) as { args: string[]; stdin: string };
}

function ndjson(...events: unknown[]): string[] {
  return events.map(event => `${JSON.stringify(event)}\n`);
}
async function waitForFixtureFile(cwd: string, name: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(join(cwd, name)).exists()) return;
    await Bun.sleep(5);
  }
  throw new Error(`fixture did not create ${name} before deadline`);
}
async function expectFixtureDead(cwd: string): Promise<void> {
  const pid = Number(await readFile(join(cwd, "agy-pid"), "utf8"));
  expect(Number.isInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
}

function initEvent(model = SLUG, conversationId = "conv-1"): unknown {
  return {
    event: "init",
    conversation_id: conversationId,
    init: { model, cwd: "/fixture", tools: [], permission_mode: "request-review" },
  };
}

function stepEvent(step: number, textDelta?: string): unknown {
  return {
    event: "step_update",
    step_update: {
      conversation_id: "conv-1",
      step_index: step,
      state: "DONE",
      step_type: "agent_response",
      ...(textDelta === undefined ? {} : { text_delta: textDelta }),
    },
  };
}

function resultEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    event: "result",
    result: {
      conversation_id: "conv-1",
      status: "SUCCESS",
      response: "final answer",
      model: SLUG,
      num_turns: 1,
      usage: { input_tokens: 17, output_tokens: 23, thinking_tokens: 5, cache_read_tokens: 2 },
      ...overrides,
    },
  };
}

async function run(cwd: string, overrides: Partial<Parameters<typeof runAgyTurn>[0]> = {}) {
  return runAgyTurn({
    model: MODEL,
    prompt: "Explain the fixture protocol",
    cwd,
    executable: FIXTURE,
    timeoutMs: 500,
    ...overrides,
  });
}
function expectTurnArgs(args: string[], suffix: string[] = []): void {
  expect(args.slice(0, 8)).toEqual([
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", SLUG,
    "--sandbox", "--print-timeout",
  ]);
  expect(args[8]).toMatch(/^\d+(?:\.\d+)?(?:ms|s)$/);
  expect(args.slice(9)).toEqual(suffix);
  expect(args).not.toContain("--dangerously-skip-permissions");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test("listAgyModels qualifies exact slugs, preserves labels' slugs, and deduplicates without inventing IDs", async () => {
  const cwd = await fixtureDir({
    models: [
      "gemini-4-argon-low\tGemini 4 Argon (Low)",
      "gemini-4-argon-high\tGemini 4 Argon (High)",
      "gemini-4-argon-low\tDuplicate label",
    ],
  });

  await expect(listAgyModels({ cwd, executable: FIXTURE, timeoutMs: 500 })).resolves.toEqual([
    "agy/gemini-4-argon-low",
    "agy/gemini-4-argon-high",
  ]);
  expect(await observed(cwd)).toEqual({ args: ["models"], stdin: "" });
});

test("listAgyModels distinguishes a successful empty list from malformed output and never fabricates a model", async () => {
  const emptyCwd = await fixtureDir({ models: [] });
  await expect(listAgyModels({ cwd: emptyCwd, executable: FIXTURE, timeoutMs: 500 })).resolves.toEqual([]);

  const malformedCwd = await fixtureDir({ models: ["not-a-tab-separated-record"] });
  await expect(listAgyModels({ cwd: malformedCwd, executable: FIXTURE, timeoutMs: 500 })).rejects.toThrow(/malformed|model list/i);
});
test("listAgyModels rejects a nonblank label with a missing slug", async () => {
  const cwd = await fixtureDir({ models: ["\tArgon Low"] });
  await expect(listAgyModels({ cwd, executable: FIXTURE, timeoutMs: 500 })).rejects.toThrow(/malformed|slug/i);
});

test("runAgyTurn sends one documented user event on stdin and pins exact model, sandbox, and bounded timeout without bypass", async () => {
  const cwd = await fixtureDir({ stdout: ndjson(initEvent(), resultEvent()) });
  const result = await run(cwd);
  const invocation = await observed(cwd);

  expect(result.model).toBe(MODEL);
  expect(invocation.stdin).toBe(JSON.stringify({ event: "user", message: { content: "Explain the fixture protocol" } }) + "\n");
  expectTurnArgs(invocation.args);
});

test("runAgyTurn streams split UTF-8 deltas once, keeps terminal response as truth, and maps upstream usage", async () => {
  const stdout = ndjson(
    initEvent(),
    stepEvent(1, "Hello "),
    stepEvent(2, "世界 🌍"),
    resultEvent({ response: "Hello 世界 🌍" }),
  );
  const utf8Boundary = Buffer.from(stdout[2]!, "utf8").indexOf(Buffer.from("世", "utf8")) + 1;
  const cwd = await fixtureDir({ stdout, splitAt: utf8Boundary, delayMs: 1 });
  const deltas: string[] = [];
  const result = await run(cwd, { onText: text => deltas.push(text) });

  expect(deltas).toEqual(["Hello ", "世界 🌍"]);
  expect(deltas.join("")).toBe(result.response);
  expect(result.response).toBe("Hello 世界 🌍");
  expect(result.conversationId).toBe("conv-1");
  expect(result.usage).toEqual({ inputTokens: 17, outputTokens: 23, thinkingTokens: 5, cacheReadTokens: 2 });
  expect(result.steps).toBe(2);
});
test.each([
  ["empty step payload", {}],
  ["missing step_index", { conversation_id: "conv-1", state: "DONE", step_type: "agent_response" }],
  ["negative step_index", { conversation_id: "conv-1", step_index: -1, state: "DONE", step_type: "agent_response" }],
  ["fractional step_index", { conversation_id: "conv-1", step_index: 1.5, state: "DONE", step_type: "agent_response" }],
  ["invalid step_index type", { conversation_id: "conv-1", step_index: "one", state: "DONE", step_type: "agent_response" }],
  ["invalid state type", { conversation_id: "conv-1", step_index: 1, state: 7, step_type: "agent_response" }],
  ["empty state", { conversation_id: "conv-1", step_index: 1, state: "", step_type: "agent_response" }],
  ["invalid step_type type", { conversation_id: "conv-1", step_index: 1, state: "DONE", step_type: 7 }],
  ["invalid text_delta type", { conversation_id: "conv-1", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: 7 }],
  ["invalid tool_name type", { conversation_id: "conv-1", step_index: 1, state: "DONE", step_type: "tool", tool_name: 7 }],
  ["invalid tool_info type", { conversation_id: "conv-1", step_index: 1, state: "DONE", step_type: "tool", tool_info: 7 }],
  ["invalid subagent_info type", { conversation_id: "conv-1", step_index: 1, state: "checkpoint", subagent_info: "bad" }],
] as const)("runAgyTurn rejects %s step_update payloads", async (_name, step) => {
  const cwd = await fixtureDir({
    stdout: ndjson(initEvent(), { event: "step_update", step_update: step }, resultEvent()),
  });
  await expect(run(cwd)).rejects.toThrow();
});

test("runAgyTurn exposes CLI-owned tool notices without executing the noticed command", async () => {
  const marker = "fixture-command-must-not-run";
  const cwd = await fixtureDir({
    stdout: ndjson(
      initEvent(),
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-1",
          step_index: 1,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { CommandLine: `touch ${marker}` }, output: "done" },
        },
      },
      resultEvent(),
    ),
  });
  const notices: string[] = [];
  await run(cwd, { onNotice: notice => notices.push(notice) });

  expect(notices.join(" ")).toMatch(/run_command|tool/i);
  expect(await Bun.file(join(cwd, marker)).exists()).toBe(false);
});

test("runAgyTurn preserves quota ERROR text and nonzero exit classification", async () => {
  const message = "Individual quota RESOURCE_EXHAUSTED 429: daily limit reached";
  const cwd = await fixtureDir({ stdout: ndjson(initEvent(), resultEvent({ status: "ERROR", response: "", error: message })), exitCode: 3 });
  await expect(run(cwd)).rejects.toThrow(/RESOURCE_EXHAUSTED.*429|429.*RESOURCE_EXHAUSTED/);
});

test.each([
  ["ERROR result with exit 0", { stdout: ndjson(initEvent(), resultEvent({ status: "ERROR", response: "", error: "upstream denied" })) }],
  ["SUCCESS result with nonzero exit", { stdout: ndjson(initEvent(), resultEvent()), exitCode: 7 }],
  ["missing terminal result", { stdout: ndjson(initEvent(), stepEvent(1, "partial")) }],
  ["truncated terminal JSON", { stdout: [`${JSON.stringify(initEvent())}\n`, '{"event":"result","result":{"status":"SUCCESS"'] }],
  ["malformed relevant event", { stdout: [`${JSON.stringify(initEvent())}\n`, '{not-json}\n'] }],
  ["mismatched init model", { stdout: ndjson(initEvent("gemini-4-argon-high"), resultEvent()) }],
  ["mismatched conversation", { stdout: ndjson(initEvent(SLUG, "other-conv"), resultEvent()) }],
  ["missing init", { stdout: ndjson(resultEvent()) }],
] as const)("runAgyTurn rejects %s rather than reporting success", async (_name, config) => {
  const cwd = await fixtureDir(config);
  await expect(run(cwd)).rejects.toThrow();
});

test("runAgyTurn includes an explicit conversation and mode only when requested", async () => {
  const cwd = await fixtureDir({ stdout: ndjson(initEvent(SLUG, "resume-conv"), resultEvent({ conversation_id: "resume-conv" })) });
  await run(cwd, { conversationId: "resume-conv", mode: "plan" });
  const { args } = await observed(cwd);

  expectTurnArgs(args, ["--conversation", "resume-conv", "--mode", "plan"]);
});
test("runAgyTurn rejects a resumed conversation mismatch before exposing the upstream conversation", async () => {
  const cwd = await fixtureDir({ stdout: ndjson(initEvent(SLUG, "wrong-conv"), resultEvent({ conversation_id: "wrong-conv" })) });
  const seen: string[] = [];
  await expect(run(cwd, { conversationId: "resume-conv", onConversation: id => seen.push(id) })).rejects.toThrow(/conversation/i);
  expect(seen).toEqual([]);
});

test("runAgyTurn aborts before spawn without creating a child", async () => {
  const cwd = await fixtureDir({ stdout: ndjson(initEvent(), resultEvent()) });
  const controller = new AbortController();
  controller.abort();

  await expect(run(cwd, { signal: controller.signal })).rejects.toThrow(/abort|cancel/i);
  expect(await Bun.file(join(cwd, "agy-observed.json")).exists()).toBe(false);
});

test("runAgyTurn aborts an in-flight child after fixture readiness, escalates cleanup, and does not return partial success", async () => {
  const cwd = await fixtureDir({ readyThenHang: true });
  const controller = new AbortController();
  const pending = run(cwd, { signal: controller.signal, timeoutMs: 2_000 });
  void pending.catch(() => {});
  await waitForFixtureFile(cwd, "agy-ready");
  controller.abort();
  expect(controller.signal.aborted).toBe(true);
  await expect(pending).rejects.toThrow(/abort|cancel/i);
  expect(await Bun.file(join(cwd, "agy-sigterm")).exists()).toBe(true);
  await expectFixtureDead(cwd);
});

test("runAgyTurn times out after fixture readiness and cleans up a child whose descendant retains stdout", async () => {
  const cwd = await fixtureDir({ readyThenHang: true, spawnDescendantMs: 250 });
  const started = performance.now();
  const pending = run(cwd, { timeoutMs: 50 });
  void pending.catch(() => {});
  await waitForFixtureFile(cwd, "agy-ready");
  await expect(pending).rejects.toThrow(/timeout|timed out/i);
  expect(performance.now() - started).toBeLessThan(1_500);
  expect(await Bun.file(join(cwd, "agy-sigterm")).exists()).toBe(true);
  await expectFixtureDead(cwd);
});

test("runAgyTurn reaps a child that exits while stdin is being written", async () => {
  const cwd = await fixtureDir({ exitBeforeStdin: true, exitCode: 7 });
  const started = performance.now();
  await expect(run(cwd, { timeoutMs: 250 })).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(1_500);
  await waitForFixtureFile(cwd, "agy-pid");
  await expectFixtureDead(cwd);
});
