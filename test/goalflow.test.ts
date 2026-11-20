import { describe, test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  START,
  END,
  MAX_LOOP_ITERATIONS,
  command,
  send,
  InterruptError,
  FunctionNode,
  AgentBaseNode,
  StateGraph,
  MemoryCheckpointer,
  FileCheckpointer,
  StreamProcessor,
  OpenAIDataAdapter,
  GoalFlowDataAdapter,
  sortMiddlewares,
  createEntryGuardMiddleware,
  createJevRuntimeGuardMiddleware,
  createJeoWorkflow,
  createInitialJeoWorkflowState,
  type AgentMiddleware,
  type JeoWorkflowState,
  type TracePayload,
} from "../src/agent/goalflow";
import type { AgentLoopResult } from "../src/agent/engine";

interface SimpleState extends Record<string, unknown> {
  count: number;
  log: string[];
  items?: string[];
  results?: string[];
  error?: string;
}

describe("GoalFlow Core Engine", () => {
  test("executes linear and conditional edges with fan-in barrier", async () => {
    const graph = new StateGraph<SimpleState>();

    graph.addNode(
      new FunctionNode<SimpleState>({
        id: "step_a",
        handler: (s) => ({
          count: s.count + 1,
          log: [...s.log, "a"],
        }),
      }),
    );

    graph.addNode(
      new FunctionNode<SimpleState>({
        id: "branch_high",
        handler: (s) => ({
          log: [...s.log, "high"],
        }),
      }),
    );

    graph.addNode(
      new FunctionNode<SimpleState>({
        id: "branch_low",
        handler: (s) => ({
          log: [...s.log, "low"],
        }),
      }),
    );

    graph.addNode(
      new FunctionNode<SimpleState>({
        id: "finish",
        handler: (s) => ({
          count: s.count * 10,
          log: [...s.log, "finish"],
        }),
      }),
    );

    graph.addEdge(START, "step_a");
    graph.addConditionalEdges("step_a", (s) => (s.count >= 5 ? "branch_high" : "branch_low"));
    graph.addEdge("branch_high", "finish");
    graph.addEdge("branch_low", "finish");
    graph.addEdge("finish", END);

    const workflow = graph.compile({ name: "linear-cond" });
    const record = await workflow.run({ count: 1, log: [] });

    expect(record.status).toBe("completed");
    expect(record.state.count).toBe(20);
    expect(record.state.log).toEqual(["a", "low", "finish"]);
  });

  test("supports Send[] bounded-concurrency fan-out and state reducers", async () => {
    const graph = new StateGraph<SimpleState>();
    const processed: string[] = [];

    graph.addNode(
      new FunctionNode<SimpleState>({
        id: "dispatcher",
        handler: (s) =>
          (s.items ?? []).map((item) => send("worker", { currentItem: item })),
      }),
    );

    graph.addNode(
      new FunctionNode<SimpleState>({
        id: "worker",
        handler: (s) => {
          const item = String((s as Record<string, unknown>).currentItem ?? "");
          processed.push(`done:${item}`);
          return { results: [item] };
        },
      }),
    );

    graph.addEdge(START, "dispatcher");
    graph.addEdge("worker", END);

    const workflow = graph.compile({
      name: "fanout-test",
      maxConcurrency: 2,
      reducers: {
        results: (prev, next) => [...(prev ?? []), ...(next ?? [])],
      },
    });
    const record = await workflow.run({
      count: 0,
      log: [],
      items: ["alpha", "beta", "gamma"],
      results: [],
    });

    expect(record.status).toBe("completed");
    expect(processed.sort()).toEqual(["done:alpha", "done:beta", "done:gamma"]);
    expect([...(record.state.results ?? [])].sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("handles errorStrategy 'default-value' and 'fail-branch'", async () => {
    const graphDefault = new StateGraph<SimpleState>();
    graphDefault.addNode(
      new FunctionNode<SimpleState>({
        id: "flaky_default",
        errorStrategy: "default-value",
        defaultValue: { count: 99, log: ["recovered_default"] },
        handler: () => {
          throw new Error("boom");
        },
      }),
    );
    graphDefault.addEdge(START, "flaky_default");
    graphDefault.addEdge("flaky_default", END);

    const wfDefault = graphDefault.compile();
    const resDefault = await wfDefault.run({ count: 0, log: [] });
    expect(resDefault.status).toBe("completed");
    expect(resDefault.state.count).toBe(99);
    expect(resDefault.state.log).toEqual(["recovered_default"]);

    const graphBranch = new StateGraph<SimpleState>();
    graphBranch.addNode(
      new FunctionNode<SimpleState>({
        id: "flaky_branch",
        errorStrategy: "fail-branch",
        failBranchNodeId: "fallback_node",
        handler: () => {
          throw new Error("branch_boom");
        },
      }),
    );
    graphBranch.addNode(
      new FunctionNode<SimpleState>({
        id: "fallback_node",
        handler: (s) => ({
          count: 42,
          log: [...s.log, "in_fallback"],
        }),
      }),
    );
    graphBranch.addEdge(START, "flaky_branch");
    graphBranch.addEdge("fallback_node", END);

    const wfBranch = graphBranch.compile();
    const resBranch = await wfBranch.run({ count: 0, log: [] });
    expect(resBranch.status).toBe("completed");
    expect(resBranch.state.count).toBe(42);
    expect(resBranch.state.log).toContain("in_fallback");
  });

  test("enforces MAX_LOOP_ITERATIONS cycle guard", async () => {
    const graph = new StateGraph<SimpleState>();
    graph.addNode(
      new FunctionNode<SimpleState>({
        id: "looper",
        handler: (s) =>
          command<SimpleState>({
            update: { count: s.count + 1 },
            goto: "looper",
          }),
      }),
    );
    graph.addEdge(START, "looper");

    const wf = graph.compile();
    const res = await wf.run({ count: 0, log: [] });
    expect(res.status).toBe("failed");
    expect(res.error).toContain(String(MAX_LOOP_ITERATIONS));
  });

  test("FileCheckpointer durably checkpoints HITL interrupt and resumes strictly from paused node", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "goalflow-ckpt-"));
    try {
      const checkpointer = new FileCheckpointer<SimpleState>({ cwd: tmpDir });
      let step1Runs = 0;
      let gateRuns = 0;

      const graph = new StateGraph<SimpleState>();
      graph.addNode(
        new FunctionNode<SimpleState>({
          id: "step_1",
          handler: (s) => {
            step1Runs += 1;
            return { count: s.count + 10, log: [...s.log, "step_1"] };
          },
        }),
      );

      graph.addNode(
        new FunctionNode<SimpleState>({
          id: "human_gate",
          handler: (s, ctx) => {
            gateRuns += 1;
            if (!ctx.resumeValue) {
              throw new InterruptError({
                interruptId: "int-1",
                nodeId: "human_gate",
                kind: "plan_approval",
                prompt: "Approve step?",
                allowedDecisions: ["approve", "reject"],
              });
            }
            return {
              count: s.count + 5,
              log: [...s.log, "approved"],
            };
          },
        }),
      );

      graph.addEdge(START, "step_1");
      graph.addEdge("step_1", "human_gate");
      graph.addEdge("human_gate", END);

      const wf = graph.compile({ name: "hitl-test" });
      const paused = await wf.run(
        { count: 0, log: [] },
        { runId: "run-123", threadId: "thread-1", checkpointer },
      );

      expect(paused.status).toBe("interrupted");
      expect(paused.currentNodeId).toBe("human_gate");
      expect(paused.pendingInterrupt?.prompt).toBe("Approve step?");
      expect(step1Runs).toBe(1);
      expect(gateRuns).toBe(1);

      const loaded = await checkpointer.load("run-123");
      expect(loaded?.status).toBe("interrupted");

      for await (const _ of wf.resume(
        "run-123",
        { decision: "approve", input: "ship it" },
        { checkpointer },
      )) {
        // consume stream
      }

      const completed = await checkpointer.load("run-123");
      expect(completed?.status).toBe("completed");
      expect(completed?.state.count).toBe(15);
      expect(completed?.state.log).toEqual(["step_1", "approved"]);
      // Upstream step_1 must NOT re-run on resume!
      expect(step1Runs).toBe(1);
      expect(gateRuns).toBe(2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("GoalFlow Middlewares & Jev Guard", () => {
  test("sortMiddlewares enforces control phase strictly before enhancement phase", () => {
    const m1: AgentMiddleware = { name: "enh-1", phase: "enhancement" };
    const m2: AgentMiddleware = { name: "ctrl-1", phase: "control" };
    const m3: AgentMiddleware = { name: "enh-2", phase: "enhancement" };
    const m4: AgentMiddleware = { name: "ctrl-2", phase: "control" };

    const sorted = sortMiddlewares([m1, m2, m3, m4]);
    expect(sorted.map((m) => m.name)).toEqual(["ctrl-1", "ctrl-2", "enh-1", "enh-2"]);
  });

  test("JevRuntimeGuardMiddleware gates destructive tool calls, skips read-only tools, and fails open when unreachable", async () => {
    let fetchCalls = 0;
    const guardBlock = createJevRuntimeGuardMiddleware({
      enabled: true,
      riskThreshold: 0.7,
      fetchImpl: (async () => {
        fetchCalls++;
        return new Response(
          JSON.stringify({
            answers: {
              safe_to_execute: { answer: "no", probability: 0.1, confidence: 0.9 },
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    const ctx = {
      runId: "r1",
      threadId: "t1",
      nodeId: "n1",
      cwd: "/tmp",
      prompt: "clean files",
      systemPrompt: "sys",
      tools: {},
      metadata: {},
    };

    const readDecision = await guardBlock.beforeTool!(
      "read",
      { filePath: "src/index.ts" },
      ctx,
    );
    expect(readDecision.allow).toBe(true);
    expect(fetchCalls).toBe(0);

    const decision = await guardBlock.beforeTool!(
      "bash",
      { command: "rm -rf /important/data" },
      ctx,
    );
    expect(decision.allow).toBe(false);
    expect(fetchCalls).toBe(1);

    // Fail-open when qev is offline
    const guardOffline = createJevRuntimeGuardMiddleware({
      enabled: true,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    const offlineDecision = await guardOffline.beforeTool!(
      "bash",
      { command: "rm -rf /tmp/build" },
      ctx,
    );
    expect(offlineDecision.allow).toBe(true);
  });

  test("AgentBaseNode skips enhancement middlewares when blocked by control middleware", async () => {
    const order: string[] = [];
    const blocker = createEntryGuardMiddleware({ maxPromptChars: 10 });
    const enhancer: AgentMiddleware = {
      name: "enhancer",
      phase: "enhancement",
      beforeTurn: () => {
        order.push("enhancer_ran");
      },
    };

    class TestAgentNode extends AgentBaseNode<SimpleState> {
      buildPrompt(s: SimpleState) {
        return s.log.join(" ");
      }
      buildCommand(s: SimpleState, output: string) {
        return { log: [...s.log, output] };
      }
    }

    const graph = new StateGraph<SimpleState>();
    graph.addNode(
      new TestAgentNode({
        id: "agent",
        middlewares: [enhancer, blocker],
        loopRunner: async () => {
          order.push("loop_ran");
          return {
            done: true,
            doneReason: "ok",
            steps: 1,
          };
        },
      }),
    );
    graph.addEdge(START, "agent");
    graph.addEdge("agent", END);

    const wf = graph.compile();
    const res = await wf.run({ count: 0, log: ["prompt_that_is_way_too_long"] });
    expect(res.status).toBe("completed");
    expect(order).toEqual([]);
  });
});

describe("StreamProcessor & DataAdapters", () => {
  test("OpenAIDataAdapter and GoalFlowDataAdapter format SSE, split boundary <think> tags, and return blocking JSON", async () => {
    const graph = new StateGraph<SimpleState>();
    graph.addNode(
      new FunctionNode<SimpleState>({
        id: "talker",
        handler: (s, ctx) => {
          ctx.emit("messages", { text: "<thi" });
          ctx.emit("messages", { text: "nk>plan</th" });
          ctx.emit("messages", { text: "ink>Hello world!" });
          return { count: s.count + 1 };
        },
      }),
    );
    graph.addEdge(START, "talker");
    graph.addEdge("talker", END);

    const wf = graph.compile({ name: "stream-wf" });
    const processor = new StreamProcessor();

    // 1. OpenAI SSE
    const oaiAdapter = new OpenAIDataAdapter({ model: "llama-cpp/qwen" });
    const sseFrames: string[] = [];
    for await (const frame of oaiAdapter.generate(
      processor.process(wf.stream({ count: 0, log: [] })),
    )) {
      sseFrames.push(frame);
    }
    expect(sseFrames.some((f) => f.includes("chat.completion.chunk"))).toBe(true);
    expect(sseFrames.some((f) => f.includes("llama-cpp/qwen"))).toBe(true);
    expect(sseFrames[sseFrames.length - 1]).toContain("[DONE]");

    // 2. OpenAI Blocking JSON
    const oaiBlocking = await oaiAdapter.execute(
      processor.process(wf.stream({ count: 0, log: [] })),
    );
    expect(oaiBlocking.object).toBe("chat.completion");
    expect(oaiBlocking.model).toBe("llama-cpp/qwen");
    const choices = oaiBlocking.choices as Array<{
      message: { content: string; reasoning_content?: string };
    }>;
    expect(choices[0].message.content).toContain("Hello world!");
    expect(choices[0].message.reasoning_content).toContain("plan");

    // 3. GoalFlow Native Adapter
    const gfAdapter = new GoalFlowDataAdapter();
    const gfResult = await gfAdapter.execute(
      processor.process(wf.stream({ count: 0, log: [] })),
    );
    expect(gfResult.status).toBe("completed");
    expect(gfResult.output).toContain("Hello world!");
  });
});

describe("createJeoWorkflow (Spec-First & Coding)", () => {
  test("executes full Spec-first HITL workflow (deep_interview -> ralplan -> approve_gate -> team -> ultragoal)", async () => {
    const checkpointer = new MemoryCheckpointer<JeoWorkflowState>();
    const stagesRan: string[] = [];

    const wf = createJeoWorkflow({
      jevGuard: false,
      runners: {
        deepInterview: async ({ answers }) => {
          stagesRan.push(`deep_interview:${answers.join(",")}`);
          return { ok: true, seedPath: ".jeo/seed.json", reason: "Seed frozen" };
        },
        ralplan: async ({ feedback }) => {
          stagesRan.push(`ralplan:${feedback ?? "initial"}`);
          return { ok: true, planPath: "plan/current.json", reason: "Plan ready" };
        },
        approve: async ({ planPath }) => {
          stagesRan.push(`approve:${planPath}`);
          return { ok: true, reason: "Approved" };
        },
        team: async () => {
          stagesRan.push("team");
          return { ok: true, reason: "Team finished" };
        },
        ultragoal: async () => {
          stagesRan.push("ultragoal");
          return { ok: true, reason: "All acceptance criteria verified" };
        },
      },
    });

    const initialState = createInitialJeoWorkflowState({
      prompt: "Build local model server",
      workflow: "spec-first",
      autoApprove: false,
    });

    const run1 = await wf.run(initialState, {
      runId: "jeo-run-1",
      checkpointer,
    });
    expect(run1.status).toBe("interrupted");
    expect(run1.currentNodeId).toBe("deep_interview");
    expect(run1.pendingInterrupt?.kind).toBe("interview_question");

    for await (const _ of wf.resume(
      "jeo-run-1",
      { decision: "approve", input: "Use Bun and TypeScript" },
      { checkpointer },
    )) {
      // consume
    }
    const run2 = await checkpointer.load("jeo-run-1");
    expect(run2?.status).toBe("interrupted");
    expect(run2?.currentNodeId).toBe("approve_gate");
    expect(run2?.pendingInterrupt?.kind).toBe("plan_approval");

    for await (const _ of wf.resume(
      "jeo-run-1",
      { decision: "modify", feedback: "Add SSE endpoint tests" },
      { checkpointer },
    )) {
      // consume
    }
    const run3 = await checkpointer.load("jeo-run-1");
    expect(run3?.status).toBe("interrupted");
    expect(run3?.currentNodeId).toBe("approve_gate");

    for await (const _ of wf.resume(
      "jeo-run-1",
      { decision: "approve" },
      { checkpointer },
    )) {
      // consume
    }
    const finalRecord = await checkpointer.load("jeo-run-1");
    expect(finalRecord?.status).toBe("completed");
    expect(finalRecord?.state.planApproved).toBe(true);
    expect(finalRecord?.state.finalOutput).toContain("All acceptance criteria verified");
    expect(stagesRan).toEqual([
      "deep_interview:Use Bun and TypeScript",
      "ralplan:initial",
      "ralplan:Add SSE endpoint tests",
      "approve:plan/current.json",
      "team",
      "ultragoal",
    ]);
  });

  test("executes unmanned Spec-first workflow when autoApprove is true", async () => {
    const stagesRan: string[] = [];
    const wf = createJeoWorkflow({
      jevGuard: false,
      runners: {
        deepInterview: async () => {
          stagesRan.push("deep_interview");
          return { ok: true, seedPath: ".jeo/seed.json" };
        },
        ralplan: async () => {
          stagesRan.push("ralplan");
          return { ok: true, planPath: "plan/auto.json" };
        },
        approve: async () => {
          stagesRan.push("approve");
          return { ok: true };
        },
        team: async () => {
          stagesRan.push("team");
          return { ok: true };
        },
        ultragoal: async () => {
          stagesRan.push("ultragoal");
          return { ok: true, reason: "Auto pipeline complete" };
        },
      },
    });

    const record = await wf.run(
      createInitialJeoWorkflowState({
        prompt: "Automated feature",
        workflow: "spec-first",
        autoApprove: true,
      }),
    );

    expect(record.status).toBe("completed");
    expect(stagesRan).toEqual(["deep_interview", "ralplan", "approve", "team", "ultragoal"]);
    expect(record.state.finalOutput).toBe("Auto pipeline complete");
  });

  test("executes coding workflow through Karpathy AgentBaseNode and emits trace callback", async () => {
    const traces: TracePayload[] = [];
    const wf = createJeoWorkflow({
      jevGuard: false,
      contextWindow: 8192,
      onTrace: (t) => traces.push(t),
      runners: {
        codingLoop: async (_history, opts): Promise<AgentLoopResult> => {
          await opts.events?.onStep?.(1);
          opts.events?.onToolResult?.("read", true, "content");
          opts.events?.onModelStream?.("Implemented fix.");
          return {
            done: true,
            doneReason: "Implemented fix and verified tests.",
            steps: 1,
          };
        },
      },
    });

    const record = await wf.run(
      createInitialJeoWorkflowState({
        prompt: "Fix bug in parser",
        workflow: "coding",
        model: "llama-cpp/qwen2.5-coder",
      }),
    );

    expect(record.status).toBe("completed");
    expect(record.state.finalOutput).toBe("Implemented fix and verified tests.");
    expect(traces.length).toBe(1);
    expect(traces[0].done).toBe(true);
    expect(traces[0].steps).toBe(1);
  });
});
