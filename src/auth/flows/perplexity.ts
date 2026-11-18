/**
 * Perplexity Pro/Max OAuth login and token refresh.
 *
 * Login paths (in priority order):
 * 1. macOS native app: reads JWT from NSUserDefaults (`defaults read ai.perplexity.mac authToken`)
 * 2. HTTP email OTP: `GET /api/auth/csrf` -> `POST /api/auth/signin-email` -> `POST /api/auth/signin-otp`
 */
import { jeoEnv } from "../../util/env";
import type { OAuthController, OAuthCredentials } from "../types";

const PERPLEXITY_AUTH_BASE = "https://www.perplexity.ai/api/auth";
const API_VERSION = "2.18";
const NATIVE_APP_BUNDLE = "ai.perplexity.mac";
const APP_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const JWT_EXPIRY_SKEW_MS = 5 * 60_000;

export const PERPLEXITY_NEVER_EXPIRES = 8.64e15;

/**
 * Decode expiry (in epoch ms) from a Perplexity JWT, subtracting a 5-minute skew.
 * Perplexity session JWTs typically omit `exp` (server-side sessions), in which
 * case `8.64e15` is returned so the token is treated as non-expiring.
 */
export function perplexityJwtExpiryMs(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return PERPLEXITY_NEVER_EXPIRES;
    const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof decoded?.exp === "number" && Number.isFinite(decoded.exp)) {
      return decoded.exp * 1000 - JWT_EXPIRY_SKEW_MS;
    }
  } catch {
    // Ignore malformed JWT payloads and treat as opaque/non-expiring.
  }
  return PERPLEXITY_NEVER_EXPIRES;
}

/**
 * Read the Perplexity JWT from the native macOS Catalyst app's UserDefaults.
 * Skipped on non-darwin, when `JEO_AUTH_NO_BORROW === "1"`, or in hermetic test runs
 * (`NODE_ENV === "test"` or `JEO_CONFIG_DIR` set).
 */
export async function extractPerplexityMacAppToken(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  if (
    jeoEnv("AUTH_NO_BORROW") === "1" ||
    process.env.NODE_ENV === "test" ||
    Boolean(jeoEnv("CONFIG_DIR")?.trim())
  ) {
    return null;
  }

  try {
    const proc = Bun.spawn(["defaults", "read", NATIVE_APP_BUNDLE, "authToken"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    if (exitCode !== 0) return null;
    const token = stdout.trim();
    if (!token || token === "(null)") return null;
    return token;
  } catch {
    return null;
  }
}

function perplexityAuthHeaders(includeJsonContentType = false): Record<string, string> {
  return {
    ...(includeJsonContentType ? { "Content-Type": "application/json" } : {}),
    "User-Agent": APP_USER_AGENT,
    "X-App-ApiVersion": API_VERSION,
  };
}

async function httpEmailLogin(ctrl: OAuthController): Promise<OAuthCredentials> {
  if (!ctrl.onManualCodeInput) {
    throw new Error("Perplexity login requires interactive input (onManualCodeInput)");
  }
  if (ctrl.signal?.aborted) throw new Error("Perplexity login cancelled");

  const email = (await ctrl.onManualCodeInput("Perplexity email address: ")).trim();
  if (!email) {
    throw new Error("Email is required for Perplexity login");
  }
  if (ctrl.signal?.aborted) throw new Error("Perplexity login cancelled");

  ctrl.onProgress?.("Fetching Perplexity CSRF token...");
  const csrfResponse = await fetch(`${PERPLEXITY_AUTH_BASE}/csrf`, {
    headers: perplexityAuthHeaders(),
    signal: ctrl.signal,
  });
  if (!csrfResponse.ok) {
    throw new Error(`Perplexity CSRF request failed: ${csrfResponse.status}`);
  }
  const csrfData = (await csrfResponse.json()) as { csrfToken?: string };
  if (!csrfData.csrfToken) {
    throw new Error("Perplexity CSRF response missing csrfToken");
  }

  ctrl.onProgress?.("Sending login code to your email...");
  const sendResponse = await fetch(`${PERPLEXITY_AUTH_BASE}/signin-email`, {
    method: "POST",
    headers: perplexityAuthHeaders(true),
    body: JSON.stringify({
      email,
      csrfToken: csrfData.csrfToken,
    }),
    signal: ctrl.signal,
  });
  if (!sendResponse.ok) {
    const body = await sendResponse.text();
    throw new Error(`Perplexity send login code failed (${sendResponse.status}): ${body}`);
  }
  if (ctrl.signal?.aborted) throw new Error("Perplexity login cancelled");

  const otp = (await ctrl.onManualCodeInput("One-time login code sent to your email: ")).trim();
  if (!otp) {
    throw new Error("OTP code is required for Perplexity login");
  }
  if (ctrl.signal?.aborted) throw new Error("Perplexity login cancelled");

  ctrl.onProgress?.("Verifying login code...");
  const verifyResponse = await fetch(`${PERPLEXITY_AUTH_BASE}/signin-otp`, {
    method: "POST",
    headers: perplexityAuthHeaders(true),
    body: JSON.stringify({
      email,
      otp,
      csrfToken: csrfData.csrfToken,
    }),
    signal: ctrl.signal,
  });

  const verifyData = (await verifyResponse.json().catch(() => ({}))) as {
    token?: string;
    status?: string;
    error_code?: string;
    text?: string;
  };
  if (!verifyResponse.ok) {
    const reason = verifyData.text ?? verifyData.error_code ?? verifyData.status ?? `HTTP ${verifyResponse.status}`;
    throw new Error(`Perplexity OTP verification failed: ${reason}`);
  }
  if (!verifyData.token) {
    throw new Error("Perplexity OTP verification response missing token");
  }

  return {
    access: verifyData.token,
    refresh: verifyData.token,
    expires: perplexityJwtExpiryMs(verifyData.token),
    email,
  };
}

/**
 * Login to Perplexity via macOS native app token extraction, falling back to email OTP.
 */
export async function loginPerplexity(ctrl: OAuthController): Promise<OAuthCredentials> {
  if (jeoEnv("AUTH_NO_BORROW") !== "1") {
    ctrl.onProgress?.("Checking for Perplexity desktop app...");
    const nativeJwt = await extractPerplexityMacAppToken();
    if (nativeJwt) {
      ctrl.onProgress?.("Found Perplexity JWT from native app");
      return {
        access: nativeJwt,
        refresh: nativeJwt,
        expires: perplexityJwtExpiryMs(nativeJwt),
      };
    }
  }

  return httpEmailLogin(ctrl);
}

/**
 * Validate/refresh a Perplexity JWT credential.
 * Returns the token with its decoded (or non-expiring) expiry if still valid;
 * if an embedded `exp` has passed, attempts re-extraction from the macOS app.
 */
export async function refreshPerplexityToken(token: string): Promise<OAuthCredentials> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("Perplexity refresh failed: invalid_token");
  }
  const expires = perplexityJwtExpiryMs(trimmed);
  if (expires > Date.now()) {
    return {
      access: trimmed,
      refresh: trimmed,
      expires,
    };
  }

  const nativeJwt = await extractPerplexityMacAppToken();
  if (nativeJwt) {
    const nativeExpires = perplexityJwtExpiryMs(nativeJwt);
    if (nativeExpires > Date.now()) {
      return {
        access: nativeJwt,
        refresh: nativeJwt,
        expires: nativeExpires,
      };
    }
  }

  throw new Error("Perplexity OAuth token expired (invalid_token); run 'jeo auth login perplexity' to re-authenticate.");
}
