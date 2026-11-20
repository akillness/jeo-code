/**
 * GoalFlow Stream Processor and Data Adapters
 * Pure TypeScript, zero native dependencies.
 */

import { createThinkSplitter } from "../../ai/think-tags";
import type {
  InterruptPayload,
  RunStatus,
  SemanticEvent,
  StreamTuple,
} from "./types";

export interface DataAdapter {
  generate(events: AsyncIterable<SemanticEvent>): AsyncIterable<string>;
  execute(events: AsyncIterable<SemanticEvent>): Promise<Record<string, unknown>>;
}

/**
 * StreamProcessor consumes raw StreamTuples from the workflow,
 * separates inline <think>...</think> reasoning deltas safely across chunk boundaries,
 * and yields clean protocol-neutral SemanticEvents.
 */
export class StreamProcessor {
  async *process(stream: AsyncIterable<StreamTuple>): AsyncGenerator<SemanticEvent> {
    let runId = "unknown";
    let lastNodeId = "unknown";
    let lastTimestamp = Date.now();
    const reasoningQueue: string[] = [];
    const splitter = createThinkSplitter((delta) => {
      if (delta) reasoningQueue.push(delta);
    });

    for await (const tuple of stream) {
      lastNodeId = tuple.nodeId;
      lastTimestamp = tuple.timestamp;

      if (tuple.mode === "custom") {
        const data = tuple.data as Record<string, unknown>;
        if (data && typeof data.type === "string") {
          if (data.runId && typeof data.runId === "string") {
            runId = data.runId;
          }
          if (data.type === "workflow_finished") {
            const trailing = splitter.flush();
            while (reasoningQueue.length > 0) {
              yield {
                type: "reasoning_chunk",
                runId,
                nodeId: lastNodeId,
                reasoning: reasoningQueue.shift()!,
                timestamp: tuple.timestamp,
              };
            }
            if (trailing) {
              yield {
                type: "text_chunk",
                runId,
                nodeId: lastNodeId,
                text: trailing,
                timestamp: tuple.timestamp,
              };
            }
          }
          yield data as unknown as SemanticEvent;
          continue;
        }
      }

      if (tuple.mode === "messages") {
        const raw = tuple.data;
        let textContent = "";

        if (typeof raw === "string") {
          textContent = raw;
        } else if (raw && typeof raw === "object") {
          const obj = raw as Record<string, unknown>;
          if (obj.type === "reasoning_chunk" && typeof obj.reasoning === "string") {
            yield {
              type: "reasoning_chunk",
              runId: typeof obj.runId === "string" ? obj.runId : runId,
              nodeId: tuple.nodeId,
              reasoning: obj.reasoning,
              timestamp: tuple.timestamp,
            };
            continue;
          }
          if (obj.type === "text_chunk" && typeof obj.text === "string") {
            textContent = obj.text;
          } else if (typeof obj.text === "string") {
            textContent = obj.text;
          } else if (obj.type === "tool_call" || obj.type === "tool_result") {
            yield obj as unknown as SemanticEvent;
            continue;
          }
        }

        if (textContent) {
          const visible = splitter.push(textContent);
          while (reasoningQueue.length > 0) {
            yield {
              type: "reasoning_chunk",
              runId,
              nodeId: tuple.nodeId,
              reasoning: reasoningQueue.shift()!,
              timestamp: tuple.timestamp,
            };
          }
          if (visible) {
            yield {
              type: "text_chunk",
              runId,
              nodeId: tuple.nodeId,
              text: visible,
              timestamp: tuple.timestamp,
            };
          }
        }
      }

      if (tuple.mode === "updates") {
        yield {
          type: "control",
          runId,
          action: "state_update",
          details: { nodeId: tuple.nodeId, data: tuple.data },
          timestamp: tuple.timestamp,
        };
      }
    }

    const trailing = splitter.flush();
    while (reasoningQueue.length > 0) {
      yield {
        type: "reasoning_chunk",
        runId,
        nodeId: lastNodeId,
        reasoning: reasoningQueue.shift()!,
        timestamp: lastTimestamp,
      };
    }
    if (trailing) {
      yield {
        type: "text_chunk",
        runId,
        nodeId: lastNodeId,
        text: trailing,
        timestamp: lastTimestamp,
      };
    }
  }
}

export interface OpenAIDataAdapterOptions {
  model?: string;
}

/**
 * OpenAIDataAdapter formats SemanticEvents into:
 * 1. OpenAI-compatible chat.completion.chunk SSE frames (data: {...}\n\n + data: [DONE]\n\n)
 * 2. OpenAI chat.completion blocking JSON with x_goalflow run/interrupt metadata
 */
export class OpenAIDataAdapter implements DataAdapter {
  readonly model: string;

  constructor(opts?: OpenAIDataAdapterOptions) {
    this.model = opts?.model?.trim() || "goalflow-jeo";
  }

  async *generate(events: AsyncIterable<SemanticEvent>): AsyncIterable<string> {
    let runId = "goalflow";
    let toolCallIdx = 0;

    for await (const ev of events) {
      if (ev.runId) runId = ev.runId;
      const created = Math.floor(ev.timestamp / 1000);

      if (ev.type === "text_chunk") {
        const chunk = {
          id: `chatcmpl-${runId}`,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [
            {
              index: 0,
              delta: { content: ev.text },
              finish_reason: null,
            },
          ],
        };
        yield `data: ${JSON.stringify(chunk)}\n\n`;
      } else if (ev.type === "reasoning_chunk") {
        const chunk = {
          id: `chatcmpl-${runId}`,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: ev.reasoning },
              finish_reason: null,
            },
          ],
        };
        yield `data: ${JSON.stringify(chunk)}\n\n`;
      } else if (ev.type === "tool_call") {
        const chunk = {
          id: `chatcmpl-${runId}`,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolCallIdx++,
                    id: ev.callId ?? `call_${toolCallIdx}`,
                    type: "function",
                    function: {
                      name: ev.tool,
                      arguments: JSON.stringify(ev.args),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        yield `data: ${JSON.stringify(chunk)}\n\n`;
      } else if (ev.type === "interrupt") {
        const chunk = {
          id: `chatcmpl-${runId}`,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          x_goalflow: {
            status: "interrupted",
            interrupt: ev.payload,
          },
        };
        yield `data: ${JSON.stringify(chunk)}\n\n`;
      } else if (ev.type === "workflow_finished") {
        const chunk = {
          id: `chatcmpl-${runId}`,
          object: "chat.completion.chunk",
          created,
          model: this.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason:
                ev.status === "completed" || ev.status === "interrupted" ? "stop" : "error",
            },
          ],
        };
        yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
    }

    yield "data: [DONE]\n\n";
  }

  async execute(events: AsyncIterable<SemanticEvent>): Promise<Record<string, unknown>> {
    let runId = "goalflow";
    let fullContent = "";
    let fullReasoning = "";
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    let status: RunStatus = "completed";
    let pendingInterrupt: InterruptPayload | undefined;
    let finishReason = "stop";
    let reportedPromptTokens = 0;
    let reportedCompletionTokens = 0;

    for await (const ev of events) {
      if (ev.runId) runId = ev.runId;

      if (ev.type === "text_chunk") {
        fullContent += ev.text;
      } else if (ev.type === "reasoning_chunk") {
        fullReasoning += ev.reasoning;
      } else if (ev.type === "tool_call") {
        toolCalls.push({
          id: ev.callId ?? `call_${toolCalls.length}`,
          type: "function",
          function: {
            name: ev.tool,
            arguments: JSON.stringify(ev.args),
          },
        });
      } else if (ev.type === "node_finished" && ev.output && typeof ev.output === "object") {
        const usage = (ev.output as { loopResult?: { usage?: { inputTokens?: number; outputTokens?: number } } }).loopResult?.usage;
        if (usage) {
          reportedPromptTokens += usage.inputTokens ?? 0;
          reportedCompletionTokens += usage.outputTokens ?? 0;
        }
      } else if (ev.type === "interrupt") {
        status = "interrupted";
        pendingInterrupt = ev.payload;
        finishReason = "stop";
      } else if (ev.type === "workflow_finished") {
        status = ev.status;
        finishReason = ev.status === "failed" ? "error" : "stop";
        if (!fullContent && typeof ev.output === "string") {
          fullContent = ev.output;
        }
      }
    }

    const promptTokens = reportedPromptTokens > 0 ? reportedPromptTokens : Math.max(1, Math.ceil((fullContent.length + fullReasoning.length) / 8));
    const completionTokens = reportedCompletionTokens > 0 ? reportedCompletionTokens : Math.ceil((fullContent.length + fullReasoning.length) / 4);

    return {
      id: `chatcmpl-${runId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: fullContent,
            ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      x_goalflow: {
        runId,
        status,
        interrupted: status === "interrupted",
        ...(pendingInterrupt ? { interruptPayload: pendingInterrupt } : {}),
      },
    };
  }
}

/**
 * GoalFlowDataAdapter formats SemanticEvents into:
 * 1. GoalFlow SSE frames (event: <type>\ndata: <json>\n\n)
 * 2. Structured Run JSON summary
 */
export class GoalFlowDataAdapter implements DataAdapter {
  async *generate(events: AsyncIterable<SemanticEvent>): AsyncIterable<string> {
    for await (const ev of events) {
      yield `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
    }
  }

  async execute(events: AsyncIterable<SemanticEvent>): Promise<Record<string, unknown>> {
    let runId = "unknown";
    let status: RunStatus = "completed";
    let costMs = 0;
    let output: unknown;
    let pendingInterrupt: InterruptPayload | undefined;
    let error: string | undefined;
    const nodeOutputs: Record<string, unknown> = {};
    const eventsList: SemanticEvent[] = [];
    const textChunks: string[] = [];

    for await (const ev of events) {
      eventsList.push(ev);
      if (ev.runId) runId = ev.runId;

      if (ev.type === "text_chunk") {
        textChunks.push(ev.text);
      } else if (ev.type === "node_finished") {
        nodeOutputs[ev.nodeId] = ev.output;
      } else if (ev.type === "interrupt") {
        status = "interrupted";
        pendingInterrupt = ev.payload;
      } else if (ev.type === "error") {
        error = ev.error;
      } else if (ev.type === "workflow_finished") {
        status = ev.status;
        costMs = ev.costMs;
        output = ev.output;
      }
    }

    const resolvedOutput =
      output !== undefined
        ? output
        : textChunks.length > 0
          ? textChunks.join("")
          : undefined;

    return {
      runId,
      status,
      costMs,
      output: resolvedOutput,
      nodeOutputs,
      events: eventsList,
      ...(pendingInterrupt ? { pendingInterrupt } : {}),
      ...(error ? { error } : {}),
    };
  }
}
