/**
 * OpenAI (ChatGPT / Codex) OAuth — real PKCE flow with device-code fallback.
 * Faithful port of gjc's packages/ai/src/utils/oauth/openai-codex.ts.
 *
 * NOTE: tokens minted here authenticate against OpenAI's ChatGPT/Codex
 * backend. joc's default `openai` adapter targets the Chat Completions API,
 * which expects a platform API key. Use this flow with a Codex-compatible
 * endpoint, or prefer an `OPENAI_API_KEY` for the bundled chat adapter.
 */
import { OAuthCallbackFlow } from "../callback-server";
import { generatePKCE } from "../pkce";
import type { OAuthController, OAuthCredentials } from "../types";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const SCOPE = "openid profile email offline_access";
const TIMEOUT_MS = 15_000;
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

function decodeJwt<T = Record<string, unknown>>(token: string): T | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf-8")) as T;
  } catch {
    return null;
  }
}

function profileFromToken(access: string): { accountId?: string; email?: string } {
  const payload = decodeJwt<Record<string, any>>(access);
  const accountId = payload?.[JWT_AUTH_CLAIM]?.chatgpt_account_id;
  const email = payload?.[JWT_PROFILE_CLAIM]?.email?.trim?.().toLowerCase?.();
  return {
    accountId: typeof accountId === "string" && accountId ? accountId : undefined,
    email: typeof email === "string" && email ? email : undefined,
  };
}

async function exchangeCodeForToken(code: string, verifier: string, redirectUri: string): Promise<OAuthCredentials> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI token exchange failed (HTTP ${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error("OpenAI token response missing required fields");
  }
  const { accountId, email } = profileFromToken(data.access_token);
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    accountId,
    email,
  };
}

class OpenAIOAuthFlow extends OAuthCallbackFlow {
  #verifier = "";

  constructor(ctrl: OAuthController) {
    super(ctrl, {
      preferredPort: CALLBACK_PORT,
      callbackPath: CALLBACK_PATH,
      redirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
    });
  }

  async generateAuthUrl(state: string, redirectUri: string) {
    const pkce = await generatePKCE();
    this.#verifier = pkce.verifier;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "joc",
    });
    return { url: `${AUTHORIZE_URL}?${params.toString()}`, instructions: "Complete login in your browser." };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
    return exchangeCodeForToken(code, this.#verifier, redirectUri);
  }
}

export async function loginOpenAI(ctrl: OAuthController): Promise<OAuthCredentials> {
  return new OpenAIOAuthFlow(ctrl).login();
}

export async function refreshOpenAIToken(refreshToken: string): Promise<OAuthCredentials> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI token refresh failed (HTTP ${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new Error("OpenAI refresh response missing required fields");
  }
  const { accountId, email } = profileFromToken(data.access_token);
  return {
    access: data.access_token,
    refresh: data.refresh_token || refreshToken,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    accountId,
    email,
  };
}
