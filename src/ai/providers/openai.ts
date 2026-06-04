import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";

function openaiRequest(messages: Message[], options: CallOptions, credential: Credential, stream: boolean): { url: string; headers: Record<string, string>; body: string } {
  const resolvedModel = options.model.startsWith("openai/") ? options.model.slice(7) : options.model;
  const model = resolvedModel.includes("gpt-4o") ? "gpt-4o" : resolvedModel;
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const openaiMessages: { role: string; content: string }[] = [];
  if (systemPrompt) openaiMessages.push({ role: "system", content: systemPrompt });
  for (const msg of messages) {
    if (msg.role !== "system") openaiMessages.push({ role: msg.role, content: msg.content });
  }
  const payload: Record<string, unknown> = {
    model,
    messages: openaiMessages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 4000,
  };
  if (stream) payload.stream = true;
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
    const { url, headers, body } = openaiRequest(messages, options, credential, false);
    const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API request failed (HTTP ${response.status}): ${text}`);
    }
    const result = (await response.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (result.usage) options.onUsage?.({ inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens });
    return result.choices[0]?.message?.content ?? "";
  },
  async *stream(messages, options, credential) {
    const { url, headers, body } = openaiRequest(messages, options, credential, true);
    const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI stream failed (HTTP ${response.status}): ${text}`);
    }
    if (!response.body) return;
    for await (const data of readSse(response.body)) {
      let chunk: { choices?: { delta?: { content?: string } }[] };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  },
};

function bearerFor(credential: Credential): string {
  if (credential.kind === "oauth") return credential.token;
  if (credential.kind === "api_key") return credential.token;
  return "no-key";
}
