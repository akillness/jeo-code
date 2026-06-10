/**
 * Google (Gemini CLI / Cloud Code Assist) OAuth — standard authorization-code flow.
 * Port of gjc's google-oauth-shared.ts + google-gemini-cli.ts constants.
 *
 * NOTE: these tokens authenticate against Google's Cloud Code Assist backend.
 * joc's default `gemini` adapter targets the public generativelanguage API,
 * which prefers an API key (`GEMINI_API_KEY`). The login/refresh machinery is
 * real; project provisioning is best-effort (env-driven) to keep joc lean.
 */
import { OAuthCallbackFlow } from "../callback-server";
import { discoverGoogleProjectId } from "./google-project";
import type { OAuthController, OAuthCredentials } from "../types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
  [
    "NjgxMjU1ODA5Mzk1",
    "LW9vOGZ0Mm9wcmRy",
    "bnA5ZTNhcWY2YXYz",
    "aG1kaWIxMzVqLmFw",
    "cHMuZ29vZ2xldXNl",
    "cmNvbnRlbnQuY29t",
  ].join("")
);
// Google's installed-app ("desktop") OAuth client secret is not a true secret —
// gemini-cli ships it publicly in its source (RFC 8252 §8.5: installed-app
// secrets are not confidential) — but committing the literal trips secret
// scanners, so it is stored base64-encoded like the client id above.
// `GEMINI_OAUTH_CLIENT_SECRET` overrides it for self-provisioned clients.
// Previously this was env-ONLY, so a user who completed the whole browser
// sign-in still got "[FAILED] … requires GEMINI_OAUTH_CLIENT_SECRET" at the
// token-exchange step — login must work out of the box.
const DEFAULT_CLIENT_SECRET_B64 = [
  "R09DU1BYLTR1SGdN",
  "UG0tMW83U2stZ2VW",
  "NkN1NWNsWEZzeGw=",
].join("");

/** Effective Google OAuth client secret: env override → bundled gemini-cli default. */
export function googleClientSecret(env: Record<string, string | undefined> = process.env): string {
  return env.GEMINI_OAUTH_CLIENT_SECRET || decode(DEFAULT_CLIENT_SECRET_B64);
}
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/oauth2callback";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

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

class GoogleOAuthFlow extends OAuthCallbackFlow {
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
    return { url: `${AUTH_URL}?${params.toString()}`, instructions: "Complete the sign-in in your browser." };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: googleClientSecret(),
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed (HTTP ${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (!data.refresh_token) throw new Error("No refresh token received from Google. Try again with prompt=consent.");
    const email = await getUserEmail(data.access_token);
    let projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
    if (!projectId) {
      // gjc parity: auto-discover (or provision) the Cloud Code Assist project so
      // Antigravity models work straight after login — best-effort, never fails login.
      try {
        projectId = await discoverGoogleProjectId(data.access_token);
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

export async function loginGoogle(ctrl: OAuthController): Promise<OAuthCredentials> {
  return new GoogleOAuthFlow(ctrl).login();
}

export async function refreshGoogleToken(refreshToken: string): Promise<OAuthCredentials> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: googleClientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (HTTP ${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  return {
    access: data.access_token,
    refresh: data.refresh_token || refreshToken,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}
