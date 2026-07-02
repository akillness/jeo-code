import {
  getStoredOAuth,
  setOauthCredential,
  setOauthCredentialNoLock,
  resolveCredential,
  snapshotProvider,
  acquireLock,
  releaseLock,
  clearOauthToken,
  type AuthProvider,
  isOAuthProvider,
  type Credential,
} from "./storage";
import { OAUTH_FLOW_REGISTRY } from "./flows";
import { readGlobalConfig, type StoredOAuth } from "../agent/state";

// gjc auth-broker refresher parity: a refresh attempt fails either *definitively*
// (the refresh token itself is dead — invalid_grant / revoked / a 401-403 that is
// not a network blip) or *transiently* (timeout / connection reset). A definitive
// failure must stop us re-attempting a doomed refresh on every call; a transient
// one must leave the credential untouched for the next sweep.
const DEFINITIVE_REFRESH_RE = /invalid_grant|invalid_token|revoked|unauthorized|expired.*refresh|refresh.*expired/i;
const TRANSIENT_REFRESH_RE = /timeout|network|fetch failed|ECONNREFUSED/i;
const HTTP_401_403_RE = /\b(401|403)\b/;

/** Classify an OAuth refresh error as a dead-token ("definitive") vs retryable ("transient") failure. */
export function classifyRefreshFailure(err: unknown): "definitive" | "transient" {
  const msg = (err as Error)?.message ?? String(err);
  if (DEFINITIVE_REFRESH_RE.test(msg)) return "definitive";
  if (HTTP_401_403_RE.test(msg) && !TRANSIENT_REFRESH_RE.test(msg)) return "definitive";
  return "transient";
}

export interface RefreshResult {
  refreshed: boolean;
  reason: string;
  credential: Credential;
}

/** Refresh-ahead window: a token expiring within this many ms is treated as stale
 *  and refreshed NOW, so it never dies mid-request. gjc parity: auth-storage.ts
 *  OAUTH_REFRESH_SKEW_MS = 60_000. */
export const OAUTH_REFRESH_SKEW_MS = 60_000;

/**
 * Exchange the stored refresh token for a fresh access token via the provider's
 * real OAuth token endpoint, persist it, and return the updated credential.
 * Mirrors gjc's auth-broker refresher semantics (single source of truth).
 */
export async function refreshOAuthToken(provider: AuthProvider): Promise<RefreshResult> {
  // API-key-only providers (xai/kimi) have no OAuth flow — nothing to refresh.
  if (!isOAuthProvider(provider)) {
    return { refreshed: false, reason: "no_oauth_token", credential: await resolveCredential(provider) };
  }
  await acquireLock(provider);
  try {
    const stored = await getStoredOAuth(provider);
    if (!stored) {
      const snap = await snapshotProvider(provider);
      const reason = snap.oauth ? "manual_token_no_refresh" : "no_oauth_token";
      return { refreshed: false, reason, credential: await resolveCredential(provider) };
    }

    if (stored.expires && stored.expires > Date.now() + OAUTH_REFRESH_SKEW_MS) {
      return {
        refreshed: true,
        reason: "already_refreshed",
        credential: { kind: "oauth", provider, token: stored.access, projectId: stored.projectId },
      };
    }

    if (!stored.refresh) {
      return {
        refreshed: false,
        reason: "no_refresh_token",
        credential: { kind: "oauth", provider, token: stored.access, projectId: stored.projectId },
      };
    }

    const flow = OAUTH_FLOW_REGISTRY[provider];
    let fresh: Awaited<ReturnType<typeof flow.refresh>>;
    try {
      fresh = await flow.refresh(stored.refresh);
    } catch (err) {
      if (classifyRefreshFailure(err) === "definitive") {
        // Dead refresh token: re-attempting it on every resolution only burns a
        // round-trip and then emits an opaque stale-token 401. Clear it so the
        // next resolution degrades cleanly to an API key (or a logged-out state
        // that prompts re-login). Mirrors gjc auth-broker disableCredentialById.
        await clearOauthToken(provider);
        const cfg = await readGlobalConfig();
        const apiKey = cfg.providers[provider];
        return {
          refreshed: false,
          reason: "refresh_token_invalid",
          credential: apiKey
            ? { kind: "api_key", provider, token: apiKey }
            : { kind: "none", provider },
        };
      }
      // Transient failure: keep the credential and surface the stale access token
      // so the in-flight call can try once more; the next expiry sweep retries.
      return {
        refreshed: false,
        reason: "refresh_transient_error",
        credential: { kind: "oauth", provider, token: stored.access, projectId: stored.projectId },
      };
    }
    const next: StoredOAuth = {
      access: fresh.access,
      refresh: fresh.refresh || stored.refresh,
      expires: fresh.expires,
      accountId: fresh.accountId ?? stored.accountId,
      email: fresh.email ?? stored.email,
      projectId: fresh.projectId ?? stored.projectId,
    };
    await setOauthCredentialNoLock(provider, next);
    return {
      refreshed: true,
      reason: "refreshed",
      credential: { kind: "oauth", provider, token: next.access, projectId: next.projectId },
    };
  } finally {
    await releaseLock(provider);
  }
}

/** Force-replace the stored OAuth token (used after a manual re-login). */
export async function rotateOAuthToken(provider: AuthProvider, newToken: string): Promise<void> {
  const { setOauthToken } = await import("./storage");
  await setOauthToken(provider, newToken);
}
