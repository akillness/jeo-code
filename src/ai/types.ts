import type { Credential } from "../auth";

export type ProviderName = "anthropic" | "openai" | "gemini" | "antigravity" | "ollama" | "lmstudio" | "xai" | "kimi" | "groq" | "deepseek" | "mistral" | "openrouter" | "together" | "cerebras" | "fireworks" | "nvidia" | "alibaba-coding-plan" | "huggingface" | "nanogpt" | "qwen-portal" | "synthetic" | "venice" | "zenmux" | "qianfan" | "xiaomi" | "xiaomi-token-plan-ams" | "xiaomi-token-plan-cn" | "xiaomi-token-plan-sgp" | "minimax-code" | "minimax-code-cn" | "zai" | "minimax";

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
  /** Persisted reasoning/thinking text for an assistant turn (the thought before the
   *  answer). Survives /resume + export so the durable record shows "think → answer".
   *  Display-only: NOT replayed to providers (anthropic/gemini thinking replay needs
   *  the original signed block, which the streaming path does not capture). */
  reasoning?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Generation duration in ms, when the provider reports it. */
  durationMs?: number;
}

/** Provider-neutral function/tool schema for NATIVE tool-calling. Capable adapters
 *  (anthropic/openai/gemini) map this onto their wire format (Anthropic input_schema,
 *  OpenAI function.parameters, Gemini functionDeclarations); fallback adapters
 *  (antigravity/ollama) ignore it and keep the JSON-in-prose protocol. */
export interface NativeToolSchema {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
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
  /** NATIVE tool-calling: function declarations the model may call. Present only on the
   *  main agent step (never the prose wrap-up). Adapters with `supportsNativeTools` send
   *  these on the wire and re-serialize the structured tool call back into the engine's
   *  canonical {"tool":...}/{"tools":[...]} string; others ignore it. */
  tools?: NativeToolSchema[];
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  /** True when this adapter implements native function-calling (re-serialized to the
   *  canonical JSON string). When false/absent, `CallOptions.tools` is ignored and the
   *  model drives tools via the JSON-in-prose protocol. */
  readonly supportsNativeTools?: boolean;
  /** Local providers ignore the credential argument; cloud adapters require it. */
  call(messages: Message[], options: CallOptions, credential: Credential): Promise<string>;
  /** Optional token streaming. Yields text deltas; concatenation equals the `call()` result. */
  stream?(messages: Message[], options: CallOptions, credential: Credential): AsyncIterable<string>;
}
