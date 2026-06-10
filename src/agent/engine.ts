import type { Message, CallLlmOptions } from "./loop";
import { extractJsonObject } from "./json";
import type { ToolResult } from "./tools";
import { friendlyProviderError } from "../util/provider-error";
import { isRateLimitError } from "../util/retry";
import { runPreToolHooks, runPostTurnHooks } from "./hooks";
import { truncateToolOutput, spillToolResult, TOOL_SPILL_THRESHOLD, logPerformanceMetric, loadSpecKitContext } from "./output-util";
import { DEFAULT_TOOLS, TOOL_PROTOCOL, READONLY_TOOL_PROTOCOL, type ToolHandler, nearestToolName } from "./tool-registry";

export { truncateToolOutput, spillToolResult, TOOL_SPILL_THRESHOLD };

async function invokeCallLlm(history: Message[], options: CallLlmOptions): Promise<string> {
  const mod = await import("./loop");
  return mod.callLlm(history, options);
}

export interface ToolInvocation {
  tool: string;
  arguments?: Record<string, any>;
}

export function executorSystemPrompt(
  role = "Executor Agent, a senior software developer",
  protocol: string = TOOL_PROTOCOL,
  verificationDirective = "Always verify before calling done.",
): string {
  return "You are the " + role + ".\nAccomplish the user's request by calling tools and verifying your work.\n\n" + protocol + "\n\n" + verificationDirective;
}

export interface AgentLoopEvents {
  onStep?(step: number): void | Promise<void>;
  onAssistant?(raw: string, invocation: ToolInvocation | null): void;
  onToolResult?(tool: string, success: boolean, output: string): void;
  onNotice?(message: string): void;
  onUsage?(usage: { inputTokens: number; outputTokens: number }): void;
}

export interface AgentLoopOptions {
  systemPrompt?: string;
  cwd: string;
  maxSteps?: number;
  model?: string;
  maxTokens?: number;
  tools?: Record<string, ToolHandler>;
  signal?: AbortSignal;
  events?: AgentLoopEvents;
}

export interface AgentLoopResult {
  done: boolean;
  steps: number;
  doneReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export async function runAgentLoop(history: Message[], opts: AgentLoopOptions) {
  const specKitContext = await loadSpecKitContext(opts.cwd);
  if (specKitContext) opts.systemPrompt = (opts.systemPrompt || "") + specKitContext;

  const { cwd } = opts;
  const tools = opts.tools ?? DEFAULT_TOOLS;
  const maxSteps = opts.maxSteps ?? 15;
  const ev = opts.events ?? {};

  let step = 1;
  const acc = { inputTokens: 0, outputTokens: 0 };
  let sawUsage = false;
  const finish = (r: AgentLoopResult): AgentLoopResult => (sawUsage ? { ...r, usage: { ...acc } } : r);
  const MAX_REPEAT = 3;
  const MAX_FAILURES = 5;
  let consecutiveFailures = 0;
  let lastSig = "";
  let repeatCount = 0;
  let invalidToolCalls = 0;
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
              onRetry: (attempt, err, delayMs) => {
                const wait = Math.max(1, Math.round(delayMs / 1000));
                const what = isRateLimitError(err) ? "rate limited" : "transient error";
                ev.onNotice?.(what + " — retry #" + attempt + " in " + wait + "s");
              },
            });
    } catch (err) {
      const message = friendlyProviderError(err);
      return finish({ done: false, steps: step, doneReason: "Error: " + message });
    }
    if (sawUsage) ev.onUsage?.({ ...acc });

    let invocation: ToolInvocation;
    try {
      invocation = extractJsonObject<ToolInvocation>(responseText);
    } catch (err) {
      ev.onAssistant?.(responseText, null);
      const trimmed = responseText.trim();
      parseFailures++;
      if (trimmed && (!trimmed.includes("{") || parseFailures > MAX_PARSE_BOUNCES)) {
        history.push({ role: "assistant", content: responseText });
        return finish({ done: true, steps: step, doneReason: trimmed });
      }
      history.push({ role: "assistant", content: responseText });
      history.push({
        role: "user",
        content: "Your last reply was not a valid tool call.",
      });
      step++;
      continue;
    }

    ev.onAssistant?.(responseText, invocation);

    const toolName = typeof invocation?.tool === "string" ? invocation.tool.trim() : "";
    if (!toolName) {
      invalidToolCalls++;
      if (invalidToolCalls >= MAX_REPEAT) {
        return finish({ done: false, steps: step, doneReason: "Stopped: no valid tool call." });
      }
      history.push({ role: "assistant", content: responseText });
      history.push({ role: "user", content: "No \"tool\" field." });
      step++;
      continue;
    }
    invalidToolCalls = 0;

    if (invocation.tool === "done") {
      return finish({ done: true, steps: step, doneReason: (invocation.arguments?.reason as string) ?? "" });
    }

    const sig = invocation.tool + ":" + JSON.stringify(invocation.arguments ?? {});
    if (sig === lastSig) repeatCount++;
    else { repeatCount = 1; lastSig = sig; }
    if (repeatCount >= MAX_REPEAT) {
      return finish({ done: false, steps: step, doneReason: "Stopped: repeated tool call." });
    }

    const handler = tools[invocation.tool];
    let success: boolean;
    let output: string;
    const startTime = Date.now();
    if (!handler) {
      success = false;
      const suggestion = nearestToolName(invocation.tool, Object.keys(tools));
      const hint = suggestion ? " Did you mean \"" + suggestion + "\"?" : "";
      output = "Unknown tool: " + invocation.tool + "." + hint;
    } else {
      const preHookResult = await runPreToolHooks(cwd, invocation.tool, invocation.arguments ?? {}, opts.signal, ev.onNotice);
      if (preHookResult.vetoed) {
        success = false;
        output = preHookResult.error + (preHookResult.output ? "\n" + preHookResult.output : "");
      } else {
        const res = await handler(invocation.arguments ?? {}, cwd);
        success = res.success;
        output = res.success ? res.output : (res.error ? (res.output ? res.error + "\n" + res.output : res.error) : res.output);
      }
    }
    const duration = Date.now() - startTime;
    await logPerformanceMetric(cwd, { tool: invocation.tool, duration, success });

    ev.onToolResult?.(invocation.tool, success, output);
    history.push({ role: "assistant", content: responseText });
    let resultBody = truncateToolOutput(output);
    if (output.length > TOOL_SPILL_THRESHOLD) {
      const artifact = await spillToolResult(invocation.tool, output, cwd).catch(() => null);
      if (artifact) resultBody += "\n[full output saved to " + artifact + "]";
    }
    history.push({
      role: "user",
      content: "Tool [" + invocation.tool + "] result (" + (success ? "ok" : "fail") + "):\n" + resultBody,
    });

    await runPostTurnHooks(cwd, invocation.tool, invocation.arguments ?? {}, success, output, opts.signal, ev.onNotice);

    if (success) {
      consecutiveFailures = 0;
    } else if (++consecutiveFailures >= MAX_FAILURES) {
      return finish({ done: false, steps: step, doneReason: "Stopped: consecutive failures." });
    }
    step++;
  }

  return finish({ done: false, steps: maxSteps });
}
