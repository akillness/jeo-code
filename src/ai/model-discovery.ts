/**
 * Live model discovery — query a provider's `models` endpoint with the resolved
 * credential (OAuth bearer or API key) and return the model ids the account can
 * actually use. This powers the TUI `/model` and `/provider` flows, so users
 * pick from the real, logged-in catalog instead of a static alias guess.
 *
 * Network access is injectable (`fetchImpl`) and every call is timeout-bounded so
 * the TUI never hangs; failures degrade to a tagged result, never a throw.
 */
import { readGlobalConfig, type Config } from "../agent/state";
import { resolveCredential, type AuthProvider, type Credential } from "../auth";
import type { ProviderName } from "./types";
import { PROVIDER_NAMES } from "./provider-status";
import { catalogByProvider, CODEX_MODELS } from "./model-catalog";
import { extractChatgptAccountId } from "./providers/openai-responses";

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
// The Codex models endpoint REQUIRES `client_version` (HTTP 400 without it) and
// GATES the list by it — old versions get `{"models":[]}`. Keep this high enough
// to receive the full current list (verified live 2026-06-12: 0.46→[], 0.99→gpt-5.4,
// 1.0/2.0→full gpt-5.5 set). On drift the catalog fallback keeps Codex usable.
const CODEX_CLIENT_VERSION = "2.0.0";
const CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`;
const ANTIGRAVITY_MODELS_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const ANTIGRAVITY_MODEL_DENYLIST = new Set([
  "chat_20706",
  "chat_23310",
  "gemini-2.5-flash-thinking",
  "gemini-3-pro-low",
  "gemini-2.5-pro",
]);

function anthropicHeaders(cred: Credential): Record<string, string> {
  if (cred.kind === "oauth") {
    return { authorization: `Bearer ${cred.token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" };
  }
  if (cred.kind === "api_key") {
    return { "x-api-key": cred.token, "anthropic-version": "2023-06-01" };
  }
  return {};
}

function authProviderFor(provider: ProviderName): AuthProvider | undefined {
  // Local providers (ollama/lmstudio) are keyless and do not resolve through the
  // auth core. API-key providers (incl. xai/kimi) DO — so discovery sends their key.
  if (provider === "ollama" || provider === "lmstudio") return undefined;
  return provider;
}

/** Build the discovery request (url + headers) for a provider/credential. */
export function discoveryRequest(
  provider: ProviderName,
  cred: Credential | undefined,
  baseUrl?: string,
): { url: string; headers: Record<string, string>; method?: "GET" | "POST"; body?: string } {
  switch (provider) {
    case "anthropic":
      return { url: "https://api.anthropic.com/v1/models", headers: anthropicHeaders(cred!) };
    case "openai": {
      const token = cred?.kind === "oauth" || cred?.kind === "api_key" ? cred.token : "";
      if (cred?.kind === "oauth" && !baseUrl && !process.env.OPENAI_BASE_URL) {
        const accountId = extractChatgptAccountId(token);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          "OpenAI-Beta": "responses=experimental",
          originator: "codex_cli_rs",
        };
        if (accountId) headers["chatgpt-account-id"] = accountId;
        return { url: CODEX_MODELS_URL, headers };
      }
      const base = (baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
      return { url: `${base}/models`, headers: token ? { Authorization: `Bearer ${token}` } : {} };
    }
    case "gemini": {
      const oauth = cred?.kind === "oauth" ? cred.token : undefined;
      const apiKey = cred?.kind === "api_key" ? cred.token : undefined;
      // pageSize=1000: the DEFAULT page is 50 models WITH a nextPageToken — the
      // single-shot fetch silently dropped everything past page 1 (verified live:
      // 50+token vs 55 total). listProviderModels also follows nextPageToken.
      const url = oauth
        ? "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
        : `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${apiKey ?? ""}`;
      return { url, headers: oauth ? { authorization: `Bearer ${oauth}` } : {} };
    }
    case "antigravity": {
      const token = cred?.kind === "oauth" ? cred.token : "";
      return {
        url: ANTIGRAVITY_MODELS_URL,
        headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json", "User-Agent": "antigravity/1.104.0" } : {},
        method: "POST",
        body: "{}",
      };
    }
    case "ollama": {
      const base = (baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
      return { url: `${base}/api/tags`, headers: {} };
    }
    case "lmstudio": {
      const base = (baseUrl ?? "http://localhost:1234/v1").replace(/\/$/, "");
      return { url: `${base}/models`, headers: {} };
    }
    case "xai": {
      const token = cred?.kind === "api_key" ? cred.token : "";
      return { url: "https://api.x.ai/v1/models", headers: token ? { Authorization: `Bearer ${token}` } : {} };
    }
    case "kimi": {
      const token = cred?.kind === "api_key" ? cred.token : "";
      return { url: "https://api.moonshot.ai/v1/models", headers: token ? { Authorization: `Bearer ${token}` } : {} };
    }
  }
}

/**
 * OpenAI `/v1/models` lists every model family — embeddings, audio/tts, image, moderation,
 * realtime — but jeo only calls chat/completions. Drop the families that can never serve a
 * chat turn so pickers never offer a model that fails at call time.
 */
function isOpenAiChatModel(id: string): boolean {
  return !/(^|[-/])(text-embedding|embedding|tts|whisper|dall-e|moderation|omni-moderation|davinci|babbage|computer-use|realtime|audio|image|sora|transcribe|instruct|codex)([-/]|$)/i.test(id);
}

/**
 * Gemini exposes generateContent for image/tts/embedding variants too, but those emit
 * audio/image/vectors — not a usable text turn for a coding chat. Drop them by family.
 */
function isGeminiChatModel(id: string): boolean {
  return !/(^|[-/])(embedding|aqa|tts|image|imagen|veo|lyria|nano-banana|deep-research|computer-use|antigravity)([-/]|$)/i.test(id);
}

type CodexModelRow = { slug?: string; id?: string; supported_in_api?: boolean; priority?: number };
type AntigravityModelRow = { slug?: string; id?: string; name?: string; isInternal?: boolean; model?: string };

/** Parse a provider's models response body into normalized, chat-capable model ids. */
export function parseModelsBody(provider: ProviderName, body: unknown): string[] {
  const data = body as {
    data?: { id?: string }[];
    models?: ({ name?: string; supportedGenerationMethods?: string[] } & CodexModelRow)[];
  };
  if (provider === "ollama") {
    return (data.models ?? []).map(m => `ollama/${m.name ?? ""}`).filter(s => s !== "ollama/");
  }
  if (provider === "lmstudio") {
    // LM Studio is OpenAI-compatible: { data: [{ id }] }. Qualify with the routing prefix.
    return (data.data ?? []).map(m => `lmstudio/${m.id ?? ""}`).filter(s => s !== "lmstudio/");
  }
  if (provider === "xai") {
    // xAI is OpenAI-compatible: { data: [{ id }] }. Grok ids route to xai by name, so no prefix.
    return (data.data ?? []).map(m => m.id ?? "").filter(Boolean);
  }
  if (provider === "kimi") {
    // Moonshot is OpenAI-compatible: { data: [{ id }] }. kimi/moonshot ids route by name.
    return (data.data ?? []).map(m => m.id ?? "").filter(Boolean);
  }
  if (provider === "antigravity") {
    // fetchAvailableModels keys the map by the CALLABLE model id (e.g.
    // "gemini-3-flash"); the entry's `model` field is an internal enum
    // (MODEL_PLACEHOLDER_*) and must never be surfaced. The response's OWN
    // metadata decides what to show — no hard-coded model lists:
    //  1. `agentModelSorts` groups are the API's positive agent/chat set
    //     (exactly what Antigravity's model picker offers) — prefer it.
    //  2. Otherwise fall back to excluding the API's non-chat role lists
    //     (tab completion, image generation, transcription, deprecations).
    const payload = body as {
      models?: Record<string, AntigravityModelRow> | AntigravityModelRow[];
      agentModelSorts?: { groups?: { modelIds?: string[] }[] }[];
      tabModelIds?: string[];
      imageGenerationModelIds?: string[];
      audioTranscriptionModelIds?: string[];
      commitMessageModelIds?: string[];
      mqueryModelIds?: string[];
      /** Array of ids OR an object keyed by deprecated id. */
      deprecatedModelIds?: string[] | Record<string, unknown>;
    };
    const roleIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const deprecated = Array.isArray(payload.deprecatedModelIds)
      ? roleIds(payload.deprecatedModelIds)
      : Object.keys(payload.deprecatedModelIds ?? {});
    const agentIds = new Set(
      (Array.isArray(payload.agentModelSorts) ? payload.agentModelSorts : [])
        .flatMap(sort => (Array.isArray(sort?.groups) ? sort.groups : []))
        .flatMap(group => roleIds(group?.modelIds)),
    );
    const nonChat = new Set([
      ...roleIds(payload.tabModelIds),
      ...roleIds(payload.imageGenerationModelIds),
      ...roleIds(payload.audioTranscriptionModelIds),
      ...roleIds(payload.commitMessageModelIds),
      ...roleIds(payload.mqueryModelIds),
      ...deprecated,
    ]);
    const rawModels = payload.models;
    const ids = Array.isArray(rawModels)
      ? rawModels.map(m => m.slug ?? m.id ?? m.name ?? "").filter(Boolean)
      : Object.entries(rawModels ?? {})
          .filter(([id, model]) =>
            !ANTIGRAVITY_MODEL_DENYLIST.has(id) &&
            model?.isInternal !== true &&
            (agentIds.size > 0 ? agentIds.has(id) : !nonChat.has(id)))
          .map(([id]) => id);
    return ids
      .map(id => id.replace(/^models\//, ""))
      .filter(Boolean)
      .map(id => id.startsWith("antigravity/") ? id : `antigravity/${id}`);
  }
  if (provider === "gemini") {
    // Keep only models the generateContent endpoint can serve (skip embeddings/tts/aqa/etc).
    // When the list omits supportedGenerationMethods, keep the id (be permissive).
    return (data.models ?? [])
      .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
      .map(m => (m.name ?? "").replace(/^models\//, ""))
      .filter(id => id && isGeminiChatModel(id));
  }
  if (provider === "openai" && data.models?.some(m => m.slug || m.id)) {
    return data.models
      .filter(m => m.supported_in_api !== false)
      .map(m => m.slug ?? m.id ?? "")
      // Review-only entries (e.g. codex-auto-review) are not chat-turn models.
      .filter(id => id && !/(^|[-/])auto-review([-/]|$)/i.test(id));
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
  // OpenAI/Codex OAuth legitimately rejects the standard /models endpoint while
  // the fixed Codex ids still work for calls. Other OAuth providers may fall
  // back to their static catalog too — EXCEPT Antigravity, whose available
  // models depend on the Cloud Code Assist agent backend and must not be faked.
  if (result.source !== "oauth") return result;
  if (result.provider === "antigravity") return result;
  const ids = result.provider === "openai" ? [...CODEX_MODELS] : catalogByProvider(result.provider).map(m => m.providerModel);
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
  if (provider === "xai") {
    // xAI (Grok) is API-key only and not an OAuth AuthProvider: resolve its key
    // directly from config/env instead of the AuthProvider credential store.
    const key = (opts.config ?? (await readGlobalConfig())).providers?.xai;
    if (!key) return { provider, models: [], ok: false, source: "none", error: "not logged in" };
    cred = { kind: "api_key", provider: "openai", token: key };
    source = "api_key";
  } else if (provider !== "ollama" && provider !== "lmstudio") {
    const authProvider = authProviderFor(provider);
    const raw = await resolveCredential(authProvider!);
    cred = raw;
    source = cred.kind === "oauth" ? "oauth" : cred.kind === "api_key" ? "api_key" : "none";
    const config = opts.config ?? (await readGlobalConfig());

    if (provider === "antigravity") {
      // Antigravity lists models from the LIVE Cloud Code Assist endpoint
      // (v1internal:fetchAvailableModels) — never from a hard-coded catalog.
      // A gemini-cli OAuth token is tried as a fallback credential for the
      // list call; if the backend rejects it the failure is surfaced honestly.
      if (cred.kind !== "oauth") {
        const gemini = await resolveCredential("gemini");
        if (gemini.kind === "oauth") {
          cred = gemini;
          source = "oauth";
        }
      }
      if (cred.kind !== "oauth") {
        return { provider, models: [], ok: false, source, error: "not logged in with Antigravity OAuth" };
      }
    }

    const prov = authProvider!;
    // Antigravity's list endpoint accepts ONLY OAuth (the request builder sends
    // no api-key header), so never swap its credential to an api_key.
    if (provider !== "antigravity" && cred.kind === "oauth" && config.providers?.[prov]) {
      // An API key is the broader, documented path — prefer it for live discovery.
      cred = { kind: "api_key", provider: prov, token: config.providers[prov]! };
      source = "api_key";
    }
    const isLocalOpenAi = provider === "openai" && !!(opts.baseUrl ?? process.env.OPENAI_BASE_URL);
    if (source === "none" && !isLocalOpenAi) {
      return { provider, models: [], ok: false, source, error: "not logged in" };
    }
  }

  const { url, headers, method, body: requestBody } = discoveryRequest(provider, cred, opts.baseUrl);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const signal = opts.signal ?? AbortSignal.timeout(timeout);
  try {
    const res = await fetchImpl(url, { method: method ?? "GET", headers, body: requestBody, signal });
    if (!res.ok) {
      const reason = res.status === 401 || res.status === 403 ? "auth rejected" : `HTTP ${res.status}`;
      return { provider, models: [], ok: false, source, error: reason };
    }
    const body = await res.json();
    let ids = parseModelsBody(provider, body);
    // Gemini paginates: follow nextPageToken (bounded) so the available list is
    // COMPLETE — page 1 alone silently dropped the newest models (round-15).
    if (provider === "gemini") {
      let pageToken = (body as { nextPageToken?: string })?.nextPageToken;
      for (let page = 0; pageToken && page < 4; page++) {
        const pagedUrl = `${url}&pageToken=${encodeURIComponent(pageToken)}`;
        const pageRes = await fetchImpl(pagedUrl, { method: "GET", headers, signal });
        if (!pageRes.ok) break; // partial list beats a hard failure
        const pageBody = await pageRes.json() as { nextPageToken?: string };
        ids = ids.concat(parseModelsBody(provider, pageBody));
        pageToken = pageBody.nextPageToken;
      }
    }
    const models = [...new Set(ids)].sort().slice(0, limit);
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
        baseUrl: p === "ollama" ? (cfg.ollamaBaseUrl ?? opts.baseUrl) : p === "lmstudio" ? (cfg.lmstudioBaseUrl ?? opts.baseUrl) : p === "openai" ? (cfg.openaiBaseUrl ?? opts.baseUrl) : opts.baseUrl,
      }),
    ),
  );
  return useFallback ? results.map(catalogOr) : results;
}
