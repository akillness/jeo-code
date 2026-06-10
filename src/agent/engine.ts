/**
 * Reusable agentic tool-call loop — the shared core behind `joc team`
 * (per-task executor) and `joc launch` (interactive coding agent).
 *
 * The model is driven in JSON tool-call mode: each step it emits exactly one
 * `{ "tool": "...", "arguments": { ... } }` object; the engine dispatches it,
 * appends the result to history, and continues until the model calls `done`
 * or the step budget is exhausted.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Message } from "./loop";
import { extractJsonObject } from "./json";
import { readTool, writeTool, editTool, bashTool, findTool, searchTool, lsTool, type ToolResult } from "./tools";
import { friendlyProviderError } from "../util/provider-error";
import { isRateLimitError } from "../util/retry";
import { runPreToolHooks, runPostTurnHooks } from "./hooks";


async function invokeCallLlm(history: Message[], options: {
  jsonMode: boolean;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onUsage?: (u: { inputTokens?: number; outputTokens?: number }) => void;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}): Promise<string> {
  const mod = await import("./loop");
  return mod.callLlm(history, options);
}
export interface ToolInvocation {
  tool: string;
  arguments?: Record<string, any>;
}

export type ToolHandler = (args: Record<string, any>, cwd: string) => Promise<ToolResult>;

/** The default executor toolset (read / write / edit / bash / find / search). */
export const DEFAULT_TOOLS: Record<string, ToolHandler> = {
  read: (a, cwd) => readTool(a.filePath ?? a.path, a.lineRange ?? a.range, cwd, !!a.raw),
  write: (a, cwd) => writeTool(a.filePath ?? a.path, a.content ?? "", cwd),
  edit: (a, cwd) => editTool(a.filePath ?? a.path, a.editBlock ?? a.edit ?? "", cwd),
  bash: (a, cwd) => bashTool(a.command ?? a.cmd, cwd, typeof a.timeoutMs === "number" ? a.timeoutMs : undefined, typeof a.cwd === "string" ? a.cwd : (typeof a.subdir === "string" ? a.subdir : undefined), a.env && typeof a.env === "object" ? a.env : undefined),
  find: (a, cwd) => findTool(a.globPattern ?? a.pattern, cwd),
  search: (a, cwd) => searchTool(a.pattern, a.globPattern ?? "*", cwd, !!(a.ignoreCase ?? a.i), { before: a.before, after: a.after, context: a.context, maxMatches: a.maxMatches }),
  ls: (a, cwd) => lsTool(a.dirPath ?? a.path ?? a.dir ?? ".", cwd),
};

/** Tool-protocol description injected into the system prompt. */
export const TOOL_PROTOCOL = [
  "You have these tools (call exactly ONE per step):",
  "1. read   {filePath, lineRange?, raw?} — read a file (lineRange \"a-b\",\"a-\",\"a\",\"a+n\",\"a-b,c-d\"; raw: verbatim, no line numbers)",
  "2. write  {filePath, content}         — create/overwrite a file",
  "3. edit   {filePath, editBlock}       — ≔A..B replace lines; ≔A+ insert after line A; ≔$ append EOF (payload on next line)",
  "4. bash   {command, timeoutMs?, cwd?, env?} — run a shell command (cwd: subdir; env: extra vars)",
  "5. find   {globPattern}               — find files by name",
  "6. search {pattern, globPattern?, ignoreCase?, context?, maxMatches?} — grep (context: N lines around each match)",
  "7. ls     {dirPath}                   — list a directory's entries (dirs first)",
  "8. done   {reason?}                   — call when the task is fully implemented AND verified",
  "",
  "Reply with STRICT JSON only — no prose, no code fences:",
  '{ "tool": "<name>", "arguments": { ... } }',
].join("\n");

/** Restricted protocol for read-only subagent roles (planner/architect/critic):
 *  advertises only the non-mutating tools so the model does not waste steps
 *  calling write/edit/bash, which `subagentToolset` has physically removed. */
export const READONLY_TOOL_PROTOCOL = [
  "You have these READ-ONLY tools (call exactly ONE per step):",
  "1. read   {filePath, lineRange?}      — read a file (lineRange: \"a-b\", \"a-\", \"a\", \"a+n\", or multi \"a-b,c-d\")",
  "2. find   {globPattern}               — find files by name",
  "3. search {pattern, globPattern?, ignoreCase?} — grep for a pattern",
  "4. ls     {dirPath}                   — list a directory's entries",
  "5. done   {reason?}                   — call when your review/analysis is complete",
  "",
  "Reply with STRICT JSON only — no prose, no code fences:",
  '{ "tool": "<name>", "arguments": { ... } }',
].join("\n");

export function executorSystemPrompt(
  role = "Executor Agent, a senior software developer",
  protocol: string = TOOL_PROTOCOL,
  verificationDirective = "Always verify (run tests / execute the program) before calling done.",
): string {
  return (
    `You are the ${role}.\n` +
    `Accomplish the user's request by calling tools and verifying your work.\n\n` +
    `${protocol}\n\n` +
    verificationDirective
  );
}

export interface AgentLoopEvents {
  onStep?(step: number): void | Promise<void>;
  onAssistant?(raw: string, invocation: ToolInvocation | null): void;
  onToolResult?(tool: string, success: boolean, output: string): void;
  /** Transient progress notice (e.g. "rate limited — retrying in Ns"); NOT a terminal error. */
  onNotice?(message: string): void;
  /** Cumulative token usage after each LLM call — drives live usage meters. */
  onUsage?(usage: { inputTokens: number; outputTokens: number }): void;
}

export interface AgentLoopOptions {
  /** Optional system prompt: prepended to `history` when it has no system message. */
  systemPrompt?: string;
  cwd: string;
  maxSteps?: number;
  model?: string;
  /** Max generation tokens per step (drives the thinking budget). */
  maxTokens?: number;
  tools?: Record<string, ToolHandler>;
  signal?: AbortSignal;
  events?: AgentLoopEvents;
}

export interface AgentLoopResult {
  done: boolean;
  steps: number;
  doneReason?: string;
  /** Summed provider token usage across the turn's steps, when reported. */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Cap a tool result fed back to the model, keeping both ends: the head holds the
 * start (e.g. a file's top / a command's invocation) and the tail holds what's
 * usually decisive (test summaries, the final error). A pure head-cut loses that.
 */
export function truncateToolOutput(s: string, max = 4000): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${s.slice(0, head)}\n…(${s.length - max} chars truncated)…\n${s.slice(s.length - tail)}`;
}

/** Tool output larger than this is spilled to a recoverable artifact file. Aligned
 *  with `truncateToolOutput`'s 4000-char cap so that whenever the model-visible
 *  result drops content, the full output is recoverable via the artifact. */
export const TOOL_SPILL_THRESHOLD = 4_000;

/**
 * Write an oversized tool result verbatim under `.joc/artifacts/tool-results/` and
 * return the workspace-relative path (for the model to `read`). Best-effort: throws
 * are caught by the caller, which simply omits the artifact note.
 */
/** Most recent tool-result artifacts to keep; older ones are pruned on each spill. */
export const MAX_TOOL_ARTIFACTS = 50;

/** Best-effort retention: keep the newest `MAX_TOOL_ARTIFACTS` files in `dir`, delete the rest. */
async function pruneToolArtifacts(dir: string): Promise<void> {
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  if (files.length <= MAX_TOOL_ARTIFACTS) return;
  const stamped = await Promise.all(
    files.map(async f => ({ f, m: (await fs.stat(path.join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  stamped.sort((a, b) => b.m - a.m); // newest first
  for (const { f } of stamped.slice(MAX_TOOL_ARTIFACTS)) {
    await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
  }
}

export async function spillToolResult(tool: string, output: string, cwd: string): Promise<string> {
  const dir = path.join(cwd, ".joc", "artifacts", "tool-results");
  await fs.mkdir(dir, { recursive: true });
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "tool";
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rel = path.join(".joc", "artifacts", "tool-results", `${stamp}-${safeTool}.txt`);
  await fs.writeFile(path.join(cwd, rel), output, "utf-8");
  // Retention so a long session can't grow the artifact dir without bound.
  await pruneToolArtifacts(dir);
  return rel;
}

/** Levenshtein distance (small inputs: tool/command names). */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Nearest known tool name for an unknown call: exact, prefix, or edit distance ≤ 2. */
export function nearestToolName(name: string, known: string[]): string | undefined {
  const want = name.trim().toLowerCase();
  if (!want) return undefined;
  let best: string | undefined;
  let bestD = Infinity;
  for (const k of known) {
    const kl = k.toLowerCase();
    if (kl === want) return k;
    const d = kl.startsWith(want) || want.startsWith(kl) ? 1 : editDistance(want, kl);
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= 2 ? best : undefined;
}
/**
 * Drive `history` through the tool-call loop, mutating it in place so callers
 * (e.g. an interactive REPL) can keep the conversation across multiple turns.
 */
export async function runAgentLoop(history: Message[], opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const { cwd } = opts;
  // Honor an explicit system prompt for callers that build history without one.
  if (opts.systemPrompt && history[0]?.role !== "system") {
    history.unshift({ role: "system", content: opts.systemPrompt });
  }
  const tools = opts.tools ?? DEFAULT_TOOLS;
  const maxSteps = opts.maxSteps ?? 15;
  const ev = opts.events ?? {};

  let step = 1;
  const acc = { inputTokens: 0, outputTokens: 0 };
  let sawUsage = false;
  const finish = (r: AgentLoopResult): AgentLoopResult => (sawUsage ? { ...r, usage: { ...acc } } : r);
  // No-progress guard: weak/local models often repeat the same tool call without
  // ever emitting `done`. Stop after MAX_REPEAT identical consecutive calls.
  const MAX_REPEAT = 3;
  // Consecutive-failure guard: a model that keeps emitting *different* but failing
  // calls (bad edits, failing commands) would otherwise burn the whole step budget.
  const MAX_FAILURES = 5;
  let consecutiveFailures = 0;
  let lastSig = "";
  let repeatCount = 0;
  // Invalid-tool-call guard: a model that returns JSON without a usable `tool`
  // field can't drive the loop at all — surface that clearly instead of looping.
  let invalidToolCalls = 0;
  // Prose-bounce guard: after this many invalid-JSON corrections, salvage the
  // model's text as the final answer instead of burning the whole step budget.
  const MAX_PARSE_BOUNCES = 2;
  let parseFailures = 0;
  while (step <= maxSteps) {
    if (opts.signal?.aborted) {
      return finish({ done: false, steps: step - 1, doneReason: "Cancelled." });
    }
    await ev.onStep?.(step);

    let responseText: string;
    try {
      responseText = await invokeCallLlm(history, {
              jsonMode: true,
              model: opts.model,
              maxTokens: opts.maxTokens,
              signal: opts.signal,
              onUsage: u => { acc.inputTokens += u.inputTokens ?? 0; acc.outputTokens += u.outputTokens ?? 0; sawUsage = true; },
              // Make provider auto-retry visible: previously a rate-limited call sat in a
              // silent backoff wait, then surfaced "auto-retry was exhausted" with no trace
              // of the retries that DID happen.
              onRetry: (attempt, err, delayMs) => {
                const wait = Math.max(1, Math.round(delayMs / 1000));
                const what = isRateLimitError(err) ? "rate limited (HTTP 429)" : "transient provider error";
                ev.onNotice?.(`${what} — auto-retry #${attempt} in ${wait}s`);
              },
            });
    } catch (err) {
      const message = friendlyProviderError(err);
      // The error IS the turn's doneReason and every caller displays that — emitting a
      // separate error event here printed the same message twice (live stream + reply).
      return finish({ done: false, steps: step, doneReason: `Error: ${message}` });
    }
    if (sawUsage) ev.onUsage?.({ ...acc });

    let invocation: ToolInvocation;
    try {
      invocation = extractJsonObject<ToolInvocation>(responseText);
    } catch (err) {
      ev.onAssistant?.(responseText, null);
      // Prose salvage: a reply with no JSON object at all is a chat-style final
      // answer, not a malformed tool call. Bouncing it back only made the model
      // apologize for the format — and that apology surfaced as the visible reply.
      // Same salvage after repeated bounces: the text we have IS the best answer.
      const trimmed = responseText.trim();
      parseFailures++;
      if (trimmed && (!trimmed.includes("{") || parseFailures > MAX_PARSE_BOUNCES)) {
        history.push({ role: "assistant", content: responseText });
        return finish({ done: true, steps: step, doneReason: trimmed });
      }
      history.push({ role: "assistant", content: responseText });
      history.push({
        role: "user",
        content:
          `Your last reply was not a valid tool call (${(err as Error).message}). ` +
          `Do NOT apologize or explain the formatting mistake. If that reply was your final answer, ` +
          `resend it as {"tool":"done","arguments":{"reason":"<that answer, verbatim>"}}; ` +
          `otherwise reply with exactly one JSON tool call: {"tool":"<name>","arguments":{...}}.`,
      });
      step++;
      continue;
    }

    ev.onAssistant?.(responseText, invocation);

    // Valid JSON but no usable `tool` field: the model isn't following the protocol.
    // Guide it once or twice, then stop with a clear, actionable reason.
    const toolName = typeof invocation?.tool === "string" ? invocation.tool.trim() : "";
    if (!toolName) {
      invalidToolCalls++;
      if (invalidToolCalls >= MAX_REPEAT) {
        return finish({
          done: false,
          steps: step,
          doneReason: `Stopped: the model returned no valid tool call ${MAX_REPEAT}× (a JSON reply with no "tool" field). The selected model may be too small to follow the JSON tool protocol — switch to a stronger model with /model.`,
        });
      }
      history.push({ role: "assistant", content: responseText });
      history.push({
        role: "user",
        content: `Your last reply had no "tool" field. Reply with exactly one JSON object, e.g. {"tool":"find","arguments":{"globPattern":"src/**"}} or {"tool":"done","arguments":{"reason":"…"}}.`,
      });
      step++;
      continue;
    }
    invalidToolCalls = 0;

    if (invocation.tool === "done") {
      return finish({ done: true, steps: step, doneReason: (invocation.arguments?.reason as string) ?? "" });
    }

    // Detect repeated identical tool calls (no forward progress).
    const sig = `${invocation.tool}:${JSON.stringify(invocation.arguments ?? {})}`;
    if (sig === lastSig) repeatCount++;
    else {
      repeatCount = 1;
      lastSig = sig;
    }
    if (repeatCount >= MAX_REPEAT) {
      return finish({
        done: false,
        steps: step,
        doneReason: `Stopped: repeated the same '${invocation.tool}' call ${MAX_REPEAT}× with no new progress (the model never signaled done).`,
      });
    }

    const handler = tools[invocation.tool];
    let success: boolean;
    let output: string;
    if (!handler) {
      success = false;
      const suggestion = nearestToolName(invocation.tool, Object.keys(tools));
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
      output = `Unknown tool: ${invocation.tool}.${hint} Available: ${Object.keys(tools).join(", ")}, done.`;
    } else {
      const preHookResult = await runPreToolHooks(
        cwd,
        invocation.tool,
        invocation.arguments ?? {},
        opts.signal,
        ev.onNotice
      );
      if (preHookResult.vetoed) {
        success = false;
        output = preHookResult.error + (preHookResult.output ? `\n${preHookResult.output}` : "");
      } else {
        const res = await handler(invocation.arguments ?? {}, cwd);
        success = res.success;
        output = res.success ? res.output : (res.error ? (res.output ? `${res.error}\n${res.output}` : res.error) : res.output);
      }
    }

    ev.onToolResult?.(invocation.tool, success, output);
    history.push({ role: "assistant", content: responseText });
    let resultBody = truncateToolOutput(output);
    // Spill oversized tool output to a recoverable artifact so the decisive middle
    // (test logs, long searches) isn't lost to the head+tail cap — the model can
    // `read` the full file when the preview elides what it needs.
    if (output.length > TOOL_SPILL_THRESHOLD) {
      const artifact = await spillToolResult(invocation.tool, output, cwd).catch(() => null);
      if (artifact) resultBody += `\n[full output (${output.length} chars) saved to ${artifact} — read it for the elided middle]`;
    }
    history.push({
      role: "user",
      content: `Tool [${invocation.tool}] result (${success ? "ok" : "fail"}):\n${resultBody}`,
    });

    await runPostTurnHooks(
      cwd,
      invocation.tool,
      invocation.arguments ?? {},
      success,
      output,
      opts.signal,
      ev.onNotice
    );

    if (success) {
      consecutiveFailures = 0;
    } else if (++consecutiveFailures >= MAX_FAILURES) {
      return finish({
        done: false,
        steps: step,
        doneReason: `Stopped: ${MAX_FAILURES} consecutive failing tool calls (last '${invocation.tool}'); the model could not recover.`,
      });
    }
    step++;
  }

  return finish({ done: false, steps: maxSteps });
}
