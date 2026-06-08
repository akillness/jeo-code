/**
 * Live model discovery — query a provider's `models` endpoint with the resolved
 * credential (OAuth bearer or API key) and return the model ids the account can
 * actually use. This powers the TUI `/models` / `/model` / `/provider` flows and
 * `joc models`, so users pick from the real, logged-in catalog instead of a
 * static alias guess.
 *
 * Network access is injectable (`fetchImpl`) and every call is timeout-bounded so
 * the TUI never hangs; failures degrade to a tagged result, never a throw.
 */
import { readGlobalConfig, type Config } from "../agent/state";
import { resolveCredential, type AuthProvider, type Credential } from "../auth";
import type { ProviderName } from "./types";
import { PROVIDER_NAMES } from "./provider-status";
import { catalogByProvider } from "./model-catalog";

export interface ProviderModelsResult {
  provider: ProviderName;
  /** Discovered model ids (provider-qualified where the router expects it). */
  models: string[];
  ok: boolean;
  /** How the request authenticated (for display). */
  source: "oauth" | "api_key" | "keyless" | "none";
  /** Present on failure: a short, human-readable reason. */
  error?: string;
  /** True when the live endpoint was unusable and ids came from the static catalog. */
  fallback?: boolean;
}

export interface DiscoveryOptions {
  baseUrl?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout; default 5000ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Cap the number of returned ids per provider; default 100. */
  limit?: number;
  /** Config snapshot used for provider base URLs. */
  config?: Config;
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_LIMIT = 100;

function anthropicHeaders(cred: Credential): Record<string, string> {
  if (cred.kind === "oauth") {
    return { authorization: `Bearer ${cred.token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" };
  }
  if (cred.kind === "api_key") {
    return { "x-api-key": cred.token, "anthropic-version": "2023-06-01" };
  }
  return {};
}

/** Build the discovery request (url + headers) for a provider/credential. */
export function discoveryRequest(
  provider: ProviderName,
  cred: Credential | undefined,
  baseUrl?: string,
): { url: string; headers: Record<string, string> } {
  switch (provider) {
    case "anthropic":
      return { url: "https://api.anthropic.com/v1/models", headers: anthropicHeaders(cred!) };
    case "openai": {
      const base = (baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
      const token = cred?.kind === "oauth" || cred?.kind === "api_key" ? cred.token : "";
      return { url: `${base}/models`, headers: token ? { Authorization: `Bearer ${token}` } : {} };
    }
    case "gemini": {
      const oauth = cred?.kind === "oauth" ? cred.token : undefined;
      const apiKey = cred?.kind === "api_key" ? cred.token : undefined;
      const url = oauth
        ? "https://generativelanguage.googleapis.com/v1beta/models"
        : `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey ?? ""}`;
      return { url, headers: oauth ? { authorization: `Bearer ${oauth}` } : {} };
    }
    case "ollama": {
      const base = (baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
      return { url: `${base}/api/tags`, headers: {} };
    }
  }
}

/**
 * OpenAI `/v1/models` lists every model family — embeddings, audio/tts, image, moderation,
 * realtime — but joc only calls chat/completions. Drop the families that can never serve a
 * chat turn so pickers never offer a model that fails at call time.
 */
function isOpenAiChatModel(id: string): boolean {
  return !/(^|[-/])(text-embedding|embedding|tts|whisper|dall-e|moderation|omni-moderation|davinci|babbage|computer-use|realtime|audio|image|sora|transcribe|search|codex)([-/]|$)/i.test(id);
}

/**
 * Gemini exposes generateContent for image/tts/embedding variants too, but those emit
 * audio/image/vectors — not a usable text turn for a coding chat. Drop them by family.
 */
function isGeminiChatModel(id: string): boolean {
  return !/(^|[-/])(embedding|aqa|tts|image|imagen|veo|learnlm)([-/]|$)/i.test(id);
}

/** Parse a provider's models response body into normalized, chat-capable model ids. */
export function parseModelsBody(provider: ProviderName, body: unknown): string[] {
  const data = body as {
    data?: { id?: string }[];
    models?: { name?: string; supportedGenerationMethods?: string[] }[];
  };
  if (provider === "ollama") {
    return (data.models ?? []).map(m => `ollama/${m.name ?? ""}`).filter(s => s !== "ollama/");
  }
  if (provider === "gemini") {
    // Keep only models the generateContent endpoint can serve (skip embeddings/tts/aqa/etc).
    // When the list omits supportedGenerationMethods, keep the id (be permissive).
    return (data.models ?? [])
      .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
      .map(m => (m.name ?? "").replace(/^models\//, ""))
      .filter(id => id && isGeminiChatModel(id));
  }
  // anthropic / openai: { data: [{ id }] }
  const ids = (data.data ?? []).map(m => m.id ?? "").filter(Boolean);
  return provider === "openai" ? ids.filter(isOpenAiChatModel) : ids;
}

/**
 * When a provider is authenticated (oauth/api_key) but the live `models` endpoint
 * is unusable — e.g. ChatGPT/Codex OAuth tokens are rejected by `api.openai.com/v1/models`
 * — surface the static catalog ids so the provider's models still appear in pickers.
 * Keyless/not-logged-in results are returned unchanged.
 */
export function catalogOr(result: ProviderModelsResult): ProviderModelsResult {
  if (result.ok && result.models.length > 0) return result;
  // Only OAuth tokens legitimately fail the *list* endpoint while still working for
  // chat (ChatGPT/Codex). An api_key rejection means a bad/invalid key — never paper
  // over that with catalog rows, or the user picks a model that cannot authenticate.
  if (result.source !== "oauth") return result;
  const ids = catalogByProvider(result.provider).map(m => m.providerModel);
  if (ids.length === 0) return result;
  return { ...result, models: ids, ok: true, fallback: true };
}

/** Discover the live model list for one provider. Never throws. */
export async function listProviderModels(
  provider: ProviderName,
  opts: DiscoveryOptions = {},
): Promise<ProviderModelsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  let cred: Credential | undefined;
  let source: ProviderModelsResult["source"] = "keyless";
  if (provider !== "ollama") {
    const raw = await resolveCredential(provider as AuthProvider);
    cred = raw;
    source = cred.kind === "oauth" ? "oauth" : cred.kind === "api_key" ? "api_key" : "none";
    const isLocalOpenAi = provider === "openai" && !!(opts.baseUrl ?? process.env.OPENAI_BASE_URL);
    if (source === "none" && !isLocalOpenAi) {
      return { provider, models: [], ok: false, source, error: "not logged in" };
    }
  }

  const { url, headers } = discoveryRequest(provider, cred, opts.baseUrl);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const signal = opts.signal ?? AbortSignal.timeout(timeout);
  try {
    const res = await fetchImpl(url, { headers, signal });
    if (!res.ok) {
      const reason = res.status === 401 || res.status === 403 ? "auth rejected" : `HTTP ${res.status}`;
      return { provider, models: [], ok: false, source, error: reason };
    }
    const body = await res.json();
    const models = parseModelsBody(provider, body).sort().slice(0, limit);
    return { provider, models, ok: true, source };
  } catch (err) {
    const msg = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError" ? "timeout" : "unreachable";
    return { provider, models: [], ok: false, source, error: msg };
  }
}

/**
 * Discover live models across providers. By default only queries providers that
 * are logged in / reachable (skips `none` cloud providers); ollama is always
 * probed. Runs in parallel.
 */
export async function discoverModels(
  opts: DiscoveryOptions & { providers?: ProviderName[]; config?: Config; catalogFallback?: boolean } = {},
): Promise<ProviderModelsResult[]> {
  const cfg = opts.config ?? (await readGlobalConfig());
  const providers = opts.providers ?? [...PROVIDER_NAMES];
  const useFallback = opts.catalogFallback !== false;
  const results = await Promise.all(
    providers.map(p =>
      listProviderModels(p, {
        ...opts,
        config: cfg,
        baseUrl: p === "ollama" ? (cfg.ollamaBaseUrl ?? opts.baseUrl) : p === "openai" ? (cfg.openaiBaseUrl ?? opts.baseUrl) : opts.baseUrl,
      }),
    ),
  );
  return useFallback ? results.map(catalogOr) : results;
}
