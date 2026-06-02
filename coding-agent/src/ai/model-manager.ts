import { readGlobalConfig } from "../agent/state";
import { resolveCredential, type AuthProvider, type Credential } from "../auth";
import { anthropicAdapter } from "./providers/anthropic";
import { openaiAdapter } from "./providers/openai";
import { geminiAdapter } from "./providers/gemini";
import { ollamaAdapter } from "./providers/ollama";
import type { CallOptions, Message, ProviderAdapter, ProviderName } from "./types";

const ADAPTERS: Record<ProviderName, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
  ollama: ollamaAdapter,
};

export function resolveProvider(model: string): ProviderName {
  if (model.startsWith("ollama/")) return "ollama";
  if (model.includes("gpt") || model.includes("o1") || model.startsWith("openai/")) return "openai";
  if (model.includes("gemini") || model.startsWith("google/")) return "gemini";
  return "anthropic";
}

export interface ModelManager {
  call(messages: Message[], options?: Partial<CallOptions>): Promise<string>;
  resolveProvider: typeof resolveProvider;
}

export function createModelManager(): ModelManager {
  return {
    resolveProvider,
    async call(messages, options = {}) {
      const config = await readGlobalConfig();
      const model = options.model ?? config.defaultModel;
      const provider = resolveProvider(model);
      const adapter = ADAPTERS[provider];

      const baseUrl =
        options.baseUrl ??
        (provider === "openai" ? config.openaiBaseUrl : undefined) ??
        (provider === "ollama" ? config.ollamaBaseUrl : undefined);

      const callOptions: CallOptions = {
        model,
        systemPrompt: options.systemPrompt,
        temperature: options.temperature ?? 0.2,
        maxTokens: options.maxTokens ?? 4000,
        jsonMode: options.jsonMode,
        baseUrl,
      };

      // Local providers (ollama) do not require credentials.
      if (provider === "ollama") {
        const noneCred: Credential = { kind: "none", provider: "openai" };
        return adapter.call(messages, callOptions, noneCred);
      }

      const credential = await resolveCredential(provider as AuthProvider);
      const isLocalOpenAi = provider === "openai" && !!baseUrl;
      if (credential.kind === "none" && !isLocalOpenAi) {
        throw new Error(
          `No credential for provider '${provider}'. Run 'joc setup', 'joc auth login', or set ${provider.toUpperCase()}_API_KEY / ${provider.toUpperCase()}_OAUTH_TOKEN.`
        );
      }
      return adapter.call(messages, callOptions, credential);
    },
  };
}
