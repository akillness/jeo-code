import type { Credential } from "../auth";

export type ProviderName = "anthropic" | "openai" | "gemini" | "ollama";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
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
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  /** Local providers ignore the credential argument; cloud adapters require it. */
  call(messages: Message[], options: CallOptions, credential: Credential): Promise<string>;
  /** Optional token streaming. Yields text deltas; concatenation equals the `call()` result. */
  stream?(messages: Message[], options: CallOptions, credential: Credential): AsyncIterable<string>;
}
