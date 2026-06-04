import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";

export const openaiAdapter: ProviderAdapter = {
  name: "openai",
  async call(messages, options, credential) {
    const resolvedModel = options.model.startsWith("openai/")
      ? options.model.slice(7)
      : options.model;
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
    if (options.jsonMode) payload.response_format = { type: "json_object" };

    const base = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${bearerFor(credential)}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API request failed (HTTP ${response.status}): ${text}`);
    }
    const result = (await response.json()) as { choices: { message: { content: string } }[] };
    return result.choices[0]?.message?.content ?? "";
  },
};

function bearerFor(credential: Credential): string {
  if (credential.kind === "oauth") return credential.token;
  if (credential.kind === "api_key") return credential.token;
  return "no-key";
}
