/**
 * Reusable agentic tool-call loop — the shared core behind `joc team`
 * (per-task executor) and `joc launch` (interactive coding agent).
 *
 * The model is driven in JSON tool-call mode: each step it emits exactly one
 * `{ "tool": "...", "arguments": { ... } }` object; the engine dispatches it,
 * appends the result to history, and continues until the model calls `done`
 * or the step budget is exhausted.
 */
import { callLlm, type Message } from "./loop";
import { extractJsonObject } from "./json";
import { readTool, writeTool, editTool, bashTool, findTool, searchTool, type ToolResult } from "./tools";

export interface ToolInvocation {
  tool: string;
  arguments?: Record<string, any>;
}

export type ToolHandler = (args: Record<string, any>, cwd: string) => Promise<ToolResult>;

/** The default executor toolset (read / write / edit / bash / find / search). */
export const DEFAULT_TOOLS: Record<string, ToolHandler> = {
  read: (a, cwd) => readTool(a.filePath ?? a.path, a.lineRange, cwd),
  write: (a, cwd) => writeTool(a.filePath ?? a.path, a.content ?? "", cwd),
  edit: (a, cwd) => editTool(a.filePath ?? a.path, a.editBlock ?? a.edit ?? "", cwd),
  bash: (a, cwd) => bashTool(a.command ?? a.cmd, cwd, typeof a.timeoutMs === "number" ? a.timeoutMs : undefined),
  find: (a, cwd) => findTool(a.globPattern ?? a.pattern, cwd),
  search: (a, cwd) => searchTool(a.pattern, a.globPattern ?? "*", cwd),
};

/** Tool-protocol description injected into the system prompt. */
export const TOOL_PROTOCOL = [
  "You have these tools (call exactly ONE per step):",
  "1. read   {filePath, lineRange?}      — read a file (lineRange: \"start-end\", \"start-\", or \"start\")",
  "2. write  {filePath, content}         — create/overwrite a file",
  "3. edit   {filePath, editBlock}       — ≔A..B replace lines; ≔A+ insert after line A; ≔$ append EOF (payload on next line)",
  "4. bash   {command, timeoutMs?}       — run a shell command (tests, build, mkdir, ...); timeoutMs default 120000",
  "5. find   {globPattern}               — find files by name",
  "6. search {pattern, globPattern?}     — grep for a pattern",
  "7. done   {reason?}                   — call when the task is fully implemented AND verified",
  "",
  "Reply with STRICT JSON only — no prose, no code fences:",
  '{ "tool": "<name>", "arguments": { ... } }',
].join("\n");

export function executorSystemPrompt(role = "Executor Agent, a senior software developer"): string {
  return (
    `You are the ${role}.\n` +
    `Accomplish the user's request by calling tools and verifying your work.\n\n` +
    `${TOOL_PROTOCOL}\n\n` +
    `Always verify (run tests / execute the program) before calling done.`
  );
}

export interface AgentLoopEvents {
  onStep?(step: number): void;
  onAssistant?(raw: string, invocation: ToolInvocation | null): void;
  onToolResult?(tool: string, success: boolean, output: string): void;
  onError?(message: string): void;
}

export interface AgentLoopOptions {
  cwd: string;
  maxSteps?: number;
  model?: string;
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

/**
 * Drive `history` through the tool-call loop, mutating it in place so callers
 * (e.g. an interactive REPL) can keep the conversation across multiple turns.
 */
export async function runAgentLoop(history: Message[], opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const { cwd } = opts;
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
  while (step <= maxSteps) {
    if (opts.signal?.aborted) {
      return finish({ done: false, steps: step - 1, doneReason: "Cancelled." });
    }
    ev.onStep?.(step);

    let responseText: string;
    try {
      responseText = await callLlm(history, {
        jsonMode: true,
        model: opts.model,
        signal: opts.signal,
        onUsage: u => { acc.inputTokens += u.inputTokens ?? 0; acc.outputTokens += u.outputTokens ?? 0; sawUsage = true; },
      });
    } catch (err) {
      const message = (err as Error).message;
      ev.onError?.(message);
      // Surface the real cause so callers don't print a misleading "step limit" message.
      return finish({ done: false, steps: step, doneReason: `Error: ${message}` });
    }

    let invocation: ToolInvocation;
    try {
      invocation = extractJsonObject<ToolInvocation>(responseText);
    } catch (err) {
      // Not valid tool-call JSON — show the model the error and let it retry.
      ev.onAssistant?.(responseText, null);
      history.push({ role: "assistant", content: responseText });
      history.push({
        role: "user",
        content:
          `Your last reply was not a valid tool call (${(err as Error).message}). ` +
          `Reply with exactly one JSON object: {"tool":"<name>","arguments":{...}}.`,
      });
      step++;
      continue;
    }

    ev.onAssistant?.(responseText, invocation);

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
      output = `Unknown tool: ${invocation.tool}. Available: ${Object.keys(tools).join(", ")}, done.`;
    } else {
      const res = await handler(invocation.arguments ?? {}, cwd);
      success = res.success;
      output = res.success ? res.output : (res.error ? (res.output ? `${res.error}\n${res.output}` : res.error) : res.output);
    }

    ev.onToolResult?.(invocation.tool, success, output);
    history.push({ role: "assistant", content: responseText });
    history.push({
      role: "user",
      content: `Tool [${invocation.tool}] result (${success ? "ok" : "fail"}):\n${truncateToolOutput(output)}`,
    });

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
