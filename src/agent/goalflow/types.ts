/**
 * GoalFlow Core Types
 * Pure TypeScript, zero native dependencies.
 */

export interface Command<S = Record<string, unknown>> {
  readonly kind: "command";
  update?: Partial<S>;
  goto?: string | string[];
  resume?: unknown;
}

export function command<S = Record<string, unknown>>(opts: {
  update?: Partial<S>;
  goto?: string | string[];
  resume?: unknown;
}): Command<S> {
  return {
    kind: "command",
    ...(opts.update !== undefined ? { update: opts.update } : {}),
    ...(opts.goto !== undefined ? { goto: opts.goto } : {}),
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
  };
}

export function isCommand<S = Record<string, unknown>>(v: unknown): v is Command<S> {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "command";
}

export interface Send {
  readonly kind: "send";
  node: string;
  payload: Record<string, unknown>;
}

export function send(node: string, payload: Record<string, unknown>): Send {
  return {
    kind: "send",
    node,
    payload,
  };
}

export function isSend(v: unknown): v is Send {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { kind?: unknown }).kind === "send" &&
    typeof (v as { node?: unknown }).node === "string"
  );
}

export type NodeOutput<S = Record<string, unknown>> =
  | Partial<S>
  | Command<S>
  | string[]
  | Send[]
  | void
  | null;

export type ErrorStrategy = "fail" | "default-value" | "fail-branch";

export type ReviewDecision = "approve" | "modify" | "reject";

export interface InterruptPayload {
  interruptId: string;
  nodeId: string;
  kind: "interview_question" | "plan_approval" | "tool_approval" | "custom";
  prompt: string;
  data?: Record<string, unknown>;
  allowedDecisions: ReviewDecision[];
}

export interface ReviewRecord {
  interruptId: string;
  nodeId: string;
  decision: ReviewDecision;
  input?: string;
  feedback?: string;
  decidedAt: string;
}

export class InterruptError extends Error {
  readonly payload: InterruptPayload;

  constructor(payload: InterruptPayload) {
    super(`GoalFlow interrupted at node '${payload.nodeId}': ${payload.prompt}`);
    this.name = "InterruptError";
    this.payload = payload;
  }
}

export type StreamMode = "updates" | "messages" | "custom";

export interface StreamTuple {
  mode: StreamMode;
  nodeId: string;
  data: unknown;
  timestamp: number;
}

export type RunStatus = "running" | "interrupted" | "completed" | "failed" | "cancelled";

export type SemanticEvent =
  | { type: "workflow_started"; runId: string; workflowName: string; timestamp: number }
  | { type: "node_started"; runId: string; nodeId: string; title?: string; timestamp: number }
  | { type: "node_finished"; runId: string; nodeId: string; costMs: number; output?: unknown; timestamp: number }
  | { type: "text_chunk"; runId: string; nodeId: string; text: string; timestamp: number }
  | { type: "reasoning_chunk"; runId: string; nodeId: string; reasoning: string; timestamp: number }
  | { type: "tool_call"; runId: string; nodeId: string; tool: string; args: Record<string, unknown>; callId?: string; timestamp: number }
  | { type: "tool_result"; runId: string; nodeId: string; tool: string; success: boolean; output: string; callId?: string; timestamp: number }
  | { type: "interrupt"; runId: string; payload: InterruptPayload; timestamp: number }
  | { type: "control"; runId: string; action: string; details?: Record<string, unknown>; timestamp: number }
  | { type: "error"; runId: string; nodeId?: string; error: string; timestamp: number }
  | { type: "workflow_finished"; runId: string; status: RunStatus; output?: unknown; costMs: number; timestamp: number };

export interface CheckpointRecord<S = Record<string, unknown>> {
  runId: string;
  threadId: string;
  workflowName: string;
  status: RunStatus;
  state: S;
  currentNodeId: string | null;
  step: number;
  completedNodes: string[];
  nodeCycleCounts?: Record<string, number>;
  pendingInterrupt?: InterruptPayload;
  reviews: ReviewRecord[];
  output?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
