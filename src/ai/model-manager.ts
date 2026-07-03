import { providerRegistry } from "./provider-registry";
import { OAUTH_FLOW_REGISTRY } from "../auth/flows";
import { readGlobalConfig } from "../agent/state";
import { resolveCredential, isOAuthProvider, type AuthProvider, type Credential } from "../auth";
import "./register-providers"; // side-effect: registers built-in adapters into providerRegistry
import type { CallOptions, Message, ProviderAdapter, ProviderName } from "./types";
import { expandAlias, resolveModelId, effectiveAliasesFor } from "./model-registry";
import { findCatalogEntry, type ModelCatalogEntry } from "./model-catalog-compat";
import { toProviderModel, CODEX_MODELS, KIMI_CODE_MODELS, findCatalogModel } from "./model-catalog";
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

/** Default cap for the catalog-derived output budget. 64k covers every real coding
 *  turn (large writes + deep adaptive thinking) while staying clear of the admission
 *  429 risk that a blanket 128k `max_tokens` carries on low-tier API keys. */
const DEFAULT_MAX_OUTPUT_CAP = 64_000;

/** Output-token budget for a call (gjc/omp parity): the model's CATALOG max-output,
 *  capped by JEO_MAX_OUTPUT_TOKENS (default 64k) — NOT the thinking-level table.
 *
 *  Rationale: on Anthropic adaptive-thinking models (Sonnet/Fable/Mythos 5, Opus 4.6+)
 *  thinking tokens are spent INSIDE `max_tokens`. Deriving `max_tokens` from the
 *  thinking level (4k–32k) makes thinking and the visible reply compete for the same
 *  small budget, so a deep-thinking step dies with `stop_reason=max_tokens` and no
 *  content ("output budget exhausted" dead turns). The thinking level keeps steering
 *  DEPTH via reasoningEffort/output_config; it no longer constrains output size.
 *  Uncatalogued models (local/live ids) keep the legacy thinking-table budget. */
export function resolveMaxOutputTokens(
  model?: string,
  level?: "minimal" | "low" | "medium" | "high" | "xhigh",
): number {
  const meta = model ? findCatalogEntry(expandAlias(model, ALIAS_DEFAULTS)) : undefined;
  if (!meta) return thinkingMaxTokens(level);
  const envCap = Number(jeoEnv("MAX_OUTPUT_TOKENS"));
  const cap = Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_MAX_OUTPUT_CAP;
  return Math.min(findCatalogModel(meta.id)?.maxOutputTokens ?? cap, cap);
}

/** Map the thinking level to an OpenAI reasoning-effort tier. minimal/low/medium/high pass
 *  through unchanged and xhigh folds to high (the deepest tier the provider APIs accept), so
 *  reasoning works at EVERY thinking level (gajae parity: minimal is a real effort). Only an
 *  unset level returns undefined (reasoning off — the explicit /fast path). */
export function thinkingToReasoningEffort(
  level?: "minimal" | "low" | "medium" | "high" | "xhigh",
): "minimal" | "low" | "medium" | "high" | undefined {
  if (!level) return undefined;
  return level === "xhigh" ? "high" : level;
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

const ALIAS_DEFAULTS = { fast: "ollama/qwen2.5:0.5b", local: "ollama/qwen2.5:0.5b", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-6", haiku: "claude-haiku-4-5", gpt: "gpt-5.5", flash: "gemini-2.5-flash", grok: "grok-4.3" };

/**
 * Build retry options from a config `retry` budget (gjc parity). `requestMaxRetries`
 * counts retries (not the initial request), so total `withRetry` attempts =
 * requestMaxRetries + 1. When unset, the `withRetry` defaults apply (3 attempts),
 * but rate-limit (429) errors get a more generous budget + a backoff floor so a
 * transient per-minute window can clear instead of the very first 429 instantly
 * exhausting auto-retry. A server-directed retry delay is honored IN FULL — no
 * default ceiling — because a generic 429 is retried forever, not treated as fatal
 * past some arbitrary budget (gjc parity: even a multi-hour Anthropic rate-limit
 * window is retried, not bailed on); `rateLimitMaxServerDelayMs` remains available
 * as an explicit opt-in for a caller that truly cannot wait that long. Explicit
 * config (`requestMaxRetries`/`maxDelayMs`) always wins and disables the matching
 * rate-limit default. `maxDelayMs` caps per-attempt backoff when provided.
 */
const DEFAULT_RATE_LIMIT_RETRIES = 6; // total attempts for 429 (initial + 5 retries)
// 429 floor when the server sends no Retry-After. Escalates per attempt inside
// withRetry (2s → 4s → 8s → 16s → 30s ≈ 60s total), spanning a per-minute window.
const DEFAULT_RATE_LIMIT_MIN_DELAY_MS = 2000;
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
  // No default `rateLimitMaxServerDelayMs` ceiling: gjc parity retries a generic 429
  // forever, honoring however long the server asks (see the doc comment above). Usage
  // limits fail fast on their own via isUsageLimitError → defaultRetryable, well before a
  // wait is ever computed, so this is safe. An explicit config value is still honored for
  // a caller that truly cannot wait an unbounded server-directed delay.
  if (typeof retry?.rateLimitMaxServerDelayMs === "number") opts.rateLimitMaxServerDelayMs = retry.rateLimitMaxServerDelayMs;

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
 * Whether the bundled adapter can serve this provider+model over OAuth end-to-end.
 * OpenAI OAuth (ChatGPT/Codex) only serves Codex models, so any other OpenAI model
 * must use an API key. Kimi OAuth (Kimi Code subscription) only serves the Kimi Code
 * catalog (api.kimi.com/coding) — Moonshot API-platform ids (kimi-latest, moonshot-v1-*)
 * need a KIMI_API_KEY. A provider whose OAuth backend is not verified end-to-end
 * cannot serve any model over OAuth. Everything else (Anthropic Messages, Gemini /
 * Antigravity Cloud Code Assist) is served end-to-end.
 */
function oauthServesModel(provider: AuthProvider, model: string): boolean {
  if (provider === "openai") return CODEX_MODELS.includes(model);
  if (provider === "kimi") {
    const wire = model.startsWith("kimi/") ? model.slice(5) : model;
    return KIMI_CODE_MODELS.includes(wire);
  }
  if (isOAuthProvider(provider) && OAUTH_FLOW_REGISTRY[provider].verifiedEndToEnd === false) return false;
  return true;
}

/**
 * Pick the credential to actually use for a provider call / live discovery.
 * OAuth is the user's explicit login, so it wins whenever the bundled adapter can
 * serve the requested model over OAuth — even when an API key is also configured
 * (e.g. a leftover env var). Only when OAuth cannot serve the model do we fall back
 * to the API key, and only then surface the OAuth-incompatibility error.
 */
export function effectiveCredentialForProvider(
  provider: AuthProvider,
  credential: Credential,
  config: Pick<Config, "providers">,
  model: string,
): Credential {
  if (credential.kind === "oauth") {
    if (oauthServesModel(provider, model)) return credential;
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
    maxTokens: options.maxTokens ?? resolveMaxOutputTokens(model, config.thinkingLevel),
    jsonMode: options.jsonMode,
    baseUrl,
    numCtx: options.numCtx ?? (provider === "ollama" ? (config as { ollamaNumCtx?: number }).ollamaNumCtx : undefined),
    onUsage: options.onUsage,
    signal: options.signal,
    reasoningEffort: options.reasoningEffort ?? thinkingToReasoningEffort(config.thinkingLevel),
    onReasoning: options.onReasoning,
    onReasoningArtifact: options.onReasoningArtifact,
    tools: options.tools,
    sessionKey: options.sessionKey,
  };
  // Caller-supplied retry sink rides on the config-derived retry budget so the
  // engine/TUI can surface "rate limited — retrying in Ns" instead of a silent wait.
  // gjc parity: `requestMaxRetries` governs non-stream calls; `streamMaxRetries`
  // governs the stream site's replay-safe pre-first-chunk loop (retryableStream
  // never replays after the first emitted chunk). Both fall back to `maxRetries`,
  // and an unset stream budget keeps the conservative withRetry default — the
  // generous gjc default of 100 only applies when the user configures it.
  // `retry.signal` is the caller's ORIGINAL signal (Ctrl-C / turn abort) — not the
  // per-attempt fetch timeout composed below — so a long, honored server-directed
  // retry wait (see resolveRetryOptions) can still be cancelled by the user without
  // waiting out the full delay, while a single attempt's timeout never cuts short
  // the NEXT attempt's backoff sleep.
  const retry: RetryOptions = { ...resolveRetryOptions(config.retry, kind), ...(options.onRetry ? { onRetry: options.onRetry } : {}), ...(callOptions.signal ? { signal: callOptions.signal } : {}) };

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
  if (provider === "kimi" && effective.kind === "oauth" && !oauthServesModel("kimi", model)) {
    throw new Error(
      `Kimi OAuth (Kimi Code subscription) serves only the Kimi Code models (${KIMI_CODE_MODELS.join(", ")}). Set KIMI_API_KEY for Moonshot API models, or pick a Kimi Code model with /model.`,
    );
  }
  if (effective.kind === "none" && !isLocalOpenAi) {
    throw new Error(
      `No credential for provider '${provider}'. Run 'jeo setup', 'jeo auth login', or set ${provider.toUpperCase()}_API_KEY / ${provider.toUpperCase()}_OAUTH_TOKEN.`
    );
  }
  return { adapter, callOptions, credential: credentialForCall(provider, effective, config, baseUrl), retry };
}

/** Hard wall-clock cap for a single NON-streaming provider request (service-readiness: a
 *  blackholed/unreachable provider must not hang the agent or `jeo team`). Unlike the
 *  streaming idle watchdog, this path collects an opaque buffered body (`response.json()`,
 *  or an internally-streamed collect in codexResponsesCall / antigravity.call) and exposes
 *  no per-chunk signal — so a wall clock is the only lever and a wire heartbeat cannot help.
 *  Raised to 300s to match STREAM_IDLE_TIMEOUT_MS: non-interactive turns (callLlm WITHOUT
 *  onToken — compaction, ralplan, deep-interview, memory distill, goal-verify, and subagent/
 *  autopilot engine steps) route here, and a long reasoning completion legitimately exceeds
 *  120s; too-tight, it aborts an alive call, retries re-incur the same slow request, the
 *  attempt budget exhausts, and the turn STOPS — the same false-failure the streaming
 *  watchdog guards, on the path the wire heartbeat never reaches. */
const DEFAULT_CALL_TIMEOUT_MS = 300_000;

/** Per-chunk idle cap for streaming: a stream that emits NOTHING for this long is
 *  aborted, but a healthy long generation (chunks keep arriving) runs unbounded —
 *  unlike a single wall-clock cap that would kill a long-but-active stream.
 *  Set to 300s (not 120s): the wire-level heartbeat already re-arms this watchdog on
 *  ANY bytes (keepalive/ping) from remote providers, so this cap now only bites the
 *  GENUINELY-silent case — chiefly local backends (Ollama / llama.cpp) whose model
 *  load + prompt-eval before the first token emits zero bytes and no keepalive, and
 *  can easily exceed 120s on modest hardware or a large context. A too-tight cap there
 *  aborts an alive-but-quiet generation, retries re-incur the same slow first byte, the
 *  attempt budget exhausts, and the turn STOPS — the exact false-failure this guards.
 *  Opt-in override via JEO_STREAM_IDLE_MS for reasoning/local workloads whose silent
 *  phase runs longer still; Ctrl-C remains the interactive escape for a truly dead one. */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

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
  /** Epoch-ms of the most recent stream ACTIVITY, including reasoning/thinking deltas
   *  that are routed to onReasoning and never yielded as a chunk. A long "thinking"
   *  phase that streams thought tokens keeps bumping this, so the per-chunk idle
   *  watchdog re-arms instead of falsely aborting an actively-reasoning stream. Absent
   *  → only a yielded chunk counts as activity (legacy behaviour). */
  lastActivityAt?: () => number;
  onIdle?: () => void;
}

/** Handle returned by {@link idleWatchdog}: the racing promise, its cleanup, and a
 *  `touch()` to call after each successfully received chunk. */
export interface StreamWatchdogHandle {
  promise: Promise<never>;
  cleanup: () => void;
  touch: () => void;
}

/** One watchdog per stream attempt. Reused across `iter.next()` calls so a busy
 *  stream does not allocate a Promise+timer pair per yielded chunk.
 *
 *  Idle measurement fallback: when the caller has no `lastActivityAt` (the common
 *  case — most providers never wire reasoning-progress tracking), idle time MUST be
 *  measured against the last moment a chunk actually arrived, not against `Date.now()`
 *  re-sampled on every internal re-arm — the latter makes `now - lastAct` collapse to
 *  ~0 forever, so the idle timer can never fire and a genuinely stalled stream hangs
 *  forever instead of timing out. `touch()` (called by the consumer after each
 *  received chunk) advances this fallback baseline; `lastActivityAt`, when provided,
 *  always takes precedence (reasoning-progress tracking is more precise). */
function idleWatchdog(idle: StreamIdleOptions): StreamWatchdogHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastChunkAt = Date.now();
  const promise = new Promise<never>((_, reject) => {
    const arm = () => {
      const now = Date.now();
      const overallRemaining = idle.deadlineAt !== undefined ? idle.deadlineAt - now : Infinity;
      if (overallRemaining <= 0) {
        idle.onIdle?.();
        reject(new Error(`stream exceeded the overall deadline (JEO_STREAM_MAX_MS) — slow-drip stream aborted`));
        return;
      }
      const lastAct = idle.lastActivityAt ? idle.lastActivityAt() : lastChunkAt;
      const idleRemaining = idle.idleMs - (now - lastAct);
      const wait = Math.min(idleRemaining, overallRemaining);
      if (wait <= 0) {
        idle.onIdle?.();
        reject(new Error(`stream idle for ${idle.idleMs}ms (no chunk) — provider sent no token within the idle window (load or long thinking); retrying. Raise JEO_STREAM_IDLE_MS or lower the thinking level if this persists.`));
        return;
      }
      timer = setTimeout(arm, wait);
    };
    arm();
  });
  return { promise, cleanup: () => clearTimeout(timer), touch: () => { lastChunkAt = Date.now(); } };
}

/** `iter.next()`, racing the stream-attempt watchdog AND (when set) the overall deadline.
 *  The watchdog re-arms while reasoning activity (idle.lastActivityAt) keeps advancing,
 *  so a model that streams thinking tokens for longer than idleMs before emitting visible
 *  text is NOT mistaken for a stalled stream — only a genuinely silent stream aborts. */
async function nextMaybeIdle(iter: AsyncIterator<string>, watchdog?: Promise<never>): Promise<IteratorResult<string>> {
  if (!watchdog) return iter.next();
  return Promise.race([iter.next(), watchdog]);
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

/** Hard wall-clock cap (ms) for a NON-streaming provider call, falling back to the
 *  built-in default. Mirrors streamIdleMs so a slow non-interactive turn (callLlm without
 *  onToken) can relax the cap via JEO_CALL_TIMEOUT_MS without a code change. */
export function callTimeoutMs(env?: Record<string, string | undefined>): number {
  const raw = jeoEnv("CALL_TIMEOUT_MS", env);
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CALL_TIMEOUT_MS;
}

export async function* retryableStream(
  makeIter: () => AsyncIterator<string>,
  retry: RetryOptions,
  idle?: StreamIdleOptions,
): AsyncGenerator<string> {
  let cleanupWatchdog = () => {};
  let touchWatchdog = () => {};
  try {
    const { iter, first, watchdog } = await withRetry(async () => {
      cleanupWatchdog();
      const it = makeIter();
      const w = idle ? idleWatchdog(idle) : undefined;
      cleanupWatchdog = w?.cleanup ?? (() => {});
      touchWatchdog = w?.touch ?? (() => {});
      const f = await nextMaybeIdle(it, w?.promise);
      if (!f.done) touchWatchdog();
      return { iter: it, first: f, watchdog: w?.promise };
    }, retry);
    if (!first.done) {
      yield first.value;
      for (;;) {
        const n = await nextMaybeIdle(iter, watchdog);
        if (n.done) break;
        touchWatchdog();
        yield n.value;
      }
    }
  } finally {
    cleanupWatchdog();
  }
}

export function createModelManager(): ModelManager {
  return {
    resolveProvider,
    async call(messages, options = {}) {
      const { adapter, callOptions, credential, retry } = await resolveCall(options);
      return withRetry(() => adapter.call(messages, { ...callOptions, signal: withTimeout(callOptions.signal, callTimeoutMs()) }, credential), retry);
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
        // Heartbeat: a long server-side "thinking" phase emits no yielded chunk, so the
        // idle watchdog would otherwise look stalled and trip a false idle-stall retry.
        // Two heartbeat sources bump lastActivityAt: (1) reasoning/thinking deltas routed
        // to onReasoning, and (2) onStreamActivity — the wire-level heartbeat fired on ANY
        // bytes from the provider stream (SSE keepalive/ping comments, events that never
        // become a chunk). The watchdog re-arms while ANY activity advances and aborts only
        // a genuinely dead stream (zero bytes for the idle window).
        let lastActivityAt = Date.now();
        const bump = () => { lastActivityAt = Date.now(); };
        const userOnReasoning = callOptions.onReasoning;
        const userOnReasoningStart = callOptions.onReasoningStart;
        const liveOptions: CallOptions = {
          ...callOptions,
          onReasoning: (delta: string) => { bump(); userOnReasoning?.(delta); },
          onReasoningStart: () => { bump(); userOnReasoningStart?.(); },
          // Wire-level heartbeat: ANY bytes from the provider stream (SSE keepalive/ping
          // comments, events that never become a chunk) stamp activity, so the idle
          // watchdog re-arms for a connected-but-quiet stream and aborts only a dead one.
          onStreamActivity: bump,
        };
        const makeIter = () => {
          attempt = new AbortController();
          const signal = composeAbort(callOptions.signal, attempt.signal);
          return streamFn(messages, { ...liveOptions, signal }, credential)[Symbol.asyncIterator]();
        };
        const maxMs = streamMaxMs();
        yield* retryableStream(makeIter, retry, {
          idleMs: streamIdleMs(),
          ...(maxMs !== undefined ? { deadlineAt: Date.now() + maxMs } : {}),
          lastActivityAt: () => lastActivityAt,
          onIdle: () => attempt?.abort(),
        });
      } else {
        // Fallback: providers without streaming yield the full response as one chunk.
        yield await withRetry(() => adapter.call(messages, { ...callOptions, signal: withTimeout(callOptions.signal, callTimeoutMs()) }, credential), retry);
      }
    },
  };
}
