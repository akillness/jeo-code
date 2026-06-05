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

export interface ProviderModelsResult {
  provider: ProviderName;
  /** Discovered model ids (provider-qualified where the router expects it). */
  models: string[];
  ok: boolean;
  /** How the request authenticated (for display). */
  source: "oauth" | "api_key" | "keyless" | "none";
  /** Present on failure: a short, human-readable reason. */
  error?: string;
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

/** Parse a provider's models response body into normalized model ids. */
export function parseModelsBody(provider: ProviderName, body: unknown): string[] {
  const data = body as { data?: { id?: string }[]; models?: { name?: string }[] };
  if (provider === "ollama") {
    return (data.models ?? []).map(m => `ollama/${m.name ?? ""}`).filter(s => s !== "ollama/");
  }
  if (provider === "gemini") {
    return (data.models ?? []).map(m => (m.name ?? "").replace(/^models\//, "")).filter(Boolean);
  }
  // anthropic / openai: { data: [{ id }] }
  return (data.data ?? []).map(m => m.id ?? "").filter(Boolean);
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
    cred = await resolveCredential(provider as AuthProvider);
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
  opts: DiscoveryOptions & { providers?: ProviderName[]; config?: Config } = {},
): Promise<ProviderModelsResult[]> {
  const cfg = opts.config ?? (await readGlobalConfig());
  const providers = opts.providers ?? [...PROVIDER_NAMES];
  return Promise.all(
    providers.map(p =>
      listProviderModels(p, {
        ...opts,
        baseUrl: p === "ollama" ? (cfg.ollamaBaseUrl ?? opts.baseUrl) : p === "openai" ? (cfg.openaiBaseUrl ?? opts.baseUrl) : opts.baseUrl,
      }),
    ),
  );
}
