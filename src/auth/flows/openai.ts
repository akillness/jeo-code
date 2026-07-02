/**
 * OpenAI (ChatGPT / Codex) OAuth — real PKCE flow with device-code fallback.
 * Faithful port of gjc's packages/ai/src/utils/oauth/openai-codex.ts.
 *
 * NOTE: tokens minted here authenticate against OpenAI's ChatGPT/Codex
 * backend. jeo's default `openai` adapter targets the Chat Completions API,
 * which expects a platform API key. Use this flow with a Codex-compatible
 * endpoint, or prefer an `OPENAI_API_KEY` for the bundled chat adapter.
 */
import { CallbackPortUnavailableError, OAuthCallbackFlow } from "../callback-server";
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
// Device-code (headless) fallback endpoints — gjc openai-codex.ts DEVICE_* parity.
const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_POLL_INTERVAL_MS = 5_000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
/** Upper bound on device-code polling to avoid infinite loops on server errors. */
const DEVICE_MAX_POLLS = 120;

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
  if (!accountId) {
    // gjc parity (openai-codex.ts:139-141): a Codex token without a chatgpt_account_id
    // claim is unusable for the request path — fail the login instead of storing it.
    throw new Error("Failed to extract accountId from token");
  }
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
      // "codex_cli_rs" for self-consistency with jeo's request path (openai-responses.ts
      // sends the same originator header) — deliberate divergence from gjc's "opencode" default.
      originator: "codex_cli_rs",
    });
    return { url: `${AUTHORIZE_URL}?${params.toString()}`, instructions: "Complete login in your browser." };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
    return exchangeCodeForToken(code, this.#verifier, redirectUri);
  }
}

export async function loginOpenAI(ctrl: OAuthController): Promise<OAuthCredentials> {
  try {
    return await new OpenAIOAuthFlow(ctrl).login();
  } catch (err) {
    // OpenAI requires the FIXED redirect http://localhost:1455/auth/callback, so a busy
    // port cannot fall back to a random one. Fall back to the device-code flow instead
    // (gjc loginOpenAICodexDevice parity) — no local callback server needed.
    if (err instanceof CallbackPortUnavailableError) {
      ctrl.onProgress?.(`Port ${CALLBACK_PORT} is busy — falling back to device-code login.`);
      return loginOpenAIDevice(ctrl);
    }
    throw err;
  }
}

/**
 * Login using OpenAI's device-code (headless) flow — no local callback server.
 * Port of gjc's loginOpenAICodexDevice (openai-codex.ts): request a user code,
 * surface it via the controller, poll for the authorization code (403/404 =
 * authorization pending), then run the standard token exchange against the
 * fixed device redirect URI.
 */
export async function loginOpenAIDevice(ctrl: OAuthController): Promise<OAuthCredentials> {
  ctrl.onProgress?.("Initiating device authorization…");

  const initResponse = await fetch(DEVICE_USERCODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!initResponse.ok) {
    throw new Error(`Device authorization initiation failed: ${initResponse.status}`);
  }
  const initData = (await initResponse.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: string | number;
  };
  if (!initData.device_auth_id || !initData.user_code) {
    throw new Error("Device authorization response missing required fields");
  }

  const userCode = initData.user_code;
  const pollIntervalMs =
    (typeof initData.interval === "number"
      ? initData.interval
      : parseInt(String(initData.interval ?? "5"), 10) || 5) *
      1000 +
    DEVICE_POLL_SAFETY_MARGIN_MS;

  ctrl.onAuth?.({ url: DEVICE_AUTH_URL, instructions: `Enter code: ${userCode}` });
  ctrl.onProgress?.(`Waiting for browser authorization (code: ${userCode})…`);

  for (let poll = 0; poll < DEVICE_MAX_POLLS; poll++) {
    await Bun.sleep(poll === 0 ? Math.min(pollIntervalMs, DEVICE_POLL_INTERVAL_MS) : pollIntervalMs);
    if (ctrl.signal?.aborted) {
      throw new Error("Device authorization cancelled");
    }

    const pollResponse = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: initData.device_auth_id, user_code: userCode }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // 403/404 = authorization pending, keep polling (gjc wire parity).
    if (pollResponse.status === 403 || pollResponse.status === 404) continue;
    if (!pollResponse.ok) {
      throw new Error(`Device token polling failed: ${pollResponse.status}`);
    }

    const pollData = (await pollResponse.json()) as {
      authorization_code?: string;
      code_verifier?: string;
    };
    if (!pollData.authorization_code || !pollData.code_verifier) {
      throw new Error("Device token response missing authorization_code or code_verifier");
    }

    ctrl.onProgress?.("Exchanging authorization code for tokens…");
    return exchangeCodeForToken(pollData.authorization_code, pollData.code_verifier, DEVICE_REDIRECT_URI);
  }

  throw new Error("Device authorization timed out — user did not complete login in time");
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
