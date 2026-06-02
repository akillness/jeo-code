import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";

export const geminiAdapter: ProviderAdapter = {
  name: "gemini",
  async call(messages, options, credential) {
    const resolvedModel = options.model.startsWith("google/")
      ? options.model.slice(7)
      : options.model;
    let geminiModel = resolvedModel;
    if (!geminiModel || geminiModel === "claude-3-5-sonnet") geminiModel = "gemini-2.0-flash";

    const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
    const contents = messages
      .filter(m => m.role !== "system")
      .map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const generationConfig: Record<string, unknown> = {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxTokens ?? 4000,
    };
    if (options.jsonMode) generationConfig.responseMimeType = "application/json";

    const payload: Record<string, unknown> = { contents, generationConfig };
    if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };

    const base = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;
    const oauth = credential.kind === "oauth" ? credential.token : undefined;
    const apiKey = credential.kind === "api_key" ? credential.token : undefined;
    const url = oauth ? base : `${base}?key=${apiKey ?? ""}`;
    const response = await fetch(url, {
      method: "POST",
      headers: oauth
        ? { "content-type": "application/json", authorization: `Bearer ${oauth}` }
        : { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini API request failed (HTTP ${response.status}): ${text}`);
    }
    const result = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return result.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  },
};
