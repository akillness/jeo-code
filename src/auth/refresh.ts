import {
  refreshOAuthSlot,
  setOauthToken,
  type AuthProvider,
  type RefreshResult,
} from "./storage";
import { classifyRefreshFailure, OAUTH_REFRESH_SKEW_MS } from "./token-refresh";

export { classifyRefreshFailure, OAUTH_REFRESH_SKEW_MS };
export type { RefreshResult };

/**
 * Exchange the stored refresh token for a fresh access token via the provider's
 * real OAuth token endpoint, persist it onto that pool slot, and return the updated credential.
 */
export async function refreshOAuthToken(
  provider: AuthProvider,
  opts?: { identityKey?: string; accountIndex?: number; token?: string; force?: boolean },
): Promise<RefreshResult> {
  return refreshOAuthSlot(provider, opts);
}

/** Persist a new OAuth bearer token (upserts into the provider's login pool). */
export async function rotateOAuthToken(provider: AuthProvider, newToken: string): Promise<void> {
  await setOauthToken(provider, newToken);
}
