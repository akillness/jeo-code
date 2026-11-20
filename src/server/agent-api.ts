/**
 * GoalFlow Inbound HTTP Agent Server for jeo-code
 *
 * Provides:
 *  1. OpenAI-compatible Chat Completion API (`POST /v1/chat/completions`)
 *     with streaming SSE (`OpenAIDataAdapter`) and non-streaming JSON responses.
 *  2. Native GoalFlow Workflow Run API (`POST /v1/workflows/run`)
 *     with event streaming (`GoalFlowDataAdapter`) and HITL interrupt support.
 *  3. Human-In-The-Loop Workflow Resume API (`POST /v1/workflows/resume`).
 *  4. Models endpoint (`GET /v1/models`) and healthcheck (`GET /health`, `GET /`).
 *
 * Pure TypeScript, zero native dependencies, Bun.serve native.
 */

import * as crypto from "node:crypto";
import {
  createJeoWorkflow,
  createInitialJeoWorkflowState,
  type JeoWorkflowState,
  type JeoWorkflowMode,
  type JeoWorkflowRunners,
  type CreateJeoWorkflowOptions,
  type CompiledWorkflow,
  type TracePayload,
  StreamProcessor,
  OpenAIDataAdapter,
  GoalFlowDataAdapter,
  MemoryCheckpointer,
  type Checkpointer,
} from "../agent/goalflow";
import type { ToolHandler } from "../agent/engine";
import pkg from "../../package.json";

export interface AgentServerOptions {
  port?: number;
  hostname?: string;
  defaultModel?: string;
  defaultWorkflow?: JeoWorkflowMode;
  autoApprove?: boolean;
  cwd?: string;
  checkpointer?: Checkpointer<JeoWorkflowState>;
  workflowRunners?: JeoWorkflowRunners;
  workflowFactory?: (opts?: CreateJeoWorkflowOptions) => CompiledWorkflow<JeoWorkflowState>;
  qevUrl?: string;
  jevGuard?: boolean;
  contextWindow?: number;
  maxSteps?: number;
  onTrace?: (trace: TracePayload) => void;
  tools?: Record<string, ToolHandler>;
}

export interface AgentServerInstance {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  hostname: string;
  url: string;
  checkpointer: Checkpointer<JeoWorkflowState>;
  close: () => Promise<void> | void;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function asyncIterableToStream(iterable: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(encoder.encode(value));
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    },
  });
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Requested-With",
};

export function createAgentServer(options: AgentServerOptions = {}): AgentServerInstance {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 8000;
  const defaultWorkflow: JeoWorkflowMode = options.defaultWorkflow ?? "coding";
  const defaultModel = options.defaultModel ?? "jeo-coding";
  const checkpointer = options.checkpointer ?? new MemoryCheckpointer<JeoWorkflowState>();

  const buildWorkflow = (): CompiledWorkflow<JeoWorkflowState> => {
    const wfOpts: CreateJeoWorkflowOptions = {
      runners: options.workflowRunners,
      middlewares: [],
      tools: options.tools,
      qevUrl: options.qevUrl,
      jevGuard: options.jevGuard,
      contextWindow: options.contextWindow,
      maxSteps: options.maxSteps,
      onTrace: options.onTrace,
    };
    if (options.workflowFactory) {
      return options.workflowFactory(wfOpts);
    }
    return createJeoWorkflow(wfOpts);
  };

  const server = Bun.serve({
    hostname,
    port,
    async fetch(req) {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(req.url);
      const path = url.pathname;

      // 1. Healthcheck
      if ((path === "/health" || path === "/") && req.method === "GET") {
        return Response.json(
          {
            status: "ok",
            version: pkg.version,
            uptime: process.uptime(),
            server: "jeo-goalflow-server",
            defaultWorkflow,
            defaultModel,
            supportedWorkflows: ["coding", "spec-first"],
            backends: ["llama-cpp", "ollama", "lmstudio", "openai-compat"],
          },
          { headers: CORS_HEADERS },
        );
      }

      // 2. Models
      if (path === "/v1/models" && req.method === "GET") {
        const now = Math.floor(Date.now() / 1000);
        return Response.json(
          {
            object: "list",
            data: [
              {
                id: "jeo-coding",
                object: "model",
                created: now,
                owned_by: "jeo-code",
                permission: [],
                root: "jeo-coding",
                parent: null,
                description: "Direct Karpathy coding loop with Jev runtime guard and tool execution",
              },
              {
                id: "jeo-spec-first",
                object: "model",
                created: now,
                owned_by: "jeo-code",
                permission: [],
                root: "jeo-spec-first",
                parent: null,
                description:
                  "Full Spec-first workflow: deep-interview -> ralplan -> approve_gate -> team -> ultragoal",
              },
              {
                id: "llama-cpp",
                object: "model",
                created: now,
                owned_by: "llama-cpp",
                permission: [],
                root: "llama-cpp",
                parent: null,
                description: "Local llama.cpp server with 3-tier tool calling cascade",
              },
              {
                id: "ollama",
                object: "model",
                created: now,
                owned_by: "ollama",
                permission: [],
                root: "ollama",
                parent: null,
                description: "Local Ollama server (/api/chat, native/structured fallback)",
              },
            ],
          },
          { headers: CORS_HEADERS },
        );
      }

      // 3. OpenAI-compatible Chat Completions (POST /v1/chat/completions)
      if (path === "/v1/chat/completions" && req.method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return Response.json(
            { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
        let prompt = "";
        if (typeof body.prompt === "string" && body.prompt.trim()) {
          prompt = body.prompt.trim();
        } else if (messages.length > 0) {
          const userMsgs = messages.filter(
            (m) => m && typeof m === "object" && (m as { role?: string }).role === "user",
          );
          if (userMsgs.length > 0) {
            const last = userMsgs[userMsgs.length - 1] as { content?: unknown };
            prompt = extractText(last.content);
          } else {
            prompt = messages
              .map((m) => {
                if (m && typeof m === "object") {
                  const role = (m as { role?: string }).role ?? "user";
                  const text = extractText((m as { content?: unknown }).content);
                  return `${role}: ${text}`;
                }
                return "";
              })
              .filter(Boolean)
              .join("\n");
          }
        }

        if (!prompt || !prompt.trim()) {
          return Response.json(
            { error: { message: "Prompt or messages cannot be empty", type: "invalid_request_error" } },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        const reqWorkflow = typeof body.workflow === "string" ? body.workflow.trim().toLowerCase() : "";
        const reqModel = typeof body.model === "string" ? body.model.trim().toLowerCase() : "";
        let workflowMode: JeoWorkflowMode = defaultWorkflow;
        if (reqWorkflow === "spec-first" || reqWorkflow === "coding") {
          workflowMode = reqWorkflow as JeoWorkflowMode;
        } else if (reqModel.includes("spec-first")) {
          workflowMode = "spec-first";
        } else if (reqModel.includes("coding")) {
          workflowMode = "coding";
        }

        const autoApprove = Boolean(
          body.auto_approve ?? body.autoApprove ?? options.autoApprove ?? false,
        );

        const workflow = buildWorkflow();
        const initialState = createInitialJeoWorkflowState({
          prompt,
          cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : (options.cwd ?? process.cwd()),
          model: typeof body.model === "string" && body.model ? body.model : defaultModel,
          workflow: workflowMode,
          autoApprove,
        });

        const runId = crypto.randomUUID();
        const tupleStream = workflow.stream(initialState, {
          checkpointer,
          runId,
          signal: req.signal,
        });
        const processor = new StreamProcessor();
        const eventStream = processor.process(tupleStream);
        const adapter = new OpenAIDataAdapter({ model: initialState.model ?? defaultModel });

        if (body.stream === true) {
          const sseIterable = adapter.generate(eventStream);
          return new Response(asyncIterableToStream(sseIterable), {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              ...CORS_HEADERS,
            },
          });
        }

        const result = await adapter.execute(eventStream);
        return Response.json(result, { headers: CORS_HEADERS });
      }

      // 4. Native GoalFlow Run (POST /v1/workflows/run)
      if (path === "/v1/workflows/run" && req.method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return Response.json(
            { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        let prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt && Array.isArray(body.messages) && body.messages.length > 0) {
          const userMsgs = (body.messages as unknown[]).filter(
            (m) => m && typeof m === "object" && (m as { role?: string }).role === "user",
          );
          if (userMsgs.length > 0) {
            prompt = extractText((userMsgs[userMsgs.length - 1] as { content?: unknown }).content);
          }
        }

        if (!prompt) {
          return Response.json(
            { error: { message: "'prompt' is required", type: "invalid_request_error" } },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        const reqWorkflow = typeof body.workflow === "string" ? body.workflow.trim().toLowerCase() : "";
        const workflowMode: JeoWorkflowMode =
          reqWorkflow === "coding" || reqWorkflow === "spec-first"
            ? (reqWorkflow as JeoWorkflowMode)
            : defaultWorkflow;

        const autoApprove = Boolean(
          body.auto_approve ?? body.autoApprove ?? options.autoApprove ?? false,
        );

        const workflow = buildWorkflow();
        const initialState = createInitialJeoWorkflowState({
          prompt,
          cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : (options.cwd ?? process.cwd()),
          model: typeof body.model === "string" && body.model ? body.model : defaultModel,
          workflow: workflowMode,
          autoApprove,
        });

        if (body.state && typeof body.state === "object") {
          Object.assign(initialState, body.state);
        }

        const runId = crypto.randomUUID();
        const tupleStream = workflow.stream(initialState, {
          checkpointer,
          runId,
          signal: req.signal,
        });
        const processor = new StreamProcessor();
        const eventStream = processor.process(tupleStream);
        const adapter = new GoalFlowDataAdapter();

        const shouldStream =
          body.stream === true ||
          (req.headers.get("accept") ?? "").toLowerCase().includes("text/event-stream");

        if (shouldStream) {
          const sseIterable = adapter.generate(eventStream);
          return new Response(asyncIterableToStream(sseIterable), {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              ...CORS_HEADERS,
            },
          });
        }

        const result = (await adapter.execute(eventStream)) as { status?: string };
        const status = result.status === "interrupted" ? 202 : 200;
        return Response.json(result, { status, headers: CORS_HEADERS });
      }

      // 5. Human-in-the-Loop Resume (POST /v1/workflows/resume)
      if (path === "/v1/workflows/resume" && req.method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return Response.json(
            { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        const runId = typeof body.runId === "string" ? body.runId.trim() : "";
        const decision = typeof body.decision === "string" ? body.decision.trim() : "";

        if (!runId || !decision) {
          return Response.json(
            { error: "Both 'runId' and 'decision' are required." },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        if (decision !== "approve" && decision !== "modify" && decision !== "reject") {
          return Response.json(
            { error: "decision must be 'approve', 'modify', or 'reject'." },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        const checkpoint = await checkpointer.load(runId);
        if (!checkpoint || checkpoint.status !== "interrupted") {
          return Response.json(
            { error: `Workflow run '${runId}' not found or not in interrupted state.` },
            { status: 404, headers: CORS_HEADERS },
          );
        }

        const workflow = buildWorkflow();
        const tupleStream = workflow.resume(
          runId,
          {
            decision,
            input: typeof body.input === "string" ? body.input : undefined,
            feedback: typeof body.feedback === "string" ? body.feedback : undefined,
          },
          {
            checkpointer,
            signal: req.signal,
          },
        );


        const processor = new StreamProcessor();
        const eventStream = processor.process(tupleStream);
        const adapter = new GoalFlowDataAdapter();

        const shouldStream =
          body.stream === true ||
          (req.headers.get("accept") ?? "").toLowerCase().includes("text/event-stream");

        if (shouldStream) {
          const sseIterable = adapter.generate(eventStream);
          return new Response(asyncIterableToStream(sseIterable), {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              ...CORS_HEADERS,
            },
          });
        }

        const result = (await adapter.execute(eventStream)) as { status?: string };
        const status = result.status === "interrupted" ? 202 : 200;
        return Response.json(result, { status, headers: CORS_HEADERS });
      }

      // 6. 404 Not Found
      return Response.json(
        { error: `Not Found: ${req.method} ${path}` },
        { status: 404, headers: CORS_HEADERS },
      );
    },
  });

  const boundPort = server.port ?? port;
  const boundHost = server.hostname ?? hostname;
  const url = `http://${boundHost}:${boundPort}`;

  return {
    server,
    port: boundPort,
    hostname: boundHost,
    url,
    checkpointer,
    close: () => {
      server.stop(true);
    },
  };
}
