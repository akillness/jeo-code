import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";
import { ProviderHttpError, parseRetryAfter, providerHttpError } from "./errors";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const DEPRECATED_TEMPERATURE = "`temperature` is deprecated for this model.";

export function anthropicPayload(messages: Message[], options: CallOptions, stream: boolean, includeTemperature: boolean): string {
  const model = options.model.startsWith("anthropic/") ? options.model.slice(10) : options.model;
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const anthropicMessages = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content }));
  const payload: Record<string, unknown> = {
    model,
    messages: anthropicMessages,
    max_tokens: options.maxTokens ?? 4000,
  };
  if (includeTemperature && options.temperature !== undefined) payload.temperature = options.temperature;
  // Prompt caching (gjc parity): the system prompt (tool protocol + skills + project
  // context) is large and stable across a session, so mark it cache_control:ephemeral.
  // Anthropic then bills cached input at ~10% on later turns; below the ~1024-token
  // cache minimum the marker is simply ignored (no error).
  if (systemPrompt) payload.system = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
  if (stream) payload.stream = true;
  return JSON.stringify(payload);
}

function isDeprecatedTemperatureError(status: number, detail: string): boolean {
  return status === 400 && detail.includes(DEPRECATED_TEMPERATURE);
}

async function postAnthropic(
  messages: Message[],
  options: CallOptions,
  credential: Credential,
  stream: boolean,
): Promise<Response> {
  const send = (includeTemperature: boolean) =>
    fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: headersFor(credential),
      body: anthropicPayload(messages, options, stream, includeTemperature),
      signal: options.signal,
    });

  let response = await send(true);
  if (response.ok) return response;

  const detail = await response.text().catch(() => "");
  if (isDeprecatedTemperatureError(response.status, detail)) {
    response = await send(false);
    if (response.ok) return response;
    throw await providerHttpError("Anthropic", response, stream ? "(stream)" : undefined);
  }

  throw new ProviderHttpError(
    "Anthropic",
    response.status,
    detail,
    stream ? "(stream)" : undefined,
    parseRetryAfter(response.headers.get("retry-after")),
  );
}

/** Anthropic usage: with prompt caching the input splits into uncached + cache read +
 *  cache creation. Sum them so reported input reflects the TRUE prompt size. */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
export function totalInputTokens(u: AnthropicUsage): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",
  async call(messages, options, credential) {
    const response = await postAnthropic(messages, options, credential, false);
    const result = (await response.json()) as { content: { type: string; text: string }[]; usage?: AnthropicUsage };
    if (result.usage) options.onUsage?.({ inputTokens: totalInputTokens(result.usage), outputTokens: result.usage.output_tokens });
    return result.content.find(c => c.type === "text")?.text ?? "";
  },
  async *stream(messages, options, credential) {
    const response = await postAnthropic(messages, options, credential, true);
    if (!response.body) return;
    let cachedInput: number | undefined;
    for await (const data of readSse(response.body)) {
      let evt: {
        type?: string;
        delta?: { type?: string; text?: string };
        message?: { usage?: AnthropicUsage };
        usage?: { output_tokens?: number };
      };
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
        yield evt.delta.text;
      } else if (evt.type === "message_start" && evt.message?.usage) {
        cachedInput = totalInputTokens(evt.message.usage);
        options.onUsage?.({ inputTokens: cachedInput, outputTokens: evt.message.usage.output_tokens });
      } else if (evt.type === "message_delta" && evt.usage) {
        options.onUsage?.({ inputTokens: cachedInput, outputTokens: evt.usage.output_tokens });
      }
    }
  },
};
function headersFor(credential: Credential): Record<string, string> {
  if (credential.kind === "oauth") {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${credential.token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    };
  }
  if (credential.kind === "api_key") {
    return {
      "content-type": "application/json",
      "x-api-key": credential.token,
      "anthropic-version": "2023-06-01",
    };
  }
  throw new Error("anthropic adapter requires a credential");
}
