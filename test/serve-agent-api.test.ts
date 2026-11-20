/**
 * Integration Tests for GoalFlow Inbound Agent HTTP Server & CLI
 *
 * Verifies:
 *  - Server lifecycle (ephemeral port binding, graceful shutdown)
 *  - Health & Models endpoints (OpenAI schema compliance)
 *  - CORS preflight and headers
 *  - POST /v1/chat/completions (OpenAI compatible, streaming SSE + non-streaming JSON)
 *  - POST /v1/workflows/run (GoalFlow native, SSE + JSON, 202 on HITL interrupt)
 *  - POST /v1/workflows/resume (Stateful resumption of interrupted workflows)
 *  - CLI argument parsing
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  createAgentServer,
  type AgentServerInstance,
} from "../src/server/agent-api";
import { parseServeArgs } from "../src/commands/serve";
import { MemoryCheckpointer, type JeoWorkflowState } from "../src/agent/goalflow";

describe("GoalFlow Inbound Agent Server (agent-api)", () => {
  let instance: AgentServerInstance | undefined;

  afterEach(async () => {
    if (instance) {
      instance.close();
      instance = undefined;
    }
  });

  test("binds ephemeral port, exposes health and models endpoints", async () => {
    instance = createAgentServer({
      port: 0,
      hostname: "127.0.0.1",
      defaultModel: "jeo-coding",
      defaultWorkflow: "coding",
      autoApprove: true,
      jevGuard: false,
    });

    expect(instance.port).toBeGreaterThan(0);
    expect(instance.url).toBe(`http://127.0.0.1:${instance.port}`);

    // GET /health
    const healthRes = await fetch(`${instance.url}/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as {
      status: string;
      server: string;
      defaultWorkflow: string;
    };
    expect(healthJson.status).toBe("ok");
    expect(healthJson.server).toBe("jeo-goalflow-server");
    expect(healthJson.defaultWorkflow).toBe("coding");

    // GET /v1/models
    const modelsRes = await fetch(`${instance.url}/v1/models`);
    expect(modelsRes.status).toBe(200);
    const modelsJson = (await modelsRes.json()) as {
      object: string;
      data: Array<{ id: string }>;
    };
    expect(modelsJson.object).toBe("list");
    expect(modelsJson.data.some((m) => m.id === "jeo-coding")).toBe(true);
    expect(modelsJson.data.some((m) => m.id === "jeo-spec-first")).toBe(true);
  });

  test("handles CORS preflight OPTIONS and adds CORS headers", async () => {
    instance = createAgentServer({
      port: 0,
      hostname: "127.0.0.1",
      jevGuard: false,
    });

    const res = await fetch(`${instance.url}/v1/chat/completions`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  test("POST /v1/chat/completions validates empty input and executes non-streaming JSON", async () => {
    instance = createAgentServer({
      port: 0,
      hostname: "127.0.0.1",
      autoApprove: true,
      jevGuard: false,
      workflowRunners: {
        codingLoop: async (history, opts) => {
          const userPrompt = typeof history[0]?.content === "string" ? history[0].content : "";
          opts.events?.onModelStream?.(`Hello from codingLoop for: ${userPrompt}`);
          return {
            done: true,
            doneReason: `Executed coding task: ${userPrompt}`,
            steps: 1,
            finalText: `Hello from codingLoop for: ${userPrompt}`,
          };
        },
      },
    });


    // 1. Empty messages -> 400
    const emptyRes = await fetch(`${instance.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(emptyRes.status).toBe(400);

    // 2. Non-streaming call -> 200 JSON in OpenAI format
    const chatRes = await fetch(`${instance.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "jeo-coding",
        messages: [{ role: "user", content: "Write a fibonacci function in TS" }],
        stream: false,
      }),
    });
    expect(chatRes.status).toBe(200);
    const chatJson = (await chatRes.json()) as {
      id: string;
      object: string;
      model: string;
      choices: Array<{ message: { role: string; content: string } }>;
    };

    expect(chatJson.object).toBe("chat.completion");
    expect(chatJson.model).toBe("jeo-coding");
    expect(chatJson.choices[0]!.message.role).toBe("assistant");
    expect(chatJson.choices[0]!.message.content).toContain("fibonacci");
  });

  test("POST /v1/chat/completions returns OpenAI-compliant SSE stream when stream=true", async () => {
    instance = createAgentServer({
      port: 0,
      hostname: "127.0.0.1",
      autoApprove: true,
      jevGuard: false,
      workflowRunners: {
        codingLoop: async (history, opts) => {
          const userPrompt = typeof history[0]?.content === "string" ? history[0].content : "";
          opts.events?.onModelStream?.(`Streamed result for: ${userPrompt}`);
          return {
            done: true,
            doneReason: "Done",
            steps: 2,
            finalText: `Streamed result for: ${userPrompt}`,
          };
        },
      },
    });


    const streamRes = await fetch(`${instance.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "jeo-coding",
        messages: [{ role: "user", content: "Stream test" }],
        stream: true,
      }),
    });

    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await streamRes.text();
    expect(text).toContain("data: {");
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
  });

  test("POST /v1/workflows/run executes native GoalFlow workflow with JSON output", async () => {
    instance = createAgentServer({
      port: 0,
      hostname: "127.0.0.1",
      autoApprove: true,
      jevGuard: false,
      workflowRunners: {
        deepInterview: async () => ({ ok: true, reason: "Seed created" }),
        ralplan: async () => ({ ok: true, reason: "Plan created" }),
        approve: async () => ({ ok: true, reason: "Auto-approved" }),
        team: async () => ({ ok: true, reason: "Team finished" }),
        ultragoal: async () => ({ ok: true, reason: "Verified 100%" }),
      },
    });

    const runRes = await fetch(`${instance.url}/v1/workflows/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Build user service",
        workflow: "spec-first",
        autoApprove: true,
        stream: false,
      }),
    });

    expect(runRes.status).toBe(200);
    const runJson = (await runRes.json()) as {
      status: string;
      output: string;
    };
    expect(runJson.status).toBe("completed");
    expect(runJson.output).toContain("Verified 100%");
  });

  test("POST /v1/workflows/run pauses on HITL approval with 202, and resumes via POST /v1/workflows/resume", async () => {
    const checkpointer = new MemoryCheckpointer<JeoWorkflowState>();
    const executedStages: string[] = [];

    instance = createAgentServer({
      port: 0,
      hostname: "127.0.0.1",
      checkpointer,
      jevGuard: false,
      workflowRunners: {
        deepInterview: async () => {
          executedStages.push("deepInterview");
          return { ok: true, reason: "Interview done" };
        },
        ralplan: async () => {
          executedStages.push("ralplan");
          return { ok: true, reason: "Plan ready" };
        },
        approve: async () => {
          executedStages.push("approve");
          return { ok: true, reason: "Plan approved" };
        },
        team: async () => {
          executedStages.push("team");
          return { ok: true, reason: "Team done" };
        },
        ultragoal: async () => {
          executedStages.push("ultragoal");
          return { ok: true, reason: "Verified" };
        },
      },
    });

    // 1. Run spec-first workflow without autoApprove -> pauses at interview or plan gate with 202
    const runRes = await fetch(`${instance.url}/v1/workflows/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Build payment gateway",
        workflow: "spec-first",
        autoApprove: false,
        stream: false,
      }),
    });

    expect(runRes.status).toBe(202);
    const runJson = (await runRes.json()) as {
      runId: string;
      status: string;
      pendingInterrupt?: { prompt: string; kind: string };
    };
    expect(runJson.status).toBe("interrupted");
    expect(runJson.runId).toBeTruthy();
    const pausedRunId = runJson.runId;

    // 2. Validate resume validation errors
    const badResume = await fetch(`${instance.url}/v1/workflows/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: pausedRunId, decision: "invalid-choice" }),
    });
    expect(badResume.status).toBe(400);

    const missingRun = await fetch(`${instance.url}/v1/workflows/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "unknown-run-id", decision: "approve" }),
    });
    expect(missingRun.status).toBe(404);

    // 3. Resume the interview gate with decision "approve"
    const resume1Res = await fetch(`${instance.url}/v1/workflows/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: pausedRunId,
        decision: "approve",
        input: "Use Stripe API",
        stream: false,
      }),
    });

    // The spec-first workflow has a second gate: approve_gate!
    expect([200, 202]).toContain(resume1Res.status);
    const resume1Json = (await resume1Res.json()) as { status: string };

    // If it hit the plan approval gate (202), approve it to completion
    if (resume1Json.status === "interrupted") {
      const resume2Res = await fetch(`${instance.url}/v1/workflows/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: pausedRunId,
          decision: "approve",
          stream: false,
        }),
      });
      expect(resume2Res.status).toBe(200);
      const resume2Json = (await resume2Res.json()) as { status: string; output: string };
      expect(resume2Json.status).toBe("completed");
      expect(resume2Json.output).toContain("Verified");
    }

    expect(executedStages).toContain("deepInterview");
    expect(executedStages).toContain("team");
    expect(executedStages).toContain("ultragoal");
  });

  test("CLI parseServeArgs correctly parses flags", () => {
    const opts = parseServeArgs([
      "--port",
      "9090",
      "--host",
      "0.0.0.0",
      "-m",
      "llama-cpp/qwen",
      "-w",
      "spec-first",
      "--auto-approve",
      "--no-jev-guard",
      "--context-window",
      "65536",
      "--max-steps",
      "100",
    ]);

    expect(opts.port).toBe(9090);
    expect(opts.host).toBe("0.0.0.0");
    expect(opts.model).toBe("llama-cpp/qwen");
    expect(opts.workflow).toBe("spec-first");
    expect(opts.autoApprove).toBe(true);
    expect(opts.jevGuard).toBe(false);
    expect(opts.contextWindow).toBe(65536);
    expect(opts.maxSteps).toBe(100);
    expect(opts.help).toBe(false);
  });
});
