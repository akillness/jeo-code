/**
 * Reusable agentic tool-call loop — the shared core behind `jeo team`
 * (per-task executor) and `jeo launch` (interactive coding agent).
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
import { webSearchTool, setWebSearchActiveModel } from "./web-search";
import { friendlyProviderError } from "../util/provider-error";
import { isRateLimitError } from "../util/retry";
import { runPreToolHooks, runPostTurnHooks } from "./hooks";
import { minimizeToolOutput } from "./output-minimizer";
import { StepBudget, dynamicStepBudgetConfig, resolveStepBudgetConfig, type StepBudgetConfig } from "./step-budget";
import { historyTokens, trimToolResultsInPlace } from "./compaction";
import { jeoEnv } from "../util/env";


async function invokeCallLlm(history: Message[], options: {
  jsonMode: boolean;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onUsage?: (u: { inputTokens?: number; outputTokens?: number }) => void;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  onToken?: (delta: string) => void;
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
  web_search: (a, cwd) => webSearchTool(a, cwd),
};

/** Tool-protocol description injected into the system prompt. */
export const TOOL_PROTOCOL = [
  "You have these tools (call exactly ONE per step, or batch multiple independent calls):",
  "1. read   {filePath, lineRange?, raw?} — read a file; lines are prefixed `LINEhh|` (hh = 2-char content anchor; the | is a separator, not file bytes)",
  "2. write  {filePath, content}         — create/overwrite a file",
  "3. edit   {filePath, editBlock}       — ≔A..B replace lines (append read anchors for safety: ≔12ab..15cd — rejected with fresh content if the lines changed); ≔A+ insert after line A; ≔$ append EOF (payload on next line). NEVER copy the `LINEhh|` prefixes into SEARCH blocks or payloads",
  "4. bash   {command, timeoutMs?, cwd?, env?} — run a shell command (cwd: subdir; env: extra vars)",
  "5. find   {globPattern}               — find files by name",
  "6. search {pattern, globPattern?, ignoreCase?, context?, maxMatches?} — grep (context: N lines around each match)",
  "7. ls     {dirPath}                   — list a directory's entries (dirs first)",
  "8. web_search {query, recency?, limit?} — search the web (Anthropic-native: synthesized answer + sources + citations)",
  "9. done   {reason?}                   — call when the task is fully implemented AND verified",
  "",
  "Reply with STRICT JSON only — no code fences. You MAY include an optional leading",
  '"reasoning" string (one short sentence on your plan) before "tool":',
  '{ "reasoning": "<one short sentence>", "tool": "<name>", "arguments": { ... } }',
  "",
  "Alternatively, you may batch up to 6 independent calls in a single turn using the following format:",
  '{ "reasoning": "<one short sentence>", "tools": [{ "tool": "<name>", "arguments": { ... } }, ...] }',
  "Batch only independent calls; NEVER batch 'done', and NEVER put a mutating tool (write/edit/bash) after another mutating tool in one batch whose inputs depend on the earlier one.",
].join("\n");

/** Restricted protocol for read-only subagent roles (planner/architect/critic):
 *  advertises only the non-mutating tools so the model does not waste steps
 *  calling write/edit/bash, which `subagentToolset` has physically removed. */
export const READONLY_TOOL_PROTOCOL = [
  "You have these READ-ONLY tools (call exactly ONE per step, or batch multiple independent calls):",
  "1. read   {filePath, lineRange?}      — read a file (lineRange: \"a-b\", \"a-\", \"a\", \"a+n\", or multi \"a-b,c-d\")",
  "2. find   {globPattern}               — find files by name",
  "3. search {pattern, globPattern?, ignoreCase?} — grep for a pattern",
  "4. ls     {dirPath}                   — list a directory's entries",
  "5. web_search {query, recency?, limit?} — search the web (answer + sources + citations)",
  "6. done   {reason?}                   — call when your review/analysis is complete",
  "",
  "Reply with STRICT JSON only — no prose, no code fences:",
  '{ "tool": "<name>", "arguments": { ... } }',
  "",
  "Alternatively, you may batch up to 6 independent calls in a single turn using the following format:",
  '{ "tools": [{ "tool": "<name>", "arguments": { ... } }, ...] }',
  "Batch only independent calls; NEVER batch 'done'.",
].join("\n");

/** gjc-inherited working discipline (plan/gjc-inheritance.md B3): the completion
 *  contract and tool-priority rules distilled from gjc's system prompt — compact
 *  (<300 tokens) per the pi-mono budget so the core prompt stays lean. */
export const WORKING_DISCIPLINE = [
  "Working discipline:",
  "- Correctness first, maintainability second, brevity third. Prefer boring, explicit code.",
  "- Never present partial work as complete; never suppress tests or warnings to make code pass.",
  "- Never fabricate tool results or test outcomes; verification claims must match what was actually run.",
  "- Never ship stubs, placeholders, or TODO-only code as a delivered feature.",
  "- Never substitute the requested problem with an easier adjacent one.",
  "- Update directly affected callsites, tests, and docs — or state why they are unchanged.",
  "- Reuse existing patterns; parallel conventions are prohibited. Fix problems at their source.",
  "- You are not alone in the repository: treat unexpected changes as user work; never revert or delete them.",
  "- Re-read before acting if a tool fails or a file may have changed.",
  "- Prefer dedicated tools over shell pipelines: read (not cat), search (not grep), edit (not sed).",
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
    `${WORKING_DISCIPLINE}\n\n` +
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
  /** Accumulated streamed model response so far — drives the live reasoning view. Only
   *  requested when a consumer sets it (the engine streams solely for the TUI). */
  onModelStream?(textSoFar: string): void;
  /** Step-budget change (gjc-style retry flow): the limit was extended because the
   *  turn is making progress. `limit` is the new max; `reason` is display-ready. */
  onBudget?(limit: number, reason: string): void;
}

export interface AgentLoopOptions {
  /** Optional system prompt: prepended to `history` when it has no system message. */
  systemPrompt?: string;
  /** Mid-turn context budget (estimated tokens). When the in-turn history grows
   *  past this, the OLDEST tool-result bodies are deterministically elided so a
   *  long turn cannot snowball into multi-million-token prompts. Default 80k. */
  maxHistoryTokens?: number;
  cwd: string;
  /** Base step budget (default 15). Non-finite or `<= 0` selects the DYNAMIC budget:
   *  the budget keeps extending while the recent tool window shows NOVEL progress,
   *  a stalled or cycling turn consolidates a final wrap-up, and a large finite
   *  safety cap (`DYNAMIC_HARD_CAP`, default 600) guarantees termination. */
  maxSteps?: number;
  model?: string;
  /** Max generation tokens per step (drives the thinking budget). */
  maxTokens?: number;
  tools?: Record<string, ToolHandler>;
  signal?: AbortSignal;
  events?: AgentLoopEvents;
  /** Step-budget overrides (gjc-style retry flow). `{ maxExtensions: 0 }` restores the
   *  legacy fixed counter — used by bounded subagent delegation. */
  budget?: Partial<StepBudgetConfig>;
}

export interface AgentLoopResult {
  done: boolean;
  steps: number;
  doneReason?: string;
  /** Summed provider token usage across the turn's steps, when reported. */
  usage?: { inputTokens: number; outputTokens: number };
}

/** Env-tunable output budget (plan/gjc-inheritance.md B10, gjc settings-driven
 *  output handling 계승): JOC_TOOL_OUTPUT_MAX caps the model-visible tool result;
 *  the spill threshold tracks it so anything truncated stays artifact-recoverable. */
function envOutputMax(): number {
  const raw = Number(jeoEnv("TOOL_OUTPUT_MAX") ?? "");
  return Number.isFinite(raw) && raw >= 500 && raw <= 200_000 ? Math.trunc(raw) : 4_000;
}
export const TOOL_OUTPUT_MAX = envOutputMax();

/**
 * Cap a tool result fed back to the model, keeping both ends: the head holds the
 * start (e.g. a file's top / a command's invocation) and the tail holds what's
 * usually decisive (test summaries, the final error). A pure head-cut loses that.
 */
export function truncateToolOutput(s: string, max = TOOL_OUTPUT_MAX): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${s.slice(0, head)}\n…(${s.length - max} chars truncated)…\n${s.slice(s.length - tail)}`;
}

/** Tool output larger than this is spilled to a recoverable artifact file. Aligned
 *  with `truncateToolOutput`'s cap so that whenever the model-visible result drops
 *  content, the full output is recoverable via the artifact. */
export const TOOL_SPILL_THRESHOLD = TOOL_OUTPUT_MAX;

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
  // Active-model gate for web_search's provider chain (gjc parity): the chain
  // prefers the active model's native search backend, never credential-scanning.
  setWebSearchActiveModel(opts.model);
  // Honor an explicit system prompt for callers that build history without one.
  if (opts.systemPrompt && history[0]?.role !== "system") {
    history.unshift({ role: "system", content: opts.systemPrompt });
  }
  const tools = opts.tools ?? DEFAULT_TOOLS;
  const maxSteps = opts.maxSteps ?? 15;
  // gjc-style retry flow: the step limit is a flexible BUDGET, not a bare counter.
  // While the recent window shows real progress the budget extends itself; a stalled
  // turn fails fast into the consolidation wrap-up. An explicit positive maxSteps
  // keeps the bounded flow (base + capped extensions); a non-finite / non-positive
  // maxSteps selects the DYNAMIC budget — extensions keep flowing while NOVEL
  // progress continues, a stalled/cycling window consolidates, and a large finite
  // safety cap (default 600 steps) guarantees the turn always terminates.
  const budget = new StepBudget(
    Number.isFinite(maxSteps) && maxSteps > 0
      ? resolveStepBudgetConfig(maxSteps, process.env, opts.budget)
      : dynamicStepBudgetConfig(process.env, opts.budget),
  );
  // Why the loop stopped at the limit — folded into the consolidation message.
  let budgetStopReason = "";
  const ev = opts.events ?? {};
  const maxHistoryTokens = Math.max(10_000, opts.maxHistoryTokens ?? 80_000);

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
  // done-verification guard (plan/gjc-inheritance.md B4, gjc ultragoal-guard 경량 계승):
  // a turn that MUTATED files but shows no verification signal gets ONE pushback on
  // `done` — run the relevant test/build, or call done again (the escape hatch for
  // doc/config changes where verification is genuinely not applicable).
  let sawMutation = false;
  let sawVerification = false;
  let donePushbackUsed = false;
  const VERIFY_SIGNAL_RE = /\b(test|tests|tsc|typecheck|lint|build|check|spec|pytest|vitest|jest)\b/i;
  let lastSig = "";
  let repeatCount = 0;
  // Invalid-tool-call guard: a model that returns JSON without a usable `tool`
  // field can't drive the loop at all — surface that clearly instead of looping.
  let invalidToolCalls = 0;
  // Prose-bounce guard: after this many invalid-JSON corrections, salvage the
  // model's text as the final answer instead of burning the whole step budget.
  const MAX_PARSE_BOUNCES = 2;
  let parseFailures = 0;
  while (true) {
    if (step > budget.limit()) {
      const decision = budget.tryExtend();
      if (!decision.extend) {
        budgetStopReason = decision.reason;
        break;
      }
      // One surface per sink: budget-aware consumers get onBudget; others the notice.
      if (ev.onBudget) ev.onBudget(decision.limit, decision.reason);
      else ev.onNotice?.(decision.reason);
    }
    if (opts.signal?.aborted) {
      return finish({ done: false, steps: step - 1, doneReason: "Cancelled." });
    }
    await ev.onStep?.(step);

    // MID-TURN context guard: a single long turn (60+ steps) otherwise grows the
    // history without bound — turn-boundary compaction never runs inside a turn,
    // and field evidence shows multi-million-token prompts degrading the model
    // into repeat loops while cost compounds. Deterministically elide the OLDEST
    // tool-result bodies once the estimate crosses the budget; recent evidence
    // and all assistant/user content stay intact.
    if (historyTokens(history) > maxHistoryTokens) {
      const res = trimToolResultsInPlace(history, { budgetTokens: maxHistoryTokens });
      if (res.trimmed > 0) {
        ev.onNotice?.(`context guard: elided ${res.trimmed} older tool result(s) mid-turn (~${Math.round(res.tokens / 1000)}k tokens kept)`);
      }
    }

    // Stream the response into the live reasoning view ONLY when a consumer is attached
    // (a TUI). Non-interactive/test callers leave onModelStream unset → a single
    // non-streaming call(), unchanged. The accumulated text is still parsed as one JSON
    // tool call below, so streaming changes nothing about loop semantics.
    let streamBuf = "";
    const onToken = ev.onModelStream
      ? (delta: string) => { streamBuf += delta; ev.onModelStream!(streamBuf); }
      : undefined;
    let responseText: string;
    try {
      responseText = await invokeCallLlm(history, {
              jsonMode: true,
              model: opts.model,
              maxTokens: opts.maxTokens,
              signal: opts.signal,
              onUsage: u => { acc.inputTokens += u.inputTokens ?? 0; acc.outputTokens += u.outputTokens ?? 0; sawUsage = true; },
              onToken,
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

    let invocation: any;
    try {
      invocation = extractJsonObject<any>(responseText);
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
    // A successfully parsed reply ends any bounce streak: MAX_PARSE_BOUNCES is a
    // CONSECUTIVE-failure salvage, not a cumulative one — without this reset a long
    // turn accumulated scattered parse slips and prematurely salvaged mid-task prose.
    parseFailures = 0;

    // Normalize to an invocation list
    let toolCalls: { tool: string; arguments?: Record<string, any> }[] = [];
    if (invocation && typeof invocation === "object") {
      if (Array.isArray(invocation.tools)) {
        const isValidBatch = invocation.tools.length > 0 && invocation.tools.every(
          (t: any) => t && typeof t === "object" && typeof t.tool === "string" && t.tool.trim().length > 0
        );
        if (isValidBatch) {
          toolCalls = invocation.tools.map((t: any) => ({
            tool: t.tool.trim(),
            arguments: t.arguments
          }));
        }
      } else if (typeof invocation.tool === "string" && invocation.tool.trim().length > 0) {
        toolCalls = [{
          tool: invocation.tool.trim(),
          arguments: invocation.arguments
        }];
      }
    }

    if (toolCalls.length === 0) {
      invalidToolCalls++;
      if (invalidToolCalls >= MAX_REPEAT) {
        return finish({
          done: false,
          steps: step,
          doneReason: `Stopped: the model returned no valid tool call ${MAX_REPEAT}× (a JSON reply with no valid "tool" or "tools" field). The selected model may be too small to follow the JSON tool protocol — switch to a stronger model with /model.`,
        });
      }
      history.push({ role: "assistant", content: responseText });
      history.push({
        role: "user",
        content: `Your last reply had no "tool" or "tools" field. Reply with exactly one JSON object, e.g. {"tool":"find","arguments":{"globPattern":"src/**"}} or {"tools":[{"tool":"read","arguments":{"filePath":"src/main.ts"}}, ...]}.`,
      });
      step++;
      continue;
    }
    invalidToolCalls = 0;

    if (toolCalls.length > 6) {
      ev.onNotice?.(`Too many tool calls in batch (${toolCalls.length}); capping at 6 and dropping the rest.`);
      toolCalls = toolCalls.slice(0, 6);
    }

    ev.onAssistant?.(responseText, toolCalls[0]);

    if (toolCalls.length === 1 && toolCalls[0].tool === "done") {
      if (sawMutation && !sawVerification && !donePushbackUsed) {
        donePushbackUsed = true; // second done always passes — escape hatch
        history.push({ role: "assistant", content: responseText });
        history.push({
          role: "user",
          content:
            "You modified files this turn but ran NO verification (no test/build/typecheck command succeeded). " +
            "Run the narrowest command that proves your change works, then call done. " +
            "If verification is genuinely not applicable (docs/config-only change), call done again and say why in the reason.",
        });
        step++;
        continue;
      }
      return finish({ done: true, steps: step, doneReason: (toolCalls[0].arguments?.reason as string) ?? "" });
    }

    // Anti-spin guard, checked BEFORE execution: a repeated identical step must
    // not run its calls again — a repeated mutating bash/edit must not execute
    // a third time merely to be detected.
    //  - 2nd identical step → ONE corrective bounce (skip execution, tell the
    //    model its previous identical call already ran and to either act
    //    differently or call done). Field evidence: long turns died here right
    //    after a SUCCESSFUL write because nothing ever told the model to stop
    //    repeating — a recovery prompt resolves that without killing the turn.
    //  - 3rd identical step (repeated through the explicit correction) → stop.
    const callSigs = toolCalls.map(c => `${c.tool}:${JSON.stringify(c.arguments ?? {})}`);
    const sig = callSigs.join(" | ");
    if (sig === lastSig) repeatCount++;
    else {
      repeatCount = 1;
      lastSig = sig;
    }
    if (repeatCount === 2) {
      const what = toolCalls.length === 1 ? `'${toolCalls[0].tool}' call` : "tool batch";
      history.push({ role: "assistant", content: responseText });
      history.push({
        role: "user",
        content:
          `You just repeated the EXACT same ${what} you already ran in the previous step — it was not re-executed. ` +
          `Its result has not changed. If the task is complete, reply {"tool":"done","arguments":{"reason":"<summary of what was accomplished>"}}; ` +
          `otherwise take a DIFFERENT next action (verify the result, move to the next file, or fix something new).`,
      });
      ev.onNotice?.(`repeated ${what} skipped — asked the model to act differently or call done`);
      step++;
      continue;
    }
    if (repeatCount >= MAX_REPEAT) {
      const what = toolCalls.length === 1 ? `the same '${toolCalls[0].tool}' call` : "the same tool calls";
      return finish({
        done: false,
        steps: step,
        doneReason: `Stopped: repeated ${what} ${MAX_REPEAT}× even after an explicit correction (the model never signaled done).`,
      });
    }

    // Helper to execute a single tool call
    const executeTool = async (call: { tool: string; arguments?: Record<string, any> }) => {
      const { tool, arguments: args } = call;
      let success: boolean;
      let output: string;

      if (tool === "done") {
        success = false;
        output = "Error: 'done' can only be called as the single tool invocation, not in a batch. Please send 'done' alone.";
      } else {
        const handler = tools[tool];
        if (!handler) {
          success = false;
          const suggestion = nearestToolName(tool, Object.keys(tools));
          const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
          output = `Unknown tool: ${tool}.${hint} Available: ${Object.keys(tools).join(", ")}, done.`;
        } else {
          const preHookResult = await runPreToolHooks(
            cwd,
            tool,
            args ?? {},
            opts.signal,
            ev.onNotice
          );
          if (preHookResult.vetoed) {
            success = false;
            output = preHookResult.error + (preHookResult.output ? `\n${preHookResult.output}` : "");
          } else {
            try {
              const res = await handler(args ?? {}, cwd);
              success = res.success;
              output = res.success ? res.output : (res.error ? (res.output ? `${res.error}\n${res.output}` : res.error) : res.output);
            } catch (err: any) {
              success = false;
              output = err?.message || String(err);
            }
          }
        }
      }
      return { success, output };
    };

    const READONLY_TOOLS = new Set(["read", "find", "search", "ls", "web_search"]);
    const WRITE_TOOLS = new Set(["write", "edit"]);
    // Batch grouping → concurrency plan (plan/gjc-inheritance.md cycle 12):
    //   read group      — consecutive read-only calls run in parallel (safe).
    //   write group     — consecutive write/edit calls to DISTINCT files run in
    //                     parallel; a same-file (or path-less) collision opens a
    //                     sequential boundary so ordered edits to one file stay ordered.
    //   exclusive group — bash (and anything else) always runs alone, in order.
    // Reads and writes never share a group, so a read can never race a write.
    type ToolGroup = {
      kind: "read" | "write" | "exclusive";
      calls: { tool: string; arguments?: Record<string, any>; index: number }[];
      files?: Set<string>;
    };
    const groups: ToolGroup[] = [];
    const targetFile = (call: { arguments?: Record<string, any> }): string | null => {
      const p = call.arguments?.filePath ?? call.arguments?.path;
      return typeof p === "string" && p.trim() !== "" ? p : null;
    };
    for (let i = 0; i < toolCalls.length; i++) {
      const entry = { ...toolCalls[i], index: i };
      const last = groups[groups.length - 1];
      if (READONLY_TOOLS.has(entry.tool)) {
        if (last && last.kind === "read") last.calls.push(entry);
        else groups.push({ kind: "read", calls: [entry] });
      } else if (WRITE_TOOLS.has(entry.tool)) {
        const file = targetFile(entry);
        if (last && last.kind === "write" && file !== null && !last.files!.has(file)) {
          last.calls.push(entry);
          last.files!.add(file);
        } else {
          groups.push({ kind: "write", calls: [entry], files: new Set(file !== null ? [file] : []) });
        }
      } else {
        groups.push({ kind: "exclusive", calls: [entry] });
      }
    }

    const results: { success: boolean; output: string; executed: boolean }[] = Array.from(
      { length: toolCalls.length },
      () => ({ success: false, output: "", executed: false })
    );

    let aborted = false;
    for (const group of groups) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
      if (group.calls.length > 1) {
        // read OR distinct-file write group → run concurrently.
        await Promise.all(group.calls.map(async (call) => {
          const res = await executeTool(call);
          results[call.index] = { ...res, executed: true };
        }));
      } else {
        const call = group.calls[0];
        const res = await executeTool(call);
        results[call.index] = { ...res, executed: true };
      }
    }

    const processAndPushResults = async (indices: number[]) => {
      const resultBlocks: string[] = [];
      for (const idx of indices) {
        const call = toolCalls[idx];
        const res = results[idx];

        ev.onToolResult?.(call.tool, res.success, res.output);

        const minimized = minimizeToolOutput(res.output, call.tool);
        const visible = minimized.text;
        let resultBody = truncateToolOutput(visible);
        if (res.output.length > TOOL_SPILL_THRESHOLD) {
          const artifact = await spillToolResult(call.tool, res.output, cwd).catch(() => null);
          if (artifact) {
            resultBody += `\n[full output (${res.output.length} chars) saved to ${artifact} — read it for the elided middle]`;
          }
        }

        await runPostTurnHooks(
          cwd,
          call.tool,
          call.arguments ?? {},
          res.success,
          res.output,
          opts.signal,
          ev.onNotice
        );

        resultBlocks.push(`Tool [${call.tool}] result (${res.success ? "ok" : "fail"}):\n${resultBody}`);
      }

      history.push({ role: "assistant", content: responseText });
      history.push({
        role: "user",
        content: resultBlocks.join("\n\n"),
      });
    };

    if (aborted) {
      const executedIndices = results.map((r, i) => r.executed ? i : -1).filter(i => i !== -1);
      if (executedIndices.length > 0) {
        await processAndPushResults(executedIndices);
      }
      return finish({ done: false, steps: step, doneReason: "Cancelled." });
    }

    const allIndices = toolCalls.map((_, i) => i);
    await processAndPushResults(allIndices);

    // Score the budget window per CALL, not per batch: a batch of five failing
    // edits plus one trivial successful read must not look like a progressing
    // step to the extension heuristic (that loophole earned endless extensions).
    for (let i = 0; i < toolCalls.length; i++) {
      if (results[i].executed) budget.record(callSigs[i], results[i].success);
    }
    // done-verification guard bookkeeping: write/edit successes mark the turn as
    // mutating; a successful bash whose command/output looks like a test/build run
    // counts as verification. A verification AFTER the last mutation is what the
    // done guard wants, but order-insensitive tracking keeps it one-pushback simple.
    for (let i = 0; i < toolCalls.length; i++) {
      if (!results[i].executed || !results[i].success) continue;
      const t = toolCalls[i].tool;
      if (t === "write" || t === "edit") sawMutation = true;
      else if (t === "bash") {
        const cmd = String(toolCalls[i].arguments?.command ?? "");
        if (VERIFY_SIGNAL_RE.test(cmd) || VERIFY_SIGNAL_RE.test(results[i].output.slice(0, 2000))) sawVerification = true;
      }
    }
    const stepSuccess = results.some(r => r.success);

    if (stepSuccess) {
      consecutiveFailures = 0;
    } else if (++consecutiveFailures >= MAX_FAILURES) {
      const isSingle = toolCalls.length === 1;
      const stopMsg = isSingle
        ? `Stopped: ${MAX_FAILURES} consecutive failing tool calls (last '${toolCalls[0].tool}'); the model could not recover.`
        : `Stopped: ${MAX_FAILURES} consecutive failing tool steps; the model could not recover.`;
      return finish({
        done: false,
        steps: step,
        doneReason: stopMsg,
      });
    }
    step++;
  }

  // Step budget exhausted without `done` (and the retry flow declined a further
  // extension). Instead of dying with a bare "(reached the N-step limit)" error,
  // dynamically CONSOLIDATE: one final no-tools model call summarizes what was
  // accomplished, key findings, and what remains — a useful wrap-up, not a failure.
  const extInfo = budget.extensionsUsed() > 0 ? ` after ${budget.extensionsUsed()} extension(s)` : "";
  const stopInfo = budgetStopReason ? `; ${budgetStopReason}` : "";
  try {
    if (!opts.signal?.aborted) {
      const wrapUp = await invokeCallLlm(
        [
          ...history,
          {
            role: "user",
            content:
              "The step budget for this turn is exhausted. Do NOT call any tool. " +
              "Reply with plain prose (no JSON): consolidate what you accomplished this turn, " +
              "the key findings/changes so far, and what remains to be done next.",
          },
        ],
        { jsonMode: false, model: opts.model, maxTokens: opts.maxTokens, signal: opts.signal },
      );
      const consolidated = wrapUp.trim();
      if (consolidated) {
        history.push({ role: "assistant", content: consolidated });
        return finish({
          done: false,
          steps: budget.limit(),
          doneReason: `${consolidated}\n\n(step budget of ${budget.limit()} reached${extInfo}${stopInfo} — consolidated wrap-up above; continue with a follow-up request)`,
        });
      }
    }
  } catch { /* wrap-up is best-effort; fall through to the plain budget message */ }
  return finish({ done: false, steps: budget.limit(), doneReason: budgetStopReason ? `(step budget of ${budget.limit()} reached${extInfo} — ${budgetStopReason})` : undefined });
}
