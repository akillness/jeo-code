import { OAUTH_FLOW_REGISTRY } from "../auth/flows";
import { readGlobalConfig } from "../agent/state";
import { resolveCredential, type AuthProvider, type Credential } from "../auth";
import { anthropicAdapter } from "./providers/anthropic";
import { openaiAdapter } from "./providers/openai";
import { geminiAdapter } from "./providers/gemini";
import { ollamaAdapter } from "./providers/ollama";
import type { CallOptions, Message, ProviderAdapter, ProviderName } from "./types";
import { expandAlias, resolveModelId, effectiveAliasesFor } from "./model-registry";
import { findCatalogEntry, type ModelCatalogEntry } from "./model-catalog-compat";
import { toProviderModel } from "./model-catalog";
import { withRetry, defaultRetryable, type RetryOptions } from "../util/retry";
import type { Config } from "../agent/state";

const ADAPTERS: Record<ProviderName, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
  ollama: ollamaAdapter,
};

export function resolveProvider(model: string): ProviderName {
  // Catalog is authoritative for known ids (correct even when heuristics would
  // misroute a future/edge id); heuristics handle everything uncatalogued.
  const entry = findCatalogEntry(model);
  if (entry) return entry.provider;
  const m = (model ?? "").toLowerCase();
  if (m.startsWith("ollama/")) return "ollama";
  // OpenAI: explicit prefix, any GPT, or a reasoning model (o1/o3/o4-mini, o1-preview…).
  if (m.startsWith("openai/") || m.includes("gpt") || /(^|\/)o\d/.test(m)) return "openai";
  if (m.startsWith("google/") || m.includes("gemini")) return "gemini";
  return "anthropic";
}

/** Map the configured thinking level to a default max-token budget. */
export function thinkingMaxTokens(level?: "minimal" | "low" | "medium" | "high" | "xhigh"): number {
  if (level === "minimal") return 1000;
  if (level === "low") return 2000;
  if (level === "high") return 8000;
  if (level === "xhigh") return 16000;
  return 4000;
}

/** Describe a model id: alias expansion + the provider it routes to. For `/model` + diagnostics. */
export async function describeModel(input: string): Promise<{ input: string; resolved: string; provider: ProviderName }> {
  const resolved = await resolveModelId(input);
  return { input, resolved, provider: resolveProvider(resolved) };
}

export type ModelRole = "smol" | "slow" | "plan";

/** Resolve a model role tier (smol/slow/plan) → configured tier model, else defaultModel. */
export function resolveRoleModel(role: ModelRole, config: { defaultModel: string; roles?: { smol?: string; slow?: string; plan?: string } }): string {
  return config.roles?.[role] || config.defaultModel;
}

export interface ModelDescription {
  input: string;
  resolved: string;
  provider: ProviderName;
  /** Catalog metadata when the resolved id is known (context window, reasoning…). */
  entry?: ModelCatalogEntry;
  /** Alias names that expand to the resolved id. */
  aliases: string[];
}

/**
 * Rich model description for the `/model` panel + diagnostics: alias expansion,
 * routed provider, catalog metadata (context window, reasoning, recommended),
 * and the reverse-alias list. Falls back gracefully for uncatalogued ids.
 */
export async function describeModelDetailed(input: string): Promise<ModelDescription> {
  const { resolved, provider } = await describeModel(input);
  return {
    input,
    resolved,
    provider,
    entry: findCatalogEntry(resolved),
    aliases: await effectiveAliasesFor(resolved),
  };
}

export interface ModelManager {
  call(messages: Message[], options?: Partial<CallOptions>): Promise<string>;
  stream(messages: Message[], options?: Partial<CallOptions>): AsyncIterable<string>;
  resolveProvider: typeof resolveProvider;
}

const ALIAS_DEFAULTS = { fast: "ollama/qwen2.5:0.5b", local: "ollama/qwen2.5:0.5b", sonnet: "claude-sonnet-4-5", opus: "claude-opus-4-5", haiku: "claude-haiku-4-5", gpt: "gpt-5.5", flash: "gemini-2.5-flash" };

/**
 * Build retry options from a config `retry` budget (gjc parity). `requestMaxRetries`
 * counts retries (not the initial request), so total `withRetry` attempts =
 * requestMaxRetries + 1. When unset, the `withRetry` defaults apply (3 attempts),
 * but rate-limit (429) errors get a more generous budget + a backoff floor so a
 * transient per-minute window can clear instead of the very first 429 instantly
 * exhausting auto-retry. Explicit config (`requestMaxRetries`/`maxDelayMs`) always
 * wins and disables the matching rate-limit default.
 * `maxDelayMs` caps backoff when provided.
 */
const DEFAULT_RATE_LIMIT_RETRIES = 5; // total attempts for 429 (initial + 4 retries)
const DEFAULT_RATE_LIMIT_MIN_DELAY_MS = 2000; // 429 floor when the server sends no Retry-After
export function resolveRetryOptions(retry: Config["retry"]): RetryOptions {
  const opts: RetryOptions = { isRetryable: defaultRetryable };
  if (typeof retry?.requestMaxRetries === "number") {
    opts.retries = retry.requestMaxRetries + 1;
    opts.rateLimitRetries = retry.requestMaxRetries + 1; // explicit budget: no rate-limit bonus
  } else {
    opts.rateLimitRetries = DEFAULT_RATE_LIMIT_RETRIES;
  }
  if (typeof retry?.maxDelayMs === "number") {
    opts.maxDelayMs = retry.maxDelayMs;
  } else {
    opts.rateLimitMinDelayMs = DEFAULT_RATE_LIMIT_MIN_DELAY_MS;
  }
  return opts;
}

/**
 * Pick the credential to actually use for a provider call / live discovery.
 * An API key is the broader, documented path, so it wins whenever present.
 * An OAuth-only login is usable only when the bundled adapter is verified
 * end-to-end (Anthropic Messages, OpenAI ChatGPT/Codex Responses); otherwise
 * (e.g. Gemini OAuth) we fail fast asking for an API key.
 */
export function effectiveCredentialForProvider(
  provider: AuthProvider,
  credential: Credential,
  config: Pick<Config, "providers">,
  model: string,
): Credential {
  if (credential.kind === "oauth") {
    const apiKey = config.providers[provider];
    if (apiKey) return { kind: "api_key", provider, token: apiKey };
    if (OAUTH_FLOW_REGISTRY[provider]?.verifiedEndToEnd === false) {
      throw new Error(
        provider === "gemini"
          ? `Gemini OAuth (Gemini CLI / Cloud Code Assist) is not served by joc's bundled adapter yet. Use a free GEMINI_API_KEY from https://aistudio.google.com/apikey (or run 'joc setup') — or use Anthropic/OpenAI, which ARE served via OAuth — then retry ${model}.`
          : `Provider '${provider}' has only an OAuth token, but its OAuth backend is not compatible with the bundled adapter. Set ${provider.toUpperCase()}_API_KEY (or run 'joc setup') to use ${model}.`,
      );
    }
  }
  return credential;
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
    // Map a catalog canonical (e.g. claude-3-5-sonnet) to the exact wire id the
    // provider accepts (claude-3-5-sonnet-20241022); live/provider ids pass through.
    model: toProviderModel(model, provider),
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
  const effective = effectiveCredentialForProvider(provider as AuthProvider, credential, config, model);

  const isLocalOpenAi = provider === "openai" && !!baseUrl;
  if (effective.kind === "none" && !isLocalOpenAi) {
    throw new Error(
      `No credential for provider '${provider}'. Run 'joc setup', 'joc auth login', or set ${provider.toUpperCase()}_API_KEY / ${provider.toUpperCase()}_OAUTH_TOKEN.`
    );
  }
  return { adapter, callOptions, credential: effective, retry: resolveRetryOptions(config.retry) };
}

/** Hard cap for a single non-streaming provider request (service-readiness: a
 *  blackholed/unreachable provider must not hang the agent or `joc team`). */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** Compose the caller's signal (if any) with a fresh per-attempt timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

export function createModelManager(): ModelManager {
  return {
    resolveProvider,
    async call(messages, options = {}) {
      const { adapter, callOptions, credential, retry } = await resolveCall(options);
      return withRetry(() => adapter.call(messages, { ...callOptions, signal: withTimeout(callOptions.signal, DEFAULT_CALL_TIMEOUT_MS) }, credential), retry);
    },
    async *stream(messages, options = {}) {
      const { adapter, callOptions, credential, retry } = await resolveCall(options);
      if (adapter.stream) {
        yield* adapter.stream(messages, { ...callOptions, signal: withTimeout(callOptions.signal, DEFAULT_CALL_TIMEOUT_MS) }, credential);
      } else {
        // Fallback: providers without streaming yield the full response as one chunk.
        yield await withRetry(() => adapter.call(messages, { ...callOptions, signal: withTimeout(callOptions.signal, DEFAULT_CALL_TIMEOUT_MS) }, credential), retry);
      }
    },
  };
}
