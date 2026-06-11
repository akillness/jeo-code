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
  const chatMessages: { role: string; content: string; images?: string[] }[] = [];
  if (systemPrompt) chatMessages.push({ role: "system", content: systemPrompt });
  for (const msg of messages) {
    if (msg.role === "system") continue;
    // Ollama multimodal models take raw base64 strings in a sibling `images` array.
    if (msg.images?.length) chatMessages.push({ role: msg.role, content: msg.content, images: msg.images.map(i => i.data) });
    else chatMessages.push({ role: msg.role, content: msg.content });
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

/** Round-5 #1: surface done_reason when a 200 carries no text (uniform contract). */
function emptyCompletionError(doneReason: string | undefined): Error {
  const hint = doneReason === "length"
    ? " — output budget exhausted before any text; raise maxTokens"
    : "";
  return new Error(`Ollama returned no content${doneReason ? ` (done_reason=${doneReason})` : ""}${hint}.`);
}

export const ollamaAdapter: ProviderAdapter = {
  name: "ollama",
  async call(messages, options) {
    const { url, body } = ollamaRequest(messages, options, false);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: options.signal });
    if (!response.ok) throw await providerHttpError("Ollama", response, `at ${url}`);
    const result = (await response.json()) as { message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number; total_duration?: number };
    options.onUsage?.({ inputTokens: result.prompt_eval_count, outputTokens: result.eval_count, durationMs: result.total_duration ? Math.round(result.total_duration / 1e6) : undefined });
    const text = result.message?.content ?? "";
    if (!text) throw emptyCompletionError(result.done_reason);
    return text;
  },
  async *stream(messages, options) {
    const { url, body } = ollamaRequest(messages, options, true);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: options.signal });
    if (!response.ok) throw await providerHttpError("Ollama", response, `(stream) at ${url}`);
    if (!response.body) return;
    let yieldedAny = false;
    let doneReason: string | undefined;
    for await (const line of readLines(response.body)) {
      let chunk: { message?: { content?: string }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; total_duration?: number };
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      const delta = chunk.message?.content;
      if (delta) {
        yieldedAny = true;
        yield delta;
      }
      if (chunk.done) {
        if (chunk.done_reason) doneReason = chunk.done_reason;
        options.onUsage?.({ inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count, durationMs: chunk.total_duration ? Math.round(chunk.total_duration / 1e6) : undefined });
        break;
      }
    }
    if (!yieldedAny) throw emptyCompletionError(doneReason);
  },
};
