import type { Credential } from "../auth";

export type ProviderName = "anthropic" | "openai" | "gemini" | "antigravity" | "ollama" | "lmstudio" | "xai" | "kimi" | "groq" | "deepseek" | "mistral" | "openrouter" | "together" | "cerebras" | "fireworks" | "nvidia" | "alibaba-coding-plan" | "huggingface" | "nanogpt" | "qwen-portal" | "synthetic" | "venice" | "zenmux" | "qianfan" | "xiaomi" | "xiaomi-token-plan-ams" | "xiaomi-token-plan-cn" | "xiaomi-token-plan-sgp" | "minimax-code" | "minimax-code-cn" | "zai" | "minimax" | "tencent" | "deepinfra" | "litellm";


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
   *  Display channel; the REPLAY channel is `reasoningArtifacts`. */
  reasoning?: string;
  /** Provider-native, opaque reasoning artifacts captured during streaming (Anthropic
   *  thinking signature, Gemini thoughtSignature, OpenAI Responses reasoning items).
   *  Replayed to the SAME provider+model to preserve multi-step reasoning continuity;
   *  dropped on cross-model replay. Display-agnostic, not written to markdown export. */
  reasoningArtifacts?: ReasoningArtifact[];
  /** Structured native tool calls this assistant turn made (with stable ids). `content`
   *  keeps the canonical JSON envelope for display/compaction/fallback adapters; capable
   *  adapters replay these as native tool_use / functionCall / function_call blocks. */
  toolUse?: ToolUseRecord[];
  /** Structured native tool results for a tool-feedback user turn (ids match the prior
   *  assistant's `toolUse`). Capable adapters replay these as native tool_result /
   *  functionResponse / function_call_output blocks. */
  toolResults?: ToolResultRecord[];
  /** Non-tool trailing text on a tool-feedback user turn (e.g. post-turn hook
   *  diagnostics) — replayed as a trailing text block after the native tool results. */
  toolResultExtra?: string;
}

/** A provider-native opaque reasoning artifact. Only replayed when `provider` AND
 *  `model` match the active call (the adapter stamps the exact wire model id). */
export interface ReasoningArtifact {
  provider: ProviderName;
  model: string;
  /** Thought text (display is covered by Message.reasoning; kept here for fidelity). */
  text?: string;
  /** Anthropic: thinking block signature. */
  signature?: string;
  /** Anthropic: redacted_thinking opaque data. */
  redacted?: string;
  /** Gemini: per-part thoughtSignature (binds to the matching functionCall part). */
  thoughtSignature?: string;
  /** OpenAI Responses: reasoning item id. */
  itemId?: string;
  /** OpenAI Responses: reasoning item encrypted_content. */
  encrypted?: string;
}

/** A structured native tool call (assistant turn). `id` is a stable synthetic id the
 *  engine assigns so tool_use ↔ tool_result correlation survives replay. */
export interface ToolUseRecord {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/** A structured native tool result (user turn). `id` matches a prior `ToolUseRecord`. */
export interface ToolResultRecord {
  id: string;
  output: string;
  isError: boolean;
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
  /** Ollama context window (`num_ctx`). Overrides the server's small default so jeo's
   *  large system prompt fits; ignored by non-Ollama providers. */
  numCtx?: number;
  /** Optional sink for provider-reported token usage. */
  onUsage?: (usage: Usage) => void;
  /** Abort in-flight provider requests (Ctrl-C / timeout / supersede). */
  signal?: AbortSignal;
  /** Reasoning effort for reasoning models (o-series / gpt-5), mapped from thinkingLevel. */
  reasoningEffort?: "low" | "medium" | "high" | "none";
  /** How an OpenAI-compatible backend enables/streams native reasoning (gjc parity):
   *  "openai" → `reasoning_effort`; "openrouter" → `reasoning: {effort}`; "qwen" →
   *  `enable_thinking: true`; "zai" → `thinking: {type:"enabled"}`. Set per provider by
   *  the openai-compatible factory; without it a model never emits reasoning to surface. */
  reasoningFormat?: "openai" | "openrouter" | "qwen" | "zai";
  /** Stable per-conversation key (the session id) for provider-side prompt caching.
   *  gjc parity: the Codex/Responses backends key their prompt cache on
   *  `prompt_cache_key` (+ `session_id`/`conversation_id` headers on the Codex
   *  backend), so an agent loop replaying the same history each step gets cache
   *  hits instead of full-prompt re-reads. Optional — absent for one-shot calls. */
  sessionKey?: string;
  /** Notified before each auto-retry backoff wait (rate limits / transient errors).
   *  NOT forwarded to provider adapters — consumed by the manager's retry layer.
   *  Returning `false` aborts the retry immediately instead of backing off and
   *  re-attempting (see util/retry.ts's RetryOptions.onRetry). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void | false;
  /** Streaming sink for native model reasoning/thinking text deltas (separate from the
   *  answer text). Surfaced as a transient dimmed view; absent for models that emit no
   *  thought text. */
  onReasoning?: (delta: string) => void;
  /** Fired ONCE when the model opens an extended-thinking block, before (or without) any
   *  thinking-text deltas. Lets a UI show a live "thinking" indicator even for models
   *  (e.g. claude-opus-4-7/4-8) that reason internally and stream NO visible thought text,
   *  so the response wait does not look frozen. Display-only — carries no content. */
  onReasoningStart?: () => void;
  /** Sink for provider-native reasoning ARTIFACTS captured during streaming (signature /
   *  thoughtSignature / reasoning item id+encrypted). Separate from `onReasoning` (display
   *  text) because these arrive on different SSE events and are opaque replay data. */
  onReasoningArtifact?: (artifact: ReasoningArtifact) => void;
  /** Internal wire-activity heartbeat: fired on ANY bytes received from the provider
   *  stream — including SSE keepalive/ping comments and events that never become a
   *  yielded chunk or reasoning delta. Set by the manager's streaming path so the idle
   *  watchdog treats a connected-but-quiet stream (e.g. a model reasoning server-side
   *  that emits only ping events) as alive. NOT forwarded to user callbacks. */
  onStreamActivity?: () => void;
  /** NATIVE tool-calling: function declarations the model may call. Present only on the
   *  main agent step (never the prose wrap-up). Adapters with `supportsNativeTools` send
   *  these on the wire and re-serialize the structured tool call back into the engine's
   *  canonical {"tool":...}/{"tools":[...]} string; others ignore it. */
  tools?: NativeToolSchema[];
  /** Extra HTTP headers merged into the outgoing provider request (adapter-specific;
   *  currently honored by the anthropic adapter). Used by Anthropic-compatible OAuth
   *  providers — e.g. Kimi Code sends its X-Msh-* device headers on every call. */
  extraHeaders?: Record<string, string>;
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
