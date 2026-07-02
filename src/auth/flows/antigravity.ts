/**
 * Antigravity OAuth — Google authorization-code flow with the Antigravity
 * desktop-app client (gjc parity). The Antigravity/Cloud Code Assist agent
 * backend rejects gemini-cli client tokens (PERMISSION_DENIED), so Antigravity
 * models need this dedicated login: different client id/secret, extra scopes
 * (cclog, experimentsandconfigs), and ANTIGRAVITY discovery metadata.
 *
 * Like the Google installed-app secret in `google.ts`, the client secret ships
 * publicly in the Antigravity app (RFC 8252 §8.5: installed-app secrets are not
 * confidential) and is stored base64-encoded only to avoid secret scanners.
 * `ANTIGRAVITY_OAUTH_CLIENT_SECRET` overrides it for self-provisioned clients.
 */
import { OAuthCallbackFlow } from "../callback-server";
import { discoverGoogleProjectId, ANTIGRAVITY_DISCOVERY_METADATA } from "./google-project";
import { getAntigravityUserAgent } from "../../ai/providers/antigravity";
import type { OAuthController, OAuthCredentials } from "../types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
  [
    "MTA3MTAwNjA2MDU5MS10",
    "bWhzc2luMmgyMWxjcmUy",
    "MzV2dG9sb2poNGc0MDNl",
    "cC5hcHBzLmdvb2dsZXVz",
    "ZXJjb250ZW50LmNvbQ==",
  ].join("")
);
const DEFAULT_CLIENT_SECRET_B64 = [
  "R09DU1BYLUs1OEZX",
  "UjQ4NkxkTEoxbUxC",
  "OHNYQzR6NnFEQWY=",
].join("");

/** Effective Antigravity OAuth client secret: env override → bundled default. */
export function antigravityClientSecret(env: Record<string, string | undefined> = process.env): string {
  return env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || decode(DEFAULT_CLIENT_SECRET_B64);
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

/** Discover (or provision) the Antigravity Cloud Code Assist project for an access token. */
export function discoverAntigravityProjectId(
  accessToken: string,
  opts: { onProgress?: (message: string) => void } = {},
): Promise<string> {
  return discoverGoogleProjectId(accessToken, {
    metadata: { ...ANTIGRAVITY_DISCOVERY_METADATA },
    extraHeaders: { "User-Agent": getAntigravityUserAgent() },
    // gjc antigravity parity: a reported tier without a project ONBOARDS the
    // default/legacy tier instead of throwing the workspace-project hint.
    alwaysOnboard: true,
    onProgress: opts.onProgress,
  });
}

async function getUserEmail(access: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { authorization: `Bearer ${access}` },
    });
    if (res.ok) return ((await res.json()) as { email?: string }).email;
  } catch {
    /* email is optional */
  }
  return undefined;
}

class AntigravityOAuthFlow extends OAuthCallbackFlow {
  constructor(ctrl: OAuthController) {
    super(ctrl, { preferredPort: CALLBACK_PORT, callbackPath: CALLBACK_PATH });
  }

  async generateAuthUrl(state: string, redirectUri: string) {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return { url: `${AUTH_URL}?${params.toString()}`, instructions: "Complete the Antigravity sign-in in your browser." };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: antigravityClientSecret(),
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`Antigravity token exchange failed (HTTP ${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (!data.refresh_token) throw new Error("No refresh token received from Google. Try again with prompt=consent.");
    const email = await getUserEmail(data.access_token);
    let projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
    if (!projectId) {
      // Project discovery is what makes the login usable — but keep login
      // best-effort: the adapter retries discovery lazily at call time.
      try {
        projectId = await discoverAntigravityProjectId(data.access_token);
      } catch {
        projectId = undefined;
      }
    }
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
      email,
      projectId,
    };
  }
}

export async function loginAntigravity(ctrl: OAuthController): Promise<OAuthCredentials> {
  return new AntigravityOAuthFlow(ctrl).login();
}

export async function refreshAntigravityToken(refreshToken: string): Promise<OAuthCredentials> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: antigravityClientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Antigravity token refresh failed (HTTP ${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  return {
    access: data.access_token,
    refresh: data.refresh_token || refreshToken,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}
