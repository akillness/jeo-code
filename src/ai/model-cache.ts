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
 * corrupt, or stale file only means "fall back to live discovery + static catalog",
 * never an error.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { jeoEnv } from "../util/env";
import { recordLiveCodexModels, recordLiveProviderModels, setOpenAIOauthAccountScope } from "./model-catalog";
import { getStoredOAuth } from "../auth/storage";
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
  /** Stable OpenAI OAuth account scope for this row; required for account-specific rehydration. */
  accountId?: string;
}

export interface ModelCacheFile {
  version: 2;
  updatedAt: number;
  providers: CachedProviderModels[];
}

const CACHE_VERSION = 2;
/** Refresh in the background once the cache is older than this (6h). */
export const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Bound a single provider's persisted list so a pathological aggregator cannot bloat the file. */
const MAX_MODELS_PER_PROVIDER = 500;

function cacheDir(): string {
  return jeoEnv("CONFIG_DIR") || path.join(os.homedir(), ".jeo");
}

function cachePath(): string {
  return path.join(cacheDir(), "model-catalog-cache.json");
}

export function normalizeCacheEntries(raw: unknown): CachedProviderModels[] {
  if (!Array.isArray(raw)) return [];
  const out: CachedProviderModels[] = [];
  for (const entry of raw) {
    const row = entry as Partial<CachedProviderModels>;
    if (!row || typeof row.provider !== "string" || !Array.isArray(row.models)) continue;
    const models = row.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0).slice(0, MAX_MODELS_PER_PROVIDER);
    if (models.length === 0) continue;
    const provider = row.provider as ProviderName;
    const source: ModelCacheSource =
      row.source === "oauth" || row.source === "api_key" || row.source === "keyless" || row.source === "none" ? row.source : "none";
    const baseUrl = typeof row.baseUrl === "string" ? row.baseUrl.replace(/\/+$/, "") : undefined;
    const accountId = typeof row.accountId === "string" ? row.accountId.trim() : "";
    if (provider === "openai" && source === "oauth" && !accountId) continue;
    out.push({
      provider,
      models,
      source,
      ...(baseUrl ? { baseUrl } : {}),
      ...(provider === "openai" && source === "oauth" ? { accountId } : {}),
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
  results: readonly { provider: ProviderName; models: readonly string[]; ok: boolean; source?: ModelCacheSource; baseUrl?: string; accountId?: string }[],
): CachedProviderModels[] {
  const byKey = new Map<string, CachedProviderModels>();
  const keyOf = (provider: string, baseUrl?: string, accountId?: string) =>
    `${provider}\u0000${baseUrl ?? ""}\u0000${accountId ?? ""}`;
  for (const entry of previous) {
    const isOpenAIOAuth = entry.provider === "openai" && entry.source === "oauth";
    if (isOpenAIOAuth && !entry.accountId) continue;
    byKey.set(keyOf(entry.provider, entry.baseUrl, isOpenAIOAuth ? entry.accountId : undefined), entry);
  }
  for (const result of results) {
    if (!result.ok || result.models.length === 0) continue;
    const source: ModelCacheSource = result.source ?? "none";
    const isOpenAIOAuth = result.provider === "openai" && source === "oauth";
    const baseUrl = typeof result.baseUrl === "string" ? result.baseUrl.replace(/\/+$/, "") : undefined;
    const accountId = typeof result.accountId === "string" ? result.accountId.trim() : "";
    if (isOpenAIOAuth && !accountId) continue;
    byKey.set(keyOf(result.provider, baseUrl, isOpenAIOAuth ? accountId : undefined), {
      provider: result.provider,
      models: [...result.models].slice(0, MAX_MODELS_PER_PROVIDER),
      source,
      ...(baseUrl ? { baseUrl } : {}),
      ...(isOpenAIOAuth ? { accountId } : {}),
    });
  }
  return [...byKey.values()];
}

/** Persist discovery results (best-effort; never throws, never blocks a turn). */
export async function writeModelCache(
  results: readonly { provider: ProviderName; models: readonly string[]; ok: boolean; source?: ModelCacheSource; baseUrl?: string; accountId?: string }[],
): Promise<void> {
  // Same hermeticity rule as saveGlobalConfig: a test run may only write into an
  // explicitly sandboxed JEO_CONFIG_DIR, never the developer's real ~/.jeo.
  if (process.env.NODE_ENV === "test" && !jeoEnv("CONFIG_DIR")) return;
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
export function applyCachedModels(cache: ModelCacheFile | null, openAIOauthAccountId?: string): number {
  if (!cache) return 0;
  const accountId = typeof openAIOauthAccountId === "string" ? openAIOauthAccountId.trim() : "";
  let applied = 0;
  for (const entry of cache.providers) {
    const isOpenAIOAuth = entry.provider === "openai" && entry.source === "oauth";
    if (isOpenAIOAuth && (!accountId || entry.accountId !== accountId)) continue;
    recordLiveProviderModels(entry.provider, entry.models, {
      source: entry.source,
      baseUrl: entry.baseUrl,
      ...(isOpenAIOAuth && entry.accountId ? { accountId: entry.accountId } : {}),
    });
    if (isOpenAIOAuth && entry.accountId) {
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
  setOpenAIOauthAccountScope(accountId);
  applyCachedModels(cache, accountId);
  return cache;
}
