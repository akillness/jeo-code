/**
 * Persistent cache of the model lists providers reported from their OWN endpoints.
 *
 * Live discovery (`listProviderModels`) already asks each authenticated provider
 * what it serves, but the answer only ever lived in this process: every launch
 * started blind, showed the maintained static snapshot until the network call
 * returned, and — worse — the OAuth Codex gate (`isCodexModel`) rejected any model
 * newer than that snapshot, so an account that had `gpt-5.6-*` could not select it
 * until discovery happened to finish first.
 *
 * Persisting the discovered lists (gjc parity) closes both gaps: the next launch
 * rehydrates the account's REAL model set from disk before any network call, and a
 * background refresh keeps it current. The cache is an optimization — a missing,
 * corrupt, or stale file only means live discovery must refresh the catalog,
 * never an error.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { jeoEnv } from "../util/env";
import { recordLiveCodexModels, recordLiveProviderModels, setAntigravityAccountScope, setOpenAIOauthAccountScope } from "./model-catalog";
import type { Credential } from "../auth";
import { getStoredOAuth, snapshotProvider } from "../auth/storage";
import { extractChatgptAccountId } from "./providers/openai-responses";
import type { ProviderName } from "./types";

/** How a provider's list was obtained; mirrors `ProviderModelsResult["source"]`. */
export type ModelCacheSource = "oauth" | "api_key" | "keyless" | "none";

export interface CachedProviderModels {
  provider: ProviderName;
  models: string[];
  source: ModelCacheSource;
  /** Base URL the list came from, so an OpenAI-compatible endpoint's ids stay scoped to it. */
  baseUrl?: string;
  /** Stable account scope for OAuth rows; required for OpenAI and Antigravity rows. */
  accountId?: string;
}

export interface ModelCacheFile {
  version: 3;
  updatedAt: number;
  providers: CachedProviderModels[];
}

// Earlier snapshots could persist hidden or fabricated OpenAI entries.
const CACHE_VERSION = 3;
/** Refresh in the background once the cache is older than this (6h). */
export const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Bound non-authoritative provider rows; preserve complete OpenAI and Antigravity lists. */
const MAX_MODELS_PER_PROVIDER = 500;

function cacheDir(): string {
  return jeoEnv("CONFIG_DIR") || path.join(os.homedir(), ".jeo");
}

function cachePath(): string {
  return path.join(cacheDir(), "model-catalog-cache.json");
}

/** Peek at the selected OAuth account without importing or refreshing credentials. */
export async function antigravityAccountScope(credential?: Credential): Promise<string | undefined> {
  try {
    let selected = credential;
    if (!selected) {
      const own = await snapshotProvider("antigravity");
      const provider = own.oauth ? "antigravity" : "gemini";
      const snapshot = own.oauth ? own : await snapshotProvider("gemini");
      if (!snapshot.oauth) return undefined;
      selected = { kind: "oauth", provider, token: snapshot.oauth };
    }
    if (selected.kind !== "oauth" || (selected.provider !== "antigravity" && selected.provider !== "gemini")) return undefined;
    const providerSlot = selected.provider;
    const stored = await getStoredOAuth(providerSlot).catch(() => undefined);
    const accessMatches = stored?.access === selected.token;
    const email = accessMatches ? stored?.email?.trim().toLowerCase() : "";
    const identity = accessMatches
      ? email
        ? `email:${email}`
        : stored?.refresh
          ? `refresh:${stored.refresh}`
          : `access:${selected.token}`
      : `access:${selected.token}`;
    const projectId = selected.projectId?.trim()
      || (accessMatches ? stored?.projectId?.trim() : undefined)
      || process.env.GOOGLE_CLOUD_PROJECT?.trim()
      || process.env.GOOGLE_CLOUD_PROJECT_ID?.trim()
      || "";
    return createHash("sha256").update(`${providerSlot}\u0000${identity}\u0000${projectId}`, "utf8").digest("hex");
  } catch {
    return undefined;
  }
}

export function normalizeCacheEntries(raw: unknown): CachedProviderModels[] {
  if (!Array.isArray(raw)) return [];
  const out: CachedProviderModels[] = [];
  for (const entry of raw) {
    const row = entry as Partial<CachedProviderModels>;
    if (!row || typeof row.provider !== "string" || !Array.isArray(row.models)) continue;
    const provider = row.provider as ProviderName;
    if (provider === "agy") continue;
    const source: ModelCacheSource =
      row.source === "oauth" || row.source === "api_key" || row.source === "keyless" || row.source === "none" ? row.source : "none";
    const baseUrl = typeof row.baseUrl === "string" ? row.baseUrl.replace(/\/+$/, "") : undefined;
    const accountId = typeof row.accountId === "string" ? row.accountId.trim() : "";
    const isScopedOAuth = (provider === "openai" || provider === "antigravity") && source === "oauth";
    if ((isScopedOAuth && !accountId) || (provider === "antigravity" && source !== "oauth")) continue;
    const models = row.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      .slice(0, provider === "openai" || provider === "antigravity" ? undefined : MAX_MODELS_PER_PROVIDER);
    if (models.length === 0 && provider !== "openai" && provider !== "antigravity") continue;
    out.push({
      provider,
      models,
      source,
      ...(baseUrl ? { baseUrl } : {}),
      ...(isScopedOAuth ? { accountId } : {}),
    });
  }
  return out;
}

/** Read the persisted lists, or null when absent/unreadable/incompatible. */
export async function readModelCache(): Promise<ModelCacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf-8")) as Partial<ModelCacheFile>;
    if (!parsed || parsed.version !== CACHE_VERSION) return null;
    const providers = normalizeCacheEntries(parsed.providers);
    if (providers.length === 0) return null;
    return {
      version: CACHE_VERSION,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      providers,
    };
  } catch {
    return null;
  }
}

/** True when the cache is missing or older than the TTL, i.e. a refresh is worth doing. */
export function isModelCacheStale(cache: ModelCacheFile | null, now = Date.now(), ttlMs = MODEL_CACHE_TTL_MS): boolean {
  if (!cache) return true;
  return now - cache.updatedAt >= ttlMs;
}

/**
 * Merge fresh discovery results over the existing cache. Providers absent from
 * `results` (not logged in this run, or a transient failure) keep their previous
 * entry, so one offline launch never erases a known-good list.
 */
export function mergeCacheEntries(
  previous: readonly CachedProviderModels[],
  results: readonly { provider: ProviderName; models: readonly string[]; ok: boolean; source?: ModelCacheSource | "cli_session"; baseUrl?: string; accountId?: string; fallback?: boolean }[],
): CachedProviderModels[] {
  const byKey = new Map<string, CachedProviderModels>();
  const isScopedOAuth = (provider: ProviderName, source: ModelCacheSource): boolean =>
    (provider === "openai" || provider === "antigravity") && source === "oauth";
  const keyOf = (provider: ProviderName, baseUrl?: string, accountId?: string, source?: ModelCacheSource) =>
    `${provider}\u0000${baseUrl?.replace(/\/+$/, "") ?? ""}\u0000${isScopedOAuth(provider, source ?? "none") ? accountId ?? "" : ""}\u0000${provider === "openai" || provider === "antigravity" ? source ?? "none" : ""}`;
  for (const entry of previous) {
    const scoped = isScopedOAuth(entry.provider, entry.source);
    if (entry.provider === "agy") continue;
    if ((scoped && !entry.accountId) || (entry.provider === "antigravity" && entry.source !== "oauth")) continue;
    byKey.set(keyOf(entry.provider, entry.baseUrl, entry.accountId, entry.source), entry);
  }
  for (const result of results) {
    if (result.provider === "agy" || result.source === "cli_session") continue;
    const source: ModelCacheSource = result.source ?? "none";
    const scoped = isScopedOAuth(result.provider, source);
    const isAntigravity = result.provider === "antigravity";
    const baseUrl = typeof result.baseUrl === "string" ? result.baseUrl.replace(/\/+$/, "") : undefined;
    const accountId = typeof result.accountId === "string" ? result.accountId.trim() : "";
    if ((scoped && !accountId) || (isAntigravity && source !== "oauth")) continue;
    if (!result.ok || result.fallback || (result.models.length === 0 && result.provider !== "openai" && !isAntigravity)) continue;
    byKey.set(keyOf(result.provider, baseUrl, accountId, source), {
      provider: result.provider,
      models: [...result.models].slice(0, result.provider === "openai" || isAntigravity ? undefined : MAX_MODELS_PER_PROVIDER),
      source,
      ...(baseUrl ? { baseUrl } : {}),
      ...(scoped ? { accountId } : {}),
    });
  }
  return [...byKey.values()];
}

/** Persist discovery results (best-effort; never throws, never blocks a turn). */
export async function writeModelCache(
  results: readonly { provider: ProviderName; models: readonly string[]; ok: boolean; source?: ModelCacheSource | "cli_session"; baseUrl?: string; accountId?: string; fallback?: boolean }[],
): Promise<void> {
  // Same hermeticity rule as saveGlobalConfig: a test run may only write into an
  // explicitly sandboxed JEO_CONFIG_DIR, never the developer's real ~/.jeo.
  if (process.env.NODE_ENV === "test" && !jeoEnv("CONFIG_DIR")) return;
  // A failed/fallback-only refresh must not make an old snapshot appear fresh.
  const hasFreshResult = results.some(result => {
    if (result.provider === "agy" || result.source === "cli_session") return false;
    if (!result.ok || result.fallback) return false;
    if (result.provider === "antigravity") return result.source === "oauth" && !!result.accountId?.trim();
    if (result.provider === "openai") return result.models.length > 0 || !(result.source === "oauth" && !result.accountId?.trim());
    return result.models.length > 0;
  });
  if (!hasFreshResult) return;
  try {
    const existing = await readModelCache();
    const providers = mergeCacheEntries(existing?.providers ?? [], results);
    if (providers.length === 0) return;
    const payload: ModelCacheFile = { version: CACHE_VERSION, updatedAt: Date.now(), providers };
    await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
    await writeFile(cachePath(), JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {
    // A cache write failure must never surface to the user.
  }
}

/**
 * Feed cached lists into the in-process registries so pickers, autocomplete,
 * routing, and — critically — the OAuth Codex gate know the account's real models
 * BEFORE the first network call of this launch. Returns the number of ids applied.
 */
export function applyCachedModels(cache: ModelCacheFile | null, openAIOauthAccountId?: string, antigravityAccountId?: string): number {
  const openAIScope = typeof openAIOauthAccountId === "string" ? openAIOauthAccountId.trim() : "";
  const antigravityScope = typeof antigravityAccountId === "string" ? antigravityAccountId.trim() : "";
  setAntigravityAccountScope(antigravityScope);
  if (!cache) return 0;
  let applied = 0;
  for (const entry of cache.providers) {
    if (entry.provider === "agy") continue;
    const isOpenAIOAuth = entry.provider === "openai" && entry.source === "oauth";
    const isAntigravityOAuth = entry.provider === "antigravity" && entry.source === "oauth";
    if (isOpenAIOAuth && (!openAIScope || entry.accountId !== openAIScope)) continue;
    if (isAntigravityOAuth && (!antigravityScope || entry.accountId !== antigravityScope)) continue;
    if (entry.provider === "antigravity" && !isAntigravityOAuth) continue;
    recordLiveProviderModels(entry.provider, entry.models, {
      source: entry.source,
      baseUrl: entry.baseUrl,
      replace: entry.provider === "openai" || entry.provider === "antigravity",
      ...(isOpenAIOAuth || isAntigravityOAuth ? { accountId: entry.accountId } : {}),
    });
    if (isOpenAIOAuth && entry.accountId && !entry.baseUrl) {
      recordLiveCodexModels(entry.models, entry.accountId);
    }
    applied += entry.models.length;
  }
  return applied;
}

/** Read + apply in one step. Returns the cache so callers can decide about refreshing. */
export async function rehydrateLiveModels(): Promise<ModelCacheFile | null> {
  const cache = await readModelCache();
  let accountId: string | undefined;
  try {
    const stored = await getStoredOAuth("openai");
    const jwtAccountId = stored ? extractChatgptAccountId(stored.access) : undefined;
    accountId = jwtAccountId || stored?.accountId;
  } catch {
    accountId = undefined;
  }
  const antigravityAccountId = await antigravityAccountScope();
  setOpenAIOauthAccountScope(accountId);
  setAntigravityAccountScope(antigravityAccountId);
  applyCachedModels(cache, accountId, antigravityAccountId);
  return cache;
}
