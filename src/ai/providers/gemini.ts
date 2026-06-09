import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";
import { readSse } from "../sse";
import { providerHttpError } from "./errors";

export function geminiRequest(messages: Message[], options: CallOptions, credential: Credential, action: "generateContent" | "streamGenerateContent"): { url: string; headers: Record<string, string>; body: string } {
  const resolvedModel = options.model.replace(/^(google|gemini)\//, "");
  let geminiModel = resolvedModel;
  if (!geminiModel || geminiModel === "claude-3-5-sonnet") geminiModel = "gemini-2.0-flash";

  const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
  // Gemini requires strictly ALTERNATING user/model turns. joc histories can carry
  // consecutive same-role messages (a compaction summary prepended before a tool-result,
  // back-to-back tool results, etc.), so coalesce adjacent same-role turns into one
  // content block — otherwise the API rejects the request mid-session.
  const contents: { role: string; parts: { text: string }[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "model" : "user";
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) {
      prev.parts.push({ text: m.content });
    } else {
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }

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
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function textOf(chunk: GeminiChunk): string {
  return chunk.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? "";
}

/** When Gemini returns HTTP 200 with no text, surface the real cause (safety block /
 *  RECITATION / MAX_TOKENS) instead of a silent empty string that downstream JSON
 *  parsing would misreport as "couldn't parse tool call". */
function blockedReason(chunk: GeminiChunk): string | undefined {
  const block = chunk.promptFeedback?.blockReason;
  if (block) return `blockReason=${block}`;
  const finish = chunk.candidates?.[0]?.finishReason;
  if (finish && finish !== "STOP" && finish !== "MAX_TOKENS") return `finishReason=${finish}`;
  return undefined;
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
    const text = textOf(result);
    if (!text) {
      const reason = blockedReason(result);
      if (reason) throw new Error(`Gemini returned no content (${reason}).`);
    }
    return text;
  },
  async *stream(messages, options, credential) {
    const { url, headers, body } = geminiRequest(messages, options, credential, "streamGenerateContent");
    const response = await fetch(url, { method: "POST", headers, body, signal: options.signal });
    if (!response.ok) throw await providerHttpError("Gemini", response, "(stream)");
    if (!response.body) return;
    let lastUsage: GeminiChunk["usageMetadata"];
    for await (const data of readSse(response.body)) {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = textOf(chunk);
      if (delta) yield delta;
      // Gemini emits cumulative usageMetadata on most chunks; capture the last and
      // report ONCE after the stream so an accumulating sink can't over-count.
      if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
    }
    if (lastUsage) {
      options.onUsage?.({ inputTokens: lastUsage.promptTokenCount, outputTokens: lastUsage.candidatesTokenCount });
    }
  },
};
