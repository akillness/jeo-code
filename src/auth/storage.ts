import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  readGlobalConfig,
  readRawGlobalConfig,
  saveConfigPatch,
  type Config,
  type OAuthEntry,
  type OAuthPoolEntry,
  type StoredOAuth,
} from "../agent/state";
import { jeoEnv } from "../util/env";
import { isRateLimitError, isUsageLimitError } from "../util/retry";
import { OAUTH_FLOW_REGISTRY } from "./flows";
import { classifyRefreshFailure, mergeRefreshedOAuth, OAUTH_REFRESH_SKEW_MS } from "./token-refresh";

/** Providers with an interactive OAuth login + refresh flow. */
export type OAuthProvider = "anthropic" | "openai" | "gemini" | "antigravity" | "kimi";
/** Every provider jeo resolves a credential for: OAuth-capable ∪ API-key-only. */
export type AuthProvider =
  | OAuthProvider
  | "xai"
  | "groq"
  | "deepseek"
  | "mistral"
  | "openrouter"
  | "together"
  | "cerebras"
  | "fireworks"
  | "nvidia"
  | "alibaba-coding-plan"
  | "huggingface"
  | "nanogpt"
  | "qwen-portal"
  | "synthetic"
  | "venice"
  | "zenmux"
  | "qianfan"
  | "xiaomi"
  | "xiaomi-token-plan-ams"
  | "xiaomi-token-plan-cn"
  | "xiaomi-token-plan-sgp"
  | "minimax-code"
  | "minimax-code-cn"
  | "zai"
  | "minimax"
  | "tencent"
  | "deepinfra"
  | "litellm";

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["anthropic", "openai", "gemini", "antigravity", "kimi"];
/** API-key-only providers (no OAuth flow) — resolved from config.providers / `<NAME>_API_KEY`. */
export const API_KEY_ONLY_PROVIDERS: readonly AuthProvider[] = [
  "xai",
  "groq",
  "deepseek",
  "mistral",
  "openrouter",
  "together",
  "cerebras",
  "fireworks",
  "nvidia",
  "alibaba-coding-plan",
  "huggingface",
  "nanogpt",
  "qwen-portal",
  "synthetic",
  "venice",
  "zenmux",
  "qianfan",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "minimax-code",
  "minimax-code-cn",
  "zai",
  "minimax",
  "tencent",
  "deepinfra",
  "litellm",
];

/** Narrow an AuthProvider to the OAuth-capable subset (xai has no OAuth flow). */
export function isOAuthProvider(p: AuthProvider): p is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(p);
}

export type Credential =
  | {
      kind: "oauth";
      provider: AuthProvider;
      token: string;
      projectId?: string;
      accountIndex?: number;
      accountEmail?: string;
      accountId?: string;
    }
  | {
      kind: "api_key";
      provider: AuthProvider;
      token: string;
      accountIndex?: number;
    }
  | { kind: "none"; provider: AuthProvider };

export interface AuthSnapshotAccount {
  index: number;
  kind: "oauth" | "api_key";
  ownerProvider: AuthProvider;
  identityKey: string;
  email?: string;
  accountId?: string;
  projectId?: string;
  expires?: number;
  hasRefresh?: boolean;
  dead?: boolean;
  active: boolean;
  blockedUntil?: number;
  blockedReason?: string;
  maskedToken: string;
}

export interface AuthSnapshot {
  apiKey: string | undefined;
  oauth: string | undefined;
  /** Present only when the active stored OAuth is a refreshable {@link StoredOAuth}. */
  oauthExpires?: number;
  oauthHasRefresh?: boolean;
  oauthEmail?: string;
  /** Total OAuth accounts configured in the provider's login pool. */
  poolSize?: number;
  /** Total API keys configured in the provider's key pool. */
  apiKeyPoolSize?: number;
  /** Detailed per-account pool view (OAuth accounts followed by API keys). */
  accounts?: AuthSnapshotAccount[];
}

export interface RefreshResult {
  refreshed: boolean;
  reason: string;
  credential: Credential;
}

export interface ResolveCredentialOptions {
  sessionKey?: string;
  accountIndex?: number;
  forceRefresh?: boolean;
  allowGeminiFallback?: boolean;
  preferKind?: "oauth" | "api_key";
}

export interface RotateCredentialResult {
  rotated: boolean;
  credential: Credential;
  fromIndex: number;
  toIndex: number;
  total: number;
  fromLabel?: string;
  toLabel?: string;
  reason: string;
  earliestUnblockAt?: number;
}

const DEFAULT_USAGE_LIMIT_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_AUTH_FAILURE_COOLDOWN_MS = 5 * 60_000;
const MAX_SESSION_PINS = 128;

const LockFileSchema = z.object({
  pid: z.number().optional(),
  createdAt: z.number().optional(),
});

const GeminiCredsSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  expiry_date: z.union([z.number(), z.string()]).optional(),
});

const JwtIdentitySchema = z.object({
  email: z.string().optional(),
  "https://api.openai.com/auth": z
    .object({
      chatgpt_account_id: z.string().optional(),
    })
    .optional(),
});

const PersistedPoolEntrySchema = z.object({
  cursor: z.number().int().min(0).default(0),
  blockedUntil: z.record(z.string(), z.number()).default({}),
  blockedReason: z.record(z.string(), z.string()).default({}),
  sessionPinned: z.record(z.string(), z.string()).default({}),
});

const PersistedPoolFileSchema = z.object({
  version: z.literal(1),
  pools: z.record(z.string(), PersistedPoolEntrySchema).default({}),
});

interface PoolRuntimeEntry {
  cursor: number;
  blockedUntil: Map<string, number>;
  blockedReason: Map<string, string>;
  sessionPinned: Map<string, string>;
}

const inFlightRefresh = new Map<string, Promise<RefreshResult>>();
const loadedPoolDirs = new Map<string, Map<string, PoolRuntimeEntry>>();

function resolveConfigDir(): string {
  return jeoEnv("CONFIG_DIR") || path.join(os.homedir(), ".jeo");
}

function getLockPath(provider: AuthProvider): string {
  return path.join(resolveConfigDir(), `oauth-${provider}.lock`);
}

function poolStatePath(dir: string): string {
  return path.join(dir, "auth-pool-state.json");
}

function canPersistPoolState(): boolean {
  return !(process.env.NODE_ENV === "test" && !jeoEnv("CONFIG_DIR"));
}

async function getDirPools(): Promise<Map<string, PoolRuntimeEntry>> {
  const dir = resolveConfigDir();
  const existing = loadedPoolDirs.get(dir);
  if (existing) return existing;

  const map = new Map<string, PoolRuntimeEntry>();
  loadedPoolDirs.set(dir, map);
  try {
    const raw = await fs.readFile(poolStatePath(dir), "utf-8");
    const parsed = PersistedPoolFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed.data.pools)) {
        const blockedUntil = new Map<string, number>();
        const blockedReason = new Map<string, string>();
        for (const [idKey, until] of Object.entries(entry.blockedUntil)) {
          if (until > now) {
            blockedUntil.set(idKey, until);
            const reason = entry.blockedReason[idKey];
            if (reason) blockedReason.set(idKey, reason);
          }
        }
        map.set(key, {
          cursor: entry.cursor,
          blockedUntil,
          blockedReason,
          sessionPinned: new Map(Object.entries(entry.sessionPinned).slice(-MAX_SESSION_PINS)),
        });
      }
    }
  } catch {
    // Missing or malformed pool state file starts clean.
  }
  return map;
}

async function persistDirPools(): Promise<void> {
  if (!canPersistPoolState()) return;
  const dir = resolveConfigDir();
  const map = loadedPoolDirs.get(dir);
  if (!map) return;

  const now = Date.now();
  const pools: Record<string, z.infer<typeof PersistedPoolEntrySchema>> = {};
  for (const [key, entry] of map.entries()) {
    const blockedUntil: Record<string, number> = {};
    const blockedReason: Record<string, string> = {};
    for (const [idKey, until] of entry.blockedUntil.entries()) {
      if (until > now) {
        blockedUntil[idKey] = until;
        const reason = entry.blockedReason.get(idKey);
        if (reason) blockedReason[idKey] = reason;
      }
    }
    const sessionPinned = Object.fromEntries([...entry.sessionPinned.entries()].slice(-MAX_SESSION_PINS));
    if (entry.cursor !== 0 || Object.keys(blockedUntil).length > 0 || Object.keys(sessionPinned).length > 0) {
      pools[key] = { cursor: entry.cursor, blockedUntil, blockedReason, sessionPinned };
    }
  }

  const target = poolStatePath(dir);
  const tmpPath = `${target}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(tmpPath, JSON.stringify({ version: 1, pools }, null, 2), { encoding: "utf-8", mode: 0o600 });
    await fs.chmod(tmpPath, 0o600).catch(() => {});
    await fs.rename(tmpPath, target);
  } catch {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

function getPoolRuntimeEntry(dirMap: Map<string, PoolRuntimeEntry>, poolKey: string): PoolRuntimeEntry {
  let entry = dirMap.get(poolKey);
  if (!entry) {
    entry = {
      cursor: 0,
      blockedUntil: new Map(),
      blockedReason: new Map(),
      sessionPinned: new Map(),
    };
    dirMap.set(poolKey, entry);
  }
  // Prune expired blocks lazily.
  const now = Date.now();
  for (const [idKey, until] of entry.blockedUntil.entries()) {
    if (until <= now) {
      entry.blockedUntil.delete(idKey);
      entry.blockedReason.delete(idKey);
    }
  }
  return entry;
}

function setSessionPin(entry: PoolRuntimeEntry, sessionKey: string | undefined, identityKey: string): void {
  if (!sessionKey) return;
  if (entry.sessionPinned.has(sessionKey)) {
    entry.sessionPinned.delete(sessionKey);
  } else if (entry.sessionPinned.size >= MAX_SESSION_PINS) {
    const oldest = entry.sessionPinned.keys().next().value;
    if (oldest !== undefined) entry.sessionPinned.delete(oldest);
  }
  entry.sessionPinned.set(sessionKey, identityKey);
}

/** Clear in-memory (and optional persisted) pool cursor/cooldown state. */
export async function resetAuthPoolState(provider?: AuthProvider): Promise<void> {
  const dir = resolveConfigDir();
  if (!provider) {
    loadedPoolDirs.delete(dir);
    if (canPersistPoolState()) {
      await fs.unlink(poolStatePath(dir)).catch(() => {});
    }
    return;
  }
  const dirMap = await getDirPools();
  for (const kind of ["oauth", "api_key"] as const) {
    dirMap.delete(`${provider}:${kind}`);
  }
  await persistDirPools();
}

export async function acquireLock(provider: AuthProvider, timeoutMs = 5000): Promise<void> {
  const lockPath = getLockPath(provider);
  const dir = path.dirname(lockPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const deadline = Date.now() + Math.max(timeoutMs * 2, 1_000);
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const info = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
      await handle.writeFile(info, "utf-8");
      await handle.close();
      return;
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
      if (code !== "EEXIST") {
        throw err;
      }
      try {
        const content = await fs.readFile(lockPath, "utf-8");
        const parsed = LockFileSchema.safeParse(JSON.parse(content));
        if (parsed.success && typeof parsed.data.createdAt === "number" && parsed.data.createdAt + timeoutMs < Date.now()) {
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
      await fs.unlink(lockPath).catch(() => {});
      const handle = await fs.open(lockPath, "wx").catch(() => null);
      if (handle) {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), stolen: true }), "utf-8");
        await handle.close();
        return;
      }
      throw new Error(
        `OAuth lock for ${provider} could not be acquired within ${Math.max(timeoutMs * 2, 1_000)}ms (${lockPath})`,
      );
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
}

export async function releaseLock(provider: AuthProvider): Promise<void> {
  const lockPath = getLockPath(provider);
  await fs.unlink(lockPath).catch(() => {});
}

export function normalizeOAuthPool(raw: OAuthPoolEntry | undefined): OAuthEntry[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.filter((entry): entry is OAuthEntry => {
    if (typeof entry === "string") return entry.trim().length > 0;
    return typeof entry === "object" && entry !== null && typeof entry.access === "string" && entry.access.trim().length > 0;
  });
}

export function compactOAuthPool(entries: readonly OAuthEntry[]): OAuthPoolEntry | undefined {
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0];
  return [...entries];
}

export function hasOAuthConfigured(raw: OAuthPoolEntry | undefined): boolean {
  return normalizeOAuthPool(raw).length > 0;
}

export function oauthEntryAccess(entry: OAuthEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return typeof entry === "string" ? entry : entry.access;
}

export function oauthEntryDead(entry: OAuthEntry | undefined): boolean {
  if (!entry || typeof entry === "string") return false;
  return !!entry.expires && entry.expires <= Date.now() && !entry.refresh;
}

function extractJwtIdentity(token: string): { email?: string; accountId?: string } {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    const rawJson = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    const parsed = JwtIdentitySchema.safeParse(JSON.parse(rawJson));
    if (!parsed.success) return {};
    const email = parsed.data.email?.trim() || undefined;
    const accountId = parsed.data["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() || undefined;
    return { email, accountId };
  } catch {
    return {};
  }
}

export function oauthIdentityKey(entry: OAuthEntry): string {
  if (typeof entry === "string") {
    const jwt = extractJwtIdentity(entry);
    if (jwt.email) return `email:${jwt.email.toLowerCase()}`;
    if (jwt.accountId) return `account:${jwt.accountId.toLowerCase()}`;
    return `bearer:${createHash("sha256").update(entry).digest("hex").slice(0, 16)}`;
  }
  const jwt = extractJwtIdentity(entry.access);
  const email = entry.email?.trim() || jwt.email;
  if (email) return `email:${email.toLowerCase()}`;
  const accountId = entry.accountId?.trim() || jwt.accountId;
  if (accountId) return `account:${accountId.toLowerCase()}`;
  if (entry.projectId?.trim()) return `project:${entry.projectId.trim().toLowerCase()}`;
  if (entry.refresh?.trim()) return `refresh:${createHash("sha256").update(entry.refresh.trim()).digest("hex").slice(0, 16)}`;
  return `access:${createHash("sha256").update(entry.access).digest("hex").slice(0, 16)}`;
}

export function apiKeyPoolFor(provider: AuthProvider, cfg: Pick<Config, "providers" | "providerPools">): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  const primary = cfg.providers?.[provider];
  if (typeof primary === "string" && primary.trim()) {
    const trimmed = primary.trim();
    seen.add(trimmed);
    keys.push(trimmed);
  }
  const extras = cfg.providerPools?.[provider] ?? [];
  for (const raw of extras) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    keys.push(trimmed);
  }
  return keys;
}

function apiKeyIdentityKey(key: string): string {
  return `key:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function maskSecret(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 10) return "***";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function formatSlotLabel(slot: {
  index: number;
  email?: string;
  accountId?: string;
  projectId?: string;
  maskedToken: string;
}): string {
  return slot.email || slot.accountId || slot.projectId || slot.maskedToken || `#${slot.index + 1}`;
}

interface PoolCandidateSlot {
  index: number;
  kind: "oauth" | "api_key";
  ownerProvider: AuthProvider;
  ownerIndex: number;
  identityKey: string;
  entry?: OAuthEntry;
  apiKey?: string;
  email?: string;
  accountId?: string;
  projectId?: string;
  expires?: number;
  hasRefresh?: boolean;
  dead: boolean;
  maskedToken: string;
}

function buildOAuthSlots(
  provider: AuthProvider,
  cfg: Pick<Config, "oauth">,
  allowGeminiFallback: boolean,
): PoolCandidateSlot[] {
  const slots: PoolCandidateSlot[] = [];
  const pushFrom = (owner: AuthProvider) => {
    const entries = normalizeOAuthPool(cfg.oauth?.[owner]);
    entries.forEach((entry, ownerIndex) => {
      const token = oauthEntryAccess(entry) ?? "";
      const jwt = extractJwtIdentity(token);
      const obj = typeof entry === "object" ? entry : undefined;
      slots.push({
        index: slots.length,
        kind: "oauth",
        ownerProvider: owner,
        ownerIndex,
        identityKey: `${owner}:${oauthIdentityKey(entry)}`,
        entry,
        email: obj?.email ?? jwt.email,
        accountId: obj?.accountId ?? jwt.accountId,
        projectId: obj?.projectId,
        expires: obj?.expires,
        hasRefresh: !!obj?.refresh,
        dead: oauthEntryDead(entry),
        maskedToken: maskSecret(token),
      });
    });
  };
  pushFrom(provider);
  if (allowGeminiFallback && provider === "antigravity") {
    pushFrom("gemini");
  }
  return slots;
}

function buildApiKeySlots(
  provider: AuthProvider,
  cfg: Pick<Config, "providers" | "providerPools">,
): PoolCandidateSlot[] {
  return apiKeyPoolFor(provider, cfg).map((key, index) => ({
    index,
    kind: "api_key" as const,
    ownerProvider: provider,
    ownerIndex: index,
    identityKey: apiKeyIdentityKey(key),
    apiKey: key,
    dead: false,
    maskedToken: maskSecret(key),
  }));
}

function selectSlotIndex(
  slots: readonly PoolCandidateSlot[],
  runtime: PoolRuntimeEntry,
  opts?: { sessionKey?: string; accountIndex?: number },
): number {
  if (slots.length <= 1) return 0;
  if (opts?.accountIndex !== undefined && opts.accountIndex >= 0 && opts.accountIndex < slots.length) {
    return opts.accountIndex;
  }

  const now = Date.now();
  if (opts?.sessionKey) {
    const pinnedId = runtime.sessionPinned.get(opts.sessionKey);
    if (pinnedId) {
      const pinnedIdx = slots.findIndex(s => s.identityKey === pinnedId);
      if (pinnedIdx !== -1) {
        const pinnedSlot = slots[pinnedIdx]!;
        const blockedUntil = runtime.blockedUntil.get(pinnedSlot.identityKey);
        if (!pinnedSlot.dead && (!blockedUntil || blockedUntil <= now)) {
          return pinnedIdx;
        }
      }
    }
  }

  const start = ((runtime.cursor % slots.length) + slots.length) % slots.length;
  // Pass 1: first unblocked, non-dead slot in circular order.
  for (let offset = 0; offset < slots.length; offset++) {
    const idx = (start + offset) % slots.length;
    const slot = slots[idx]!;
    const blockedUntil = runtime.blockedUntil.get(slot.identityKey);
    if (!slot.dead && (!blockedUntil || blockedUntil <= now)) {
      return idx;
    }
  }

  // Pass 2: all non-dead slots are blocked — pick earliest unblocking in circular order.
  let bestIdx = -1;
  let earliestUntil = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < slots.length; offset++) {
    const idx = (start + offset) % slots.length;
    const slot = slots[idx]!;
    if (slot.dead) continue;
    const until = runtime.blockedUntil.get(slot.identityKey) ?? Number.POSITIVE_INFINITY;
    if (until < earliestUntil) {
      earliestUntil = until;
      bestIdx = idx;
    }
  }
  if (bestIdx !== -1) return bestIdx;

  // Pass 3: all slots are dead — return cursor position.
  return start;
}

async function autoImportGeminiIfMissing(cfg: Config): Promise<Config> {
  if (normalizeOAuthPool(cfg.oauth?.gemini).length > 0) return cfg;
  const credsOverride = jeoEnv("GEMINI_CREDS_PATH");
  const configDirOverridden = !!jeoEnv("CONFIG_DIR");
  if (!credsOverride && configDirOverridden) return cfg;

  try {
    const credsPath = credsOverride || path.join(os.homedir(), ".gemini", "oauth_creds.json");
    const content = await fs.readFile(credsPath, "utf-8");
    const parsed = GeminiCredsSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return cfg;
    const creds = parsed.data;
    const jwt = creds.id_token ? extractJwtIdentity(creds.id_token) : {};
    let expires =
      typeof creds.expiry_date === "number"
        ? creds.expiry_date
        : typeof creds.expiry_date === "string"
          ? parseInt(creds.expiry_date, 10)
          : undefined;
    if (expires !== undefined && Number.isNaN(expires)) expires = undefined;

    const imported: StoredOAuth = {
      access: creds.access_token,
      refresh: creds.refresh_token,
      expires,
      email: jwt.email,
    };
    await setOauthCredential("gemini", imported);
    console.error("[NOTICE] Transparently imported Gemini OAuth credentials from ~/.gemini/oauth_creds.json");
    return await readGlobalConfig();
  } catch {
    return cfg;
  }
}

async function updateOAuthSlotNoLock(
  provider: AuthProvider,
  identityKey: string,
  nextCred: StoredOAuth,
): Promise<void> {
  const bareIdentity = identityKey.startsWith(`${provider}:`) ? identityKey.slice(provider.length + 1) : identityKey;
  await saveConfigPatch(raw => {
    const pool = normalizeOAuthPool(raw.oauth?.[provider]);
    let idx = pool.findIndex(item => oauthIdentityKey(item) === bareIdentity);
    if (idx === -1 && pool.length === 1) idx = 0;
    const nextPool = [...pool];
    if (idx >= 0) nextPool[idx] = nextCred;
    else nextPool.push(nextCred);
    return { oauth: { ...(raw.oauth ?? {}), [provider]: compactOAuthPool(nextPool) } };
  });
}

async function removeOAuthSlotNoLock(provider: AuthProvider, identityKey: string): Promise<boolean> {
  const bareIdentity = identityKey.startsWith(`${provider}:`) ? identityKey.slice(provider.length + 1) : identityKey;
  const raw = await readRawGlobalConfig();
  const pool = normalizeOAuthPool(raw.oauth?.[provider]);
  if (pool.length === 0) return false;
  let idx = pool.findIndex(item => oauthIdentityKey(item) === bareIdentity);
  if (idx === -1 && pool.length === 1) idx = 0;
  if (idx === -1) return false;
  const remaining = pool.filter((_, i) => i !== idx);
  await saveConfigPatch(r => {
    const oauth = { ...(r.oauth ?? {}) };
    const compacted = compactOAuthPool(remaining);
    if (compacted === undefined) delete oauth[provider];
    else oauth[provider] = compacted;
    return { oauth };
  });
  return true;
}

/**
 * Refresh a single OAuth slot in the provider's pool (under file lock).
 * Only that slot is updated on success or removed on definitive failure;
 * sibling accounts in the pool remain untouched.
 */
export async function refreshOAuthSlot(
  provider: AuthProvider,
  opts?: { identityKey?: string; accountIndex?: number; force?: boolean },
): Promise<RefreshResult> {
  if (!isOAuthProvider(provider)) {
    return { refreshed: false, reason: "no_oauth_token", credential: await resolveCredential(provider) };
  }
  await acquireLock(provider);
  try {
    const cfg = await readGlobalConfig();
    const pool = normalizeOAuthPool(cfg.oauth?.[provider]);
    if (pool.length === 0) {
      return { refreshed: false, reason: "no_oauth_token", credential: await resolveCredential(provider) };
    }

    let targetIdx = -1;
    if (opts?.identityKey) {
      const bare = opts.identityKey.startsWith(`${provider}:`)
        ? opts.identityKey.slice(provider.length + 1)
        : opts.identityKey;
      targetIdx = pool.findIndex(item => oauthIdentityKey(item) === bare);
    }
    if (targetIdx === -1 && opts?.accountIndex !== undefined && opts.accountIndex >= 0 && opts.accountIndex < pool.length) {
      targetIdx = opts.accountIndex;
    }
    if (targetIdx === -1) {
      const dirMap = await getDirPools();
      const runtime = getPoolRuntimeEntry(dirMap, `${provider}:oauth`);
      const slots = buildOAuthSlots(provider, cfg, false);
      targetIdx = selectSlotIndex(slots, runtime);
    }

    const entry = pool[targetIdx];
    if (!entry || typeof entry === "string") {
      return {
        refreshed: false,
        reason: entry ? "manual_token_no_refresh" : "no_oauth_token",
        credential: await resolveCredential(provider, { accountIndex: targetIdx >= 0 ? targetIdx : undefined }),
      };
    }

    if (!opts?.force && entry.expires && entry.expires > Date.now() + OAUTH_REFRESH_SKEW_MS) {
      return {
        refreshed: true,
        reason: "already_refreshed",
        credential: {
          kind: "oauth",
          provider,
          token: entry.access,
          projectId: entry.projectId,
          accountIndex: targetIdx,
          accountEmail: entry.email,
          accountId: entry.accountId,
        },
      };
    }

    if (!entry.refresh) {
      return {
        refreshed: false,
        reason: "no_refresh_token",
        credential: {
          kind: "oauth",
          provider,
          token: entry.access,
          projectId: entry.projectId,
          accountIndex: targetIdx,
          accountEmail: entry.email,
          accountId: entry.accountId,
        },
      };
    }

    const slotIdentity = `${provider}:${oauthIdentityKey(entry)}`;
    const flow = OAUTH_FLOW_REGISTRY[provider];
    try {
      const fresh = await flow.refresh(entry.refresh);
      const next = mergeRefreshedOAuth(entry, fresh);
      await updateOAuthSlotNoLock(provider, slotIdentity, next);
      return {
        refreshed: true,
        reason: "refreshed",
        credential: {
          kind: "oauth",
          provider,
          token: next.access,
          projectId: next.projectId,
          accountIndex: targetIdx,
          accountEmail: next.email,
          accountId: next.accountId,
        },
      };
    } catch (err) {
      if (classifyRefreshFailure(err) === "definitive") {
        await removeOAuthSlotNoLock(provider, slotIdentity);
        const afterCfg = await readGlobalConfig();
        const remainingOAuth = normalizeOAuthPool(afterCfg.oauth?.[provider]);
        if (remainingOAuth.length > 0) {
          const nextEntry = remainingOAuth[0]!;
          const nextObj = typeof nextEntry === "object" ? nextEntry : undefined;
          return {
            refreshed: false,
            reason: "refresh_token_invalid",
            credential: {
              kind: "oauth",
              provider,
              token: oauthEntryAccess(nextEntry) ?? "",
              projectId: nextObj?.projectId,
              accountIndex: 0,
              accountEmail: nextObj?.email,
              accountId: nextObj?.accountId,
            },
          };
        }
        const keys = apiKeyPoolFor(provider, afterCfg);
        return {
          refreshed: false,
          reason: "refresh_token_invalid",
          credential: keys[0]
            ? { kind: "api_key", provider, token: keys[0], accountIndex: 0 }
            : { kind: "none", provider },
        };
      }
      return {
        refreshed: false,
        reason: "refresh_transient_error",
        credential: {
          kind: "oauth",
          provider,
          token: entry.access,
          projectId: entry.projectId,
          accountIndex: targetIdx,
          accountEmail: entry.email,
          accountId: entry.accountId,
        },
      };
    }
  } finally {
    await releaseLock(provider);
  }
}

function buildOAuthCredentialFromSlot(slot: PoolCandidateSlot): Credential {
  const token = oauthEntryAccess(slot.entry) ?? "";
  return {
    kind: "oauth",
    provider: slot.ownerProvider,
    token,
    projectId: slot.projectId,
    accountIndex: slot.ownerIndex,
    accountEmail: slot.email,
    accountId: slot.accountId,
  };
}

/**
 * Resolve the active credential for `provider` from its OAuth / API-key login pool.
 * Picks circularly around blocked/dead accounts, auto-refreshes expired OAuth tokens,
 * and falls back across remaining healthy accounts in the pool if one refresh fails definitively.
 */
export async function resolveCredential(
  provider: AuthProvider,
  opts?: ResolveCredentialOptions,
): Promise<Credential> {
  let cfg = await readGlobalConfig();
  if (provider === "gemini" || (provider === "antigravity" && opts?.allowGeminiFallback)) {
    cfg = await autoImportGeminiIfMissing(cfg);
  }

  const allowFallback = !!opts?.allowGeminiFallback && provider === "antigravity";
  const dirMap = await getDirPools();
  const runtimeOAuth = getPoolRuntimeEntry(dirMap, `${provider}:oauth`);
  const triedDeadIdentities = new Set<string>();

  while (opts?.preferKind !== "api_key") {
    const slots = buildOAuthSlots(provider, cfg, allowFallback).filter(s => !triedDeadIdentities.has(s.identityKey));
    if (slots.length === 0) break;

    const chosenIdx = selectSlotIndex(slots, runtimeOAuth, {
      sessionKey: opts?.sessionKey,
      accountIndex: opts?.accountIndex,
    });
    const chosen = slots[chosenIdx]!;
    const entry = chosen.entry;
    if (!entry) break;

    const needsRefresh =
      typeof entry !== "string" &&
      !!entry.refresh &&
      (opts?.forceRefresh || (!!entry.expires && entry.expires <= Date.now()));

    if (needsRefresh && isOAuthProvider(chosen.ownerProvider)) {
      const flightKey = `${resolveConfigDir()}\0${chosen.ownerProvider}\0${chosen.identityKey}`;
      let refreshPromise = inFlightRefresh.get(flightKey);
      if (!refreshPromise) {
        refreshPromise = refreshOAuthSlot(chosen.ownerProvider, {
          identityKey: chosen.identityKey,
          accountIndex: chosen.ownerIndex,
          force: opts?.forceRefresh,
        });
        inFlightRefresh.set(flightKey, refreshPromise);
        void refreshPromise
          .finally(() => {
            inFlightRefresh.delete(flightKey);
          })
          .catch(() => {});
      }
      try {
        const result = await refreshPromise;
        if (result.reason === "refresh_token_invalid") {
          triedDeadIdentities.add(chosen.identityKey);
          cfg = await readGlobalConfig();
          const remainingOAuth = buildOAuthSlots(provider, cfg, allowFallback).filter(
            s => !triedDeadIdentities.has(s.identityKey),
          );
          if (remainingOAuth.length > 0 && opts?.accountIndex === undefined) {
            continue;
          }
          return result.credential;
        }
        runtimeOAuth.cursor = chosen.index;
        setSessionPin(runtimeOAuth, opts?.sessionKey, chosen.identityKey);
        await persistDirPools();
        return result.credential;
      } catch {
        // Fall through to return existing access token; provider call handles 401.
      }
    }

    const token = oauthEntryAccess(entry);
    if (token) {
      runtimeOAuth.cursor = chosen.index;
      setSessionPin(runtimeOAuth, opts?.sessionKey, chosen.identityKey);
      await persistDirPools();
      return buildOAuthCredentialFromSlot(chosen);
    }
    break;
  }

  const keySlots = buildApiKeySlots(provider, cfg);
  if (keySlots.length > 0) {
    const runtimeKeys = getPoolRuntimeEntry(dirMap, `${provider}:api_key`);
    const chosenIdx = selectSlotIndex(keySlots, runtimeKeys, {
      sessionKey: opts?.sessionKey,
      accountIndex: opts?.accountIndex,
    });
    const chosen = keySlots[chosenIdx]!;
    runtimeKeys.cursor = chosen.index;
    setSessionPin(runtimeKeys, opts?.sessionKey, chosen.identityKey);
    await persistDirPools();
    return { kind: "api_key", provider, token: chosen.apiKey!, accountIndex: chosen.index };
  }

  return { kind: "none", provider };
}

function classifyRotationCooldown(error: unknown): { cooldownMs: number; reason: string } {
  let retryAfterMs: number | undefined;
  let status: number | undefined;
  if (typeof error === "object" && error !== null) {
    if ("retryAfterMs" in error && typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)) {
      retryAfterMs = error.retryAfterMs;
    }
    if ("status" in error && typeof error.status === "number") {
      status = error.status;
    }
  }

  if (isUsageLimitError(error)) {
    return {
      cooldownMs: retryAfterMs && retryAfterMs > 0 ? Math.max(retryAfterMs, 1000) : DEFAULT_USAGE_LIMIT_COOLDOWN_MS,
      reason: "usage_limit",
    };
  }
  if (status === 402 || /\b402\b|insufficient credit|billing (?:is )?not enabled|free trial quota/i.test(String(error))) {
    return {
      cooldownMs: retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_USAGE_LIMIT_COOLDOWN_MS,
      reason: "billing_limit",
    };
  }
  if (isRateLimitError(error) || status === 429) {
    return {
      cooldownMs: retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      reason: "rate_limit",
    };
  }
  return {
    cooldownMs: DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
    reason: "auth_rejected",
  };
}

/** True when `provider` has at least one unblocked sibling credential in the same pool as `currentCredential`. */
export async function hasUnblockedPoolSibling(
  provider: AuthProvider,
  currentCredential: Credential,
  opts?: { allowGeminiFallback?: boolean },
): Promise<boolean> {
  if (currentCredential.kind === "none") return false;
  const cfg = await readGlobalConfig();
  const dirMap = await getDirPools();
  const allowFallback = !!opts?.allowGeminiFallback && provider === "antigravity";

  const slots =
    currentCredential.kind === "oauth"
      ? buildOAuthSlots(provider, cfg, allowFallback)
      : buildApiKeySlots(provider, cfg);
  if (slots.length <= 1) return false;

  const runtime = getPoolRuntimeEntry(dirMap, `${provider}:${currentCredential.kind}`);
  const now = Date.now();
  return slots.some(slot => {
    const token = slot.kind === "oauth" ? oauthEntryAccess(slot.entry) : slot.apiKey;
    if (token === currentCredential.token) return false;
    if (slot.dead) return false;
    const until = runtime.blockedUntil.get(slot.identityKey);
    return !until || until <= now;
  });
}

/**
 * Mark `failedCredential` cooled-down/blocked and rotate circularly to the next
 * unblocked account in the provider's pool.
 */
export async function rotateCredential(
  provider: AuthProvider,
  failedCredential: Credential,
  error: unknown,
  opts?: { sessionKey?: string; allowGeminiFallback?: boolean },
): Promise<RotateCredentialResult> {
  if (failedCredential.kind === "none") {
    return {
      rotated: false,
      credential: failedCredential,
      fromIndex: 0,
      toIndex: 0,
      total: 0,
      reason: "no_credential",
    };
  }

  let cfg = await readGlobalConfig();
  const allowFallback = !!opts?.allowGeminiFallback && provider === "antigravity";
  const dirMap = await getDirPools();
  const poolKind = failedCredential.kind;
  const runtime = getPoolRuntimeEntry(dirMap, `${provider}:${poolKind}`);

  const slots =
    poolKind === "oauth"
      ? buildOAuthSlots(provider, cfg, allowFallback)
      : buildApiKeySlots(provider, cfg);

  if (slots.length === 0) {
    return {
      rotated: false,
      credential: failedCredential,
      fromIndex: 0,
      toIndex: 0,
      total: 0,
      reason: "empty_pool",
    };
  }

  let failedIdx = slots.findIndex(slot => {
    const token = slot.kind === "oauth" ? oauthEntryAccess(slot.entry) : slot.apiKey;
    return token === failedCredential.token;
  });
  if (failedIdx === -1 && failedCredential.accountIndex !== undefined) {
    failedIdx = slots.findIndex(slot => slot.ownerIndex === failedCredential.accountIndex);
  }
  if (failedIdx === -1) failedIdx = 0;

  const failedSlot = slots[failedIdx]!;
  const { cooldownMs, reason } = classifyRotationCooldown(error);
  const now = Date.now();
  runtime.blockedUntil.set(failedSlot.identityKey, now + cooldownMs);
  runtime.blockedReason.set(failedSlot.identityKey, reason);

  if (opts?.sessionKey && runtime.sessionPinned.get(opts.sessionKey) === failedSlot.identityKey) {
    runtime.sessionPinned.delete(opts.sessionKey);
  }

  const fromLabel = formatSlotLabel(failedSlot);

  for (let offset = 1; offset < slots.length; offset++) {
    const candidateIdx = (failedIdx + offset) % slots.length;
    const candidate = slots[candidateIdx]!;
    if (candidate.dead) continue;
    const blockedUntil = runtime.blockedUntil.get(candidate.identityKey);
    if (blockedUntil && blockedUntil > now) continue;

    // Resolve via the owner provider + ownerIndex so any expired OAuth token auto-refreshes cleanly.
    let nextCred: Credential;
    if (candidate.kind === "oauth" && isOAuthProvider(candidate.ownerProvider)) {
      const entry = candidate.entry;
      const needsRefresh =
        typeof entry === "object" && !!entry.refresh && !!entry.expires && entry.expires <= Date.now();
      if (needsRefresh) {
        const refreshed = await refreshOAuthSlot(candidate.ownerProvider, {
          identityKey: candidate.identityKey,
          accountIndex: candidate.ownerIndex,
        });
        if (refreshed.reason === "refresh_token_invalid") {
          cfg = await readGlobalConfig();
          continue;
        }
        nextCred = refreshed.credential;
      } else {
        nextCred = buildOAuthCredentialFromSlot(candidate);
      }
    } else {
      nextCred = {
        kind: "api_key",
        provider,
        token: candidate.apiKey!,
        accountIndex: candidate.index,
      };
    }

    runtime.cursor = candidateIdx;
    setSessionPin(runtime, opts?.sessionKey, candidate.identityKey);
    await persistDirPools();

    return {
      rotated: true,
      credential: nextCred,
      fromIndex: failedIdx,
      toIndex: candidateIdx,
      total: slots.length,
      fromLabel,
      toLabel: formatSlotLabel(candidate),
      reason,
    };
  }

  // All accounts are currently blocked; advance cursor circularly for the next unblocked window.
  runtime.cursor = (failedIdx + 1) % slots.length;
  await persistDirPools();

  let earliestUnblockAt: number | undefined;
  for (const slot of slots) {
    const until = runtime.blockedUntil.get(slot.identityKey);
    if (until !== undefined && (earliestUnblockAt === undefined || until < earliestUnblockAt)) {
      earliestUnblockAt = until;
    }
  }

  return {
    rotated: false,
    credential: failedCredential,
    fromIndex: failedIdx,
    toIndex: failedIdx,
    total: slots.length,
    fromLabel,
    reason,
    earliestUnblockAt,
  };
}

export async function snapshotProvider(provider: AuthProvider): Promise<AuthSnapshot> {
  const cfg = await readGlobalConfig();
  const oauthSlots = buildOAuthSlots(provider, cfg, false);
  const keySlots = buildApiKeySlots(provider, cfg);
  const dirMap = await getDirPools();
  const runtimeOAuth = getPoolRuntimeEntry(dirMap, `${provider}:oauth`);
  const runtimeKeys = getPoolRuntimeEntry(dirMap, `${provider}:api_key`);

  const activeOAuthIdx = oauthSlots.length > 0 ? selectSlotIndex(oauthSlots, runtimeOAuth) : -1;
  const activeKeyIdx = keySlots.length > 0 ? selectSlotIndex(keySlots, runtimeKeys) : -1;
  const activeOAuthSlot = activeOAuthIdx >= 0 ? oauthSlots[activeOAuthIdx] : undefined;
  const activeEntry = activeOAuthSlot?.entry;

  const accounts: AuthSnapshotAccount[] = [
    ...oauthSlots.map((slot, idx) => ({
      index: idx,
      kind: "oauth" as const,
      ownerProvider: slot.ownerProvider,
      identityKey: slot.identityKey,
      email: slot.email,
      accountId: slot.accountId,
      projectId: slot.projectId,
      expires: slot.expires,
      hasRefresh: slot.hasRefresh,
      dead: slot.dead,
      active: idx === activeOAuthIdx,
      blockedUntil: runtimeOAuth.blockedUntil.get(slot.identityKey),
      blockedReason: runtimeOAuth.blockedReason.get(slot.identityKey),
      maskedToken: slot.maskedToken,
    })),
    ...keySlots.map((slot, idx) => ({
      index: idx,
      kind: "api_key" as const,
      ownerProvider: slot.ownerProvider,
      identityKey: slot.identityKey,
      active: oauthSlots.length === 0 && idx === activeKeyIdx,
      blockedUntil: runtimeKeys.blockedUntil.get(slot.identityKey),
      blockedReason: runtimeKeys.blockedReason.get(slot.identityKey),
      maskedToken: slot.maskedToken,
    })),
  ];

  return {
    apiKey: keySlots[activeKeyIdx >= 0 ? activeKeyIdx : 0]?.apiKey,
    oauth: oauthEntryAccess(activeEntry),
    oauthExpires: typeof activeEntry === "object" ? activeEntry.expires : undefined,
    oauthHasRefresh: typeof activeEntry === "object" ? !!activeEntry.refresh : false,
    oauthEmail: activeOAuthSlot?.email,
    poolSize: oauthSlots.length,
    apiKeyPoolSize: keySlots.length,
    accounts,
  };
}

/** Read all stored OAuth entries for a provider (object or string entries). */
export async function getStoredOAuthPool(provider: AuthProvider): Promise<OAuthEntry[]> {
  const cfg = await readGlobalConfig();
  return normalizeOAuthPool(cfg.oauth?.[provider]);
}

/** Read the active stored OAuth record (object form only). */
export async function getStoredOAuth(provider: AuthProvider): Promise<StoredOAuth | undefined> {
  const cfg = await readGlobalConfig();
  const slots = buildOAuthSlots(provider, cfg, false);
  if (slots.length === 0) return undefined;
  const dirMap = await getDirPools();
  const runtime = getPoolRuntimeEntry(dirMap, `${provider}:oauth`);
  const activeIdx = selectSlotIndex(slots, runtime);
  const chosen = slots[activeIdx]?.entry;
  if (typeof chosen === "object") return chosen;
  const firstObj = slots.find(s => typeof s.entry === "object")?.entry;
  return typeof firstObj === "object" ? firstObj : undefined;
}

/** Upsert an OAuth entry into `provider`'s login pool (deduplicating by account identity). */
export async function upsertOAuthEntryNoLock(
  provider: AuthProvider,
  entry: OAuthEntry,
  opts?: { replaceAll?: boolean },
): Promise<{ poolSize: number; index: number; added: boolean }> {
  let resultInfo = { poolSize: 1, index: 0, added: true };
  await saveConfigPatch(raw => {
    const existing = opts?.replaceAll ? [] : normalizeOAuthPool(raw.oauth?.[provider]);
    const incomingId = oauthIdentityKey(entry);
    const matchIdx = existing.findIndex(item => oauthIdentityKey(item) === incomingId);
    const nextPool = [...existing];
    if (matchIdx >= 0) {
      const prev = existing[matchIdx]!;
      const merged: OAuthEntry =
        typeof prev === "object" && typeof entry === "object"
          ? { ...prev, ...entry, projectId: entry.projectId ?? prev.projectId }
          : entry;
      nextPool[matchIdx] = merged;
      resultInfo = { poolSize: nextPool.length, index: matchIdx, added: false };
    } else {
      nextPool.push(entry);
      resultInfo = { poolSize: nextPool.length, index: nextPool.length - 1, added: true };
    }
    return { oauth: { ...(raw.oauth ?? {}), [provider]: compactOAuthPool(nextPool) } };
  });

  // Clear any stale block for this freshly logged-in identity.
  const dirMap = await getDirPools();
  const runtime = getPoolRuntimeEntry(dirMap, `${provider}:oauth`);
  const fullId = `${provider}:${oauthIdentityKey(entry)}`;
  runtime.blockedUntil.delete(fullId);
  runtime.blockedReason.delete(fullId);
  await persistDirPools();

  return resultInfo;
}

/** Persist a plain bearer token (upserts into the pool unless `replaceAll` is true). */
export async function setOauthToken(
  provider: AuthProvider,
  token: string,
  opts?: { replaceAll?: boolean },
): Promise<{ poolSize: number; index: number; added: boolean }> {
  await acquireLock(provider);
  try {
    return await upsertOAuthEntryNoLock(provider, token, opts);
  } finally {
    await releaseLock(provider);
  }
}

/** Persist a full OAuth credential set (upserts into the pool unless locked by caller). */
export async function setOauthCredentialNoLock(
  provider: AuthProvider,
  cred: StoredOAuth,
  opts?: { replaceAll?: boolean },
): Promise<{ poolSize: number; index: number; added: boolean }> {
  return upsertOAuthEntryNoLock(provider, cred, opts);
}

/** Persist a full OAuth credential set (access + refresh + expiry) into the provider's pool. */
export async function setOauthCredential(
  provider: AuthProvider,
  cred: StoredOAuth,
  opts?: { replaceAll?: boolean },
): Promise<{ poolSize: number; index: number; added: boolean }> {
  await acquireLock(provider);
  try {
    return await upsertOAuthEntryNoLock(provider, cred, opts);
  } finally {
    await releaseLock(provider);
  }
}

/** Remove all OAuth credentials for `provider`. */
export async function clearOauthToken(provider: AuthProvider): Promise<boolean> {
  const raw = await readRawGlobalConfig();
  if (!hasOAuthConfigured(raw.oauth?.[provider])) return false;
  await saveConfigPatch(r => {
    const oauth = { ...(r.oauth ?? {}) };
    delete oauth[provider];
    return { oauth };
  });
  await resetAuthPoolState(provider);
  return true;
}

/** Remove one OAuth account by 1-based index, email, accountId, or identityKey; omit selector to clear all. */
export async function removeOAuthAccount(
  provider: AuthProvider,
  selector?: number | string,
): Promise<{ removed: boolean; remaining: number; removedLabel?: string }> {
  if (selector === undefined) {
    const cleared = await clearOauthToken(provider);
    return { removed: cleared, remaining: 0 };
  }

  await acquireLock(provider);
  try {
    const raw = await readRawGlobalConfig();
    const pool = normalizeOAuthPool(raw.oauth?.[provider]);
    if (pool.length === 0) return { removed: false, remaining: 0 };

    const slots = buildOAuthSlots(provider, raw, false);
    let targetIdx = -1;
    if (typeof selector === "number") {
      targetIdx = selector >= 1 && selector <= slots.length ? selector - 1 : -1;
    } else {
      const trimmed = selector.trim();
      const asNum = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
      if (Number.isFinite(asNum) && asNum >= 1 && asNum <= slots.length) {
        targetIdx = asNum - 1;
      } else {
        const lower = trimmed.toLowerCase();
        targetIdx = slots.findIndex(
          s =>
            s.email?.toLowerCase() === lower ||
            s.accountId?.toLowerCase() === lower ||
            s.identityKey.toLowerCase() === lower ||
            s.identityKey.toLowerCase() === `${provider}:${lower}`,
        );
      }
    }
    if (targetIdx === -1) return { removed: false, remaining: pool.length };

    const targetSlot = slots[targetIdx]!;
    const remaining = pool.filter((_, idx) => idx !== targetIdx);
    await saveConfigPatch(r => {
      const oauth = { ...(r.oauth ?? {}) };
      const compacted = compactOAuthPool(remaining);
      if (compacted === undefined) delete oauth[provider];
      else oauth[provider] = compacted;
      return { oauth };
    });

    const dirMap = await getDirPools();
    const runtime = getPoolRuntimeEntry(dirMap, `${provider}:oauth`);
    runtime.blockedUntil.delete(targetSlot.identityKey);
    runtime.blockedReason.delete(targetSlot.identityKey);
    for (const [sess, pinned] of runtime.sessionPinned.entries()) {
      if (pinned === targetSlot.identityKey) runtime.sessionPinned.delete(sess);
    }
    runtime.cursor = remaining.length > 0 ? runtime.cursor % remaining.length : 0;
    await persistDirPools();

    return {
      removed: true,
      remaining: remaining.length,
      removedLabel: formatSlotLabel(targetSlot),
    };
  } finally {
    await releaseLock(provider);
  }
}

export async function setApiKey(provider: AuthProvider, key: string): Promise<void> {
  await saveConfigPatch(raw => ({ providers: { ...(raw.providers ?? {}), [provider]: key } }));
}

/** Add an API key / subscription token to `provider`'s pool (preserving existing primary key). */
export async function addApiKeyToPool(
  provider: AuthProvider,
  key: string,
): Promise<{ added: boolean; poolSize: number }> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key cannot be empty");
  const raw = await readRawGlobalConfig();
  const primary = raw.providers?.[provider]?.trim();
  const extras = (raw.providerPools?.[provider] ?? []).map(k => k.trim()).filter(Boolean);

  if (!primary) {
    await setApiKey(provider, trimmed);
    return { added: true, poolSize: 1 + extras.length };
  }
  if (primary === trimmed || extras.includes(trimmed)) {
    return { added: false, poolSize: 1 + extras.length };
  }
  const nextExtras = [...extras, trimmed];
  await saveConfigPatch(r => ({
    providerPools: { ...(r.providerPools ?? {}), [provider]: nextExtras },
  }));
  return { added: true, poolSize: 1 + nextExtras.length };
}

/** Remove an API key from `provider`'s pool by 1-based index or exact/suffix match; omit selector to clear all. */
export async function removeApiKeyFromPool(
  provider: AuthProvider,
  selector?: number | string,
): Promise<{ removed: boolean; remaining: number }> {
  const raw = await readRawGlobalConfig();
  const keys = apiKeyPoolFor(provider, raw);
  if (keys.length === 0) return { removed: false, remaining: 0 };

  let nextKeys: string[];
  if (selector === undefined) {
    nextKeys = [];
  } else {
    let targetIdx = -1;
    if (typeof selector === "number") {
      targetIdx = selector >= 1 && selector <= keys.length ? selector - 1 : -1;
    } else {
      const trimmed = selector.trim();
      const asNum = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
      if (Number.isFinite(asNum) && asNum >= 1 && asNum <= keys.length) {
        targetIdx = asNum - 1;
      } else {
        targetIdx = keys.findIndex(k => k === trimmed || k.endsWith(trimmed) || maskSecret(k) === trimmed);
      }
    }
    if (targetIdx === -1) return { removed: false, remaining: keys.length };
    nextKeys = keys.filter((_, i) => i !== targetIdx);
  }

  await saveConfigPatch(r => {
    const providers = { ...(r.providers ?? {}) };
    const pools = { ...(r.providerPools ?? {}) };
    if (nextKeys.length === 0) {
      delete providers[provider];
      delete pools[provider];
    } else {
      providers[provider] = nextKeys[0]!;
      if (nextKeys.length > 1) pools[provider] = nextKeys.slice(1);
      else delete pools[provider];
    }
    return {
      providers,
      providerPools: Object.keys(pools).length > 0 ? pools : undefined,
    };
  });

  const dirMap = await getDirPools();
  const runtime = getPoolRuntimeEntry(dirMap, `${provider}:api_key`);
  runtime.cursor = nextKeys.length > 0 ? runtime.cursor % nextKeys.length : 0;
  await persistDirPools();

  return { removed: true, remaining: nextKeys.length };
}

/** Manually advance circularly (`"next"`) or select a specific 1-based index/email in the pool. */
export async function selectAuthAccount(
  provider: AuthProvider,
  selector: "next" | number | string,
  opts?: { kind?: "oauth" | "api_key"; sessionKey?: string },
): Promise<{ selected: boolean; index: number; total: number; label?: string; kind?: "oauth" | "api_key" }> {
  const cfg = await readGlobalConfig();
  const oauthSlots = opts?.kind === "api_key" ? [] : buildOAuthSlots(provider, cfg, false);
  const keySlots = opts?.kind === "oauth" ? [] : buildApiKeySlots(provider, cfg);
  const slots = oauthSlots.length > 0 ? oauthSlots : keySlots;
  if (slots.length === 0) return { selected: false, index: 0, total: 0 };

  const poolKind = slots[0]!.kind;
  const dirMap = await getDirPools();
  const runtime = getPoolRuntimeEntry(dirMap, `${provider}:${poolKind}`);

  let targetIdx = -1;
  if (selector === "next") {
    const current = selectSlotIndex(slots, runtime, { sessionKey: opts?.sessionKey });
    targetIdx = (current + 1) % slots.length;
  } else if (typeof selector === "number") {
    targetIdx = selector >= 1 && selector <= slots.length ? selector - 1 : -1;
  } else {
    const trimmed = selector.trim();
    const asNum = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
    if (Number.isFinite(asNum) && asNum >= 1 && asNum <= slots.length) {
      targetIdx = asNum - 1;
    } else {
      const lower = trimmed.toLowerCase();
      targetIdx = slots.findIndex(
        s =>
          s.email?.toLowerCase() === lower ||
          s.accountId?.toLowerCase() === lower ||
          s.maskedToken.toLowerCase() === lower,
      );
    }
  }
  if (targetIdx === -1) return { selected: false, index: 0, total: slots.length, kind: poolKind };

  const chosen = slots[targetIdx]!;
  runtime.cursor = targetIdx;
  runtime.blockedUntil.delete(chosen.identityKey);
  runtime.blockedReason.delete(chosen.identityKey);
  setSessionPin(runtime, opts?.sessionKey, chosen.identityKey);
  await persistDirPools();

  return {
    selected: true,
    index: targetIdx,
    total: slots.length,
    label: formatSlotLabel(chosen),
    kind: poolKind,
  };
}

/** Clear active rate/usage-limit cooldowns for a provider (or all providers). */
export async function clearAuthCooldown(provider?: AuthProvider): Promise<void> {
  const dirMap = await getDirPools();
  for (const [key, entry] of dirMap.entries()) {
    if (!provider || key.startsWith(`${provider}:`)) {
      entry.blockedUntil.clear();
      entry.blockedReason.clear();
    }
  }
  await persistDirPools();
}
