import { getGoalPath, readGoalState, writeGoalState } from "../src/agent/goal-verifier";
import { test, expect, mock, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import type { AgentLoopOptions, AgentLoopResult } from "../src/agent/engine";
import type { Message } from "../src/agent/loop";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as loop from "../src/agent/loop";
import { SubagentRegistry } from "../src/agent/subagent-registry";
const realEngine = { ...(await import("../src/agent/engine")) };
let executorRun: PromiseWithResolvers<AgentLoopResult> = Promise.withResolvers();
let plannerRun: PromiseWithResolvers<AgentLoopResult> = Promise.withResolvers();
let runAgentLoopDelegate: (history: unknown, opts: AgentLoopOptions) => Promise<AgentLoopResult>;

mock.module("../src/agent/engine", () => ({
  ...realEngine,
  runAgentLoop: mock((history: unknown, opts: AgentLoopOptions) => runAgentLoopDelegate(history, opts)),
}));
let mockQuestions: string[] = [];
let mockQuestionIndex = 0;
const realReadline = { ...(await import("node:readline/promises")) };

mock.module("node:readline/promises", () => ({
  createInterface: () => ({
    question: mock(async () => mockQuestions[mockQuestionIndex++] ?? "/exit"),
    close: mock(() => {}),
    on: mock(() => {}),
    pause: mock(() => {}),
    resume: mock(() => {}),
  }),
}));

beforeEach(() => {
  executorRun = Promise.withResolvers<AgentLoopResult>();
  plannerRun = Promise.withResolvers<AgentLoopResult>();
  mockQuestions = [];
  mockQuestionIndex = 0;
  runAgentLoopDelegate = async (_history, opts) => {
    if (!opts.events?.onBeforeDone) {
      return opts.tools?.write ? executorRun.promise : plannerRun.promise;
    }

    const task = opts.tools?.task;
    const control = opts.tools?.subagent;
    if (!task || !control || !opts.events.onBeforeDone) {
      throw new Error("launch did not provide its completion and detached-subagent tools");
    }

    await task({ role: "executor", task: "finish the implementation", detached: true }, opts.cwd);
    const blocked = await opts.events.onBeforeDone("finished", {
      sawMutation: false,
      sawVerification: false,
      verificationStale: false,
    });
    expect(blocked).toContain("Cannot finish while mutating subagent(s) are still in flight:");
    expect(blocked).toContain("executor-1");
    expect(blocked).toContain("executor");

    executorRun.resolve({
      done: true,
      steps: 1,
      doneReason: "Summary: completed\nChanged Files: src/example.ts\nVerification: checked",
    });
    await control({ action: "await", ids: ["executor-1"] }, opts.cwd);
    expect(await opts.events.onBeforeDone("finished", {
      sawMutation: false,
      sawVerification: false,
      verificationStale: false,
    })).toBeNull();

    await task({ role: "planner", task: "review the implementation", detached: true }, opts.cwd);
    expect(await opts.events.onBeforeDone("finished", {
      sawMutation: false,
      sawVerification: false,
      verificationStale: false,
    })).toBeNull();

    plannerRun.resolve({
      done: true,
      steps: 1,
      doneReason: "Summary: reviewed\nIn Scope: implementation\nOut of Scope: unrelated work\nFile-level Changes: none\nSequencing: complete\nAcceptance Criteria: met\nVerification: checked\nRisks: none",
    });
    await control({ action: "await", ids: ["planner-1"] }, opts.cwd);
    return { done: true, steps: 1, doneReason: "finished" };
  };
});

afterEach(() => {
  executorRun.resolve({ done: false, steps: 0, doneReason: "test cleanup" });
  plannerRun.resolve({ done: false, steps: 0, doneReason: "test cleanup" });
});

afterAll(() => {
  mock.module("node:readline/promises", () => realReadline);
  mock.module("../src/agent/engine", () => realEngine);
});

test("launch completion requires fresh verification after mutation evidence from an earlier turn", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-cross-turn-done-gate-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-cross-turn-cwd-"));
  const previousConfigDir = process.env.JEO_CONFIG_DIR;
  const previousCwd = process.cwd();
  let completionResult: AgentLoopResult | undefined;
  const llm = spyOn(loop, "callLlm").mockImplementation(async messages => {
    const systemPrompt = messages.find(message => message.role === "system")?.content ?? "";
    return systemPrompt.includes("independent Goal Verifier")
      ? JSON.stringify({ verdict: "MET", reason: "the transcript says complete" })
      : JSON.stringify({ tool: "done", arguments: { reason: "finished" } });
  });
  runAgentLoopDelegate = async (history, opts) => {
    const onEvidence = opts.events?.onEvidence;
    const onBeforeDone = opts.events?.onBeforeDone;
    if (!onEvidence || !onBeforeDone) throw new Error("launch did not provide its evidence and completion gates");

    // Simulate end-of-turn persistence from an earlier turn; this later engine run
    // has no current-turn mutation or verification evidence.
    await onEvidence({ sawMutation: true, sawVerification: false, verificationStale: false });
    completionResult = await realEngine.runAgentLoop([{ role: "user", content: "finish the task" }], {
      ...opts,
      maxSteps: 4,
      events: { ...opts.events, onBeforeDone },
    });
    return completionResult;
  };

  try {
    process.chdir(workdir);
    process.env.JEO_CONFIG_DIR = configDir;
    await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
      providers: {},
      defaultModel: "ollama/qwen2.5:0.5b",
    }));
    await writeGoalState({ condition: "complete and verify the task", setAt: Date.now(), verdicts: [] }, workdir);
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", "-p", "complete the task"]);
    expect(completionResult?.done).toBe(false);
    expect(completionResult?.doneReason).toContain("workspace mutation from this session still lacks a successful, non-stale verification");
  } finally {
    process.chdir(previousCwd);
    if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previousConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
    llm.mockRestore();
  }
});

test("launch completion waits for running mutating detached subagents but not settled or read-only ones", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-launch-done-gate-"));
  const previousConfigDir = process.env.JEO_CONFIG_DIR;
  try {
    process.env.JEO_CONFIG_DIR = configDir;
    await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
      providers: {},
      defaultModel: "ollama/qwen2.5:0.5b",
    }));

    // Dynamic import is required because the mock must be installed before launch.ts captures its engine import.
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", "-p", "complete the task"]);
  } finally {
    if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previousConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test("runAgentLoop corrects a rejected completion and accepts it after the cancelled runner settles", async () => {
  const registry = new SubagentRegistry();
  const runner = Promise.withResolvers<{ success: boolean; output: string }>();
  const record = registry.launch("executor", "finish work", () => runner.promise);
  registry.cancel([record.id]);

  let calls = 0;
  const verificationCommand = "bun test test/engine.test.ts --test-name-pattern extractJsonObject";
  const llm = spyOn(loop, "callLlm").mockImplementation(async history => {
    calls++;
    if (calls === 1) return JSON.stringify({ tool: "bash", arguments: { command: verificationCommand } });

    if (calls === 2) {
      return JSON.stringify({ tool: "done", arguments: { reason: "finished after cancellation" } });
    }
    expect(history.some(message => message.role === "user" && message.content.includes("Cannot finish while mutating subagent(s) are still in flight"))).toBe(true);
    runner.resolve({ success: true, output: "settled after cancellation" });
    return JSON.stringify({ tool: "done", arguments: { reason: "finished after correction" } });
  });

  try {
    const result = await realEngine.runAgentLoop([{ role: "user", content: "complete the task" }], {
      cwd: process.cwd(),
      maxSteps: 4,
      budget: { maxExtensions: 0 },
      tools: { bash: async () => ({ success: true, output: "verification passed" }) },
      events: {
        onBeforeDone: (_reason, evidence) => registry.inFlightMutators().length > 0 && evidence.sawVerification
          ? `Cannot finish while mutating subagent(s) are still in flight: ${record.id}`
          : null,
      },
    });

    expect(result.done).toBe(true);
    expect(result.doneReason).toBe("finished after correction");
    expect(calls).toBe(3);
    expect(registry.inFlightMutators()).toEqual([]);
  } finally {
    runner.resolve({ success: false, output: "test cleanup" });
    llm.mockRestore();
  }
});

test("in-flight and settled background job mutation blocks done until fresh verification succeeds without a goal", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-launch-job-done-gate-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-launch-job-cwd-"));
  const previousConfigDir = process.env.JEO_CONFIG_DIR;
  const previousCwd = process.cwd();
  let completionResult: AgentLoopResult | undefined;
  let modelSawPendingMutationRejection = false;
  let agentResponses = 0;
  let inFlightJobPreventedCompletion = false;
  let observedBackgroundMutation = false;
  const mutationPath = path.join(workdir, "background-mutation.txt");
  const llm = spyOn(loop, "callLlm").mockImplementation(async messages => {
    const transcript = messages.map(message => String(message.content)).join("\n");
    agentResponses++;
    if (agentResponses === 2) {
      modelSawPendingMutationRejection = transcript.includes("Cannot finish: a workspace mutation from this session still lacks a successful, non-stale verification.");
      return JSON.stringify({ tool: "bash", arguments: { command: "bun test background-mutation.test.ts" } });
    }
    return JSON.stringify({ tool: "done", arguments: { reason: "finished" } });
  });
  runAgentLoopDelegate = async (_history, opts) => {
    const job = opts.tools?.job;
    const onEvidence = opts.events?.onEvidence;
    const onBeforeDone = opts.events?.onBeforeDone;
    if (!job || !onEvidence || !onBeforeDone) throw new Error("launch did not provide its job and completion gates");

    const mutationEvents = fs.watch(workdir)[Symbol.asyncIterator]();
    const started = await job({
      action: "start",
      command: `printf changed > '${mutationPath}'; exec sleep 30`,
    }, opts.cwd);
    if (!started.success) return { done: false, steps: 0, doneReason: "background job failed to start" };
    const mutationEvent = await mutationEvents.next();
    observedBackgroundMutation = String(mutationEvent.value?.filename) === path.basename(mutationPath)
      && await fs.readFile(mutationPath, "utf8") === "changed";
    // A passing verification cannot clear the pending mutation while the job remains active.
    const blockedWhileRunning = await onBeforeDone("finished", {
      sawMutation: false,
      sawVerification: true,
      verificationStale: false,
    });
    inFlightJobPreventedCompletion = blockedWhileRunning?.includes("Cannot finish while background job(s) are still running:") === true;
    const cancelled = await job({ action: "cancel", ids: ["job-1"] }, opts.cwd);
    await mutationEvents.return?.();
    if (!cancelled.success) return { done: false, steps: 0, doneReason: "background job failed to cancel" };
    expect(cancelled.mutationMayHaveOccurred).toBe(true);
    await onEvidence({ sawMutation: cancelled.mutationMayHaveOccurred === true, sawVerification: false, verificationStale: false });
    const drained = await job({ action: "await", ids: ["job-1"] }, opts.cwd);
    expect(drained.success).toBe(false);
    expect(drained.output).toContain("all settled");
    expect(drained.output).toContain("job-1 [KILLED]");
    expect(drained.mutationMayHaveOccurred).not.toBe(true);
    expect(await onBeforeDone("finished", {
      sawMutation: true,
      sawVerification: false,
      verificationStale: false,
    })).toContain("Cannot finish: a workspace mutation from this session still lacks a successful, non-stale verification.");
 
    // The completed job's mutation was observed on its originating turn and
    // persisted by launch; this later engine run must verify before accepting done.
    await fs.writeFile(path.join(workdir, "background-mutation.test.ts"),
      'import { test, expect } from "bun:test";\nimport { readFileSync } from "node:fs";\ntest("job mutation is present", () => expect(readFileSync("background-mutation.txt", "utf8")).toBe("changed"));\n');
    completionResult = await realEngine.runAgentLoop([{ role: "user", content: "finish the task" }], {
      ...opts,
      maxSteps: 5,
      events: { ...opts.events, onBeforeDone },
    });
    return completionResult;
  };

  try {
    process.chdir(workdir);
    process.env.JEO_CONFIG_DIR = configDir;
    await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
      providers: {},
      defaultModel: "ollama/qwen2.5:0.5b",
    }));
    // Deliberately no GoalState: this exercises launch-session evidence on its own.
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", "-p", "complete the task"]);
    expect(observedBackgroundMutation).toBe(true);
    expect(inFlightJobPreventedCompletion).toBe(true);
    expect(modelSawPendingMutationRejection).toBe(true);
    expect(completionResult?.done).toBe(true);
    expect(completionResult?.doneReason).toBe("finished");
  } finally {
    process.chdir(previousCwd);
    if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previousConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
    llm.mockRestore();
  }
});

test("launch completion blocks running monitors, preserves monitor mutation evidence, and accepts fresh verification after cancellation", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-launch-monitor-done-gate-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-launch-monitor-cwd-"));
  const previousConfigDir = process.env.JEO_CONFIG_DIR;
  const previousCwd = process.cwd();
  const verificationCommand = `bun test ${path.join(previousCwd, "test/monitor-tool.test.ts")}`;
  let completionResult: AgentLoopResult | undefined;
  let cleanupMonitor: (() => Promise<void>) | undefined;
  let runningMonitorReason: string | null = null;
  let runningMonitorVerifiedReason: string | null = null;
  let postSettlementReason: string | null = null;
  let postSettlementSawMutation = false;
  let finalEvidence: { sawMutation: boolean; sawVerification: boolean; verificationStale: boolean } | undefined;
  let responses = 0;
  const llm = spyOn(loop, "callLlm").mockImplementation(async () => {
    responses++;
    switch (responses) {
      case 1:
        return JSON.stringify({
          tool: "monitor",
          arguments: { action: "start", command: "printf 'monitor-ready\\n'; sleep 1", persistent: true },
        });
      case 2:
      case 5:
      case 7:
        return JSON.stringify({ tool: "done", arguments: { reason: "finished" } });
      case 3:
        return JSON.stringify({ tool: "monitor", arguments: { action: "cancel", ids: ["monitor-1"] } });
      case 4:
        return JSON.stringify({ tool: "monitor", arguments: { action: "await", ids: ["monitor-1"] } });
      case 6:
        return JSON.stringify({ tool: "bash", arguments: { command: verificationCommand } });
      default:
        return JSON.stringify({ tool: "done", arguments: { reason: "finished" } });
    }
  });
  runAgentLoopDelegate = async (_history, opts) => {
    const monitor = opts.tools?.monitor;
    const onBeforeDone = opts.events?.onBeforeDone;
    if (!monitor || !onBeforeDone) throw new Error("launch did not provide its monitor and completion gates");

    cleanupMonitor = async () => {
      await monitor({ action: "cancel", ids: ["monitor-1"] }, opts.cwd);
      await monitor({ action: "await", ids: ["monitor-1"] }, opts.cwd);
    };
    const gatedOnBeforeDone = async (
      reason: string,
      evidence: { sawMutation: boolean; sawVerification: boolean; verificationStale: boolean },
    ): Promise<string | null> => {
      const rejection = await onBeforeDone(reason, evidence);
      if (rejection && rejection.includes("monitor")) {
        const verifiedRejection = await onBeforeDone(reason, { ...evidence, sawVerification: true, verificationStale: false });
        if (verifiedRejection) runningMonitorVerifiedReason = verifiedRejection;
      }
      if (rejection && rejection.includes("monitor")) {
        runningMonitorReason = rejection;
      } else if (rejection) {
        postSettlementReason = rejection;
        postSettlementSawMutation = evidence.sawMutation;
      } else {
        finalEvidence = evidence;
      }
      return rejection;
    };

    completionResult = await realEngine.runAgentLoop([{ role: "user", content: "complete the task" }], {
      ...opts,
      maxSteps: 10,
      events: { ...opts.events, onBeforeDone: gatedOnBeforeDone },
    });
    return completionResult;
  };

  try {
    process.chdir(workdir);
    process.env.JEO_CONFIG_DIR = configDir;
    await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
      providers: {},
      defaultModel: "ollama/qwen2.5:0.5b",
    }));
    // Dynamic import is required because the engine mock must be installed before launch captures its import.
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", "-p", "complete the task"]);

    expect(runningMonitorReason).toContain("Cannot finish while background monitor(s) are still running:");
    expect(runningMonitorReason).toContain("monitor-1");
    expect(runningMonitorReason).toContain("Wait for them to exit or cancel them");
    expect(runningMonitorVerifiedReason).toContain("Cannot finish while background monitor(s) are still running:");
    expect(postSettlementSawMutation).toBe(true);
    expect(postSettlementReason).toContain("Cannot finish: a workspace mutation from this session still lacks a successful, non-stale verification.");
    expect(finalEvidence).toEqual({ sawMutation: true, sawVerification: true, verificationStale: false });
    expect(completionResult?.done).toBe(true);
  } finally {
    await cleanupMonitor?.();
    process.chdir(previousCwd);
    if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previousConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
    llm.mockRestore();
  }
});
test("interactive /goal replacement retains pending mutation verification and resets verdict history", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-interactive-goal-config-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-interactive-goal-cwd-"));
  const previousConfigDir = process.env.JEO_CONFIG_DIR;
  const previousCwd = process.cwd();
  const previousIsTTY = process.stdin.isTTY;

  try {
    process.chdir(workdir);
    process.env.JEO_CONFIG_DIR = configDir;
    process.stdin.isTTY = true;
    await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
      providers: {},
      defaultModel: "ollama/qwen2.5:0.5b",
    }));
    await writeGoalState({
      condition: "old goal",
      setAt: 1,
      verdicts: [{ at: 2, verdict: "NOT_MET", gap: "old gap" }],
      pendingMutationVerification: true,
    }, workdir);
    mockQuestions = ["/goal new interactive goal", "/exit"];

    // Dynamic import is required because the launch module captures the mocked engine/readline imports.
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);

    const state = await readGoalState(workdir);
    expect(state).toMatchObject({
      condition: "new interactive goal",
      verdicts: [],
      pendingMutationVerification: true,
    });
  } finally {
    process.stdin.isTTY = previousIsTTY;
    process.chdir(previousCwd);
    if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previousConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  }
});

test("corrupt persisted goal state blocks done until clear and fresh verification", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-corrupt-goal-config-"));
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-corrupt-goal-cwd-"));
  const previousConfigDir = process.env.JEO_CONFIG_DIR;
  const previousCwd = process.cwd();
  let firstBlock: string | null | undefined;
  let postClearBlock: string | null | undefined;
  let clearResult: { success: boolean; output: string } | undefined;
  let finalResult: AgentLoopResult | undefined;

  runAgentLoopDelegate = async (_history, opts) => {
    const onBeforeDone = opts.events?.onBeforeDone;
    const onEvidence = opts.events?.onEvidence;
    const goal = opts.tools?.goal;
    if (!onBeforeDone || !onEvidence || !goal) {
      throw new Error("launch did not provide goal recovery and completion gates");
    }

    const noEvidence = { sawMutation: false, sawVerification: false, verificationStale: false };
    firstBlock = await onBeforeDone("finished", noEvidence);
    clearResult = await goal({ action: "clear" }, opts.cwd);
    postClearBlock = await onBeforeDone("finished", noEvidence);
    await onEvidence({ sawMutation: false, sawVerification: true, verificationStale: false });
    expect(await onBeforeDone("finished", noEvidence)).toBeNull();

    finalResult = { done: true, steps: 1, doneReason: "finished after fresh verification" };
    return finalResult;
  };

  try {
    process.chdir(workdir);
    process.env.JEO_CONFIG_DIR = configDir;
    await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
      providers: {},
      defaultModel: "ollama/qwen2.5:0.5b",
    }));
    await fs.mkdir(path.dirname(getGoalPath(workdir)), { recursive: true });
    await fs.writeFile(getGoalPath(workdir), "{\"condition\":");

    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", "-p", "complete the task"]);
    expect(finalResult).toMatchObject({ done: true });

    expect(firstBlock).toContain("corrupt");
    expect(firstBlock).toMatch(/\/goal clear|goal \{action:/);
    expect(clearResult).toEqual({ success: true, output: "Goal cleared." });
    expect(await readGoalState(workdir)).toBeNull();
    expect(postClearBlock).toContain("successful, non-stale verification");
    expect(finalResult).toMatchObject({ done: true });
  } finally {
    process.chdir(previousCwd);
    if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previousConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  }
});

for (const goal of [false, true]) {
  test(`launch carry-over across turns (goal: ${goal}) (AC-11)`, async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-carry-over-config-"));
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-carry-over-cwd-"));
    const previousConfigDir = process.env.JEO_CONFIG_DIR;
    const previousNoMemory = process.env.JEO_NO_MEMORY;
    const previousCwd = process.cwd();
    const previousIsTTY = process.stdin.isTTY;
    const noEvidence = { sawMutation: false, sawVerification: false, verificationStale: false };
    const followUpHistory: Message[] = [{ role: "user", content: "follow up" }];
    let turns = 0;
    let engineCalls = 0;
    let turnOneBlock: string | null | undefined;
    let followUp: AgentLoopResult | undefined;
    const llm = spyOn(loop, "callLlm").mockImplementation(async messages => {
      const systemPrompt = messages.find(message => message.role === "system")?.content ?? "";
      if (systemPrompt.includes("independent Goal Verifier")) return JSON.stringify({ verdict: "MET", reason: "the transcript says complete" });
      if (!messages.some(message => message.role === "user" && message.content === "follow up")) {
        throw new Error("unexpected model call outside the follow-up engine run");
      }
      return ++engineCalls === 1
        ? JSON.stringify({ tool: "bash", arguments: { command: "date" } })
        : JSON.stringify({ tool: "done", arguments: { reason: "finished" } });
    });
    runAgentLoopDelegate = async (_history, opts) => {
      const onEvidence = opts.events?.onEvidence;
      const onBeforeDone = opts.events?.onBeforeDone;
      if (!onEvidence || !onBeforeDone) throw new Error("launch did not provide its evidence and completion gates");
      if (++turns === 1) {
        // Turn N: a real mutation that is never verified; this turn's own evidence still blocks.
        await onEvidence({ sawMutation: true, sawVerification: false, verificationStale: false });
        turnOneBlock = await onBeforeDone("finished", noEvidence);
        return { done: false, steps: 1, doneReason: "Stopped: unverified" };
      }
      // Turn N+1: read-only work (`date` changes no workspace file) and no verification.
      followUp = await realEngine.runAgentLoop(followUpHistory, { ...opts, maxSteps: 6, budget: { maxExtensions: 0 } });
      return followUp;
    };

    try {
      process.chdir(workdir);
      process.env.JEO_CONFIG_DIR = configDir;
      process.env.JEO_NO_MEMORY = "1";
      process.stdin.isTTY = true;
      await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
        providers: {},
        defaultModel: "ollama/qwen2.5:0.5b",
      }));
      if (goal) await writeGoalState({ condition: "verify everything", setAt: Date.now(), verdicts: [] }, workdir);
      mockQuestions = ["mutate without verifying", "read-only follow-up", "/exit"];

      // Dynamic import is required because the mocked engine/readline modules must be installed before launch captures them.
      const { runLaunchCommand } = await import("../src/commands/launch");
      await runLaunchCommand(["--no-tui", "--no-session"]);

      expect(turns).toBe(2);
      expect(turnOneBlock).toContain("workspace mutation from this session still lacks a successful, non-stale verification");
      if (goal) {
        expect(followUp?.done).toBe(false);
        expect(followUp?.completionRejected).toBe(true);
        expect(followUp?.doneReason).toContain("workspace mutation from this session still lacks a successful, non-stale verification");
        expect(followUp?.doneReason).toContain("UNVERIFIED");
        expect((await readGoalState(workdir))?.pendingMutationVerification).toBe(true);
        expect(followUpHistory.some(message => message.role === "user" && message.content.includes("Cannot finish"))).toBe(true);
      } else {
        expect(followUp).toMatchObject({ done: true, doneReason: "finished" });
        expect(engineCalls).toBe(2);
        expect(followUpHistory.some(message => message.role === "user" && message.content.includes("Cannot finish"))).toBe(false);
      }
    } finally {
      process.stdin.isTTY = previousIsTTY;
      process.chdir(previousCwd);
      if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
      else process.env.JEO_CONFIG_DIR = previousConfigDir;
      if (previousNoMemory === undefined) delete process.env.JEO_NO_MEMORY;
      else process.env.JEO_NO_MEMORY = previousNoMemory;
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(workdir, { recursive: true, force: true });
      llm.mockRestore();
    }
  });
}
