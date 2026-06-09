import { readGlobalConfig, readRawGlobalConfig, saveConfigPatch, type StoredOAuth } from "../agent/state";

export type AuthProvider = "anthropic" | "openai" | "gemini";

export type Credential =
  | { kind: "oauth"; provider: AuthProvider; token: string }
  | { kind: "api_key"; provider: AuthProvider; token: string }
  | { kind: "none"; provider: AuthProvider };

export interface AuthSnapshot {
  apiKey: string | undefined;
  oauth: string | undefined;
  /** Present only when the stored OAuth is a refreshable {@link StoredOAuth}. */
  oauthExpires?: number;
  oauthHasRefresh?: boolean;
  oauthEmail?: string;
}

const inFlightRefresh = new Map<AuthProvider, Promise<any>>();

function accessOf(stored: string | StoredOAuth | undefined): string | undefined {
  if (!stored) return undefined;
  return typeof stored === "string" ? stored : stored.access;
}

/** Single point of resolution: OAuth bearer beats API key when both exist. */
export async function resolveCredential(provider: AuthProvider): Promise<Credential> {
  const cfg = await readGlobalConfig();
  const stored = cfg.oauth?.[provider];

  if (stored) {
    // Auto-refresh refreshable credentials that are past their expiry.
    if (typeof stored !== "string" && stored.refresh && stored.expires && stored.expires <= Date.now()) {
      try {
        let refreshPromise = inFlightRefresh.get(provider);
        if (!refreshPromise) {
          refreshPromise = (async () => {
            const { refreshOAuthToken } = await import("./refresh");
            return refreshOAuthToken(provider);
          })();
          inFlightRefresh.set(provider, refreshPromise);
          // Cleanup must not create its own unobserved rejection if the refresh rejects.
          void refreshPromise.finally(() => {
            inFlightRefresh.delete(provider);
          }).catch(() => {});
        }
        const result = await refreshPromise;
        if (result.refreshed && result.credential.kind === "oauth") {
          return result.credential;
        }
      } catch {
        // Fall through and use the (stale) access token; the provider call will surface a 401.
      }
    }
    const token = accessOf(stored);
    if (token) return { kind: "oauth", provider, token };
  }

  const apiKey = cfg.providers[provider];
  if (apiKey) return { kind: "api_key", provider, token: apiKey };
  return { kind: "none", provider };
}

export async function snapshotProvider(provider: AuthProvider): Promise<AuthSnapshot> {
  const cfg = await readGlobalConfig();
  const stored = cfg.oauth?.[provider];
  return {
    apiKey: cfg.providers[provider],
    oauth: accessOf(stored),
    oauthExpires: typeof stored === "object" ? stored.expires : undefined,
    oauthHasRefresh: typeof stored === "object" ? !!stored.refresh : false,
    oauthEmail: typeof stored === "object" ? stored.email : undefined,
  };
}

/** Read the full stored OAuth record (object form only). */
export async function getStoredOAuth(provider: AuthProvider): Promise<StoredOAuth | undefined> {
  const cfg = await readGlobalConfig();
  const stored = cfg.oauth?.[provider];
  return typeof stored === "object" ? stored : undefined;
}

/** Persist a plain bearer token (legacy / manual paste — no refresh metadata). */
export async function setOauthToken(provider: AuthProvider, token: string): Promise<void> {
  // Persist onto the RAW on-disk config (not env-overlaid) so a short-lived
  // *_OAUTH_TOKEN env / OLLAMA_HOST / role tier is never baked into config.json.
  await saveConfigPatch(raw => ({ oauth: { ...(raw.oauth ?? {}), [provider]: token } }));
}

/** Persist a full OAuth credential set (access + refresh + expiry). */
export async function setOauthCredential(provider: AuthProvider, cred: StoredOAuth): Promise<void> {
  await saveConfigPatch(raw => ({ oauth: { ...(raw.oauth ?? {}), [provider]: cred } }));
}

export async function clearOauthToken(provider: AuthProvider): Promise<boolean> {
  const raw = await readRawGlobalConfig();
  if (!raw.oauth?.[provider]) return false;
  await saveConfigPatch(r => {
    const oauth = { ...(r.oauth ?? {}) };
    delete oauth[provider];
    return { oauth };
  });
  return true;
}

export async function setApiKey(provider: AuthProvider, key: string): Promise<void> {
  await saveConfigPatch(raw => ({ providers: { ...(raw.providers ?? {}), [provider]: key } }));
}
