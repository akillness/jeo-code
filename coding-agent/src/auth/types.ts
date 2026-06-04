/** OAuth flow types, mirroring gjc's oauth/types.ts (trimmed to joc's surface). */

export interface OAuthCredentials {
  access: string;
  refresh: string;
  /** Epoch ms when the access token should be treated as expired (already skew-adjusted). */
  expires: number;
  accountId?: string;
  email?: string;
  projectId?: string;
}

export interface OAuthAuthInfo {
  url: string;
  instructions?: string;
}

export interface OAuthController {
  /** Invoked once the authorization URL is ready (open it / print it). */
  onAuth?(info: OAuthAuthInfo): void;
  /** Progress messages during the flow. */
  onProgress?(message: string): void;
  /** Optional manual paste fallback when the browser cannot reach the callback. */
  onManualCodeInput?(): Promise<string>;
  signal?: AbortSignal;
}
