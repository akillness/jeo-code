/**
 * Harness² Execution Trace Collector
 *
 * Non-intrusively wraps `AgentLoopEvents` to capture per-turn execution telemetry,
 * tool failures, verification signals, parse bounces, and tool-calling tier demotions,
 * persisting structured JSONL traces under `<cwd>/.harness2/traces/YYYY-MM-DD.jsonl`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AgentLoopEvents, AgentLoopResult, ToolInvocation } from "../engine";
import { isVerificationSignal, verificationProducedEvidence } from "../loop-guards";
import { onTierDemotion } from "../../ai/providers/local-capabilities";

export type FailureTag =
  | "parse_bounce"
  | "repeat_stop"
  | "cycle_stop"
  | "consecutive_failure_stop"
  | "unverified_done"
  | "tier_demotion"
  | "budget_exhausted"
  | `tool_failure:${string}`;

export interface ToolExecutionTrace {
  tool: string;
  success: boolean;
  durationMs: number;
  isVerification: boolean;
  errorSnippet?: string;
}

export interface ExecutionTraceRecord {
  traceId: string;
  timestamp: string;
  cwd: string;
  model?: string;
  domain?: string;
  promptPreview: string;
  done: boolean;
  steps: number;
  durationMs: number;
  parseBounces: number;
  verificationRuns: number;
  verificationPassed: boolean;
  tierDemotions: number;
  stopClass?: AgentLoopResult["stopClass"];
  completionRejected?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  toolCalls: ToolExecutionTrace[];
  failureTags: FailureTag[];
}

export interface TraceSummary {
  totalRuns: number;
  completedRuns: number;
  successRate: number;
  avgSteps: number;
  toolErrorRate: number;
  recurringTags: Array<{ tag: FailureTag; count: number }>;
  byModel: Record<
    string,
    {
      runs: number;
      completed: number;
      successRate: number;
      topTags: FailureTag[];
    }
  >;
}

export function tracesDir(cwd: string): string {
  return path.join(cwd, ".harness2", "traces");
}

function dateStampFor(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function appendTraceRecord(
  cwd: string,
  record: ExecutionTraceRecord,
): Promise<string> {
  const dir = tracesDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  const day = record.timestamp.slice(0, 10) || dateStampFor(new Date());
  const filePath = path.join(dir, `${day}.jsonl`);
  await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
  return filePath;
}

export class TraceCollector {
  private readonly startedAt: number;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly domain?: string;
  private readonly promptPreview: string;
  private readonly nowFn: () => Date;

  private lastToolStartAt: number;
  private lastBashCommand = "";
  private parseBounces = 0;
  private verificationRuns = 0;
  private verificationPassed = false;
  private tierDemotions = 0;
  private pendingNullInvocation = false;
  private readonly toolCalls: ToolExecutionTrace[] = [];
  private readonly extraTags = new Set<FailureTag>();
  private unsubscribeDemotion?: () => void;

  constructor(opts: {
    cwd: string;
    model?: string;
    domain?: string;
    prompt?: string;
    now?: () => Date;
  }) {
    this.nowFn = opts.now ?? (() => new Date());
    this.startedAt = this.nowFn().getTime();
    this.lastToolStartAt = this.startedAt;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.domain = opts.domain;
    this.promptPreview = (opts.prompt ?? "").trim().slice(0, 240);
    this.unsubscribeDemotion = onTierDemotion(() => {
      this.tierDemotions++;
      this.extraTags.add("tier_demotion");
    });
  }

  recordTierDemotion(): void {
    this.tierDemotions++;
    this.extraTags.add("tier_demotion");
  }

  /**
   * Composes trace hooks onto an existing `AgentLoopEvents` object without altering
   * any caller-facing behavior.
   */
  attachToEvents(base: AgentLoopEvents = {}): AgentLoopEvents {
    return {
      ...base,
      onStep: async (step: number) => {
        if (this.pendingNullInvocation) {
          // A null invocation followed by another step means the engine bounced non-JSON prose.
          this.parseBounces++;
          this.extraTags.add("parse_bounce");
          this.pendingNullInvocation = false;
        }
        this.lastToolStartAt = this.nowFn().getTime();
        await base.onStep?.(step);
      },
      onAssistant: (raw: string, invocation: ToolInvocation | null) => {
        if (invocation === null) {
          this.pendingNullInvocation = true;
        } else {
          this.pendingNullInvocation = false;
          if (invocation.tool === "bash") {
            this.lastBashCommand = String(
              invocation.arguments?.command ?? invocation.arguments?.cmd ?? "",
            );
          } else {
            this.lastBashCommand = "";
          }
        }
        base.onAssistant?.(raw, invocation);
      },
      onBeforeTools: async (raw: string) => {
        this.lastToolStartAt = this.nowFn().getTime();
        await base.onBeforeTools?.(raw);
      },
      onToolResult: (tool: string, success: boolean, output: string) => {
        const nowMs = this.nowFn().getTime();
        const durationMs = Math.max(0, nowMs - this.lastToolStartAt);
        this.lastToolStartAt = nowMs;

        const cmd = tool === "bash" ? this.lastBashCommand : "";
        const isVerif = tool === "bash" && cmd.length > 0 && isVerificationSignal(cmd);
        if (isVerif) {
          this.verificationRuns++;
          this.verificationPassed =
            success && verificationProducedEvidence(cmd, String(output ?? ""));
        }
        if (!success) {
          this.extraTags.add(`tool_failure:${tool}`);
        }
        this.toolCalls.push({
          tool,
          success,
          durationMs,
          isVerification: isVerif,
          ...(!success
            ? { errorSnippet: String(output ?? "").trim().slice(0, 200) }
            : {}),
        });
        base.onToolResult?.(tool, success, output);
      },
      onNotice: (message: string) => {
        if (/not a valid tool call/i.test(message)) {
          this.parseBounces++;
          this.extraTags.add("parse_bounce");
          this.pendingNullInvocation = false;
        }
        base.onNotice?.(message);
      },
    };
  }

  async finalize(
    result: AgentLoopResult,
    overrides?: {
      cwd?: string;
      model?: string;
      domain?: string;
      prompt?: string;
      persist?: boolean;
    },
  ): Promise<ExecutionTraceRecord> {
    this.unsubscribeDemotion?.();
    this.unsubscribeDemotion = undefined;

    if (result.stopClass === "repeat") this.extraTags.add("repeat_stop");
    if (result.stopClass === "cycle") this.extraTags.add("cycle_stop");
    if (result.stopClass === "consecutive_failure") {
      this.extraTags.add("consecutive_failure_stop");
    }
    if (result.completionRejected) {
      this.extraTags.add("unverified_done");
    }
    if (!result.done && !result.stopClass && !result.completionRejected) {
      this.extraTags.add("budget_exhausted");
    }

    const finishedAt = this.nowFn();
    const record: ExecutionTraceRecord = {
      traceId: crypto.randomUUID(),
      timestamp: finishedAt.toISOString(),
      cwd: overrides?.cwd ?? this.cwd,
      model: overrides?.model ?? this.model,
      domain: overrides?.domain ?? this.domain,
      promptPreview: overrides?.prompt
        ? overrides.prompt.trim().slice(0, 240)
        : this.promptPreview,
      done: result.done,
      steps: result.steps,
      durationMs: Math.max(0, finishedAt.getTime() - this.startedAt),
      parseBounces: this.parseBounces,
      verificationRuns: this.verificationRuns,
      verificationPassed: this.verificationPassed,
      tierDemotions: this.tierDemotions,
      ...(result.stopClass ? { stopClass: result.stopClass } : {}),
      ...(result.completionRejected ? { completionRejected: true } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      toolCalls: [...this.toolCalls],
      failureTags: [...this.extraTags],
    };

    if (overrides?.persist !== false) {
      await appendTraceRecord(record.cwd, record);
    }
    return record;
  }
}

export async function loadRecentTraces(
  cwd: string,
  opts: { limit?: number; model?: string; domain?: string } = {},
): Promise<ExecutionTraceRecord[]> {
  const limit = Math.max(1, opts.limit ?? 50);
  const dir = tracesDir(cwd);
  let files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }

  const out: ExecutionTraceRecord[] = [];
  for (const name of files) {
    if (out.length >= limit) break;
    let raw = "";
    try {
      raw = await fs.readFile(path.join(dir, name), "utf-8");
    } catch {
      continue;
    }
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .reverse();
    for (const line of lines) {
      if (out.length >= limit) break;
      try {
        const rec = JSON.parse(line) as ExecutionTraceRecord;
        if (opts.model && rec.model !== opts.model) continue;
        if (opts.domain && rec.domain !== opts.domain) continue;
        out.push(rec);
      } catch {
        // Ignore malformed line
      }
    }
  }
  return out;
}

export function summarizeTraces(traces: readonly ExecutionTraceRecord[]): TraceSummary {
  if (traces.length === 0) {
    return {
      totalRuns: 0,
      completedRuns: 0,
      successRate: 0,
      avgSteps: 0,
      toolErrorRate: 0,
      recurringTags: [],
      byModel: {},
    };
  }

  let completedRuns = 0;
  let totalSteps = 0;
  let totalTools = 0;
  let failedTools = 0;
  const tagCounts = new Map<FailureTag, number>();
  const modelBuckets = new Map<
    string,
    { runs: number; completed: number; tags: Map<FailureTag, number> }
  >();

  for (const tr of traces) {
    if (tr.done) completedRuns++;
    totalSteps += tr.steps;
    for (const tc of tr.toolCalls) {
      totalTools++;
      if (!tc.success) failedTools++;
    }
    const modelKey = tr.model || "unknown";
    let bucket = modelBuckets.get(modelKey);
    if (!bucket) {
      bucket = { runs: 0, completed: 0, tags: new Map() };
      modelBuckets.set(modelKey, bucket);
    }
    bucket.runs++;
    if (tr.done) bucket.completed++;

    for (const tag of tr.failureTags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      bucket.tags.set(tag, (bucket.tags.get(tag) ?? 0) + 1);
    }
  }

  const recurringTags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const byModel: TraceSummary["byModel"] = {};
  for (const [modelKey, bucket] of modelBuckets.entries()) {
    const topTags = [...bucket.tags.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([tag]) => tag);
    byModel[modelKey] = {
      runs: bucket.runs,
      completed: bucket.completed,
      successRate: bucket.runs > 0 ? bucket.completed / bucket.runs : 0,
      topTags,
    };
  }

  return {
    totalRuns: traces.length,
    completedRuns,
    successRate: completedRuns / traces.length,
    avgSteps: totalSteps / traces.length,
    toolErrorRate: totalTools > 0 ? failedTools / totalTools : 0,
    recurringTags,
    byModel,
  };
}
