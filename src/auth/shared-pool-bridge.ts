import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { readGlobalConfig, saveConfigPatch, type OAuthEntry } from "../agent/state";
import { jeoEnv } from "../util/env";
import { isPerplexityJweToken, verifyPerplexitySessionToken } from "./flows/perplexity";

export interface SharedCooldownRecord {
  blockedUntil: number;
  reason?: string;
  source: "jeo-code" | "jeopi";
}

interface SharedCooldownFile {
  version: 1;
  updatedAt: number;
  cooldowns: Record<string, SharedCooldownRecord>;
}

const CANONICAL_PROVIDER_MAP: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  "openai-codex": "openai",
  antigravity: "antigravity",
  "google-antigravity": "antigravity",
  gemini: "gemini",
  "google-gemini-cli": "gemini",
  perplexity: "perplexity",
};

export function canonicalSharedProvider(provider: string): string {
  return CANONICAL_PROVIDER_MAP[provider.toLowerCase()] ?? provider.toLowerCase();
}

export function resolveSharedPoolPath(): string {
  return process.env.JEO_SHARED_AUTH_POOL_PATH?.trim() || path.join(os.homedir(), ".agents", "auth-pool", "cooldowns.json");
}

export function shouldUseSharedPool(configDir: string): boolean {
  if (process.env.JEO_SHARED_AUTH_POOL_PATH?.trim()) return true;
  if (process.env.NODE_ENV === "test" && !jeoEnv("CONFIG_DIR")) return false;
  return path.resolve(configDir) === path.resolve(path.join(os.homedir(), ".jeo"));
}

function hashToken(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
}

export function sharedIdentityKey(input: {
  email?: string;
  accountId?: string;
  entry?: OAuthEntry;
}): string | null {
  const obj = typeof input.entry === "object" ? input.entry : undefined;
  const email = (input.email || obj?.email)?.trim().toLowerCase();
  if (email) return `email:${email}`;
  const accountId = (input.accountId || obj?.accountId)?.trim().toLowerCase();
  if (accountId) return `account:${accountId}`;
  const refresh = obj?.refresh?.trim();
  if (refresh) return `tok:${hashToken(refresh)}`;
  const access = typeof input.entry === "string" ? input.entry.trim() : obj?.access?.trim();
  if (access) return `tok:${hashToken(access)}`;
  return null;
}

let cachedSharedFile: {
  filePath: string;
  mtimeNs: bigint;
  size: bigint;
  ino: bigint;
  data: SharedCooldownFile;
} | null = null;

function pruneActiveCooldowns(raw: SharedCooldownFile): SharedCooldownFile {
  const now = Date.now();
  const active: Record<string, SharedCooldownRecord> = {};
  for (const [k, rec] of Object.entries(raw.cooldowns)) {
    if (rec.blockedUntil > now) active[k] = rec;
  }
  return { version: 1, updatedAt: raw.updatedAt, cooldowns: active };
}

function readSharedFile(): SharedCooldownFile {
  const filePath = resolveSharedPoolPath();
  try {
    const st = fs.statSync(filePath, { bigint: true });
    if (
      cachedSharedFile &&
      cachedSharedFile.filePath === filePath &&
      cachedSharedFile.mtimeNs === st.mtimeNs &&
      cachedSharedFile.size === st.size &&
      cachedSharedFile.ino === st.ino
    ) {
      return pruneActiveCooldowns(cachedSharedFile.data);
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SharedCooldownFile>;
    if (parsed && parsed.version === 1 && parsed.cooldowns && typeof parsed.cooldowns === "object") {
      const now = Date.now();
      const active: Record<string, SharedCooldownRecord> = {};
      for (const [k, rec] of Object.entries(parsed.cooldowns)) {
        if (rec && typeof rec.blockedUntil === "number" && Number.isFinite(rec.blockedUntil) && rec.blockedUntil > now) {
          active[k] = {
            blockedUntil: rec.blockedUntil,
            ...(typeof rec.reason === "string" ? { reason: rec.reason } : {}),
            source: rec.source === "jeopi" ? "jeopi" : "jeo-code",
          };
        }
      }
      const data: SharedCooldownFile = { version: 1, updatedAt: parsed.updatedAt ?? now, cooldowns: active };
      cachedSharedFile = { filePath, mtimeNs: st.mtimeNs, size: st.size, ino: st.ino, data };
      return data;
    }
  } catch {
    cachedSharedFile = null;
  }
  return { version: 1, updatedAt: Date.now(), cooldowns: {} };
}

function writeSharedFile(data: SharedCooldownFile): void {
  const filePath = resolveSharedPoolPath();
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  cachedSharedFile = null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {}
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
}

export function lookupSharedCooldown(
  provider: string,
  slot: { email?: string; accountId?: string; entry?: OAuthEntry },
): SharedCooldownRecord | undefined {
  const ident = sharedIdentityKey(slot);
  if (!ident) return undefined;
  const key = `${canonicalSharedProvider(provider)}:${ident}`;
  const data = readSharedFile();
  const rec = data.cooldowns[key];
  if (!rec || rec.blockedUntil <= Date.now()) return undefined;
  return rec;
}

export function recordSharedCooldown(
  provider: string,
  slot: { email?: string; accountId?: string; entry?: OAuthEntry },
  blockedUntil: number,
  reason?: string,
): void {
  if (!Number.isFinite(blockedUntil) || blockedUntil <= Date.now()) return;
  const ident = sharedIdentityKey(slot);
  if (!ident) return;
  const key = `${canonicalSharedProvider(provider)}:${ident}`;
  const data = readSharedFile();
  const existing = data.cooldowns[key];
  const mergedUntil = existing ? Math.max(existing.blockedUntil, blockedUntil) : blockedUntil;
  data.cooldowns[key] = {
    blockedUntil: mergedUntil,
    ...(reason ? { reason } : existing?.reason ? { reason: existing.reason } : {}),
    source: "jeo-code",
  };
  data.updatedAt = Date.now();
  writeSharedFile(data);
}

export function clearSharedCooldown(provider?: string): void {
  const filePath = resolveSharedPoolPath();
  cachedSharedFile = null;
  if (!provider) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
    return;
  }
  const canon = `${canonicalSharedProvider(provider)}:`;
  const data = readSharedFile();
  let changed = false;
  for (const key of Object.keys(data.cooldowns)) {
    if (key.startsWith(canon)) {
      delete data.cooldowns[key];
      changed = true;
    }
  }
  if (changed) {
    data.updatedAt = Date.now();
    writeSharedFile(data);
  }
}

export interface SyncOAuthResult {
  imported: number;
  skipped: number;
  byProvider: Record<string, number>;
}

const JEOPI_PROVIDER_TO_JEO: Record<string, "anthropic" | "openai" | "antigravity" | "perplexity"> = {
  anthropic: "anthropic",
  "openai-codex": "openai",
  "google-antigravity": "antigravity",
  perplexity: "perplexity",
};

export async function syncOAuthFromJeopi(opts?: { agentDbPath?: string; dryRun?: boolean }): Promise<SyncOAuthResult> {
  const dbPath = opts?.agentDbPath?.trim() || path.join(os.homedir(), ".jeopi", "agent", "agent.db");
  const result: SyncOAuthResult = { imported: 0, skipped: 0, byProvider: {} };
  if (!fs.existsSync(dbPath)) return result;

  const cfg = await readGlobalConfig();
  const oauthCopy: Record<string, OAuthEntry[]> = {};
  for (const p of ["anthropic", "openai", "gemini", "antigravity", "kimi", "perplexity"] as const) {
    const rawPool = cfg.oauth?.[p];
    if (Array.isArray(rawPool)) oauthCopy[p] = [...rawPool];
    else if (rawPool) oauthCopy[p] = [rawPool];
    else oauthCopy[p] = [];
  }

  const hasAccount = (pool: OAuthEntry[], cand: { email?: string; accountId?: string; refresh?: string; access?: string }) => {
    const cEmail = cand.email?.trim().toLowerCase();
    const cAcct = cand.accountId?.trim().toLowerCase();
    const cRef = cand.refresh?.trim();
    const cAcc = cand.access?.trim();
    return pool.some((entry) => {
      if (typeof entry === "string") return Boolean(cAcc && entry === cAcc);
      if (cEmail && entry.email?.trim().toLowerCase() === cEmail) return true;
      if (cAcct && entry.accountId?.trim().toLowerCase() === cAcct) return true;
      if (cRef && entry.refresh?.trim() === cRef) return true;
      if (cAcc && entry.access?.trim() === cAcc) return true;
      return false;
    });
  };

  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query("SELECT provider, data FROM auth_credentials WHERE credential_type = 'oauth' AND disabled_cause IS NULL")
      .all() as Array<{ provider: string; data: string }>;
    for (const row of rows) {
      const target = JEOPI_PROVIDER_TO_JEO[row.provider];
      if (!target) {
        result.skipped++;
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        result.skipped++;
        continue;
      }
      const access = typeof parsed.access === "string" ? parsed.access.trim() : "";
      const refresh = typeof parsed.refresh === "string" ? parsed.refresh.trim() : "";
      let email = typeof parsed.email === "string" ? parsed.email.trim() : undefined;
      const accountId = typeof parsed.accountId === "string" ? parsed.accountId.trim() : undefined;
      const projectId = typeof parsed.projectId === "string" ? parsed.projectId.trim() : undefined;
      const expires = typeof parsed.expires === "number" && Number.isFinite(parsed.expires) ? parsed.expires : undefined;
      if (!access || (!refresh && expires && expires <= Date.now())) {
        result.skipped++;
        continue;
      }
      const pool = (oauthCopy[target] ??= []);
      if (hasAccount(pool, { email, accountId, refresh, access })) {
        result.skipped++;
        continue;
      }
      if (target === "perplexity" && isPerplexityJweToken(access)) {
        const verified = await verifyPerplexitySessionToken(access);
        if (!verified.valid) {
          result.skipped++;
          continue;
        }
        if (!email && verified.email) {
          email = verified.email;
          if (hasAccount(pool, { email, accountId, refresh, access })) {
            result.skipped++;
            continue;
          }
        }
      }
      pool.push({
        access,
        ...(refresh ? { refresh } : {}),
        ...(expires ? { expires } : {}),
        ...(email ? { email } : {}),
        ...(accountId ? { accountId } : {}),
        ...(projectId ? { projectId } : {}),
      });
      result.imported++;
      result.byProvider[target] = (result.byProvider[target] ?? 0) + 1;
    }
  } finally {
    db?.close();
  }

  if (result.imported > 0 && !opts?.dryRun) {
    const nextOAuth: Record<string, OAuthEntry | OAuthEntry[]> = {};
    for (const [k, list] of Object.entries(oauthCopy)) {
      if (list.length === 1) nextOAuth[k] = list[0]!;
      else if (list.length > 1) nextOAuth[k] = list;
    }
    await saveConfigPatch(() => ({ oauth: nextOAuth }));
  }
  return result;
}
