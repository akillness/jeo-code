import { createModelManager, type Message as AiMessage } from "../ai";

export type Message = AiMessage;

/** Back-compat alias: engine and callers import the call options under this name. */
export type CallLlmOptions = ChatOptions;

export interface ChatOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Provider reasoning depth (mapped from the live session thinking level). When set it
   *  overrides the global config-derived effort, so `/thinking` and `--thinking` reach the
   *  provider's actual reasoning budget (Anthropic budget_tokens / OpenAI reasoning_effort /
   *  Gemini thinkingBudget), not just the max-token ceiling. */
  reasoningEffort?: import("../ai/types").CallOptions["reasoningEffort"];
  jsonMode?: boolean;
  signal?: AbortSignal;
  onUsage?: (usage: import("../ai/types").Usage) => void;
  /** Notified before each provider auto-retry backoff wait (e.g. rate limits).
   *  Returning `false` aborts the retry immediately (see ai/types.ts's CallOptions). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void | false;
  /** When set, the response is consumed via the provider STREAM and each text delta is
   *  delivered here (concatenation equals the returned string). Absent ⇒ a single
   *  non-streaming `call()` (unchanged behavior for non-interactive/test callers). */
  onToken?: (delta: string) => void;
  /** Streaming sink for native reasoning/thinking deltas (drives the dimmed live view). */
  onReasoning?: (delta: string) => void;
  /** Streaming sink for provider-native reasoning ARTIFACTS (signature / thoughtSignature /
   *  reasoning item id+encrypted) — the replay channel, separate from onReasoning. */
  onReasoningArtifact?: (artifact: import("../ai/types").ReasoningArtifact) => void;
  /** NATIVE tool-calling function declarations (forwarded to capable adapters). */
  tools?: import("../ai/types").NativeToolSchema[];
  /** Stable per-conversation key (session id) for provider-side prompt caching
   *  (gjc parity: prompt_cache_key / session_id correlation on Codex/Responses). */
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
