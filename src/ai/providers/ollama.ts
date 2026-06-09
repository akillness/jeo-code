import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readLines } from "../sse";
import { providerHttpError } from "./errors";

/**
 * Resolve the Ollama base URL. `OLLAMA_HOST` is documented as a bare host:port
 * (e.g. `127.0.0.1:11434`), but `fetch` needs a scheme — prepend `http://` when
 * missing, else `fetch("127.0.0.1:11434/api/chat")` throws "Failed to parse URL".
 */
export function normalizeOllamaBaseUrl(baseUrl?: string): string {
  const v = (baseUrl ?? process.env.OLLAMA_HOST ?? "http://localhost:11434").trim();
  return (/^https?:\/\//i.test(v) ? v : `http://${v}`).replace(/\/$/, "");
}

function ollamaRequest(messages: Message[], options: CallOptions, stream: boolean): { url: string; body: string } {
  const model = options.model.startsWith("ollama/") ? options.model.slice(7) : options.model;
  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const chatMessages: { role: string; content: string }[] = [];
  if (systemPrompt) chatMessages.push({ role: "system", content: systemPrompt });
  for (const msg of messages) {
    if (msg.role !== "system") chatMessages.push({ role: msg.role, content: msg.content });
  }
  const payload: Record<string, unknown> = {
    model,
    messages: chatMessages,
    stream,
    options: { temperature: options.temperature ?? 0.2, num_predict: options.maxTokens ?? 4000 },
  };
  if (options.jsonMode) payload.format = "json";
  const base = normalizeOllamaBaseUrl(options.baseUrl);
  return { url: `${base}/api/chat`, body: JSON.stringify(payload) };
}

export const ollamaAdapter: ProviderAdapter = {
  name: "ollama",
  async call(messages, options) {
    const { url, body } = ollamaRequest(messages, options, false);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: options.signal });
    if (!response.ok) throw await providerHttpError("Ollama", response, `at ${url}`);
    const result = (await response.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; total_duration?: number };
    options.onUsage?.({ inputTokens: result.prompt_eval_count, outputTokens: result.eval_count, durationMs: result.total_duration ? Math.round(result.total_duration / 1e6) : undefined });
    return result.message?.content ?? "";
  },
  async *stream(messages, options) {
    const { url, body } = ollamaRequest(messages, options, true);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: options.signal });
    if (!response.ok) throw await providerHttpError("Ollama", response, `(stream) at ${url}`);
    if (!response.body) return;
    for await (const line of readLines(response.body)) {
      let chunk: { message?: { content?: string }; done?: boolean; prompt_eval_count?: number; eval_count?: number; total_duration?: number };
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      const delta = chunk.message?.content;
      if (delta) yield delta;
      if (chunk.done) {
        options.onUsage?.({ inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count, durationMs: chunk.total_duration ? Math.round(chunk.total_duration / 1e6) : undefined });
        break;
      }
    }
  },
};
