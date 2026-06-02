import { resolveCredential, setOauthToken, type AuthProvider, type Credential } from "./storage";

export interface RefreshResult {
  refreshed: boolean;
  reason: string;
  credential: Credential;
}

/**
 * Placeholder refresher mirroring gjc's `auth-broker/refresher.ts` surface.
 * Today: returns the current credential and records why we did not refresh.
 * Tomorrow: per-provider refresh-token exchange against the provider's OAuth
 * token endpoint (Anthropic, OpenAI, Google) with persisted refresh tokens.
 */
export async function refreshOAuthToken(provider: AuthProvider): Promise<RefreshResult> {
  const credential = await resolveCredential(provider);
  if (credential.kind !== "oauth") {
    return { refreshed: false, reason: "no_oauth_token", credential };
  }
  // No refresh-token persistence yet → caller still uses the existing bearer.
  return { refreshed: false, reason: "refresh_not_implemented", credential };
}

/** Force-replace the stored OAuth token (used after a manual re-login). */
export async function rotateOAuthToken(provider: AuthProvider, newToken: string): Promise<void> {
  await setOauthToken(provider, newToken);
}
