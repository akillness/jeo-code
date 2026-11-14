import { createModelManager, type Message as AiMessage } from "../ai";
import type { CallOptions, NativeToolSchema, ReasoningArtifact, Usage } from "../ai/types";

export type Message = AiMessage;

/** Back-compat alias: engine and callers import the call options under this name. */
export type CallLlmOptions = ChatOptions;

export interface ChatOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Provider reasoning depth (mapped from the live session thinking level). */
  reasoningEffort?: CallOptions["reasoningEffort"];
  jsonMode?: boolean;
  signal?: AbortSignal;
  onUsage?: (usage: Usage) => void;
  /** Notified before each provider auto-retry backoff wait (e.g. rate limits). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void | false;
  /** Optional status notice sink (e.g. account pool failover notices). */
  onNotice?: (message: string) => void;
  /** When set, the response is consumed via the provider STREAM and each text delta is delivered here. */
  onToken?: (delta: string) => void;
  /** Streaming sink for native reasoning/thinking deltas (drives the dimmed live view). */
  onReasoning?: (delta: string) => void;
  /** Streaming sink for provider-native reasoning ARTIFACTS. */
  onReasoningArtifact?: (artifact: ReasoningArtifact) => void;
  /** NATIVE tool-calling function declarations (forwarded to capable adapters). */
  tools?: NativeToolSchema[];
  /** Stable per-conversation key (session id) for provider-side prompt caching. */
  sessionKey?: string;
}

const manager = createModelManager();

export async function callLlm(
  messages: Message[],
  options: ChatOptions = {}
): Promise<string> {
  if (!options.onToken) return manager.call(messages, options);
  // Streaming path: accumulate the full text (still parsed as one JSON tool call by the
  // engine) while emitting deltas for the live reasoning view. A throwing consumer must
  // never abort the turn, and the manager yields one chunk for non-streaming providers —
  // so the returned STRING is identical to call() (the stream path uses the stream-kind
  // retry budget, so retry *timing* can differ — only the resulting text is guaranteed equal).
  let full = "";
  for await (const delta of manager.stream(messages, options)) {
    full += delta;
    try { options.onToken(delta); } catch { /* render consumer error must not break the turn */ }
  }
  return full;
}
