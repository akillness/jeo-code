export {
  resolveCredential,
  rotateCredential,
  hasUnblockedPoolSibling,
  snapshotProvider,
  getStoredOAuth,
  getStoredOAuthPool,
  setOauthToken,
  setOauthCredential,
  setOauthCredentialNoLock,
  clearOauthToken,
  removeOAuthAccount,
  setApiKey,
  addApiKeyToPool,
  removeApiKeyFromPool,
  selectAuthAccount,
  clearAuthCooldown,
  resetAuthPoolState,
  normalizeOAuthPool,
  compactOAuthPool,
  hasOAuthConfigured,
  oauthEntryAccess,
  oauthEntryDead,
  oauthIdentityKey,
  apiKeyPoolFor,
  isOAuthProvider,
  OAUTH_PROVIDERS,
  API_KEY_ONLY_PROVIDERS,
} from "./storage";
export type {
  AuthProvider,
  OAuthProvider,
  Credential,
  AuthSnapshot,
  AuthSnapshotAccount,
  ResolveCredentialOptions,
  RotateCredentialResult,
} from "./storage";
export {
  OAUTH_FLOWS,
  openInBrowser,
  interactiveLogin,
  loginOAuth,
  logoutOAuth,
} from "./oauth";
export type { OauthFlowDef } from "./oauth";
export { refreshOAuthToken, rotateOAuthToken, classifyRefreshFailure, OAUTH_REFRESH_SKEW_MS } from "./refresh";
export type { RefreshResult } from "./refresh";
export { OAUTH_FLOW_REGISTRY } from "./flows";
export type { OAuthFlow } from "./flows";
export type { OAuthController, OAuthCredentials, OAuthAuthInfo } from "./types";
