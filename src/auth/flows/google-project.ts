/**
 * Google Cloud Code Assist project discovery — gjc parity.
 *
 * gemini-cli style: POST v1internal:loadCodeAssist to find an existing
 * cloudaicompanionProject; when the account has none, onboard the default
 * (free) tier via v1internal:onboardUser and poll the long-running operation
 * until a managed project id is provisioned. This is how gemini-cli itself
 * obtains a project id, so plain `joc auth login gemini` users get Antigravity
 * access without ever setting GOOGLE_CLOUD_PROJECT.
 */

const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";
const DEFAULT_MAX_POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2_000;

const GEMINI_CLI_METADATA = Object.freeze({
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
});

/** Antigravity desktop-app discovery metadata (gjc parity). */
export const ANTIGRAVITY_DISCOVERY_METADATA = Object.freeze({
  ideType: "ANTIGRAVITY",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
});

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | { id?: string };
  currentTier?: { id?: string };
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface LongRunningOperationResponse {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: string | { id?: string } };
}

export interface DiscoverProjectOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  onProgress?: (message: string) => void;
  maxPollAttempts?: number;
  /** Discovery metadata; defaults to the gemini-cli shape. Antigravity logins pass ANTIGRAVITY_DISCOVERY_METADATA. */
  metadata?: Record<string, string>;
  /** Extra request headers (e.g. the Antigravity User-Agent). */
  extraHeaders?: Record<string, string>;
}

function readProjectId(value: string | { id?: string } | undefined): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && typeof value.id === "string" && value.id.length > 0) return value.id;
  return undefined;
}

function defaultTierId(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): string {
  if (!allowedTiers || allowedTiers.length === 0) return TIER_LEGACY;
  const def = allowedTiers.find(t => t.isDefault && typeof t.id === "string" && t.id.length > 0);
  return def?.id ?? TIER_LEGACY;
}

/** Workspace/enterprise accounts cannot be auto-provisioned — surface the documented fix. */
const WORKSPACE_PROJECT_HINT =
  "This Google account requires an explicit project: set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID " +
  "(see https://goo.gle/gemini-cli-auth-docs#workspace-gca), then retry.";

function isVpcScAffectedUser(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return false;
  const details = (payload as { error?: { details?: Array<{ reason?: string }> } }).error?.details;
  return Array.isArray(details) && details.some(d => d.reason === "SECURITY_POLICY_VIOLATED");
}

/**
 * Discover (or provision) the Cloud Code Assist project for a Google OAuth
 * access token. Returns the project id; throws with actionable guidance when
 * the account genuinely needs a user-supplied project.
 */
export async function discoverGoogleProjectId(
  accessToken: string,
  opts: DiscoverProjectOptions = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const env = opts.env ?? process.env;
  const maxPollAttempts = opts.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
  const envProjectId = env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID || undefined;
  const metadata = opts.metadata ?? GEMINI_CLI_METADATA;

  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    ...(opts.extraHeaders ?? {}),
  };

  opts.onProgress?.("Checking for an existing Cloud Code Assist project…");
  const loadRes = await fetchImpl(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      cloudaicompanionProject: envProjectId,
      metadata: { ...metadata, duetProject: envProjectId },
    }),
  });

  let data: LoadCodeAssistPayload;
  if (!loadRes.ok) {
    let errorPayload: unknown;
    try {
      errorPayload = await loadRes.clone().json();
    } catch {
      errorPayload = undefined;
    }
    if (isVpcScAffectedUser(errorPayload)) {
      // VPC-SC blocks loadCodeAssist but chat still works on the standard tier.
      data = { currentTier: { id: TIER_STANDARD } };
    } else {
      throw new Error(`loadCodeAssist failed (HTTP ${loadRes.status}): ${await loadRes.text()}`);
    }
  } else {
    data = (await loadRes.json()) as LoadCodeAssistPayload;
  }

  // Already onboarded: the payload names the project (or the env pins it).
  if (data.currentTier) {
    const existing = readProjectId(data.cloudaicompanionProject) ?? envProjectId;
    if (existing) return existing;
    throw new Error(WORKSPACE_PROJECT_HINT);
  }

  // Not onboarded yet: provision the default tier (free tier needs no project).
  const tierId = defaultTierId(data.allowedTiers) || TIER_FREE;
  if (tierId !== TIER_FREE && tierId !== TIER_LEGACY && !envProjectId) {
    throw new Error(WORKSPACE_PROJECT_HINT);
  }

  opts.onProgress?.("Provisioning a Cloud Code Assist project (one-time, may take a moment)…");
  const onboardBody: Record<string, unknown> = { tierId, metadata: { ...metadata } };
  if (envProjectId && tierId !== TIER_FREE) {
    onboardBody.cloudaicompanionProject = envProjectId;
    (onboardBody.metadata as Record<string, unknown>).duetProject = envProjectId;
  }

  const onboardRes = await fetchImpl(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
    method: "POST",
    headers,
    body: JSON.stringify(onboardBody),
  });
  if (!onboardRes.ok) {
    throw new Error(`onboardUser failed (HTTP ${onboardRes.status}): ${await onboardRes.text()}`);
  }

  let lro = (await onboardRes.json()) as LongRunningOperationResponse;
  for (let attempt = 1; !lro.done && lro.name && attempt <= maxPollAttempts; attempt++) {
    opts.onProgress?.(`Waiting for project provisioning (attempt ${attempt}/${maxPollAttempts})…`);
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetchImpl(`${CODE_ASSIST_ENDPOINT}/v1internal/${lro.name}`, { method: "GET", headers });
    if (!pollRes.ok) throw new Error(`Polling onboardUser operation failed (HTTP ${pollRes.status}).`);
    lro = (await pollRes.json()) as LongRunningOperationResponse;
  }

  const provisioned = readProjectId(lro.response?.cloudaicompanionProject) ?? envProjectId;
  if (provisioned) return provisioned;
  throw new Error(
    `Cloud Code Assist did not return a provisioned project id${lro.done ? "" : ` after ${maxPollAttempts} attempts`}. ${WORKSPACE_PROJECT_HINT}`,
  );
}
