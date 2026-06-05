import { OAUTH_FLOW_REGISTRY } from "../auth/flows";
import { readGlobalConfig } from "../agent/state";
import { resolveCredential, type AuthProvider, type Credential } from "../auth";
import { anthropicAdapter } from "./providers/anthropic";
import { openaiAdapter } from "./providers/openai";
import { geminiAdapter } from "./providers/gemini";
import { ollamaAdapter } from "./providers/ollama";
import type { CallOptions, Message, ProviderAdapter, ProviderName } from "./types";
import { expandAlias, resolveModelId } from "./model-registry";
import { withRetry, defaultRetryable, type RetryOptions } from "../util/retry";
import type { Config } from "../agent/state";

const ADAPTERS: Record<ProviderName, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
  ollama: ollamaAdapter,
};

export function resolveProvider(model: string): ProviderName {
  const m = (model ?? "").toLowerCase();
  if (m.startsWith("ollama/")) return "ollama";
  // OpenAI: explicit prefix, any GPT, or a reasoning model (o1/o3/o4-mini, o1-preview…).
  if (m.startsWith("openai/") || m.includes("gpt") || /(^|\/)o\d/.test(m)) return "openai";
  if (m.startsWith("google/") || m.includes("gemini")) return "gemini";
  return "anthropic";
}

/** Map the configured thinking level to a default max-token budget. */
export function thinkingMaxTokens(level?: "low" | "medium" | "high"): number {
  if (level === "low") return 2000;
  if (level === "high") return 8000;
  return 4000;
}

/** Describe a model id: alias expansion + the provider it routes to. For `/model` + diagnostics. */
export async function describeModel(input: string): Promise<{ input: string; resolved: string; provider: ProviderName }> {
  const resolved = await resolveModelId(input);
  return { input, resolved, provider: resolveProvider(resolved) };
}

export interface ModelManager {
  call(messages: Message[], options?: Partial<CallOptions>): Promise<string>;
  stream(messages: Message[], options?: Partial<CallOptions>): AsyncIterable<string>;
  resolveProvider: typeof resolveProvider;
}

const ALIAS_DEFAULTS = { fast: "ollama/qwen2.5:0.5b", local: "ollama/qwen2.5:0.5b", sonnet: "claude-3-5-sonnet", gpt: "gpt-4o", flash: "gemini-2.5-flash" };

/**
 * Build retry options from a config `retry` budget (gjc parity). `requestMaxRetries`
 * counts retries (not the initial request), so total `withRetry` attempts =
 * requestMaxRetries + 1. When unset, the `withRetry` defaults apply (3 attempts).
 * `maxDelayMs` caps backoff when provided.
 */
export function resolveRetryOptions(retry: Config["retry"]): RetryOptions {
  const opts: RetryOptions = { isRetryable: defaultRetryable };
  if (typeof retry?.requestMaxRetries === "number") {
    opts.retries = retry.requestMaxRetries + 1;
  }
  if (typeof retry?.maxDelayMs === "number") {
    opts.maxDelayMs = retry.maxDelayMs;
  }
  return opts;
}

interface Resolved {
  adapter: ProviderAdapter;
  callOptions: CallOptions;
  credential: Credential;
  retry: RetryOptions;
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
    return { adapter, callOptions, credential: { kind: "none", provider: "openai" }, retry: resolveRetryOptions(config.retry) };
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
  return { adapter, callOptions, credential: effective, retry: resolveRetryOptions(config.retry) };
}

export function createModelManager(): ModelManager {
  return {
    resolveProvider,
    async call(messages, options = {}) {
      const { adapter, callOptions, credential, retry } = await resolveCall(options);
      return withRetry(() => adapter.call(messages, callOptions, credential), retry);
    },
    async *stream(messages, options = {}) {
      const { adapter, callOptions, credential, retry } = await resolveCall(options);
      if (adapter.stream) {
        yield* adapter.stream(messages, callOptions, credential);
      } else {
        // Fallback: providers without streaming yield the full response as one chunk.
        yield await withRetry(() => adapter.call(messages, callOptions, credential), retry);
      }
    },
  };
}
