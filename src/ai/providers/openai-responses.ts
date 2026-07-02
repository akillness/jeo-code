/**
 * OpenAI ChatGPT/Codex OAuth path — the Codex subscription backend.
 *
 * ChatGPT/Codex OAuth tokens are rejected by `api.openai.com/v1/chat/completions`
 * (that endpoint wants an `OPENAI_API_KEY`). The Codex CLI instead routes through
 * `https://chatgpt.com/backend-api/codex/responses` using the Responses API schema,
 * authenticated by the OAuth bearer + the `chatgpt-account-id` claimed in the JWT.
 * This module builds that request and parses its SSE so an OAuth-only ChatGPT/Codex
 * login can actually serve a turn (verified end-to-end against a live ChatGPT account).
 *
 * Note: this backend is undocumented and unstable; it can change without notice.
 */
import type { Credential } from "../../auth";
import type { CallOptions, Message } from "../types";
import { readSse } from "../sse";
import { providerHttpError, fetchWithArtifactFailSafe } from "./errors";
import { serializeAccumulatedToolCalls } from "../../agent/tool-schemas";
import os from "node:os";
import pkg from "../../../package.json";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export const VALID_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

const CODEX_ORIGINATOR = "codex_cli_rs";

/** Codex-CLI-shaped User-Agent (gjc getCodexUserAgent parity: `originator/version (platform release; arch)`).
 *  Sent on BOTH the OAuth and api-key paths — without it Bun's default UA leaks to the backend. */
export function codexUserAgent(): string {
  return `${CODEX_ORIGINATOR}/${pkg.version} (${os.platform()} ${os.release()}; ${os.arch()})`;
}

/** Extract `chatgpt_account_id` from a ChatGPT/Codex OAuth access JWT. */
export function extractChatgptAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8")) as {
      ["https://api.openai.com/auth"]?: { chatgpt_account_id?: unknown };
    };
    const id = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}


type ResponsesInputItem = Record<string, unknown>;

/** True when an assistant turn can replay stateless reasoning: it has structured toolUse AND
 *  a same-model OpenAI reasoning item (id + encrypted_content) captured this session. */
export function responsesNativizable(m: Message, modelKey: string): boolean {
  return !!m.toolUse?.length
    && !!m.reasoningArtifacts?.some(a => a.provider === "openai" && a.model === modelKey && !!a.itemId && !!a.encrypted);
}

/** Build the Responses `input` array, reconstructing native reasoning + function_call +
 *  function_call_output items for same-model OpenAI turns (stateless reasoning replay).
 *  stripArtifacts (fail-safe) or a non-matching model ⇒ the plain output_text/input_text shape. */
export function buildResponsesInput(messages: Message[], modelKey: string, stripArtifacts = false): ResponsesInputItem[] {
  const nonSystem = messages.filter(m => m.role !== "system");
  const items: ResponsesInputItem[] = [];
  const plain = (m: Message): ResponsesInputItem => ({
    role: m.role,
    content: [
      { type: m.role === "assistant" ? "output_text" : "input_text", text: m.content },
      ...(m.role !== "assistant" && m.images?.length
        ? m.images.map(img => ({ type: "input_image", image_url: `data:${img.mediaType};base64,${img.data}` }))
        : []),
    ],
  });
  nonSystem.forEach((m, i) => {
    if (!stripArtifacts && m.role === "assistant" && responsesNativizable(m, modelKey)) {
      for (const a of m.reasoningArtifacts!) {
        if (a.provider === "openai" && a.model === modelKey && a.itemId && a.encrypted) {
          items.push({ type: "reasoning", id: a.itemId, encrypted_content: a.encrypted, summary: [] });
        }
      }
      for (const tu of m.toolUse!) {
        items.push({ type: "function_call", call_id: tu.id, name: tu.tool, arguments: JSON.stringify(tu.arguments) });
      }
      return;
    }
    if (!stripArtifacts && m.role === "user" && m.toolResults?.length && i > 0
        && nonSystem[i - 1].role === "assistant" && responsesNativizable(nonSystem[i - 1], modelKey)) {
      for (const tr of m.toolResults) items.push({ type: "function_call_output", call_id: tr.id, output: tr.output });
      if (m.toolResultExtra) items.push({ role: "user", content: [{ type: "input_text", text: m.toolResultExtra }] });
      return;
    }
    items.push(plain(m));
  });
  return items;
}
/** Build the Codex Responses request (url + headers + body) for an OAuth credential. */
export function codexResponsesRequest(
  messages: Message[],
  options: CallOptions,
  credential: Credential,
  stripArtifacts = false,
): { url: string; headers: Record<string, string>; body: string } {
  const model = options.model.startsWith("openai/") ? options.model.slice(7) : options.model;
  const token = credential.kind === "none" ? "" : credential.token;
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const input = buildResponsesInput(messages, options.model, stripArtifacts);
  const promptCacheKey = normalizePromptCacheKey(options.sessionKey);
  const payload: Record<string, unknown> = {
    model,
    instructions: systemPrompt ?? "You are a helpful coding assistant.",
    input,
    stream: true, // the Codex backend only streams
    store: false,
    // Provider-side prompt caching (gjc parity): key the cache on the stable session id
    // so an agent loop replaying the same history each step re-reads a cached prefix.
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
  };
  if (options.tools?.length) {
    // Responses API function tools (flat shape). tool_choice "auto" keeps prose + `done`.
    payload.tools = options.tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    payload.tool_choice = "auto";
  }
  // Map thinkingLevel → reasoning effort for Codex reasoning models (gjc parity).
  // Drop out-of-enum values instead of forwarding them — the backend 400s on unknown efforts.
  if (options.reasoningEffort && VALID_REASONING_EFFORTS.has(options.reasoningEffort)) {
    // `summary: "auto"` makes the backend stream reasoning-summary deltas so the live
    // frame can show the model's thinking instead of a frozen "calling model (Ns)…".
    payload.reasoning = { effort: options.reasoningEffort, summary: "auto" };
  }
  // Cap the response length (gjc parity): the computed per-call budget must reach the wire,
  // otherwise the backend free-runs to its own default.
  if (options.maxTokens) payload.max_output_tokens = options.maxTokens;
  // OAuth → the undocumented ChatGPT/Codex backend (codex headers + account-id).
  // API key → the public OpenAI Responses API (`/v1/responses`) with a plain Bearer.
  // Both speak the same Responses schema (the body above), so only url+headers differ.
  if (credential.kind === "api_key") {
    const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    // Stateless reasoning replay (public Responses API): ask for encrypted reasoning content
    // so it can be captured and threaded back into a later `input` (store stays false).
    payload.include = ["reasoning.encrypted_content"];
    return {
      url: `${base}/responses`,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, accept: "text/event-stream", "user-agent": codexUserAgent() },
      body: JSON.stringify(payload),
    };
  }
  const accountId = extractChatgptAccountId(token);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "OpenAI-Beta": "responses=experimental",
    originator: CODEX_ORIGINATOR,
    "user-agent": codexUserAgent(),
    accept: "text/event-stream",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  // Correlation headers (gjc parity): the Codex backend keys its prompt cache on the
  // session/conversation pair; x-client-request-id aids server-side tracing.
  if (promptCacheKey) {
    headers.session_id = promptCacheKey;
    headers.conversation_id = promptCacheKey;
    headers["x-client-request-id"] = promptCacheKey;
  }
  return { url: CODEX_RESPONSES_URL, headers, body: JSON.stringify(payload) };
}

/** gjc parity (normalizeOpenAIResponsesPromptCacheKey): well-formed unicode, ≤64 chars
 *  verbatim, longer keys hashed to a stable compact form. */
export function normalizePromptCacheKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey || sessionKey.length === 0) return undefined;
  const wellFormed = sessionKey.toWellFormed();
  if (wellFormed.length <= 64) return wellFormed;
  return `pc_${Bun.hash(wellFormed).toString(36)}`;
}

export interface ResponsesEvent {
  delta?: string;
  /** Reasoning-summary text delta (`response.reasoning_summary_text.delta` and the
   *  Codex backend's `reasoning_text` variant) — streamed live as the model thinks. */
  reasoningDelta?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
  /** `response.incomplete` cause (e.g. max_output_tokens) — surfaced when the
   *  whole response produced no text (round-5 #1). */
  incompleteReason?: string;
  /** NATIVE function_call output items (accumulated by the caller across SSE events). */
  toolCallName?: string;
  toolCallArgsDelta?: string;
  toolCallIndex?: number;
  /** A completed reasoning item carrying its id + encrypted_content (stateless replay capture). */
  reasoningItem?: { id: string; encrypted: string };
}

/** Parse one Responses SSE `data:` payload into a delta / usage / error. */
export function parseResponsesEvent(data: string): ResponsesEvent {
  let o: {
    type?: string;
    delta?: unknown;
    item?: { type?: string; name?: string; id?: string; encrypted_content?: string };
    output_index?: number;
    response?: {
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
      incomplete_details?: { reason?: string };
    };
    error?: { message?: string };
  };
  try {
    o = JSON.parse(data);
  } catch {
    return {};
  }
  if (o.type === "response.output_item.added" && o.item?.type === "function_call") {
    return { toolCallName: o.item.name, toolCallIndex: o.output_index };
  }
  // A completed reasoning item carries the encrypted_content we replay later (needs the
  // request's `include: ["reasoning.encrypted_content"]`). Captured on output_item.done.
  if (o.type === "response.output_item.done" && o.item?.type === "reasoning" && o.item.id && o.item.encrypted_content) {
    return { reasoningItem: { id: o.item.id, encrypted: o.item.encrypted_content } };
  }
  if (o.type === "response.function_call_arguments.delta" && typeof o.delta === "string") {
    return { toolCallArgsDelta: o.delta, toolCallIndex: o.output_index };
  }
  if (o.type === "response.output_text.delta" && typeof o.delta === "string") return { delta: o.delta };
  // Reasoning-summary streaming: surface the model's thinking live. Accept the
  // documented `response.reasoning_summary_text.delta` and the Codex backend's
  // `response.reasoning_text.delta` (any reasoning*.delta variant) uniformly.
  if (typeof o.delta === "string" && /^response\.reasoning[a-z_]*\.delta$/.test(o.type ?? "")) {
    return { reasoningDelta: o.delta };
  }
  // `response.incomplete` (max_output_tokens / content filter) also carries usage — don't drop it.
  if ((o.type === "response.completed" || o.type === "response.incomplete") && o.response?.usage) {
    return {
      usage: { inputTokens: o.response.usage.input_tokens, outputTokens: o.response.usage.output_tokens },
      ...(o.type === "response.incomplete" ? { incompleteReason: o.response.incomplete_details?.reason ?? "incomplete" } : {}),
    };
  }
  if (o.type === "response.failed" || o.type === "error") {
    return { error: o.response?.error?.message ?? o.error?.message ?? "Codex response failed" };
  }
  return {};
}

/** Accumulate Responses function_call name + streamed argument fragments by output index. */
function accumulateResponsesToolCall(acc: Map<number, { name: string; args: string }>, ev: ResponsesEvent): void {
  if (ev.toolCallName !== undefined) {
    const i = ev.toolCallIndex ?? 0;
    const b = acc.get(i) ?? { name: "", args: "" };
    b.name = ev.toolCallName;
    acc.set(i, b);
  }
  if (ev.toolCallArgsDelta) {
    const i = ev.toolCallIndex ?? 0;
    const b = acc.get(i) ?? { name: "", args: "" };
    b.args += ev.toolCallArgsDelta;
    acc.set(i, b);
  }
}


/** Round-5 #1: no-text completions surface their cause instead of returning "". */
function emptyCompletionError(reason: string | undefined): Error {
  const hint = reason === "max_output_tokens"
    ? " — output budget exhausted before any text (often reasoning tokens); raise maxTokens or lower reasoning effort"
    : "";
  return new Error(`OpenAI Codex returned no content${reason ? ` (${reason})` : ""}${hint}.`);
}

/** Fetch the Responses endpoint with a reasoning-artifact fail-safe (see fetchWithArtifactFailSafe). */
function fetchResponses(messages: Message[], options: CallOptions, credential: Credential): Promise<Response> {
  return fetchWithArtifactFailSafe(
    strip => {
      const { url, headers, body } = codexResponsesRequest(messages, options, credential, strip);
      return fetch(url, { method: "POST", headers, body, signal: options.signal });
    },
    (status, body) => status === 400 && /reasoning|encrypted_content/i.test(body),
  );
}

/** Non-streaming call over the Codex backend (collects the streamed output). */
export async function codexResponsesCall(messages: Message[], options: CallOptions, credential: Credential): Promise<string> {
  const response = await fetchResponses(messages, options, credential);
  if (!response.ok) throw await providerHttpError("OpenAI", response);
  if (!response.body) return "";
  let out = "";
  let incompleteReason: string | undefined;
  const toolAcc = new Map<number, { name: string; args: string }>();
  for await (const data of readSse(response.body)) {
    const ev = parseResponsesEvent(data);
    if (ev.delta) out += ev.delta;
    if (ev.reasoningDelta) options.onReasoning?.(ev.reasoningDelta);
    if (ev.reasoningItem) options.onReasoningArtifact?.({ provider: "openai", model: options.model, itemId: ev.reasoningItem.id, encrypted: ev.reasoningItem.encrypted });
    accumulateResponsesToolCall(toolAcc, ev);
    if (ev.usage) options.onUsage?.(ev.usage);
    if (ev.incompleteReason) incompleteReason = ev.incompleteReason;
    if (ev.error) throw new Error(`OpenAI Codex response failed: ${ev.error}`);
  }
  // Prefer a native tool call (re-serialized to canonical JSON) over any stray text.
  const envelope = serializeAccumulatedToolCalls(toolAcc);
  if (envelope) return envelope;
  if (!out) throw emptyCompletionError(incompleteReason);
  return out;
}

/** Streaming call over the Codex backend. */
export async function* codexResponsesStream(
  messages: Message[],
  options: CallOptions,
  credential: Credential,
): AsyncGenerator<string> {
  const response = await fetchResponses(messages, options, credential);
  if (!response.ok) throw await providerHttpError("OpenAI", response, "(stream)");
  if (!response.body) return;
  let yieldedAny = false;
  let incompleteReason: string | undefined;
  const toolAcc = new Map<number, { name: string; args: string }>();
  for await (const data of readSse(response.body, options.onStreamActivity)) {
    const ev = parseResponsesEvent(data);
    if (ev.reasoningDelta) options.onReasoning?.(ev.reasoningDelta);
    if (ev.reasoningItem) options.onReasoningArtifact?.({ provider: "openai", model: options.model, itemId: ev.reasoningItem.id, encrypted: ev.reasoningItem.encrypted });
    if (ev.delta) {
      yieldedAny = true;
      yield ev.delta;
    }
    accumulateResponsesToolCall(toolAcc, ev);
    if (ev.usage) options.onUsage?.(ev.usage);
    if (ev.incompleteReason) incompleteReason = ev.incompleteReason;
    if (ev.error) throw new Error(`OpenAI Codex response failed: ${ev.error}`);
  }
  // Native tool calls have no output_text deltas — yield the re-serialized envelope once.
  const envelope = serializeAccumulatedToolCalls(toolAcc);
  if (envelope) { yieldedAny = true; yield envelope; }
  if (!yieldedAny) throw emptyCompletionError(incompleteReason);
}
