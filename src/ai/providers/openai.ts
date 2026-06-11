import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";
import { providerHttpError } from "./errors";
import { codexResponsesCall, codexResponsesStream } from "./openai-responses";

export function openaiRequest(messages: Message[], options: CallOptions, credential: Credential, stream: boolean): { url: string; headers: Record<string, string>; body: string } {
  const model = options.model.startsWith("openai/") ? options.model.slice(7) : options.model;
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const openaiMessages: { role: string; content: string }[] = [];
  if (systemPrompt) openaiMessages.push({ role: "system", content: systemPrompt });
  for (const msg of messages) {
    if (msg.role !== "system") openaiMessages.push({ role: msg.role, content: msg.content });
  }
  // Reasoning models (o-series, gpt-5 family) take max_completion_tokens + reasoning_effort
  // and reject temperature; classic chat models (gpt-4o, …) take max_tokens + temperature.
  const isReasoning = /^o\d/.test(model) || /^gpt-5/.test(model);
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
  if (stream) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }
  if (options.jsonMode) payload.response_format = { type: "json_object" };
  const base = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    url: `${base}/chat/completions`,
    headers: { "content-type": "application/json", Authorization: `Bearer ${bearerFor(credential)}` },
    body: JSON.stringify(payload),
  };
}

export const openaiAdapter: ProviderAdapter = {
  name: "openai",
  async call(messages, options, credential) {
    // ChatGPT/Codex OAuth can't use /chat/completions — route to the Codex Responses backend.
    if (credential.kind === "oauth") return codexResponsesCall(messages, options, credential);
    const { url, headers, body } = openaiRequest(messages, options, credential, false);
    const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (!response.ok) throw await providerHttpError("OpenAI", response);
    const result = (await response.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (result.usage) options.onUsage?.({ inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens });
    return result.choices[0]?.message?.content ?? "";
  },
  async *stream(messages, options, credential) {
    if (credential.kind === "oauth") {
      yield* codexResponsesStream(messages, options, credential);
      return;
    }
    const { url, headers, body } = openaiRequest(messages, options, credential, true);
    const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (!response.ok) throw await providerHttpError("OpenAI", response, "(stream)");
    if (!response.body) return;
    for await (const data of readSse(response.body)) {
      let chunk: { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
      if (chunk.usage) options.onUsage?.({ inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens });
    }
  },
};

function bearerFor(credential: Credential): string {
  if (credential.kind === "oauth") return credential.token;
  if (credential.kind === "api_key") return credential.token;
  return "no-key";
}
