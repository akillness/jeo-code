import { providerRegistry } from "./provider-registry";
import { OAUTH_FLOW_REGISTRY } from "../auth/flows";
import { readGlobalConfig } from "../agent/state";
import { resolveCredential, isOAuthProvider, type AuthProvider, type Credential } from "../auth";
import "./register-providers"; // side-effect: registers built-in adapters into providerRegistry
import type { CallOptions, Message, ProviderAdapter, ProviderName } from "./types";
import { expandAlias, resolveModelId, effectiveAliasesFor } from "./model-registry";
import { findCatalogEntry, type ModelCatalogEntry } from "./model-catalog-compat";
import { toProviderModel, CODEX_MODELS } from "./model-catalog";
import { xaiCredential } from "./providers/xai";
import { OPENAI_COMPAT_NAMES, isOpenAICompatProvider } from "./providers/openai-compatible-catalog";
import { withRetry, defaultRetryable, type RetryOptions } from "../util/retry";
import { jeoEnv } from "../util/env";
import type { Config } from "../agent/state";




export function resolveProvider(model: string): ProviderName {
  // Catalog is authoritative for known ids (correct even when heuristics would
  // misroute a future/edge id); heuristics handle everything uncatalogued.
  const entry = findCatalogEntry(model);
  if (entry) return entry.provider;
  const m = (model ?? "").toLowerCase();
  // Explicit `<provider>/` prefixes ALWAYS win over substring heuristics — a model id
  // can legitimately contain another provider's name (e.g. `synthetic/hf:moonshotai/Kimi-K2.5`
  // or `openrouter/openai/gpt-4o-mini`), so prefix routing is resolved first.
  if (m.startsWith("ollama/")) return "ollama";
  if (m.startsWith("lmstudio/")) return "lmstudio";
  if (m.startsWith("antigravity/")) return "antigravity";
  if (m.startsWith("xai/")) return "xai";
  if (m.startsWith("kimi/")) return "kimi";
  for (const p of OPENAI_COMPAT_NAMES) if (m.startsWith(`${p}/`)) return p;
  if (m.startsWith("openai/")) return "openai";
  if (m.startsWith("google/")) return "gemini";
  // Loose substring heuristics for BARE (unprefixed) ids only.
  if (m.includes("grok")) return "xai";
  if (m.includes("kimi") || m.includes("moonshot")) return "kimi";
  if (m.includes("gpt") || /(^|\/)o\d/.test(m)) return "openai";
  if (m.includes("gemini")) return "gemini";
  return "anthropic";
}
// Static routing prefixes for the built-in (non-catalog) providers. Catalog
// OpenAI-compatible providers use `<name>/` directly (see providerIdPrefix).
const STATIC_ID_PREFIX: Partial<Record<ProviderName, string>> = {
  anthropic: "anthropic/",
  openai: "openai/",
  gemini: "google/",
  antigravity: "antigravity/",
  ollama: "ollama/",
  lmstudio: "lmstudio/",
  xai: "xai/",
  kimi: "kimi/",
};
function providerIdPrefix(provider: ProviderName): string {
  return isOpenAICompatProvider(provider) ? `${provider}/` : (STATIC_ID_PREFIX[provider] ?? `${provider}/`);
}

/**
 * Pin-time provider qualification: when a picked live model id would route to a
 * DIFFERENT provider than the list it came from (e.g. ollama's `qwen2.5:0.5b` → anthropic,
 * ollama's `gpt-oss:20b` → openai), prefix it so resolveProvider routes correctly.
 * Adapters strip these prefixes on the wire. Ids that already route correctly
 * (catalog ids, aliases, prefixed ids) pass through unchanged.
 */
export function qualifyModelId(model: string, provider: ProviderName): string {
  const id = (model ?? "").trim();
  if (!id) return id;
  return resolveProvider(id) === provider ? id : `${providerIdPrefix(provider)}${id}`;
}

/**
 * Wire id for a (possibly provider-qualified) model id: a catalog canonical maps
 * to the exact provider id (claude-sonnet-4-5 → claude-sonnet-4-5-20250929);
 * live/provider/prefixed ids pass through unchanged (adapters strip prefixes).
 */
export function providerModelFor(model: string): string {
  if (
    model.startsWith("ollama/") ||
    model.startsWith("openai/") ||
    model.startsWith("anthropic/") ||
    model.startsWith("google/") ||
    model.startsWith("antigravity/") ||
    model.startsWith("lmstudio/") ||
    model.startsWith("xai/") ||
    model.startsWith("kimi/") ||
    isOpenAICompatProvider(model.split("/")[0])
  ) {
    return model;
  }
  return toProviderModel(model, resolveProvider(model));
}

/** Map the configured thinking level to a default max-token budget. */
export function thinkingMaxTokens(level?: "minimal" | "low" | "medium" | "high" | "xhigh"): number {
  if (level === "minimal") return 4000;
  if (level === "low") return 8000;
  if (level === "high") return 24000;
  if (level === "xhigh") return 31999;
  return 16000;
}

/** Map the thinking level to an OpenAI reasoning-effort tier. `minimal` maps to `low`
 *  (the lowest tier o-series reliably accepts; gpt-5's `minimal` is opt-in via options). */
export function thinkingToReasoningEffort(
  level?: "minimal" | "low" | "medium" | "high" | "xhigh",
): "low" | "medium" | "high" | undefined {
  if (!level) return undefined;
  if (level === "minimal" || level === "low") return "low";
  if (level === "high" || level === "xhigh") return "high";
  return "medium";
}

/** Describe a model id: alias expansion + the provider it routes to. For `/model` + diagnostics.
 *  Pass an already-read `config` to skip a redundant readGlobalConfig() on the turn hot path. */
export async function describeModel(
  input: string,
  config?: { modelAliases?: Record<string, string> },
): Promise<{ input: string; resolved: string; provider: ProviderName }> {
  const resolved = await resolveModelId(input, config);
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

const ALIAS_DEFAULTS = { fast: "ollama/qwen2.5:0.5b", local: "ollama/qwen2.5:0.5b", sonnet: "claude-sonnet-4-5", opus: "claude-opus-4-5", haiku: "claude-haiku-4-5", gpt: "gpt-5.5", flash: "gemini-2.5-flash", grok: "grok-4.3" };

/**
 * Build retry options from a config `retry` budget (gjc parity). `requestMaxRetries`
 * counts retries (not the initial request), so total `withRetry` attempts =
 * requestMaxRetries + 1. When unset, the `withRetry` defaults apply (3 attempts),
 * but rate-limit (429) errors get a more generous budget + a backoff floor so a
 * transient per-minute window can clear instead of the very first 429 instantly
 * exhausting auto-retry. A server-directed retry delay above the five-minute
 * budget is surfaced immediately with its reset hint instead of being capped and
 * retried pointlessly. Explicit config (`requestMaxRetries`/`maxDelayMs`) always
 * wins and disables the matching rate-limit default.
 * `maxDelayMs` caps per-attempt backoff when provided.
 */
const DEFAULT_RATE_LIMIT_RETRIES = 6; // total attempts for 429 (initial + 5 retries)
// 429 floor when the server sends no Retry-After. Escalates per attempt inside
// withRetry (2s → 4s → 8s → 16s → 30s ≈ 60s total), spanning a per-minute window.
const DEFAULT_RATE_LIMIT_MIN_DELAY_MS = 2000;
// GJC parity for server-directed 429s: retry short windows, but do not hang a CLI
// through long subscription/account resets.
const DEFAULT_RATE_LIMIT_MAX_SERVER_DELAY_MS = 5 * 60 * 1000;
export function resolveRetryOptions(retry: Config["retry"], kind: "request" | "stream" = "request"): RetryOptions {
  const opts: RetryOptions = { isRetryable: defaultRetryable };

  let targetRetries: number | undefined;
  if (kind === "request") {
    if (typeof retry?.requestMaxRetries === "number") {
      targetRetries = retry.requestMaxRetries;
    } else if (typeof retry?.maxRetries === "number") {
      targetRetries = retry.maxRetries;
    }
  } else if (kind === "stream") {
    if (typeof retry?.streamMaxRetries === "number") {
      targetRetries = retry.streamMaxRetries;
    } else if (typeof retry?.maxRetries === "number") {
      targetRetries = retry.maxRetries;
    }
  }

  if (typeof targetRetries === "number") {
    opts.retries = targetRetries + 1;
  }

  if (typeof retry?.maxDelayMs === "number") opts.maxDelayMs = retry.maxDelayMs;

  // 429 attempt budget: explicit rateLimitRetries wins; else mirror the resolved
  // budget (no bonus); else the generous default so a transient window can clear.
  if (typeof retry?.rateLimitRetries === "number") {
    opts.rateLimitRetries = retry.rateLimitRetries + 1;
  } else if (typeof targetRetries === "number") {
    opts.rateLimitRetries = targetRetries + 1;
  } else {
    opts.rateLimitRetries = DEFAULT_RATE_LIMIT_RETRIES;
  }

  // 429 backoff floor: explicit wins; else default UNLESS the user pinned maxDelayMs.
  if (typeof retry?.rateLimitMinDelayMs === "number") opts.rateLimitMinDelayMs = retry.rateLimitMinDelayMs;
  else if (typeof retry?.maxDelayMs !== "number") opts.rateLimitMinDelayMs = DEFAULT_RATE_LIMIT_MIN_DELAY_MS;
  opts.rateLimitMaxServerDelayMs = DEFAULT_RATE_LIMIT_MAX_SERVER_DELAY_MS;

  // Config-driven fail-fast overrides: a status in `failFastStatuses` or a message
  // matching any `failFastPattern` is forced non-retryable, layered on top of the
  // chosen predicate (which still decides everything else). gjc parity for pinning a
  // normally-transient class (e.g. 503) to abort instead of riding the backoff ladder.
  const failFastStatuses = retry?.failFastStatuses;
  const failFastPatterns = retry?.failFastPatterns;
  if ((failFastStatuses && failFastStatuses.length > 0) || (failFastPatterns && failFastPatterns.length > 0)) {
    const base = opts.isRetryable ?? defaultRetryable;
    const statusSet = new Set(failFastStatuses ?? []);
    const lowered = (failFastPatterns ?? []).map(p => p.toLowerCase());
    opts.isRetryable = (err: unknown, attempt: number): boolean => {
      if (err && typeof err === "object") {
        const raw = (err as { status?: unknown }).status;
        const status = typeof raw === "number" ? raw : (typeof raw === "string" ? Number(raw) : NaN);
        if (!Number.isNaN(status) && statusSet.has(status)) return false;
      }
      if (lowered.length > 0) {
        const msg = err instanceof Error
          ? err.message
          : (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
            ? (err as { message: string }).message
            : String(err));
        const lowerMsg = msg.toLowerCase();
        if (lowered.some(p => lowerMsg.includes(p))) return false;
      }
      return base(err, attempt);
    };
  }

  return opts;
}

/**
 * Pick the credential to actually use for a provider call / live discovery.
 * An API key is the broader, documented path, so it wins whenever present.
 * Every bundled OAuth flow is now served end-to-end (Anthropic Messages,
 * OpenAI ChatGPT/Codex Responses, Gemini/Antigravity Cloud Code Assist); the
 * guard below only fires for a future flow that ships before its adapter.
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
    if (isOAuthProvider(provider) && OAUTH_FLOW_REGISTRY[provider].verifiedEndToEnd === false) {
      throw new Error(
        `Provider '${provider}' has only an OAuth token, but its OAuth backend is not compatible with the bundled adapter. Set ${provider.toUpperCase()}_API_KEY (or run 'jeo setup') to use ${model}.`,
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

/**
 * The credential to actually use for a provider call. A configured local OpenAI-compatible base
 * URL must use the standard /chat/completions path, but the openai adapter dispatches on
 * `credential.kind === "oauth"` → the hardcoded Codex backend, which drops the base URL. So when a
 * base URL is set we downgrade an OAuth credential to the configured api key, else keyless — making
 * discovery (which honors the base URL) and execution agree. All other cases pass through unchanged.
 */
export function credentialForCall(
  provider: ProviderName,
  effective: Credential,
  config: Pick<Config, "providers">,
  baseUrl: string | undefined,
): Credential {
  const isLocalOpenAi = provider === "openai" && !!baseUrl;
  if (isLocalOpenAi && effective.kind === "oauth") {
    return config.providers.openai
      ? { kind: "api_key", provider: "openai", token: config.providers.openai }
      : { kind: "none", provider: "openai" };
  }
  return effective;
}

async function resolveCall(options: Partial<CallOptions>, kind: "request" | "stream" = "request"): Promise<Resolved> {
  const config = await readGlobalConfig();
  const aliases = { ...((config as { modelAliases?: Record<string, string> }).modelAliases ?? {}) };
  const model = expandAlias(options.model ?? config.defaultModel, { ...ALIAS_DEFAULTS, ...aliases });
  const provider = resolveProvider(model);
  const adapter = providerRegistry.get(provider)!;

  const baseUrl =
    options.baseUrl ??
    (provider === "openai" ? config.openaiBaseUrl : undefined) ??
    (provider === "ollama" ? config.ollamaBaseUrl : undefined) ??
    (provider === "lmstudio" ? config.lmstudioBaseUrl : undefined);

  const callOptions: CallOptions = {
    // Map a catalog canonical (e.g. claude-3-5-sonnet) to the exact wire id the
    // provider accepts (claude-3-5-sonnet-20241022); live/provider ids pass through.
    model: providerModelFor(model),
    systemPrompt: options.systemPrompt,
    temperature: options.temperature ?? 0.2,
    maxTokens: options.maxTokens ?? thinkingMaxTokens(config.thinkingLevel),
    jsonMode: options.jsonMode,
    baseUrl,
    onUsage: options.onUsage,
    signal: options.signal,
    reasoningEffort: options.reasoningEffort ?? thinkingToReasoningEffort(config.thinkingLevel),
    onReasoning: options.onReasoning,
    tools: options.tools,
  };
  // Caller-supplied retry sink rides on the config-derived retry budget so the
  // engine/TUI can surface "rate limited — retrying in Ns" instead of a silent wait.
  // gjc parity: `requestMaxRetries` governs non-stream calls; `streamMaxRetries`
  // governs the stream site's replay-safe pre-first-chunk loop (retryableStream
  // never replays after the first emitted chunk). Both fall back to `maxRetries`,
  // and an unset stream budget keeps the conservative withRetry default — the
  // generous gjc default of 100 only applies when the user configures it.
  const retry: RetryOptions = { ...resolveRetryOptions(config.retry, kind), ...(options.onRetry ? { onRetry: options.onRetry } : {}) };

  if (provider === "ollama" || provider === "lmstudio") {
    return { adapter, callOptions, credential: { kind: "none", provider: "openai" }, retry };
  }

  if (provider === "xai") {
    const key = config.providers?.xai;
    if (!key) throw new Error("No credential for provider 'xai'. Set XAI_API_KEY (or providers.xai in config).");
    return { adapter, callOptions, credential: xaiCredential(key), retry };
  }

  if (provider === "antigravity") {
    // Prefer the dedicated Antigravity login (its client is what the agent
    // backend authorizes); fall back to a gemini-cli OAuth token for users with
    // their own project/permissions.
    let credential = await resolveCredential("antigravity");
    if (credential.kind !== "oauth") credential = await resolveCredential("gemini");
    if (credential.kind !== "oauth") {
      throw new Error("Antigravity models use Google OAuth. Run 'jeo auth login antigravity' (recommended) or 'jeo auth login gemini', then retry — the Google Cloud projectId is discovered automatically.");
    }
    return { adapter, callOptions, credential, retry };
  }

  const credentialProvider = provider as AuthProvider;
  const credential = await resolveCredential(credentialProvider);
  const effective = effectiveCredentialForProvider(credentialProvider, credential, config, model);
  const isLocalOpenAi = provider === "openai" && !!baseUrl;
  if (provider === "openai" && effective.kind === "oauth" && !isLocalOpenAi && !CODEX_MODELS.includes(model)) {
    throw new Error(
      "OpenAI OAuth 자격증명은 Codex 모델(gpt-5.5/gpt-5.4)만 지원. OPENAI_API_KEY를 설정하거나 모델을 변경하세요"
    );
  }
  if (effective.kind === "none" && !isLocalOpenAi) {
    throw new Error(
      `No credential for provider '${provider}'. Run 'jeo setup', 'jeo auth login', or set ${provider.toUpperCase()}_API_KEY / ${provider.toUpperCase()}_OAUTH_TOKEN.`
    );
  }
  return { adapter, callOptions, credential: credentialForCall(provider, effective, config, baseUrl), retry };
}

/** Hard cap for a single non-streaming provider request (service-readiness: a
 *  blackholed/unreachable provider must not hang the agent or `jeo team`). */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** Per-chunk idle cap for streaming: a stream that emits NOTHING for this long is
 *  aborted, but a healthy long generation (chunks keep arriving) runs unbounded —
 *  unlike a single wall-clock cap that would kill a long-but-active stream.
 *  Opt-in override via JEO_STREAM_IDLE_MS for reasoning workloads whose "thinking"
 *  phase can legitimately emit no visible token for longer than the default. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Combine two abort signals into one. Preserves BOTH even when `AbortSignal.any`
 *  is unavailable (manual fallback), so neither the caller's cancel nor the timeout
 *  is silently dropped. */
function composeAbort(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([a, b]);
  if (a.aborted || b.aborted) return AbortSignal.abort();
  const ctrl = new AbortController();
  // Memory hygiene: `a` is typically the TURN-long abort signal — a once-listener
  // per model call would otherwise accumulate on it for the whole turn. Detach
  // BOTH listeners as soon as either side fires.
  const onAbort = () => {
    a.removeEventListener("abort", onAbort);
    b.removeEventListener("abort", onAbort);
    ctrl.abort();
  };
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}

/** Compose the caller's signal (if any) with a fresh per-attempt timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return composeAbort(signal, AbortSignal.timeout(ms));
}

/**
 * Stream wrapper that retries ONLY the initial connection — before any chunk is
 * yielded — so a transient 429/5xx on stream connect recovers (the non-streaming
 * call path already retried; the stream path previously had no retry). A failure
 * after the first token propagates (retrying would duplicate emitted output).
 */
export interface StreamIdleOptions {
  /** Abort + reject if no chunk arrives within this many ms (per-chunk, not total). */
  idleMs: number;
  /** Optional OVERALL wall-clock deadline (epoch ms) — round-14, architect #7.
   *  Default absent: per-chunk idle alone keeps long ACTIVE generations alive.
   *  Non-interactive contexts opt in (JEO_STREAM_MAX_MS) so a slow-drip stream
   *  (one token every idleMs-ε) cannot run unbounded. */
  deadlineAt?: number;
  onIdle?: () => void;
}

/** `iter.next()`, racing the per-chunk idle timeout AND (when set) the overall deadline. */
async function nextMaybeIdle(iter: AsyncIterator<string>, idle?: StreamIdleOptions): Promise<IteratorResult<string>> {
  if (!idle) return iter.next();
  const remaining = idle.deadlineAt !== undefined ? idle.deadlineAt - Date.now() : Infinity;
  if (remaining <= 0) {
    idle.onIdle?.();
    throw new Error(`stream exceeded the overall deadline (JEO_STREAM_MAX_MS) — slow-drip stream aborted`);
  }
  const waitMs = Math.min(idle.idleMs, remaining);
  const deadlineFires = remaining < idle.idleMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      idle.onIdle?.();
      reject(new Error(deadlineFires
        ? `stream exceeded the overall deadline (JEO_STREAM_MAX_MS) — slow-drip stream aborted`
        : `stream idle for ${idle.idleMs}ms (no chunk) — provider sent no token within the idle window (load or long thinking); retrying. Raise JEO_STREAM_IDLE_MS or lower the thinking level if this persists.`));
    }, waitMs);
  });
  try {
    return await Promise.race([iter.next(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Opt-in overall stream wall-clock from the environment; undefined = off (default). */
export function streamMaxMs(env?: Record<string, string | undefined>): number | undefined {
  const raw = jeoEnv("STREAM_MAX_MS", env);
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Per-chunk idle cap (ms) from the environment, falling back to the built-in default.
 *  Lets reasoning workloads whose "thinking" phase emits no visible token for a long
 *  time raise the stall threshold via JEO_STREAM_IDLE_MS without a code change. */
export function streamIdleMs(env?: Record<string, string | undefined>): number {
  const raw = jeoEnv("STREAM_IDLE_MS", env);
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : STREAM_IDLE_TIMEOUT_MS;
}

export async function* retryableStream(
  makeIter: () => AsyncIterator<string>,
  retry: RetryOptions,
  idle?: StreamIdleOptions,
): AsyncGenerator<string> {
  const { iter, first } = await withRetry(async () => {
    const it = makeIter();
    const f = await nextMaybeIdle(it, idle);
    return { iter: it, first: f };
  }, retry);
  if (!first.done) {
    yield first.value;
    for (let n = await nextMaybeIdle(iter, idle); !n.done; n = await nextMaybeIdle(iter, idle)) yield n.value;
  }
}

export function createModelManager(): ModelManager {
  return {
    resolveProvider,
    async call(messages, options = {}) {
      const { adapter, callOptions, credential, retry } = await resolveCall(options);
      return withRetry(() => adapter.call(messages, { ...callOptions, signal: withTimeout(callOptions.signal, DEFAULT_CALL_TIMEOUT_MS) }, credential), retry);
    },
    async *stream(messages, options = {}) {
      const { adapter, callOptions, credential, retry } = await resolveCall(options, "stream");
      if (adapter.stream) {
        const streamFn = adapter.stream.bind(adapter);
        // Per-attempt abort controller fired by the idle timeout — so a stalled stream
        // is cancelled, but a long, actively-emitting generation is NOT killed by a
        // total wall-clock cap. The caller's signal (Ctrl-C) is preserved via composeAbort.
        // JEO_STREAM_MAX_MS opts in to an OVERALL deadline (round-14): non-interactive
        // runs can bound a slow-drip stream the per-chunk idle alone never catches.
        let attempt: AbortController | null = null;
        const makeIter = () => {
          attempt = new AbortController();
          const signal = composeAbort(callOptions.signal, attempt.signal);
          return streamFn(messages, { ...callOptions, signal }, credential)[Symbol.asyncIterator]();
        };
        const maxMs = streamMaxMs();
        yield* retryableStream(makeIter, retry, {
          idleMs: streamIdleMs(),
          ...(maxMs !== undefined ? { deadlineAt: Date.now() + maxMs } : {}),
          onIdle: () => attempt?.abort(),
        });
      } else {
        // Fallback: providers without streaming yield the full response as one chunk.
        yield await withRetry(() => adapter.call(messages, { ...callOptions, signal: withTimeout(callOptions.signal, DEFAULT_CALL_TIMEOUT_MS) }, credential), retry);
      }
    },
  };
}
