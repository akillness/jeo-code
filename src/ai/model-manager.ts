import { OAUTH_FLOW_REGISTRY } from "../auth/flows";
import { readGlobalConfig } from "../agent/state";
import { resolveCredential, type AuthProvider, type Credential } from "../auth";
import { anthropicAdapter } from "./providers/anthropic";
import { openaiAdapter } from "./providers/openai";
import { geminiAdapter } from "./providers/gemini";
import { ollamaAdapter } from "./providers/ollama";
import type { CallOptions, Message, ProviderAdapter, ProviderName } from "./types";
import { expandAlias } from "./model-registry";
import { withRetry, defaultRetryable } from "../util/retry";

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

/** Map the configured thinking level to a default max-token budget. */
export function thinkingMaxTokens(level?: "low" | "medium" | "high"): number {
  if (level === "low") return 2000;
  if (level === "high") return 8000;
  return 4000;
}

export interface ModelManager {
  call(messages: Message[], options?: Partial<CallOptions>): Promise<string>;
  stream(messages: Message[], options?: Partial<CallOptions>): AsyncIterable<string>;
  resolveProvider: typeof resolveProvider;
}

const ALIAS_DEFAULTS = { fast: "ollama/qwen2.5:0.5b", local: "ollama/qwen2.5:0.5b", sonnet: "claude-3-5-sonnet", gpt: "gpt-4o", flash: "gemini-2.5-flash" };

interface Resolved {
  adapter: ProviderAdapter;
  callOptions: CallOptions;
  credential: Credential;
}

async function resolveCall(options: Partial<CallOptions>): Promise<Resolved> {
  const config = await readGlobalConfig();
  const aliases = { ...((config as { modelAliases?: Record<string, string> }).modelAliases ?? {}) };
  const model = expandAlias(options.model ?? config.defaultModel, { ...ALIAS_DEFAULTS, ...aliases });
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
    maxTokens: options.maxTokens ?? thinkingMaxTokens(config.thinkingLevel),
    jsonMode: options.jsonMode,
    baseUrl,
    onUsage: options.onUsage,
    signal: options.signal,
  };

  if (provider === "ollama") {
    return { adapter, callOptions, credential: { kind: "none", provider: "openai" } };
  }

  const credential = await resolveCredential(provider as AuthProvider);
  let effective = credential;
  if (effective.kind === "oauth" && OAUTH_FLOW_REGISTRY[provider as AuthProvider]?.verifiedEndToEnd === false) {
    const apiKey = config.providers[provider as AuthProvider];
    if (apiKey) {
      effective = { kind: "api_key", provider: provider as AuthProvider, token: apiKey };
    } else {
      throw new Error(`Provider '${provider}' has only an OAuth token, but its OAuth backend is not compatible with the bundled adapter. Set ${provider.toUpperCase()}_API_KEY (or run 'joc setup') to use ${model}.`);
    }
  }

  const isLocalOpenAi = provider === "openai" && !!baseUrl;
  if (effective.kind === "none" && !isLocalOpenAi) {
    throw new Error(
      `No credential for provider '${provider}'. Run 'joc setup', 'joc auth login', or set ${provider.toUpperCase()}_API_KEY / ${provider.toUpperCase()}_OAUTH_TOKEN.`
    );
  }
  return { adapter, callOptions, credential: effective };
}

export function createModelManager(): ModelManager {
  return {
    resolveProvider,
    async call(messages, options = {}) {
      const { adapter, callOptions, credential } = await resolveCall(options);
      return withRetry(() => adapter.call(messages, callOptions, credential), { isRetryable: defaultRetryable });
    },
    async *stream(messages, options = {}) {
      const { adapter, callOptions, credential } = await resolveCall(options);
      if (adapter.stream) {
        yield* adapter.stream(messages, callOptions, credential);
      } else {
        // Fallback: providers without streaming yield the full response as one chunk.
        yield await withRetry(() => adapter.call(messages, callOptions, credential), { isRetryable: defaultRetryable });
      }
    },
  };
}
