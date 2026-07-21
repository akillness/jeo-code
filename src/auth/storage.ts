import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { readGlobalConfig, readRawGlobalConfig, saveConfigPatch, type StoredOAuth } from "../agent/state";
import { jeoEnv } from "../util/env";


/** Providers with an interactive OAuth login + refresh flow. */
export type OAuthProvider = "anthropic" | "openai" | "gemini" | "antigravity" | "kimi";
/** Every provider jeo resolves a credential for: OAuth-capable ∪ API-key-only. */
export type AuthProvider = OAuthProvider | "xai" | "groq" | "deepseek" | "mistral" | "openrouter" | "together" | "cerebras" | "fireworks" | "nvidia" | "alibaba-coding-plan" | "huggingface" | "nanogpt" | "qwen-portal" | "synthetic" | "venice" | "zenmux" | "qianfan" | "xiaomi" | "xiaomi-token-plan-ams" | "xiaomi-token-plan-cn" | "xiaomi-token-plan-sgp" | "minimax-code" | "minimax-code-cn" | "zai" | "minimax" | "tencent" | "deepinfra" | "litellm";


export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["anthropic", "openai", "gemini", "antigravity", "kimi"];
/** API-key-only providers (no OAuth flow) — resolved from config.providers / `<NAME>_API_KEY`. */
export const API_KEY_ONLY_PROVIDERS: readonly AuthProvider[] = ["xai", "groq", "deepseek", "mistral", "openrouter", "together", "cerebras", "fireworks", "nvidia", "alibaba-coding-plan", "huggingface", "nanogpt", "qwen-portal", "synthetic", "venice", "zenmux", "qianfan", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "minimax-code", "minimax-code-cn", "zai", "minimax", "tencent", "deepinfra", "litellm"];

/** Narrow an AuthProvider to the OAuth-capable subset (xai has no OAuth flow). */
export function isOAuthProvider(p: AuthProvider): p is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(p);
}

export type Credential =
  | { kind: "oauth"; provider: AuthProvider; token: string; projectId?: string }
  | { kind: "api_key"; provider: AuthProvider; token: string }
  | { kind: "none"; provider: AuthProvider };

export interface AuthSnapshot {
  apiKey: string | undefined;
  oauth: string | undefined;
  /** Present only when the stored OAuth is a refreshable {@link StoredOAuth}. */
  oauthExpires?: number;
  oauthHasRefresh?: boolean;
  oauthEmail?: string;
}

const inFlightRefresh = new Map<AuthProvider, Promise<any>>();
function getLockPath(provider: AuthProvider): string {
  const dir = jeoEnv("CONFIG_DIR") || path.join(os.homedir(), ".jeo");
  return path.join(dir, `oauth-${provider}.lock`);
}

export async function acquireLock(provider: AuthProvider, timeoutMs = 5000): Promise<void> {
  const lockPath = getLockPath(provider);
  const dir = path.dirname(lockPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  // `timeoutMs` is the STALENESS threshold for a dead holder's lock file; the
  // acquisition wait itself is bounded at 2× that. The previous unbounded 50ms
  // retry loop spun forever when the stale lock could not be unlinked (or was
  // recreated under churn by concurrent sessions) — a mid-turn OAuth refresh
  // then froze the whole agent turn with no diagnostic.
  const deadline = Date.now() + Math.max(timeoutMs * 2, 1_000);
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const info = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
      await handle.writeFile(info, "utf-8");
      await handle.close();
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      try {
        const content = await fs.readFile(lockPath, "utf-8");
        const info = JSON.parse(content);
        if (typeof info.createdAt === "number" && info.createdAt + timeoutMs < Date.now()) {
          await fs.unlink(lockPath).catch(() => {});
        }
      } catch {
        try {
          const stat = await fs.stat(lockPath);
          if (stat.mtimeMs + timeoutMs < Date.now()) {
            await fs.unlink(lockPath).catch(() => {});
          }
        } catch {}
      }
    }
    if (Date.now() >= deadline) {
      // Deadline reached: the holder is dead or wedged. Steal once — the lock
      // guards a short config read-modify-write, so waiting longer only hangs
      // the caller (and with it the live turn that triggered the refresh).
      await fs.unlink(lockPath).catch(() => {});
      const handle = await fs.open(lockPath, "wx").catch(() => null);
      if (handle) {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), stolen: true }), "utf-8");
        await handle.close();
        return;
      }
      throw new Error(`OAuth lock for ${provider} could not be acquired within ${Math.max(timeoutMs * 2, 1_000)}ms (${lockPath})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function releaseLock(provider: AuthProvider): Promise<void> {
  const lockPath = getLockPath(provider);
  await fs.unlink(lockPath).catch(() => {});
}


function accessOf(stored: string | StoredOAuth | undefined): string | undefined {
  if (!stored) return undefined;
  return typeof stored === "string" ? stored : stored.access;
}

/** Raw credential resolver: returns refreshable OAuth first; execution/status may override with an API key when both exist. */
export async function resolveCredential(provider: AuthProvider): Promise<Credential> {
  const cfg = await readGlobalConfig();
  let stored = cfg.oauth?.[provider];

  // Auto-import gemini-cli credentials (~/.gemini/oauth_creds.json) when jeo has no
  // gemini OAuth of its own — the out-of-the-box antigravity/gemini unlock. Hermetic
  // under tests/custom config sandboxes: if JEO_CONFIG_DIR is explicitly set, only an
  // explicit JEO_GEMINI_CREDS_PATH opts in, so tests never read the developer's real
  // credentials or refresh real tokens.
  const credsOverride = jeoEnv("GEMINI_CREDS_PATH");
  const configDirOverridden = !!jeoEnv("CONFIG_DIR");
  if (!stored && provider === "gemini" && (credsOverride || !configDirOverridden)) {
    try {
      const credsPath = jeoEnv("GEMINI_CREDS_PATH") || path.join(os.homedir(), ".gemini", "oauth_creds.json");
      const content = await fs.readFile(credsPath, "utf-8");
      const creds = JSON.parse(content);
      if (creds && creds.access_token) {
        let email: string | undefined;
        if (creds.id_token) {
          const parts = creds.id_token.split(".");
          if (parts.length >= 2) {
            try {
              const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
              const payload = JSON.parse(atob(base64));
              email = payload.email;
            } catch {}
          }
        }
        let expires = typeof creds.expiry_date === "number" ? creds.expiry_date : (typeof creds.expiry_date === "string" ? parseInt(creds.expiry_date, 10) : undefined);
        if (isNaN(expires as number)) expires = undefined;

        const imported: StoredOAuth = {
          access: creds.access_token,
          refresh: creds.refresh_token,
          expires,
          email,
        };
        await setOauthCredential("gemini", imported);
        // stderr, NOT stdout: --json consumers (doctor, models) parse stdout.
        console.error(`[NOTICE] Transparently imported Gemini OAuth credentials from ~/.gemini/oauth_creds.json`);
        stored = imported;
      }
    } catch {
      // never break existing resolution
    }
  }
  if (stored) {
    // Auto-refresh refreshable credentials that are past their expiry.
    if (typeof stored !== "string" && stored.refresh && stored.expires && stored.expires <= Date.now()) {
      try {
        let refreshPromise = inFlightRefresh.get(provider);
        if (!refreshPromise) {
          refreshPromise = (async () => {
            const { refreshOAuthToken } = await import("./refresh");
            return refreshOAuthToken(provider);
          })();
          inFlightRefresh.set(provider, refreshPromise);
          // Cleanup must not create its own unobserved rejection if the refresh rejects.
          void refreshPromise.finally(() => {
            inFlightRefresh.delete(provider);
          }).catch(() => {});
        }
        const result = await refreshPromise;
        // refreshOAuthToken encodes the best credential for every outcome: the
        // fresh token on success, the stale token on a transient blip, and an
        // API-key/logged-out fallback after a definitive (dead refresh token)
        // failure cleared the credential. Return it directly instead of reusing
        // the in-memory stale token, so a dead OAuth credential degrades cleanly
        // (to an API key or re-login) rather than looping on a doomed refresh.
        return result.credential;
      } catch {
        // Fall through and use the (stale) access token; the provider call will surface a 401.
      }
    }
    const token = accessOf(stored);
    if (token) {
      return {
        kind: "oauth",
        provider,
        token,
        projectId: typeof stored === "object" ? stored.projectId : undefined,
      };
    }
  }

  const apiKey = cfg.providers[provider];
  if (apiKey) return { kind: "api_key", provider, token: apiKey };
  return { kind: "none", provider };
}

export async function snapshotProvider(provider: AuthProvider): Promise<AuthSnapshot> {
  const cfg = await readGlobalConfig();
  const stored = cfg.oauth?.[provider];
  return {
    apiKey: cfg.providers[provider],
    oauth: accessOf(stored),
    oauthExpires: typeof stored === "object" ? stored.expires : undefined,
    oauthHasRefresh: typeof stored === "object" ? !!stored.refresh : false,
    oauthEmail: typeof stored === "object" ? stored.email : undefined,
  };
}

/** Read the full stored OAuth record (object form only). */
export async function getStoredOAuth(provider: AuthProvider): Promise<StoredOAuth | undefined> {
  const cfg = await readGlobalConfig();
  const stored = cfg.oauth?.[provider];
  return typeof stored === "object" ? stored : undefined;
}

/** Persist a plain bearer token (legacy / manual paste — no refresh metadata). */
export async function setOauthToken(provider: AuthProvider, token: string): Promise<void> {
  // Persist onto the RAW on-disk config (not env-overlaid) so a short-lived
  // *_OAUTH_TOKEN env / OLLAMA_HOST / role tier is never baked into config.json.
  await saveConfigPatch(raw => ({ oauth: { ...(raw.oauth ?? {}), [provider]: token } }));
}

/** Persist a full OAuth credential set (access + refresh + expiry). */
export async function setOauthCredentialNoLock(provider: AuthProvider, cred: StoredOAuth): Promise<void> {
  await saveConfigPatch(raw => ({ oauth: { ...(raw.oauth ?? {}), [provider]: cred } }));
}

/** Persist a full OAuth credential set (access + refresh + expiry). */
export async function setOauthCredential(provider: AuthProvider, cred: StoredOAuth): Promise<void> {
  await acquireLock(provider);
  try {
    await setOauthCredentialNoLock(provider, cred);
  } finally {
    await releaseLock(provider);
  }
}

export async function clearOauthToken(provider: AuthProvider): Promise<boolean> {
  const raw = await readRawGlobalConfig();
  if (!raw.oauth?.[provider]) return false;
  await saveConfigPatch(r => {
    const oauth = { ...(r.oauth ?? {}) };
    delete oauth[provider];
    return { oauth };
  });
  return true;
}

export async function setApiKey(provider: AuthProvider, key: string): Promise<void> {
  await saveConfigPatch(raw => ({ providers: { ...(raw.providers ?? {}), [provider]: key } }));
}
