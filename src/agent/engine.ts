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
import { readTool, writeTool, editTool, bashTool, findTool, searchTool, lsTool, mkdirTool, deleteTool, type ToolResult } from "./tools";
import { webSearchTool, setWebSearchActiveModel } from "./web-search";
import { friendlyProviderError, isContextOverflowError, isRefusalError } from "../util/provider-error";
import { isRateLimitError } from "../util/retry";
import { runPreToolHooks, runPostTurnHooks } from "./hooks";
import { truncateToolOutput, formatToolResultBody } from "./tool-output";
export { TOOL_OUTPUT_MAX, READ_OUTPUT_MAX, TOOL_SPILL_THRESHOLD, MAX_TOOL_ARTIFACTS, truncateToolOutput, spillToolResult } from "./tool-output";
import { StepBudget, dynamicStepBudgetConfig, resolveStepBudgetConfig, hashSignature, type StepBudgetConfig } from "./step-budget";
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
  onReasoning?: (delta: string) => void;
}): Promise<string> {
  const mod = await import("./loop");
  return mod.callLlm(history, options);
}
export interface ToolInvocation {
  tool: string;
  arguments?: Record<string, any>;
}

export type ToolHandler = (args: Record<string, any>, cwd: string, onProgress?: (partialOutput: string) => void) => Promise<ToolResult>;

/** The default executor toolset (read / write / edit / bash / find / search / ls / mkdir / delete / web_search). */
export const DEFAULT_TOOLS: Record<string, ToolHandler> = {
  read: (a, cwd) => readTool(a.filePath ?? a.path, a.lineRange ?? a.range, cwd, !!a.raw),
  write: (a, cwd) => writeTool(a.filePath ?? a.path, a.content ?? "", cwd),
  edit: (a, cwd) => editTool(a.filePath ?? a.path, a.editBlock ?? a.edit ?? "", cwd),
  bash: (a, cwd, onProgress) => bashTool(a.command ?? a.cmd, cwd, typeof a.timeoutMs === "number" ? a.timeoutMs : undefined, typeof a.cwd === "string" ? a.cwd : (typeof a.subdir === "string" ? a.subdir : undefined), a.env && typeof a.env === "object" ? a.env : undefined, onProgress),
  find: (a, cwd) => findTool(a.globPattern ?? a.pattern, cwd),
  search: (a, cwd) => searchTool(a.pattern, a.globPattern ?? "*", cwd, !!(a.ignoreCase ?? a.i), { before: a.before, after: a.after, context: a.context, maxMatches: a.maxMatches }),
  ls: (a, cwd) => lsTool(a.dirPath ?? a.path ?? a.dir ?? ".", cwd),
  mkdir: (a, cwd) => mkdirTool(a.dirPath ?? a.path ?? a.dir, cwd),
  delete: (a, cwd) => deleteTool(a.path ?? a.filePath ?? a.targetPath ?? a.dirPath, cwd, !!(a.recursive ?? a.r)),
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
  "8. mkdir  {dirPath}                   — create a directory (parents included; idempotent)",
  "9. delete {path, recursive?}          — remove a file (or directory with recursive:true)",
  "10. web_search {query, recency?, limit?} — search the web (Anthropic-native: synthesized answer + sources + citations)",
  "11. done   {reason?}                  — call when the task is fully implemented AND verified",
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
  /** Streaming partial output of the currently-running tool (e.g. bash stdout as it
   *  arrives) — drives a live DIMMED output view that the final formatted result
   *  replaces on onToolResult. Only bash emits today; other tools are unaffected. */
  onToolProgress?(tool: string, partial: string): void;
  /** Transient progress notice (e.g. "rate limited — retrying in Ns"); NOT a terminal error. */
  onNotice?(message: string): void;
  /** Cumulative token usage after each LLM call — drives live usage meters. */
  onUsage?(usage: { inputTokens: number; outputTokens: number }): void;
  /** Accumulated streamed model response so far — drives the live reasoning view. Only
   *  requested when a consumer sets it (the engine streams solely for the TUI). */
  onModelStream?(textSoFar: string): void;
  /** Accumulated native reasoning/thinking text so far — drives a transient dimmed
   *  "thinking" view. Only requested when a consumer (TUI) attaches. */
  onReasoningStream?(textSoFar: string): void;
  /** Step-budget change (gjc-style retry flow): the limit was extended because the
   *  turn is making progress. `limit` is the new max; `reason` is display-ready. */
  onBudget?(limit: number, reason: string): void;
  /** Consulted when a lone `done` arrives. Return a corrective message to bounce
   *  the done ONCE (e.g. "todo list still shows unfinished items — update it
   *  first"); return null to let the turn finish. The engine guarantees at most
   *  one bounce per turn, so a stubborn model can never loop here. */
  onBeforeDone?(reason: string): string | null;
  /** Fired when a mid-turn steering message (an additional user query typed while
   *  the turn is running) is injected into the live history. `text` is the raw
   *  user line — drives a TUI notice so the user sees their input was picked up. */
  onSteer?(text: string): void;
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
  /** Mid-turn steering drain (gjc parity): called at each step boundary. Any strings
   *  returned are appended to `history` as user messages BEFORE the next model call,
   *  so an additional query typed while the turn runs steers the live turn instead of
   *  waiting for the next prompt. Return [] when nothing is pending. */
  steer?: () => string[];
}

export interface AgentLoopResult {
  done: boolean;
  steps: number;
  doneReason?: string;
  /** Summed provider token usage across the turn's steps, when reported. */
  usage?: { inputTokens: number; outputTokens: number };
}


/** Wall-clock budget for ONE agent turn (ms). JEO_TURN_MAX_MS overrides; 0 disables.
 *  Default 30 minutes: long autonomous runs stay alive, while a turn that spins in
 *  "thinking" (huge contexts, endless extensions) is guaranteed to terminate into
 *  the consolidation wrap-up instead of running for hours. */
export function turnMaxMs(env: Record<string, string | undefined> = process.env): number {
  const raw = jeoEnv("TURN_MAX_MS", env);
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  }
  return 30 * 60 * 1000;
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

  // Wall-clock turn budget — the definitive "never sits in thinking forever"
  // guarantee. Step budgets bound the COUNT of model calls; this bounds their total
  // TIME: a turn that crosses it stops at the next loop boundary and consolidates a
  // wrap-up instead of spinning for hours under a generous dynamic step cap.
  const turnStartedAt = Date.now();
  const turnBudgetMs = turnMaxMs();
  // "steps" | "time" — drives honest wording in the consolidation message.
  let stopKind: "steps" | "time" = "steps";
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
  // Caller-owned done gate (onBeforeDone) — also strictly once per turn.
  let beforeDoneNudgeUsed = false;
  // F1 (round 4): the run-command of the most recent post-turn hook FAILURE whose
  // diagnostics the model saw but has not yet resolved (a later clean hook run
  // clears it). The done guard treats this as "verification missing" — the hook
  // exit code is the strongest correctness signal in the loop.
  let pendingHookFailure: string | null = null;
  // Round-6 #4: ONE reactive recovery when the PROVIDER reports context overflow
  // (authoritative where the local estimate drifted — images, tokenizer mismatch).
  let contextOverflowRetryUsed = false;
  // Refusal recovery budget: a safety refusal (HTTP 200, no content) on routine
  // coding work is usually a transient false-positive. Retry the SAME step once
  // as-is, then once more with an explicit re-grounding note; only a third
  // refusal in the turn surfaces the (friendly) error. Bounded per turn so a
  // genuinely refused request can never burn billed calls in a loop.
  const MAX_REFUSAL_RETRIES = 3;
  let refusalRetries = 0;
  const VERIFY_SIGNAL_RE = /\b(test|tests|tsc|typecheck|lint|build|check|spec|pytest|vitest|jest)\b/i;
  let lastSig = "";
  let repeatCount = 0;
  // Cycle guard (the A↔B ping-pong the exact-repeat guard cannot see): the recent
  // executed step signatures, as fixed-size digests. When a full window cycles
  // through ≤2 distinct calls, bounce ONCE with an explicit correction; a spin that
  // persists through the correction stops the turn.
  const CYCLE_WINDOW = 6;
  const recentStepSigs: string[] = [];
  let cycleBounceUsed = false;
  // Invalid-tool-call guard: a model that returns JSON without a usable `tool`
  // field can't drive the loop at all — surface that clearly instead of looping.
  let invalidToolCalls = 0;
  // Prose-bounce guard: after this many invalid-JSON corrections, salvage the
  // model's text as the final answer instead of burning the whole step budget.
  const MAX_PARSE_BOUNCES = 2;
  let parseFailures = 0;
  while (true) {
    if (turnBudgetMs > 0 && Date.now() - turnStartedAt > turnBudgetMs) {
      stopKind = "time";
      budgetStopReason = `turn wall-clock budget of ${Math.round(turnBudgetMs / 60_000)}m exceeded (JEO_TURN_MAX_MS) without done`;
      break;
    }
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

    // MID-TURN steering (gjc parity): drain any additional user queries typed while
    // the turn is running and inject them as user messages BEFORE this step's model
    // call, so the live turn adapts immediately instead of deferring to the next
    // prompt. A genuine new instruction resets the stall/failure guards (it is fresh
    // progress, not a repeat) and earns a budget extension so the loop has room to act.
    if (opts.steer) {
      const pending = opts.steer();
      for (const raw of pending) {
        const text = (raw ?? "").trim();
        if (!text) continue;
        history.push({
          role: "user",
          content: `[mid-turn steering — additional instruction from the user; incorporate it now]\n${text}`,
        });
        ev.onSteer?.(text);
        repeatCount = 0;
        lastSig = "";
        consecutiveFailures = 0;
        recentStepSigs.length = 0;
        budget.noteSteer?.();
      }
    }

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
    let reasonBuf = "";
    const onReasoning = ev.onReasoningStream
      ? (delta: string) => { reasonBuf += delta; ev.onReasoningStream!(reasonBuf); }
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
              onReasoning,
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
      // Reactive context recovery: trim older tool results in place and retry the
      // SAME step once. The provider's overflow signal beats the local estimate;
      // a second overflow (or nothing left to trim) surfaces the friendly error.
      if (isContextOverflowError(err) && !contextOverflowRetryUsed) {
        contextOverflowRetryUsed = true;
        // keepRecent 2 (vs the proactive guard's 8): the provider already REJECTED
        // this prompt — freeing real space beats keeping evidence that can be re-run.
        const res = trimToolResultsInPlace(history, { budgetTokens: Math.max(1, Math.floor(maxHistoryTokens / 2)), keepRecent: 2 });
        if (res.trimmed > 0) {
          ev.onNotice?.(`provider reported context overflow — elided ${res.trimmed} older tool result(s), retrying once`);
          continue; // free retry: the step counter is unchanged
        }
      }
      // Reactive refusal recovery (the "stop_reason=refusal" dead turn). Anthropic's
      // contract: a refusal means the streaming classifier tripped on the CURRENT
      // conversation content, and the context must be RESET before continuing —
      // resending the same prompt keeps refusing deterministically. Ladder:
      //   1) plain resend — covers a transient classifier flake (the OAuth payload
      //      also rotates its per-request user id, which alone can clear a trip);
      //   2) classifier reset — elide tool-result bodies (the usual trigger is
      //      freshly-read file/search content, not the task itself) and append a
      //      NEUTRAL continuation note. The note deliberately never mentions the
      //      safety layer: arguing with the filter reads as a jailbreak attempt
      //      and escalates instead of recovering.
      //   3) guidance strip — with tool results already gone, the remaining
      //      classifier-trigger candidate is the repo-authored prose injected
      //      into the SYSTEM prompt (<project_context> — AGENTS.md / rules can
      //      contain text that trips content filters even though the task is
      //      routine). Strip that block for the rest of the turn and retry once;
      //      core instructions stay intact. Field case: `$gjc init` inside a
      //      repo whose guidance files refuse-trip the OAuth classifier.
      if (isRefusalError(err) && refusalRetries < MAX_REFUSAL_RETRIES) {
        refusalRetries++;
        if (refusalRetries === 1) {
          ev.onNotice?.("provider refused the last call (no content) — retrying the same step");
          continue; // free resend: the step counter is unchanged
        }
        if (refusalRetries === 2) {
          const res = trimToolResultsInPlace(history, { budgetTokens: 0, keepRecent: 0 });
          ev.onNotice?.(
            res.trimmed > 0
              ? `provider refused again — reset ${res.trimmed} tool result(s) from the context and retrying (refusals require a context reset)`
              : "provider refused again — continuing with a fresh instruction",
          );
          history.push({
            role: "user",
            content:
              "(continuation) The previous response returned no content and older tool outputs were elided from this conversation. " +
              "Re-assess the task from the remaining context and reply with exactly one JSON tool call " +
              '{"tool":"<name>","arguments":{...}} — re-run any tool whose output you still need, ' +
              'or send {"tool":"done","arguments":{"reason":"<summary>"}} if the task is finished.',
          });
          step++;
          continue;
        }
        const sys = history[0];
        if (sys?.role === "system" && sys.content.includes("<project_context>")) {
          const stripped = sys.content.replace(/\n*<project_context>[\s\S]*?<\/project_context>/, "").trimEnd();
          history[0] = { ...sys, content: stripped }; // replace, never mutate (identity caches)
          ev.onNotice?.("provider refused a third time — removed project-context guidance from the system prompt and retrying once more");
          continue; // same step, reduced system prompt
        }
        // Nothing left to strip — fall through to the friendly terminal error
        // instead of burning an identical billed call.
      }
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
      if (sawMutation && (!sawVerification || pendingHookFailure !== null) && !donePushbackUsed) {
        donePushbackUsed = true; // second done always passes — escape hatch
        history.push({ role: "assistant", content: responseText });
        history.push({
          role: "user",
          content: pendingHookFailure !== null
            ? `Your latest mutation left the post-turn hook "${pendingHookFailure}" FAILING (non-zero exit) — its diagnostics were shown in the tool result above. ` +
              "Fix the reported problems (the hook re-runs on your next mutation), then call done. " +
              "If the hook failure is a false positive, call done again and say why in the reason."
            : "You modified files this turn but ran NO verification (no test/build/typecheck command succeeded). " +
              "Run the narrowest command that proves your change works, then call done. " +
              "If verification is genuinely not applicable (docs/config-only change), call done again and say why in the reason.",
        });
        step++;
        continue;
      }
      // Caller-owned done gate (e.g. stale-todo reconciliation): ONE bounded
      // bounce, then any later done passes — field case: a 28-step turn ended
      // [DONE] with the Todos checklist still showing 1 in-progress + 4 pending
      // because nothing ever forced a status update.
      if (!beforeDoneNudgeUsed && ev.onBeforeDone) {
        const nudge = ev.onBeforeDone((toolCalls[0].arguments?.reason as string) ?? "");
        if (nudge) {
          beforeDoneNudgeUsed = true;
          history.push({ role: "assistant", content: responseText });
          history.push({ role: "user", content: nudge });
          ev.onNotice?.("done deferred once — final plan reconciliation requested");
          step++;
          continue;
        }
      }
      // Steering that arrived DURING this final step (after the top-of-loop drain,
      // while the model was generating its `done`): reopen the turn and handle it now
      // instead of letting it bounce to the next prompt. Bounded by the step/time budget.
      if (opts.steer) {
        const pending = opts.steer().map(s => (s ?? "").trim()).filter(Boolean);
        if (pending.length) {
          history.push({ role: "assistant", content: responseText });
          for (const text of pending) {
            history.push({
              role: "user",
              content: `[mid-turn steering — additional instruction from the user; incorporate it now before finishing]\n${text}`,
            });
            ev.onSteer?.(text);
          }
          repeatCount = 0;
          lastSig = "";
          consecutiveFailures = 0;
          recentStepSigs.length = 0;
          budget.noteSteer();
          step++;
          continue;
        }
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
    // Fixed-size digest of the whole step — `write` signatures embed entire file
    // bodies, so the repeat/cycle guards compare digests, not megabyte strings.
    const sig = hashSignature(callSigs.join(" | "));
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

    // Cycle guard: an A↔B (or A↔B↔C-minus-one) alternation never trips the
    // exact-repeat guard above — each step differs from its immediate predecessor —
    // yet it is the same spin (field case: re-reading one file and re-running one
    // command forever, "thinking" never ends). Detect a full recent window that
    // cycles through ≤2 distinct step signatures: ONE corrective bounce (skip
    // execution — a repeated mutating call must not run again merely to be
    // detected), then stop if the spin survives the explicit correction.
    recentStepSigs.push(sig);
    if (recentStepSigs.length > CYCLE_WINDOW) recentStepSigs.shift();
    if (recentStepSigs.length === CYCLE_WINDOW && new Set(recentStepSigs).size <= 2) {
      if (!cycleBounceUsed) {
        cycleBounceUsed = true;
        recentStepSigs.length = 0; // fresh window: the correction earns a real retry
        history.push({ role: "assistant", content: responseText });
        history.push({
          role: "user",
          content:
            `You are cycling through the same ${new Set(callSigs).size <= 1 ? "tool call" : "tool calls"} you already ran in recent steps — this call was NOT re-executed and its result has not changed. ` +
            `If the task is complete, reply {"tool":"done","arguments":{"reason":"<summary of what was accomplished>"}}; ` +
            `otherwise take a genuinely DIFFERENT next action (a new file, a new command, or a fix you have not tried).`,
        });
        ev.onNotice?.("tool-call cycle detected — skipped execution and asked the model to act differently or call done");
        step++;
        continue;
      }
      return finish({
        done: false,
        steps: step,
        doneReason: `Stopped: the model cycled through the same tool calls for ${CYCLE_WINDOW} consecutive steps even after an explicit correction (it never signaled done).`,
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
              const onProgress = ev.onToolProgress ? (partial: string) => ev.onToolProgress!(tool, partial) : undefined;
              const res = await handler(args ?? {}, cwd, onProgress);
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
    // Dedup key = RESOLVED, case-folded path (F3): `./x.ts` vs `x.ts` vs
    // `src/../x.ts` — and case variants on the (default case-insensitive) macOS
    // FS — must collapse to ONE key, or two spellings of the same file run in
    // parallel and the second write silently clobbers the first. Folding case on
    // a case-sensitive FS merely serializes two genuinely-distinct files — safe.
    const targetFile = (call: { arguments?: Record<string, any> }): string | null => {
      const p = call.arguments?.filePath ?? call.arguments?.path;
      return typeof p === "string" && p.trim() !== "" ? path.resolve(cwd, p).toLowerCase() : null;
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
      // Per-batch dedup of post-turn hook diagnostics: a whole-project `tsc` hook
      // matching every edit in a batch yields identical output N times — show it
      // once, cross-reference the rest (cycle 13).
      const seenHookFeedback = new Set<string>();
      for (const idx of indices) {
        const call = toolCalls[idx];
        const res = results[idx];

        ev.onToolResult?.(call.tool, res.success, res.output);

        const resultBody = await formatToolResultBody(call.tool, res.output, cwd);

        const { diags: hookDiags, ran: hooksRan } = await runPostTurnHooks(
          cwd,
          call.tool,
          call.arguments ?? {},
          res.success,
          res.output,
          opts.signal,
          ev.onNotice
        );
        // F1: a red hook becomes a pending failure the done guard enforces; a
        // later hook run that completes CLEAN (ran > 0, zero diags) clears it.
        if (hookDiags.length > 0) pendingHookFailure = hookDiags[hookDiags.length - 1].run;
        else if (hooksRan > 0) pendingHookFailure = null;

        // Append non-zero-exit hook diagnostics to THIS tool's result block so the
        // model can self-correct. The tool's own ok/fail is unchanged (guard).
        let resultBlock = `Tool [${call.tool}] result (${res.success ? "ok" : "fail"}):\n${resultBody}`;
        for (const d of hookDiags) {
          const key = `${d.run}\u0000${d.output}`;
          if (seenHookFeedback.has(key)) {
            resultBlock += `\n[post-turn hook "${d.run}" — exit ${d.exitCode}: same diagnostics as above]`;
          } else {
            seenHookFeedback.add(key);
            resultBlock += `\n[post-turn hook "${d.run}" — exit ${d.exitCode}]:\n${truncateToolOutput(d.output)}`;
          }
        }
        resultBlocks.push(resultBlock);
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
    // F6 (round 4 architect, Low): judge the step by its NON-TRIVIAL calls — a
    // batch of read(ok)+edit(fail) repeated with varying targets previously
    // never tripped MAX_FAILURES because the trivial read reset the streak.
    // Read-only-only steps keep the old any-success rule.
    const nonTrivial = toolCalls
      .map((c, i) => ({ tool: c.tool, r: results[i] }))
      .filter(x => !READONLY_TOOLS.has(x.tool) && x.r.executed);
    const stepSuccess = nonTrivial.length > 0
      ? nonTrivial.some(x => x.r.success)
      : results.some(r => r.success);

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

  // Budget exhausted without `done` (step limit declined a further extension, or
  // the turn wall-clock budget fired). Instead of dying with a bare limit error,
  // dynamically CONSOLIDATE: one final no-tools model call summarizes what was
  // accomplished, key findings, and what remains — a useful wrap-up, not a failure.
  const extInfo = budget.extensionsUsed() > 0 ? ` after ${budget.extensionsUsed()} extension(s)` : "";
  const stopInfo = budgetStopReason ? `; ${budgetStopReason}` : "";
  const budgetLabel = stopKind === "time"
    ? `turn time budget of ${Math.round(turnBudgetMs / 60_000)}m reached`
    : `step budget of ${budget.limit()} reached`;
  try {
    if (!opts.signal?.aborted) {
      const wrapUp = await invokeCallLlm(
        [
          ...history,
          {
            role: "user",
            content:
              "The budget for this turn is exhausted. Do NOT call any tool. " +
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
          doneReason: `${consolidated}\n\n(${budgetLabel}${extInfo}${stopInfo} — consolidated wrap-up above; continue with a follow-up request)`,
        });
      }
    }
  } catch { /* wrap-up is best-effort; fall through to the plain budget message */ }
  return finish({ done: false, steps: stopKind === "time" ? step : budget.limit(), doneReason: budgetStopReason ? `(${budgetLabel}${extInfo} — ${budgetStopReason})` : undefined });
}
