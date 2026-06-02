import type { Credential } from "../../auth";
import type { CallOptions, Message, ProviderAdapter } from "../types";

export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",
  async call(messages, options, credential) {
    const resolvedModel = options.model.startsWith("anthropic/")
      ? options.model.slice(10)
      : options.model;
    const model = resolvedModel.includes("sonnet")
      ? "claude-3-5-sonnet-20241022"
      : resolvedModel;
    const systemPrompt = options.systemPrompt ?? messages.find(m => m.role === "system")?.content;
    const anthropicMessages = messages
      .filter(m => m.role !== "system")
      .map(m => ({ role: m.role, content: m.content }));

    const payload: Record<string, unknown> = {
      model,
      messages: anthropicMessages,
      max_tokens: options.maxTokens ?? 4000,
      temperature: options.temperature ?? 0.2,
    };
    if (systemPrompt) payload.system = systemPrompt;

    const headers = headersFor(credential);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API request failed (HTTP ${response.status}): ${text}`);
    }
    const result = (await response.json()) as { content: { type: string; text: string }[] };
    return result.content.find(c => c.type === "text")?.text ?? "";
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
