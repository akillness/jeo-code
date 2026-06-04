import type { CallOptions, Message, ProviderAdapter } from "../types";

export const ollamaAdapter: ProviderAdapter = {
  name: "ollama",
  async call(messages, options) {
    const resolvedModel = options.model.startsWith("ollama/")
      ? options.model.slice(7)
      : options.model;
    const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;

    const chatMessages: { role: string; content: string }[] = [];
    if (systemPrompt) chatMessages.push({ role: "system", content: systemPrompt });
    for (const msg of messages) {
      if (msg.role !== "system") chatMessages.push({ role: msg.role, content: msg.content });
    }

    const payload: Record<string, unknown> = {
      model: resolvedModel,
      messages: chatMessages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? 4000,
      },
    };
    if (options.jsonMode) payload.format = "json";

    const base = (options.baseUrl ?? process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "");
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama request failed (HTTP ${response.status}) at ${base}: ${text}`);
    }
    const result = (await response.json()) as { message?: { content?: string } };
    return result.message?.content ?? "";
  },
};
