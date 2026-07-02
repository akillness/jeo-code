/**
 * Kimi Code (Moonshot subscription) OAuth — device authorization grant.
 * Faithful port of gjc's packages/ai/src/utils/oauth/kimi.ts.
 *
 * No callback server: the user opens `verification_uri_complete` (or enters the
 * user code at `verification_uri`) and jeo polls the token endpoint until the
 * grant is approved. The minted access token is used as `Authorization: Bearer`
 * against the Anthropic-compatible endpoint at https://api.kimi.com/coding.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pkg from "../../../package.json";
import { jeoEnv } from "../../util/env";
import type { OAuthController, OAuthCredentials } from "../types";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_ID_FILENAME = "kimi-device-id";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface DeviceAuthorizationResponse {
  user_code?: string;
  device_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  interval?: number;
}

/** gjc parity: raw (non-JEO_) env overrides for the OAuth host. */
function resolveOAuthHost(): string {
  return process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST;
}

function formatDeviceModel(system: string, release: string, arch: string): string {
  return [system, release, arch].filter(Boolean).join(" ").trim();
}

function getDeviceModel(): string {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  if (platform === "darwin") return formatDeviceModel("macOS", release, arch);
  if (platform === "win32") return formatDeviceModel("Windows", release, arch);
  const label = platform === "linux" ? "Linux" : platform;
  return formatDeviceModel(label, release, arch);
}

// Cached per config-dir path so a JEO_CONFIG_DIR change (tests) is honored.
const deviceIdCache = new Map<string, string>();

/** Stable per-machine device id, persisted like gjc's `<agent-dir>/kimi-device-id`. */
function getDeviceId(): string {
  const dir = jeoEnv("CONFIG_DIR") || path.join(os.homedir(), ".jeo");
  const deviceIdPath = path.join(dir, DEVICE_ID_FILENAME);
  const cached = deviceIdCache.get(deviceIdPath);
  if (cached) return cached;
  try {
    const trimmed = fs.readFileSync(deviceIdPath, "utf-8").trim();
    if (trimmed) {
      deviceIdCache.set(deviceIdPath, trimmed);
      return trimmed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const deviceId = crypto.randomUUID().replace(/-/g, "");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(deviceIdPath, `${deviceId}\n`, { mode: 0o600 });
  deviceIdCache.set(deviceIdPath, deviceId);
  return deviceId;
}

/** X-Msh-* device headers sent on every Kimi OAuth AND API request (gjc parity). */
export function getKimiCommonHeaders(): Record<string, string> {
  return {
    "User-Agent": `KimiCLI/${pkg.version}`,
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": pkg.version,
    "X-Msh-Device-Name": os.hostname(),
    "X-Msh-Device-Model": getDeviceModel(),
    "X-Msh-Os-Version": os.version(),
    "X-Msh-Device-Id": getDeviceId(),
  };
}

/** Abortable sleep; injectable in pollForToken for tests. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function requestDeviceAuthorization(): Promise<{
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInMs: number;
  intervalMs: number;
}> {
  const response = await fetch(`${resolveOAuthHost()}/api/oauth/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getKimiCommonHeaders(),
    },
    body: new URLSearchParams({ client_id: CLIENT_ID }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kimi device authorization failed: ${response.status} ${text}`);
  }

  const payload = (await response.json()) as DeviceAuthorizationResponse;
  const { user_code: userCode, device_code: deviceCode, verification_uri: verificationUri } = payload;
  if (!userCode || !deviceCode || !verificationUri) {
    throw new Error("Kimi device authorization response missing required fields");
  }

  const expiresInMs = typeof payload.expires_in === "number" ? payload.expires_in * 1000 : DEFAULT_DEVICE_FLOW_TTL_MS;
  const intervalMs =
    typeof payload.interval === "number" && payload.interval > 0 ? payload.interval * 1000 : DEFAULT_POLL_INTERVAL_MS;

  return {
    userCode,
    deviceCode,
    verificationUri,
    verificationUriComplete: payload.verification_uri_complete || verificationUri,
    expiresInMs,
    intervalMs,
  };
}

function parseTokenPayload(payload: TokenResponse, refreshTokenFallback?: string): OAuthCredentials {
  if (!payload.access_token || typeof payload.expires_in !== "number") {
    throw new Error("Kimi token response missing required fields");
  }
  const refresh = payload.refresh_token ?? refreshTokenFallback;
  if (!refresh) {
    throw new Error("Kimi token response missing refresh token");
  }
  return {
    access: payload.access_token,
    refresh,
    expires: Date.now() + payload.expires_in * 1000 - OAUTH_EXPIRY_SKEW_MS,
  };
}

/** Poll the token endpoint until the device grant is approved (RFC 8628 semantics). */
export async function pollForToken(
  deviceCode: string,
  intervalMs: number,
  expiresInMs: number,
  signal?: AbortSignal,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = wait,
): Promise<OAuthCredentials> {
  const deadline = Date.now() + expiresInMs;
  let waitMs = Math.max(1000, intervalMs);

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");

    const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...getKimiCommonHeaders(),
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const payload = (await response.json()) as TokenResponse;
    if (response.ok && payload.access_token) {
      return parseTokenPayload(payload);
    }

    const error = payload.error;
    if (error === "authorization_pending") {
      await sleep(waitMs, signal);
      continue;
    }
    if (error === "slow_down") {
      waitMs += 5000;
      const retryAfter = typeof payload.interval === "number" ? payload.interval * 1000 : undefined;
      if (retryAfter && retryAfter > waitMs) waitMs = retryAfter;
      await sleep(waitMs, signal);
      continue;
    }
    if (error === "expired_token") {
      throw new Error("Kimi device authorization expired");
    }
    if (error === "access_denied") {
      throw new Error("Kimi device authorization denied");
    }
    const description = payload.error_description ? `: ${payload.error_description}` : "";
    throw new Error(`Kimi device flow failed: ${error ?? response.status}${description}`);
  }

  throw new Error("Kimi device flow timed out");
}

/** Login with Kimi Code OAuth (device code flow — no local callback server). */
export async function loginKimi(ctrl: OAuthController): Promise<OAuthCredentials> {
  const device = await requestDeviceAuthorization();
  ctrl.onAuth?.({
    url: device.verificationUriComplete,
    instructions: `Enter code: ${device.userCode}`,
  });
  return pollForToken(device.deviceCode, device.intervalMs, device.expiresInMs, ctrl.signal);
}

/** Refresh a Kimi OAuth access token. */
export async function refreshKimiToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch(`${resolveOAuthHost()}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getKimiCommonHeaders(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
    const description = payload?.error_description ? `: ${payload.error_description}` : "";
    throw new Error(`Kimi token refresh failed: ${response.status}${description}`);
  }

  const payload = (await response.json()) as TokenResponse;
  return parseTokenPayload(payload, refreshToken);
}
