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
  bash: (a, cwd) => bashTool(a.command ?? a.cmd, cwd),
  find: (a, cwd) => findTool(a.globPattern ?? a.pattern, cwd),
  search: (a, cwd) => searchTool(a.pattern, a.globPattern ?? "*", cwd),
};

/** Tool-protocol description injected into the system prompt. */
export const TOOL_PROTOCOL = [
  "You have these tools (call exactly ONE per step):",
  "1. read   {filePath, lineRange?}      — read a file (optional \"start-end\")",
  "2. write  {filePath, content}         — create/overwrite a file",
  "3. edit   {filePath, editBlock}       — replace a line range: \u2254[line]..[line]\\n<new text>",
  "4. bash   {command}                   — run a shell command (tests, build, mkdir, ...)",
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
  events?: AgentLoopEvents;
}

export interface AgentLoopResult {
  done: boolean;
  steps: number;
  doneReason?: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
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
  while (step <= maxSteps) {
    ev.onStep?.(step);

    let responseText: string;
    try {
      responseText = await callLlm(history, { jsonMode: true, model: opts.model });
    } catch (err) {
      ev.onError?.((err as Error).message);
      return { done: false, steps: step };
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
      return { done: true, steps: step, doneReason: (invocation.arguments?.reason as string) ?? "" };
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
      content: `Tool [${invocation.tool}] result (${success ? "ok" : "fail"}):\n${truncate(output, 4000)}`,
    });
    step++;
  }

  return { done: false, steps: maxSteps };
}
