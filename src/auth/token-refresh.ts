import type { StoredOAuth } from "../agent/state";
import type { OAuthCredentials } from "./types";

// An auth-broker refresh attempt fails either *definitively*
// (the refresh token itself is dead — invalid_grant / revoked / a 401-403 that is
// not a network blip) or *transiently* (timeout / connection reset). A definitive
// failure must stop us re-attempting a doomed refresh on every call; a transient
// one must leave the credential untouched for the next sweep.
const DEFINITIVE_REFRESH_RE = /invalid_grant|invalid_token|revoked|unauthorized|expired.*refresh|refresh.*expired/i;
const TRANSIENT_REFRESH_RE = /timeout|network|fetch failed|ECONNREFUSED/i;
const HTTP_401_403_RE = /\b(401|403)\b/;

/** Classify an OAuth refresh error as a dead-token ("definitive") vs retryable ("transient") failure. */
export function classifyRefreshFailure(err: unknown): "definitive" | "transient" {
  const msg = err instanceof Error ? err.message : String(err);
  if (DEFINITIVE_REFRESH_RE.test(msg)) return "definitive";
  if (HTTP_401_403_RE.test(msg) && !TRANSIENT_REFRESH_RE.test(msg)) return "definitive";
  return "transient";
}

/** Refresh-ahead window: a token expiring within this many ms is treated as stale
 *  and refreshed NOW, so it never dies mid-request.
 *  OAUTH_REFRESH_SKEW_MS = 60_000. */
export const OAUTH_REFRESH_SKEW_MS = 60_000;

export function mergeRefreshedOAuth(stored: StoredOAuth, fresh: OAuthCredentials): StoredOAuth {
  return {
    access: fresh.access,
    refresh: fresh.refresh || stored.refresh,
    expires: fresh.expires,
    accountId: fresh.accountId ?? stored.accountId,
    email: fresh.email ?? stored.email,
    projectId: fresh.projectId ?? stored.projectId,
  };
}
