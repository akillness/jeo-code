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
import { providerHttpError } from "./errors";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export const VALID_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

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

/** Build the Codex Responses request (url + headers + body) for an OAuth credential. */
export function codexResponsesRequest(
  messages: Message[],
  options: CallOptions,
  credential: Credential,
): { url: string; headers: Record<string, string>; body: string } {
  const model = options.model.startsWith("openai/") ? options.model.slice(7) : options.model;
  const token = credential.kind === "none" ? "" : credential.token;
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const input = messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role,
      content: [
        { type: m.role === "assistant" ? "output_text" : "input_text", text: m.content },
        // Clipboard-pasted images ride along as input_image data URLs (user turns only —
        // assistant history is always text in joc).
        ...(m.role !== "assistant" && m.images?.length
          ? m.images.map(img => ({ type: "input_image", image_url: `data:${img.mediaType};base64,${img.data}` }))
          : []),
      ],
    }));
  const payload: Record<string, unknown> = {
    model,
    instructions: systemPrompt ?? "You are a helpful coding assistant.",
    input,
    stream: true, // the Codex backend only streams
    store: false,
  };
  // Map thinkingLevel → reasoning effort for Codex reasoning models (gjc parity).
  // Drop out-of-enum values instead of forwarding them — the backend 400s on unknown efforts.
  if (options.reasoningEffort && VALID_REASONING_EFFORTS.has(options.reasoningEffort)) {
    payload.reasoning = { effort: options.reasoningEffort };
  }
  const accountId = extractChatgptAccountId(token);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    accept: "text/event-stream",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return { url: CODEX_RESPONSES_URL, headers, body: JSON.stringify(payload) };
}

export interface ResponsesEvent {
  delta?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
}

/** Parse one Responses SSE `data:` payload into a delta / usage / error. */
export function parseResponsesEvent(data: string): ResponsesEvent {
  let o: {
    type?: string;
    delta?: unknown;
    response?: { usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } };
    error?: { message?: string };
  };
  try {
    o = JSON.parse(data);
  } catch {
    return {};
  }
  if (o.type === "response.output_text.delta" && typeof o.delta === "string") return { delta: o.delta };
  // `response.incomplete` (max_output_tokens / content filter) also carries usage — don't drop it.
  if ((o.type === "response.completed" || o.type === "response.incomplete") && o.response?.usage) {
    return { usage: { inputTokens: o.response.usage.input_tokens, outputTokens: o.response.usage.output_tokens } };
  }
  if (o.type === "response.failed" || o.type === "error") {
    return { error: o.response?.error?.message ?? o.error?.message ?? "Codex response failed" };
  }
  return {};
}

/** Non-streaming call over the Codex backend (collects the streamed output). */
export async function codexResponsesCall(messages: Message[], options: CallOptions, credential: Credential): Promise<string> {
  const { url, headers, body } = codexResponsesRequest(messages, options, credential);
  const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
  if (!response.ok) throw await providerHttpError("OpenAI", response);
  if (!response.body) return "";
  let out = "";
  for await (const data of readSse(response.body)) {
    const ev = parseResponsesEvent(data);
    if (ev.delta) out += ev.delta;
    if (ev.usage) options.onUsage?.(ev.usage);
    if (ev.error) throw new Error(`OpenAI Codex response failed: ${ev.error}`);
  }
  return out;
}

/** Streaming call over the Codex backend. */
export async function* codexResponsesStream(
  messages: Message[],
  options: CallOptions,
  credential: Credential,
): AsyncGenerator<string> {
  const { url, headers, body } = codexResponsesRequest(messages, options, credential);
  const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
  if (!response.ok) throw await providerHttpError("OpenAI", response, "(stream)");
  if (!response.body) return;
  for await (const data of readSse(response.body)) {
    const ev = parseResponsesEvent(data);
    if (ev.delta) yield ev.delta;
    if (ev.usage) options.onUsage?.(ev.usage);
    if (ev.error) throw new Error(`OpenAI Codex response failed: ${ev.error}`);
  }
}
