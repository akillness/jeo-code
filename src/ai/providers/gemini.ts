import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";
import { providerHttpError } from "./errors";

function geminiRequest(messages: Message[], options: CallOptions, credential: Credential, action: "generateContent" | "streamGenerateContent"): { url: string; headers: Record<string, string>; body: string } {
  const resolvedModel = options.model.replace(/^(google|gemini)\//, "");
  let geminiModel = resolvedModel;
  if (!geminiModel || geminiModel === "claude-3-5-sonnet") geminiModel = "gemini-2.0-flash";

  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  const contents = messages
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature ?? 0.2,
    maxOutputTokens: options.maxTokens ?? 4000,
  };
  if (options.jsonMode) generationConfig.responseMimeType = "application/json";

  const payload: Record<string, unknown> = { contents, generationConfig };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };

  const oauth = credential.kind === "oauth" ? credential.token : undefined;
  const apiKey = credential.kind === "api_key" ? credential.token : undefined;
  let url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:${action}`;
  const query = action === "streamGenerateContent" ? "alt=sse" : "";
  if (!oauth) url += `?${query ? query + "&" : ""}key=${apiKey ?? ""}`;
  else if (query) url += `?${query}`;
  const headers: Record<string, string> = oauth
    ? { "content-type": "application/json", authorization: `Bearer ${oauth}` }
    : { "content-type": "application/json" };
  return { url, headers, body: JSON.stringify(payload) };
}

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function textOf(chunk: GeminiChunk): string {
  return chunk.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? "";
}

export const geminiAdapter: ProviderAdapter = {
  name: "gemini",
  async call(messages, options, credential) {
    const { url, headers, body } = geminiRequest(messages, options, credential, "generateContent");
    const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (!response.ok) throw await providerHttpError("Gemini", response);
    const result = (await response.json()) as GeminiChunk;
    if (result.usageMetadata) {
      options.onUsage?.({ inputTokens: result.usageMetadata.promptTokenCount, outputTokens: result.usageMetadata.candidatesTokenCount });
    }
    return textOf(result);
  },
  async *stream(messages, options, credential) {
    const { url, headers, body } = geminiRequest(messages, options, credential, "streamGenerateContent");
    const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (!response.ok) throw await providerHttpError("Gemini", response, "(stream)");
    if (!response.body) return;
    for await (const data of readSse(response.body)) {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = textOf(chunk);
      if (delta) yield delta;
      if (chunk.usageMetadata) {
        options.onUsage?.({ inputTokens: chunk.usageMetadata.promptTokenCount, outputTokens: chunk.usageMetadata.candidatesTokenCount });
      }
    }
  },
};
