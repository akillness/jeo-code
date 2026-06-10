import {
  getStoredOAuth,
  setOauthCredential,
  setOauthCredentialNoLock,
  resolveCredential,
  snapshotProvider,
  acquireLock,
  releaseLock,
  type AuthProvider,
  type Credential,
} from "./storage";
import { OAUTH_FLOW_REGISTRY } from "./flows";
import type { StoredOAuth } from "../agent/state";

export interface RefreshResult {
  refreshed: boolean;
  reason: string;
  credential: Credential;
}

/**
 * Exchange the stored refresh token for a fresh access token via the provider's
 * real OAuth token endpoint, persist it, and return the updated credential.
 * Mirrors gjc's auth-broker refresher semantics (single source of truth).
 */
export async function refreshOAuthToken(provider: AuthProvider): Promise<RefreshResult> {
  await acquireLock(provider);
  try {
    const stored = await getStoredOAuth(provider);
    if (!stored) {
      const snap = await snapshotProvider(provider);
      const reason = snap.oauth ? "manual_token_no_refresh" : "no_oauth_token";
      return { refreshed: false, reason, credential: await resolveCredential(provider) };
    }

    if (stored.expires && stored.expires > Date.now()) {
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
    const fresh = await flow.refresh(stored.refresh);
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
