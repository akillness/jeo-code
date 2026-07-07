/**
 * Opik observability for the jeo agent turn loop (spec-stack · Run phase).
 *
 * Each agent turn becomes ONE Opik trace; each step/tool becomes a span; token
 * usage and the eval feedback scores (`completed` / `verified` / `efficiency`)
 * are attached to the trace. Pure TypeScript over `fetch` — no Python, no
 * `opik` npm package — consistent with jeo's zero-native-dependency constraint.
 *
 * Hard invariants (see .specify/specs/opik-observability/seed.md):
 *  - I1: `JEO_OPIK` unset => the tracer is a no-op; zero Opik HTTP calls.
 *  - I2: no tracer error ever propagates out of an events callback.
 *  - I3: no secret is logged; the key only travels in the `Authorization` header.
 *  - I4: engine output is identical regardless of tracing outcome.
 *
 * Opik REST surface (private v1), confirmed against the installed SDK:
 *  - POST  {base}/v1/private/traces/batch         { traces: [...] }
 *  - POST  {base}/v1/private/spans/batch          { spans:  [...] }
 *  - PUT   {base}/v1/private/traces/feedback-scores { scores: [...] }
 * Headers: `Authorization: <api_key>`, `Comet-Workspace: <workspace>`.
 */
import { jeoEnv } from "../util/env";
import type { AgentLoopEvents, ToolInvocation } from "./engine";

type Env = Record<string, string | undefined>;
type FetchImpl = typeof fetch;

const DEFAULT_BASE = "https://www.comet.com/opik/api";
const DEFAULT_PROJECT = "jeo";
const DEFAULT_WORKSPACE = "jeo";
/** Verification signal (mirrors engine.ts VERIFY_SIGNAL_RE) — used for the eval score. */
const VERIFY_SIGNAL_RE = /\b(test|tests|tsc|typecheck|lint|build|check|spec|pytest|vitest|jest)\b/i;

/** Master switch. Tracing is OFF unless `JEO_OPIK` is `1`/`true`/`yes`/`on`. */
export function opikEnabled(env: Env = process.env): boolean {
  const raw = (jeoEnv("OPIK", env) ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export interface OpikConfig {
  apiKey?: string;
  workspace: string;
  baseUrl: string;
  projectName: string;
}

/** Resolve Opik connection config from the environment (no I/O). */
export function resolveOpikConfig(env: Env = process.env): OpikConfig {
  const baseRaw = (env.OPIK_URL_OVERRIDE ?? DEFAULT_BASE).trim();
  // Normalize a trailing slash so path joins are predictable.
  const baseUrl = baseRaw.replace(/\/+$/, "");
  return {
    apiKey: env.OPIK_API_KEY?.trim() || undefined,
    workspace: (env.COMET_WORKSPACE ?? DEFAULT_WORKSPACE).trim() || DEFAULT_WORKSPACE,
    baseUrl,
    projectName: (env.OPIK_PROJECT_NAME ?? DEFAULT_PROJECT).trim() || DEFAULT_PROJECT,
  };
}

/** RFC-9562 UUIDv7 (time-ordered) — Opik orders traces/spans by id. */
export function uuidv7(now: number = Date.now(), rnd: () => number = Math.random): string {
  const ts = Math.max(0, Math.trunc(now));
  const hex = ts.toString(16).padStart(12, "0").slice(-12);
  const b: number[] = [];
  for (let i = 0; i < 16; i++) b.push(Math.floor(rnd() * 256) & 0xff);
  // 48-bit big-endian timestamp
  for (let i = 0; i < 6; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  b[6] = 0x70 | (b[6]! & 0x0f); // version 7
  b[8] = 0x80 | (b[8]! & 0x3f); // variant
  const h = b.map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** ISO-8601 with milliseconds (Opik expects RFC-3339 timestamps). */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export interface TurnMeta {
  /** Human-readable turn name (the user intent / first message). */
  name: string;
  /** The user input recorded on the trace. */
  input?: string;
  /** Extra metadata (model, cwd, …). */
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface StepRecord {
  step: number;
  tool: string;
  success: boolean;
  output: string;
  startTime: number;
  endTime: number;
}

export interface TurnScores {
  completed: number;
  verified: number;
  efficiency: number;
}

/**
 * Eval scoring (the *evaluation* surface). All in [0,1].
 *  - completed: 1 when the turn ended in `done`.
 *  - verified: 1 when a verification signal (test/tsc/build/…) ran in-turn.
 *  - efficiency: 1 for a 1-step turn, decaying as steps grow (1/sqrt(steps)),
 *    so fewer steps to reach `done` scores higher; floored at 0.
 */
export function computeScores(args: {
  done: boolean;
  steps: number;
  verificationRan: boolean;
}): TurnScores {
  const steps = Math.max(1, Math.trunc(args.steps) || 1);
  const efficiency = Math.min(1, 1 / Math.sqrt(steps));
  return {
    completed: args.done ? 1 : 0,
    verified: args.verificationRan ? 1 : 0,
    efficiency: Number(efficiency.toFixed(4)),
  };
}

/** Whether a tool name + output looks like an in-turn verification signal. */
export function isVerificationStep(tool: string, output: string): boolean {
  if (tool !== "bash") return false;
  return VERIFY_SIGNAL_RE.test(output);
}

// ---- Pure payload builders (unit-tested without network) --------------------

export function buildTracePayload(args: {
  id: string;
  project: string;
  meta: TurnMeta;
  startTime: number;
  endTime: number;
  output?: string;
  usage?: { inputTokens: number; outputTokens: number };
}): Record<string, unknown> {
  const metadata = { ...(args.meta.metadata ?? {}) } as Record<string, unknown>;
  if (args.usage) {
    metadata.usage = {
      prompt_tokens: args.usage.inputTokens,
      completion_tokens: args.usage.outputTokens,
      total_tokens: args.usage.inputTokens + args.usage.outputTokens,
    };
  }
  return {
    id: args.id,
    project_name: args.project,
    name: args.meta.name,
    start_time: iso(args.startTime),
    end_time: iso(args.endTime),
    ...(args.meta.input != null ? { input: { message: args.meta.input } } : {}),
    ...(args.output != null ? { output: { result: args.output } } : {}),
    metadata,
    tags: args.meta.tags ?? ["jeo"],
  };
}

export function buildSpanPayload(args: {
  id: string;
  traceId: string;
  project: string;
  rec: StepRecord;
}): Record<string, unknown> {
  const { rec } = args;
  return {
    id: args.id,
    trace_id: args.traceId,
    project_name: args.project,
    name: `step ${rec.step}: ${rec.tool}`,
    type: "general",
    start_time: iso(rec.startTime),
    end_time: iso(rec.endTime),
    input: { tool: rec.tool },
    output: { success: rec.success, output: rec.output.slice(0, 4000) },
    metadata: { step: rec.step, success: rec.success },
  };
}

export function buildScorePayload(args: {
  traceId: string;
  project: string;
  scores: TurnScores;
}): Record<string, unknown> {
  const mk = (name: string, value: number, reason: string) => ({
    id: args.traceId,
    project_name: args.project,
    name,
    value,
    source: "sdk" as const,
    reason,
  });
  return {
    scores: [
      mk("completed", args.scores.completed, "1 when the turn ended in `done`"),
      mk("verified", args.scores.verified, "1 when a verification signal ran in-turn"),
      mk("efficiency", args.scores.efficiency, "1/sqrt(steps); fewer steps score higher"),
    ],
  };
}

// ---- Tracer -----------------------------------------------------------------

export interface OpikTracer {
  readonly enabled: boolean;
  startTurn(): void;
  step(rec: StepRecord): void;
  usage(u: { inputTokens: number; outputTokens: number }): void;
  endTurn(result: { done: boolean; steps: number; output?: string }): Promise<void>;
}

const NOOP_TRACER: OpikTracer = {
  enabled: false,
  startTurn() {},
  step() {},
  usage() {},
  async endTurn() {},
};

class LiveOpikTracer implements OpikTracer {
  readonly enabled = true;
  private readonly traceId = uuidv7();
  private readonly steps: StepRecord[] = [];
  private readonly spanIds = new Map<number, string>();
  private startedAt = Date.now();
  private usageAcc = { inputTokens: 0, outputTokens: 0 };
  private sawUsage = false;
  private verificationRan = false;
  private ended = false;

  constructor(
    private readonly meta: TurnMeta,
    private readonly cfg: OpikConfig,
    private readonly fetchImpl: FetchImpl,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "Comet-Workspace": this.cfg.workspace,
    };
    if (this.cfg.apiKey) h["Authorization"] = this.cfg.apiKey;
    return h;
  }

  /** Fire-and-forget POST/PUT; any failure is swallowed (I2/I4). */
  private async send(path: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<void> {
    try {
      await this.fetchImpl(`${this.cfg.baseUrl}/${path}`, {
        method,
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch {
      /* never break the turn */
    }
  }

  startTurn(): void {
    this.startedAt = Date.now();
  }

  step(rec: StepRecord): void {
    this.steps.push(rec);
    this.spanIds.set(rec.step, uuidv7(rec.startTime));
    if (isVerificationStep(rec.tool, rec.output)) this.verificationRan = true;
  }

  usage(u: { inputTokens: number; outputTokens: number }): void {
    this.usageAcc.inputTokens += u.inputTokens || 0;
    this.usageAcc.outputTokens += u.outputTokens || 0;
    this.sawUsage = true;
  }

  async endTurn(result: { done: boolean; steps: number; output?: string }): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const endedAt = Date.now();
    const project = this.cfg.projectName;

    const trace = buildTracePayload({
      id: this.traceId,
      project,
      meta: this.meta,
      startTime: this.startedAt,
      endTime: endedAt,
      output: result.output,
      usage: this.sawUsage ? this.usageAcc : undefined,
    });
    const spans = this.steps.map(rec =>
      buildSpanPayload({ id: this.spanIds.get(rec.step)!, traceId: this.traceId, project, rec }),
    );
    const scores = computeScores({
      done: result.done,
      steps: result.steps,
      verificationRan: this.verificationRan,
    });
    const scorePayload = buildScorePayload({ traceId: this.traceId, project, scores });

    await this.send("v1/private/traces/batch", { traces: [trace] });
    if (spans.length > 0) await this.send("v1/private/spans/batch", { spans });
    await this.send("v1/private/traces/feedback-scores", scorePayload, "PUT");
  }
}

/**
 * Build a tracer for one turn. Returns a no-op tracer (zero network) when
 * `JEO_OPIK` is off or no API key is configured.
 */
export function createOpikTracer(
  meta: TurnMeta,
  env: Env = process.env,
  fetchImpl: FetchImpl = fetch,
): OpikTracer {
  if (!opikEnabled(env)) return NOOP_TRACER;
  const cfg = resolveOpikConfig(env);
  if (!cfg.apiKey) return NOOP_TRACER; // no creds => stay silent, never guess
  return new LiveOpikTracer(meta, cfg, fetchImpl);
}

/**
 * Compose an existing `AgentLoopEvents` with tracer hooks. Every original
 * callback is delegated unchanged; the tracer observes step boundaries, tool
 * results, and usage. Tracer side-effects can never throw out of a callback.
 */
export function wrapEvents(events: AgentLoopEvents | undefined, tracer: OpikTracer): AgentLoopEvents {
  if (!tracer.enabled) return events ?? {};
  const base: AgentLoopEvents = events ?? {};
  let stepStartedAt = Date.now();
  let currentStep = 0;

  const wrapped: AgentLoopEvents = {
    ...base,
    onStep(step: number) {
      currentStep = step;
      stepStartedAt = Date.now();
      base.onStep?.(step);
    },
    onAssistant(raw: string, invocation: ToolInvocation | null) {
      base.onAssistant?.(raw, invocation);
    },
    onToolResult(tool: string, success: boolean, output: string) {
      try {
        tracer.step({
          step: currentStep || 1,
          tool,
          success,
          output,
          startTime: stepStartedAt,
          endTime: Date.now(),
        });
      } catch { /* I2 */ }
      base.onToolResult?.(tool, success, output);
    },
    onUsage(usage: { inputTokens: number; outputTokens: number }) {
      try { tracer.usage(usage); } catch { /* I2 */ }
      base.onUsage?.(usage);
    },
  };
  return wrapped;
}
