import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";
import { providerHttpError } from "./errors";
import { codexResponsesCall, codexResponsesStream } from "./openai-responses";
import { serializeToolCalls, serializeAccumulatedToolCalls } from "../../agent/tool-schemas";
import { createThinkSplitter } from "../think-tags";

/** True for OpenAI reasoning models (o-series + gpt-5+ family). Digit-count agnostic
 *  (gpt-6/o10 stay reasoning). Strips the `openai/` routing prefix first. */
export function isOpenAIReasoningModel(model: string): boolean {
  const m = model.startsWith("openai/") ? model.slice(7) : model;
  const gptMajor = m.match(/^gpt-(\d+)/);
  return /^o\d/.test(m) || (gptMajor ? Number(gptMajor[1]) >= 5 : false);
}

/** gjc-parity: write the backend-specific param that turns NATIVE reasoning ON, so the
 *  model streams thinking we can surface. Mutates `payload`. "openai" needs no param here
 *  (handled by `reasoning_effort` for true o-series/gpt-5 models). */
export function applyCompatThinking(
  payload: Record<string, unknown>,
  format: CallOptions["reasoningFormat"],
  effort: NonNullable<CallOptions["reasoningEffort"]>,
): void {
  switch (format) {
    case "openrouter":
      payload.reasoning = { effort };
      break;
    case "qwen":
      payload.enable_thinking = true;
      break;
    case "zai":
      payload.thinking = { type: "enabled" };
      break;
    // "openai" / undefined: no extra param (reasoning_effort path covers real OpenAI models).
  }
}

export function openaiRequest(messages: Message[], options: CallOptions, credential: Credential, stream: boolean): { url: string; headers: Record<string, string>; body: string } {
  const model = options.model.startsWith("openai/") ? options.model.slice(7) : options.model;
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const openaiMessages: { role: string; content: unknown }[] = [];
  if (systemPrompt) openaiMessages.push({ role: "system", content: systemPrompt });
  for (const msg of messages) {
    if (msg.role === "system") continue;
    // Image attachments (clipboard paste) use the content-parts form with data URLs;
    // text-only messages keep the plain-string form every OpenAI-compat server accepts.
    const content = msg.images?.length
      ? [
          ...(msg.content ? [{ type: "text", text: msg.content }] : []),
          ...msg.images.map(img => ({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
        ]
      : msg.content;
    openaiMessages.push({ role: msg.role, content });
  }
  // Reasoning models (o-series, gpt-5+ family) take max_completion_tokens + reasoning_effort
  // and reject temperature; classic chat models (gpt-4o, …) take max_tokens + temperature.
  // Digit-count agnostic (gpt-6/o10 stay reasoning) — mirrors inferCatalogMetadata.
  const isReasoning = isOpenAIReasoningModel(model);
  const payload: Record<string, unknown> = {
    model,
    messages: openaiMessages,
  };
  if (isReasoning) {
    payload.max_completion_tokens = options.maxTokens ?? 4000;
    if (options.reasoningEffort) payload.reasoning_effort = options.reasoningEffort;
  } else {
    payload.temperature = options.temperature ?? 0.2;
    payload.max_tokens = options.maxTokens ?? 4000;
  }
  // gjc parity — enable NATIVE reasoning per the backend's thinking format so the model
  // actually emits reasoning (otherwise OpenRouter/Qwen/z.ai stay silent and the TUI has
  // nothing to show). `reasoning_effort` (OpenAI-style) only suits o-series/gpt-5; other
  // backends need their own param. Gated on a requested effort (off → no thinking).
  if (options.reasoningEffort && !isReasoning) {
    applyCompatThinking(payload, options.reasoningFormat, options.reasoningEffort);
  }
  if (stream) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }
  if (options.tools?.length) {
    payload.tools = options.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    payload.tool_choice = "auto";
  }
  if (options.jsonMode && !options.tools?.length) payload.response_format = { type: "json_object" };
  const base = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    url: `${base}/chat/completions`,
    headers: { "content-type": "application/json", Authorization: `Bearer ${bearerFor(credential)}` },
    body: JSON.stringify(payload),
  };
}

/** Round-5 #1: surface the finish_reason when a 200 carries no text — an empty
 *  reply only bounces in the JSON loop (billed) until the step budget dies. */
function emptyCompletionError(finishReason: string | undefined): Error {
  const hint = finishReason === "length"
    ? " — output budget exhausted before any text (often reasoning tokens); raise maxTokens or lower reasoning effort"
    : "";
  return new Error(`OpenAI returned no content${finishReason ? ` (finish_reason=${finishReason})` : ""}${hint}.`);
}

/** A streamed `choices[].delta`. `reasoning` is `unknown` because OpenAI-compatible
 *  servers disagree on its shape: a plain string (OpenRouter/xAI), an object
 *  `{ text|content }`, or absent (the `reasoning_details[]` array carries it instead). */
export interface OpenAIDelta {
  content?: string;
  reasoning_content?: string;
  reasoning_text?: string;
  reasoning?: unknown;
  reasoning_details?: { text?: string; content?: string }[];
  tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[];
}

/** Pull a reasoning-text delta out of the many OpenAI-compatible shapes. Returns the
 *  first non-empty of: `reasoning_content`, `reasoning_text`, a string/`{text|content}`
 *  `reasoning`, or the concatenated `reasoning_details[].text|content`. */
export function reasoningDeltaOf(delta: OpenAIDelta | undefined): string | undefined {
  if (!delta) return undefined;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) return delta.reasoning_content;
  if (typeof delta.reasoning_text === "string" && delta.reasoning_text) return delta.reasoning_text;
  const r = delta.reasoning;
  if (typeof r === "string" && r) return r;
  if (r && typeof r === "object") {
    const o = r as { text?: unknown; content?: unknown };
    if (typeof o.text === "string" && o.text) return o.text;
    if (typeof o.content === "string" && o.content) return o.content;
  }
  if (Array.isArray(delta.reasoning_details)) {
    const t = delta.reasoning_details
      .map(x => (typeof x?.text === "string" ? x.text : typeof x?.content === "string" ? x.content : ""))
      .join("");
    if (t) return t;
  }
  return undefined;
}

export const openaiAdapter: ProviderAdapter = {
  name: "openai",
  supportsNativeTools: true,
  async call(messages, options, credential) {
    // ChatGPT/Codex OAuth can't use /chat/completions — route to the Codex Responses backend.
    if (credential.kind === "oauth") return codexResponsesCall(messages, options, credential);
    // OpenAI reasoning models (o-series/gpt-5) expose reasoning ONLY via the Responses
    // API — /chat/completions hides it. Use Responses for a real-OpenAI API key (no
    // custom baseUrl); OpenAI-compatible servers (groq/xai/lmstudio/… set baseUrl) keep
    // the chat path + reasoning_content. Fall back to chat if /responses is unavailable.
    if (credential.kind === "api_key" && !options.baseUrl && isOpenAIReasoningModel(options.model)) {
      try {
        return await codexResponsesCall(messages, options, credential);
      } catch { /* /responses unsupported for this model/account — fall through to chat */ }
    }
    const { url, headers, body } = openaiRequest(messages, options, credential, false);
    const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (!response.ok) throw await providerHttpError("OpenAI", response);
    const result = (await response.json()) as { choices: { message: { content?: string; tool_calls?: { function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (result.usage) options.onUsage?.({ inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens });
    // Prefer a native tool call (re-serialized to canonical JSON) over any stray text.
    const envelope = serializeToolCalls(parseOpenaiToolCalls(result.choices[0]?.message?.tool_calls));
    if (envelope) return envelope;
    const text = result.choices[0]?.message?.content ?? "";
    if (!text) throw emptyCompletionError(result.choices[0]?.finish_reason);
    return text;
  },
  async *stream(messages, options, credential) {
    if (credential.kind === "oauth") {
      yield* codexResponsesStream(messages, options, credential);
      return;
    }
    // OpenAI reasoning models surface reasoning only via Responses (see call()). Pre-stream
    // fallback: if it fails before any chunk, retry on chat completions (no regression).
    if (credential.kind === "api_key" && !options.baseUrl && isOpenAIReasoningModel(options.model)) {
      let started = false;
      try {
        for await (const chunk of codexResponsesStream(messages, options, credential)) { started = true; yield chunk; }
        return;
      } catch (e) {
        if (started) throw e; // mid-stream failure — cannot safely restart on another endpoint
        // else fall through to chat completions below
      }
    }
    const { url, headers, body } = openaiRequest(messages, options, credential, true);
    let response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (response.status === 400) {
      // Compat retry (round-5 #5): some OpenAI-compatible backends (llama.cpp,
      // LM Studio, older vLLM) 400 on the OPTIONAL `stream_options` usage nicety.
      // Retry once without it instead of killing the turn over a nicety.
      const errBody = await response.clone().text().catch(() => "");
      if (/stream_options/i.test(errBody)) {
        const stripped = JSON.parse(body) as Record<string, unknown>;
        delete stripped.stream_options;
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(stripped), signal: options.signal });
      }
    }
    if (!response.ok) throw await providerHttpError("OpenAI", response, "(stream)");
    if (!response.body) return;
    let yieldedAny = false;
    let finishReason: string | undefined;
    // Split inline <think>…</think> (DeepSeek-R1/Qwen-style local models) out of the
    // visible answer and onto the reasoning channel. No-op for models that never emit it.
    const think = createThinkSplitter(options.onReasoning);
    const toolAcc = new Map<number, { name: string; args: string }>();
    for await (const data of readSse(response.body, options.onStreamActivity)) {
      let chunk: { choices?: { delta?: OpenAIDelta; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const raw = chunk.choices?.[0]?.delta?.content;
      if (raw) {
        const visible = think.push(raw);
        if (visible) {
          yieldedAny = true;
          yield visible;
        }
      }
      // Structured reasoning channel (separate from `content`, so it bypasses the
      // <think> splitter): handles string fields, an object `reasoning`, and the
      // `reasoning_details[]` array form (OpenRouter/xAI/DeepSeek variants).
      const reason = reasoningDeltaOf(chunk.choices?.[0]?.delta);
      if (reason) options.onReasoning?.(reason);
      const tcs = chunk.choices?.[0]?.delta?.tool_calls;
      if (tcs) {
        for (const tc of tcs) {
          const idx = tc.index ?? 0;
          const b = toolAcc.get(idx) ?? { name: "", args: "" };
          if (tc.function?.name) b.name = tc.function.name;
          if (tc.function?.arguments) b.args += tc.function.arguments;
          toolAcc.set(idx, b);
        }
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      if (chunk.usage) options.onUsage?.({ inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens });
    }
    const trailing = think.flush();
    if (trailing) { yieldedAny = true; yield trailing; }
    // Native tool calls stream as tool_calls argument fragments — re-serialize once at end.
    const envelope = serializeAccumulatedToolCalls(toolAcc);
    if (envelope) { yieldedAny = true; yield envelope; }
    if (!yieldedAny) throw emptyCompletionError(finishReason);
  },
};

function parseOpenaiToolCalls(toolCalls: { function?: { name?: string; arguments?: string } }[] | undefined): { tool: string; arguments: Record<string, unknown> }[] {
  if (!toolCalls?.length) return [];
  const out: { tool: string; arguments: Record<string, unknown> }[] = [];
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
    out.push({ tool: name, arguments: args });
  }
  return out;
}

function bearerFor(credential: Credential): string {
  if (credential.kind === "oauth") return credential.token;
  if (credential.kind === "api_key") return credential.token;
  return "no-key";
}
