import type { Credential } from "../auth";

export type ProviderName = "anthropic" | "openai" | "gemini" | "antigravity" | "ollama";

/** An image attached to a (user) message — base64 payload + IANA media type. */
export interface ImageAttachment {
  /** e.g. "image/png", "image/jpeg" */
  mediaType: string;
  /** Raw base64 (no data: URL prefix). */
  data: string;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  /** Optional image attachments (clipboard paste). Multimodal providers render
   *  these alongside `content`; history bookkeeping (compaction, transcripts)
   *  keeps treating `content` as the message body. */
  images?: ImageAttachment[];
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Generation duration in ms, when the provider reports it. */
  durationMs?: number;
}

export interface CallOptions {
  model: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /** Per-call base URL override (OpenAI-compat / Ollama). */
  baseUrl?: string;
  /** Optional sink for provider-reported token usage. */
  onUsage?: (usage: Usage) => void;
  /** Abort in-flight provider requests (Ctrl-C / timeout / supersede). */
  signal?: AbortSignal;
  /** Reasoning effort for reasoning models (o-series / gpt-5), mapped from thinkingLevel. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** Notified before each auto-retry backoff wait (rate limits / transient errors).
   *  NOT forwarded to provider adapters — consumed by the manager's retry layer. */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** Streaming sink for native model reasoning/thinking text deltas (separate from the
   *  answer text). Surfaced as a transient dimmed view; absent for models that emit no
   *  thought text. */
  onReasoning?: (delta: string) => void;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  /** Local providers ignore the credential argument; cloud adapters require it. */
  call(messages: Message[], options: CallOptions, credential: Credential): Promise<string>;
  /** Optional token streaming. Yields text deltas; concatenation equals the `call()` result. */
  stream?(messages: Message[], options: CallOptions, credential: Credential): AsyncIterable<string>;
}
