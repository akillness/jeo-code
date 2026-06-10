/**
 * Anthropic (Claude Pro/Max) OAuth — real PKCE flow.
 * Faithful port of gjc's packages/ai/src/utils/oauth/anthropic.ts.
 *
 * The resulting access token is used as `Authorization: Bearer` with the
 * `anthropic-beta: oauth-2025-04-20` header against api.anthropic.com/v1/messages.
 */
import { OAuthCallbackFlow } from "../callback-server";
import { generatePKCE } from "../pkce";
import type { OAuthController, OAuthCredentials } from "../types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

interface AnthropicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account?: { uuid?: string; email_address?: string };
}

async function postJson(url: string, body: Record<string, string>): Promise<AnthropicTokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic OAuth request failed (HTTP ${res.status}): ${text}`);
  try {
    return JSON.parse(text) as AnthropicTokenResponse;
  } catch {
    throw new Error(`Anthropic OAuth returned invalid JSON: ${text}`);
  }
}

function lift(data: AnthropicTokenResponse): OAuthCredentials {
  const uuid = data.account?.uuid;
  const email = data.account?.email_address;
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    accountId: typeof uuid === "string" && uuid ? uuid : undefined,
    email: typeof email === "string" && email ? email : undefined,
  };
}

class AnthropicOAuthFlow extends OAuthCallbackFlow {
  #verifier = "";

  constructor(ctrl: OAuthController) {
    super(ctrl, { preferredPort: CALLBACK_PORT, callbackPath: CALLBACK_PATH });
  }

  async generateAuthUrl(state: string, redirectUri: string) {
    const pkce = await generatePKCE();
    this.#verifier = pkce.verifier;
    const params = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
    });
    return {
      url: `${AUTHORIZE_URL}?${params.toString()}`,
      instructions:
        "Approve in your browser. If it cannot reach this machine, paste the final redirect URL or code when prompted.",
    };
  }

  async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
    let exchangeCode = code;
    let exchangeState = state;
    const hashIdx = code.indexOf("#");
    if (hashIdx >= 0) {
      exchangeCode = code.slice(0, hashIdx);
      const frag = code.slice(hashIdx + 1);
      if (frag) exchangeState = frag;
    }
    const data = await postJson(TOKEN_URL, {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: exchangeCode,
      state: exchangeState,
      redirect_uri: redirectUri,
      code_verifier: this.#verifier,
    });
    return lift(data);
  }
}

export async function loginAnthropic(ctrl: OAuthController): Promise<OAuthCredentials> {
  return new AnthropicOAuthFlow(ctrl).login();
}

export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
  const data = await postJson(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  return { ...lift(data), refresh: data.refresh_token || refreshToken };
}
