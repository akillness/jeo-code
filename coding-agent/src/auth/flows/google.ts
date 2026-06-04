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
import type { OAuthController, OAuthCredentials } from "../types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
  "NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t"
);
// Google's installed-app ("desktop") OAuth client secret is not a true secret —
// gemini-cli ships it publicly — but committing the literal trips secret
// scanners. Source it from env so the repo stays clean; the gemini-cli value is
// the documented default for `GEMINI_OAUTH_CLIENT_SECRET`.
const CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET ?? "";

function requireClientSecret(): string {
  if (!CLIENT_SECRET) {
    throw new Error(
      "Google OAuth requires GEMINI_OAUTH_CLIENT_SECRET (the public gemini-cli desktop client secret). " +
        "Set it in your environment, or use a GEMINI_API_KEY with the bundled adapter instead."
    );
  }
  return CLIENT_SECRET;
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
        client_secret: requireClientSecret(),
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed (HTTP ${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (!data.refresh_token) throw new Error("No refresh token received from Google. Try again with prompt=consent.");
    const email = await getUserEmail(data.access_token);
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
      email,
      projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined,
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
      client_secret: requireClientSecret(),
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
