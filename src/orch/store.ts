/**
 * Atomic file storage & single-instance lock for `~/.jeo/thread-orchestrator/`.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LedgerEntry, OrchConfig, OrchConfigFile, OrchState, ProjectRoute } from "./types";

export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_DEBOUNCE_MS = 12_000;
export const DEFAULT_MAX_ITERATIONS = 4;
export const DEFAULT_SAME_FAILURE_LIMIT = 2;
export const DEFAULT_MAX_WORKERS = 3;
export const LOCAL_ORCH_CONFIG_RELPATH = path.join(".jeo", "orch.json");

export function resolveOrchHome(override?: string): string {

  if (override) return path.resolve(override);
  if (process.env.JEO_ORCH_HOME?.trim()) return path.resolve(process.env.JEO_ORCH_HOME.trim());
  return path.join(os.homedir(), ".jeo", "thread-orchestrator");
}

export function orchPaths(orchHome = resolveOrchHome()) {
  return {
    home: orchHome,
    routesFile: path.join(orchHome, "routes.json"),
    stateFile: path.join(orchHome, "state.json"),
    ledgerFile: path.join(orchHome, "ledger.jsonl"),
    lockFile: path.join(orchHome, "run.lock"),
    logFile: path.join(orchHome, "orch.log"),
    runScript: path.join(orchHome, "run-orch.sh"),
  };
}

/** Read hints (`allowedUserIds`, `tokenEnv`) from `~/.jeo/discord/messenger.json` if present. */
export async function readDiscordMessengerDefaults(home = os.homedir()): Promise<{
  ownerUserIds: string[];
  allowedChannelIds: string[];
  tokenFile: string;
  tokenEnv: string;
}> {
  const discordDir = path.join(home, ".jeo", "discord");
  const tokenFile = path.join(discordDir, "discord-token");
  const messengerFile = path.join(discordDir, "messenger.json");
  let ownerUserIds: string[] = [];
  let allowedChannelIds: string[] = [];
  let tokenEnv = "JEO_DISCORD_BOT_TOKEN";

  try {
    const raw = await fs.readFile(messengerFile, "utf8");
    const parsed = JSON.parse(raw);
    const discord = parsed?.platforms?.discord;
    if (Array.isArray(discord?.allowedUserIds)) {
      ownerUserIds = discord.allowedUserIds.map(String).filter(Boolean);
    }
    if (Array.isArray(discord?.allowedChannelIds)) {
      allowedChannelIds = discord.allowedChannelIds.map(String).filter(Boolean);
    }
    if (typeof discord?.tokenEnv === "string" && discord.tokenEnv.trim()) {
      tokenEnv = discord.tokenEnv.trim();
    }
  } catch {
    // Missing or unreadable messenger.json is fine; callers can configure explicitly.
  }

  return { ownerUserIds, allowedChannelIds, tokenFile, tokenEnv };
}

export async function createDefaultOrchConfig(
  home = os.homedir(),
  opts: { includeMessengerDefaults?: boolean } = {},
): Promise<OrchConfig> {
  const includeMessengerDefaults = opts.includeMessengerDefaults ?? true;
  const hints = includeMessengerDefaults
    ? await readDiscordMessengerDefaults(home)
    : {
        ownerUserIds: [],
        allowedChannelIds: [],
        tokenFile: path.join(home, ".jeo", "discord", "discord-token"),
        tokenEnv: "JEO_DISCORD_BOT_TOKEN",
      };
  return {
    version: 1,
    guildId: "",
    ownerUserIds: hints.ownerUserIds,
    ownerDmChannelId: undefined,
    tokenFile: hints.tokenFile,
    tokenEnv: hints.tokenEnv,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    routes: [],
  };
}

function isDefaultUserOrchHome(orchHome: string): boolean {
  return path.resolve(orchHome) === path.join(os.homedir(), ".jeo", "thread-orchestrator");
}

export function createEmptyOrchState(): OrchState {
  return {
    version: 1,
    threads: {},
    gates: {},
  };
}

async function writeAtomicJson(filePath: string, data: unknown, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, mode ? { encoding: "utf8", mode } : "utf8");
  if (mode) {
    await fs.chmod(tmp, mode).catch(() => undefined);
  }
  await fs.rename(tmp, filePath);
}

/** Resolve the repo-local hidden config file path (defaults to `<cwd>/.jeo/orch.json`). */
export function resolveLocalOrchConfigPath(cwd = process.cwd(), explicitPath?: string): string {
  const base = path.resolve(cwd);
  if (explicitPath?.trim()) {
    return path.resolve(base, explicitPath.trim());
  }
  return path.join(base, LOCAL_ORCH_CONFIG_RELPATH);
}

function configFileBaseDir(configPath: string): string {
  const resolved = path.resolve(configPath);
  const dir = path.dirname(resolved);
  return path.basename(dir) === ".jeo" ? path.dirname(dir) : dir;
}

function resolveMaybeRelativePath(value: string, baseDir: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\") || path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.resolve(baseDir, trimmed);
}

export interface LoadedOrchConfigFile {
  path: string;
  baseDir: string;
  data: OrchConfigFile;
  routes: ProjectRoute[];
}

/**
 * Read and normalize a repo-local hidden config file (e.g. `<repo>/.jeo/orch.json`).
 * Returns `undefined` if the file does not exist; throws on invalid JSON or non-object content.
 */
export async function readOrchConfigFile(filePath: string): Promise<LoadedOrchConfigFile | undefined> {
  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in orchestrator config file ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Orchestrator config file ${resolved} must contain a JSON object.`);
  }

  const data = parsed as OrchConfigFile;
  const baseDir = configFileBaseDir(resolved);
  const rawRoutes: Partial<ProjectRoute>[] = [];
  if (data.route && typeof data.route === "object" && !Array.isArray(data.route)) {
    rawRoutes.push(data.route);
  }
  if (Array.isArray(data.routes)) {
    for (const r of data.routes) {
      if (r && typeof r === "object" && !Array.isArray(r)) rawRoutes.push(r);
    }
  }

  const routes = rawRoutes.map(r =>
    normalizeRoute({
      ...r,
      repoPath: r.repoPath ? resolveMaybeRelativePath(r.repoPath, baseDir) : baseDir,
      ...(r.orcaWorktreePath ? { orcaWorktreePath: resolveMaybeRelativePath(r.orcaWorktreePath, baseDir) } : {}),
    }),
  );

  const normalizedData: OrchConfigFile = {
    ...(typeof data.guildId === "string" && data.guildId.trim() ? { guildId: data.guildId.trim() } : {}),
    ...(Array.isArray(data.ownerUserIds)
      ? { ownerUserIds: [...new Set(data.ownerUserIds.map(s => String(s).trim()).filter(Boolean))] }
      : {}),
    ...(typeof data.ownerDmChannelId === "string" && data.ownerDmChannelId.trim()
      ? { ownerDmChannelId: data.ownerDmChannelId.trim() }
      : {}),
    ...(typeof data.tokenFile === "string" && data.tokenFile.trim()
      ? { tokenFile: resolveMaybeRelativePath(data.tokenFile, baseDir) }
      : {}),
    ...(typeof data.tokenEnv === "string" && data.tokenEnv.trim() ? { tokenEnv: data.tokenEnv.trim() } : {}),
    ...(typeof data.orcaBin === "string" && data.orcaBin.trim() ? { orcaBin: data.orcaBin.trim() } : {}),
    ...(typeof data.pollIntervalMs === "number" && data.pollIntervalMs >= 2000 ? { pollIntervalMs: data.pollIntervalMs } : {}),
    ...(typeof data.debounceMs === "number" && data.debounceMs >= 0 ? { debounceMs: data.debounceMs } : {}),
    ...(data.route && typeof data.route === "object" && !Array.isArray(data.route) ? { route: data.route } : {}),
    ...(Array.isArray(data.routes) ? { routes: data.routes } : {}),
  };

  return { path: resolved, baseDir, data: normalizedData, routes };
}


/** Write a repo-local hidden orchestrator config file with 0600 permissions. */
export async function writeLocalOrchConfigFile(filePath: string, data: OrchConfigFile): Promise<string> {
  const resolved = path.resolve(filePath);
  await writeAtomicJson(resolved, data, 0o600);
  return resolved;
}

/** Load only the persisted `<orchHome>/routes.json` without merging external `configFiles`. */
export async function loadStoredOrchConfig(orchHome = resolveOrchHome()): Promise<OrchConfig> {
  const { routesFile } = orchPaths(orchHome);
  const defaults = await createDefaultOrchConfig(os.homedir(), {
    includeMessengerDefaults: isDefaultUserOrchHome(orchHome),
  });
  try {
    const raw = await fs.readFile(routesFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<OrchConfig>;
    const configFiles = Array.isArray(parsed.configFiles)
      ? [...new Set(parsed.configFiles.map(s => String(s).trim()).filter(Boolean).map(p => path.resolve(p)))]
      : undefined;
    return {
      version: 1,
      guildId: typeof parsed.guildId === "string" ? parsed.guildId : defaults.guildId,
      ownerUserIds: Array.isArray(parsed.ownerUserIds) ? parsed.ownerUserIds.map(String) : defaults.ownerUserIds,
      ownerDmChannelId: typeof parsed.ownerDmChannelId === "string" && parsed.ownerDmChannelId.trim() ? parsed.ownerDmChannelId.trim() : undefined,
      tokenFile: typeof parsed.tokenFile === "string" && parsed.tokenFile.trim() ? parsed.tokenFile.trim() : defaults.tokenFile,
      tokenEnv: typeof parsed.tokenEnv === "string" && parsed.tokenEnv.trim() ? parsed.tokenEnv.trim() : defaults.tokenEnv,
      ...(typeof parsed.orcaBin === "string" && parsed.orcaBin.trim() ? { orcaBin: parsed.orcaBin.trim() } : {}),
      pollIntervalMs: typeof parsed.pollIntervalMs === "number" && parsed.pollIntervalMs >= 2000 ? parsed.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS,
      debounceMs: typeof parsed.debounceMs === "number" && parsed.debounceMs >= 0 ? parsed.debounceMs : DEFAULT_DEBOUNCE_MS,
      ...(configFiles && configFiles.length > 0 ? { configFiles } : {}),
      routes: Array.isArray(parsed.routes) ? parsed.routes.map(normalizeRoute) : [],
    };
  } catch {
    return defaults;
  }
}

function mergeConfigOverlay(
  base: OrchConfig,
  defaults: OrchConfig,
  overlay: LoadedOrchConfigFile,
  overrideScalars: boolean,
): OrchConfig {
  const { data } = overlay;
  const mergedRoutes = [...base.routes];
  for (const route of overlay.routes) {
    const idx = mergedRoutes.findIndex(r => r.id === route.id);
    if (idx === -1) mergedRoutes.push(route);
    else mergedRoutes[idx] = route;
  }

  return {
    ...base,
    guildId: data.guildId && (overrideScalars || !base.guildId) ? data.guildId : base.guildId,
    ownerUserIds: data.ownerUserIds?.length
      ? Array.from(new Set([...base.ownerUserIds, ...data.ownerUserIds]))
      : base.ownerUserIds,
    ownerDmChannelId:
      data.ownerDmChannelId && (overrideScalars || !base.ownerDmChannelId)
        ? data.ownerDmChannelId
        : base.ownerDmChannelId,
    tokenFile:
      data.tokenFile && (overrideScalars || base.tokenFile === defaults.tokenFile)
        ? data.tokenFile
        : base.tokenFile,
    tokenEnv:
      data.tokenEnv && (overrideScalars || base.tokenEnv === defaults.tokenEnv)
        ? data.tokenEnv
        : base.tokenEnv,
    ...(data.orcaBin && (overrideScalars || !base.orcaBin)
      ? { orcaBin: data.orcaBin }
      : base.orcaBin
        ? { orcaBin: base.orcaBin }
        : {}),
    pollIntervalMs:
      typeof data.pollIntervalMs === "number" && (overrideScalars || base.pollIntervalMs === DEFAULT_POLL_INTERVAL_MS)
        ? data.pollIntervalMs
        : base.pollIntervalMs,
    debounceMs:
      typeof data.debounceMs === "number" && (overrideScalars || base.debounceMs === DEFAULT_DEBOUNCE_MS)
        ? data.debounceMs
        : base.debounceMs,
    routes: mergedRoutes,
  };
}

export interface LoadOrchConfigOptions {
  /** Optional explicit config file path to overlay (overrides scalar values). */
  configFile?: string;
  /** Whether to honor `JEO_ORCH_CONFIG` env var (default: true). */
  includeEnvConfig?: boolean;
}

export async function loadOrchConfig(
  orchHome = resolveOrchHome(),
  opts: LoadOrchConfigOptions = {},
): Promise<OrchConfig> {
  const defaults = await createDefaultOrchConfig(os.homedir(), {
    includeMessengerDefaults: isDefaultUserOrchHome(orchHome),
  });
  let config = await loadStoredOrchConfig(orchHome);

  const linkedFiles = config.configFiles ?? [];
  for (const filePath of linkedFiles) {
    try {
      const overlay = await readOrchConfigFile(filePath);
      if (overlay) {
        config = mergeConfigOverlay(config, defaults, overlay, false);
      }
    } catch {
      // Skip unreadable/invalid linked repo config so other routes keep running.
    }
  }

  const explicitFile =
    opts.configFile?.trim() || (opts.includeEnvConfig !== false ? process.env.JEO_ORCH_CONFIG?.trim() : undefined);
  if (explicitFile) {
    try {
      const overlay = await readOrchConfigFile(explicitFile);
      if (overlay) {
        config = mergeConfigOverlay(config, defaults, overlay, true);
      }
    } catch {
      // Skip unreadable explicit overlay on read path; explicit CLI link/init validates directly.
    }
  }

  return config;
}

export function normalizeRoute(raw: Partial<ProjectRoute>): ProjectRoute {
  const repoPath = path.resolve(raw.repoPath ?? process.cwd());
  const id = slugifyRouteId(raw.id || raw.name || path.basename(repoPath));
  return {
    id,
    name: raw.name?.trim() || id,
    enabled: raw.enabled ?? true,
    parentChannelIds: Array.isArray(raw.parentChannelIds) ? [...new Set(raw.parentChannelIds.map(String).filter(Boolean))] : [],
    titleKeywords: Array.isArray(raw.titleKeywords) ? raw.titleKeywords.map(s => String(s).trim()).filter(Boolean) : [],
    titlePrefixes: Array.isArray(raw.titlePrefixes) ? raw.titlePrefixes.map(s => String(s).trim()).filter(Boolean) : undefined,
    repoPath,
    orcaWorktreePath: raw.orcaWorktreePath ? path.resolve(raw.orcaWorktreePath) : undefined,
    maxIterations: clampInt(raw.maxIterations, 1, 10, DEFAULT_MAX_ITERATIONS),
    sameFailureLimit: clampInt(raw.sameFailureLimit, 1, 5, DEFAULT_SAME_FAILURE_LIMIT),
    maxWorkers: clampInt(raw.maxWorkers, 1, 8, DEFAULT_MAX_WORKERS),
    spawnIfBusy: raw.spawnIfBusy ?? true,
    verificationGates: Array.isArray(raw.verificationGates)
      ? raw.verificationGates
          .filter(g => g && typeof g.name === "string" && typeof g.command === "string")
          .map(g => ({
            name: g.name.trim(),
            command: g.command.trim(),
            ...(g.cwd ? { cwd: g.cwd } : {}),
            ...(typeof g.timeoutMs === "number" && g.timeoutMs > 0 ? { timeoutMs: g.timeoutMs } : {}),
          }))
      : [],
    allowBotQaMarkers: Array.isArray(raw.allowBotQaMarkers)
      ? raw.allowBotQaMarkers.map(String).filter(Boolean)
      : undefined,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function slugifyRouteId(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export async function saveOrchConfig(config: OrchConfig, orchHome = resolveOrchHome()): Promise<void> {
  const { routesFile } = orchPaths(orchHome);
  const configFiles = Array.isArray(config.configFiles)
    ? [...new Set(config.configFiles.map(s => String(s).trim()).filter(Boolean).map(p => path.resolve(p)))]
    : undefined;
  await writeAtomicJson(routesFile, {
    ...config,
    version: 1,
    ...(configFiles && configFiles.length > 0 ? { configFiles } : { configFiles: undefined }),
    routes: config.routes.map(normalizeRoute),
  });
}

/** Validate and link a repo-local hidden config file (e.g. `<repo>/.jeo/orch.json`) into `routes.json`. */
export async function linkOrchConfigFile(
  filePath: string,
  orchHome = resolveOrchHome(),
): Promise<{ config: OrchConfig; linkedPath: string; added: boolean; loaded: LoadedOrchConfigFile }> {
  const resolved = path.resolve(filePath);
  const loaded = await readOrchConfigFile(resolved);
  if (!loaded) {
    throw new Error(`Orchestrator config file not found: ${resolved}`);
  }
  const stored = await loadStoredOrchConfig(orchHome);
  const existing = stored.configFiles ?? [];
  const added = !existing.includes(resolved);
  if (added) {
    stored.configFiles = [...existing, resolved];
    await saveOrchConfig(stored, orchHome);
  }
  const effective = await loadOrchConfig(orchHome);
  return { config: effective, linkedPath: resolved, added, loaded };
}

/** Unlink a repo-local hidden config file from `routes.json`. */
export async function unlinkOrchConfigFile(
  filePath: string,
  orchHome = resolveOrchHome(),
): Promise<{ config: OrchConfig; unlinkedPath: string; removed: boolean }> {
  const resolved = path.resolve(filePath);
  const stored = await loadStoredOrchConfig(orchHome);
  const before = stored.configFiles ?? [];
  const after = before.filter(p => path.resolve(p) !== resolved);
  const removed = after.length !== before.length;
  if (removed) {
    stored.configFiles = after.length > 0 ? after : undefined;
    await saveOrchConfig(stored, orchHome);
  }
  const effective = await loadOrchConfig(orchHome);
  return { config: effective, unlinkedPath: resolved, removed };
}

export async function upsertRoute(route: Partial<ProjectRoute>, orchHome = resolveOrchHome()): Promise<{ config: OrchConfig; route: ProjectRoute; created: boolean }> {
  const stored = await loadStoredOrchConfig(orchHome);
  const normalized = normalizeRoute(route);
  const idx = stored.routes.findIndex(r => r.id === normalized.id);
  const created = idx === -1;
  if (created) stored.routes.push(normalized);
  else stored.routes[idx] = normalized;
  await saveOrchConfig(stored, orchHome);
  const config = await loadOrchConfig(orchHome);
  return { config, route: normalized, created };
}

export async function removeRoute(routeId: string, orchHome = resolveOrchHome()): Promise<{ config: OrchConfig; removed: boolean }> {
  const stored = await loadStoredOrchConfig(orchHome);
  const before = stored.routes.length;
  stored.routes = stored.routes.filter(r => r.id !== routeId);
  const removed = stored.routes.length !== before;
  if (removed) await saveOrchConfig(stored, orchHome);
  const config = await loadOrchConfig(orchHome);
  return { config, removed };
}


export async function loadOrchState(orchHome = resolveOrchHome()): Promise<OrchState> {
  const { stateFile } = orchPaths(orchHome);
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<OrchState>;
    return {
      version: 1,
      botUserId: typeof parsed.botUserId === "string" ? parsed.botUserId : undefined,
      lastPollAt: typeof parsed.lastPollAt === "string" ? parsed.lastPollAt : undefined,
      threads: parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {},
      gates: parsed.gates && typeof parsed.gates === "object" ? parsed.gates : {},
    };
  } catch {
    return createEmptyOrchState();
  }
}

export async function saveOrchState(state: OrchState, orchHome = resolveOrchHome()): Promise<void> {
  const { stateFile } = orchPaths(orchHome);
  await writeAtomicJson(stateFile, state);
}

export async function appendLedger(entry: LedgerEntry, orchHome = resolveOrchHome()): Promise<void> {
  const { ledgerFile } = orchPaths(orchHome);
  await fs.mkdir(path.dirname(ledgerFile), { recursive: true });
  await fs.appendFile(ledgerFile, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readRecentLedger(limit = 20, orchHome = resolveOrchHome()): Promise<LedgerEntry[]> {
  const { ledgerFile } = orchPaths(orchHome);
  try {
    const raw = await fs.readFile(ledgerFile, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines
      .slice(Math.max(0, lines.length - limit))
      .map(line => {
        try {
          return JSON.parse(line) as LedgerEntry;
        } catch {
          return undefined;
        }
      })
      .filter((x): x is LedgerEntry => !!x);
  } catch {
    return [];
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }

}

export interface InstanceLock {
  release: () => Promise<void>;
}

/**
 * Single-instance PID lock with automatic stale-lock recovery.
 * Throws if another live process already owns `run.lock`.
 */
export async function acquireInstanceLock(orchHome = resolveOrchHome()): Promise<InstanceLock> {
  const { lockFile } = orchPaths(orchHome);
  await fs.mkdir(orchHome, { recursive: true });

  const tryCreate = async (): Promise<boolean> => {
    try {
      const fh = await fs.open(lockFile, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n", "utf8");
      await fh.close();
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      return false;
    }
  };

  if (!(await tryCreate())) {
    let existingPid = 0;
    try {
      const raw = await fs.readFile(lockFile, "utf8");
      existingPid = Number(JSON.parse(raw)?.pid ?? 0);
    } catch {
      existingPid = 0;
    }
    if (existingPid > 0 && existingPid !== process.pid && isPidAlive(existingPid)) {
      throw new Error(`Thread orchestrator is already running (pid ${existingPid}, lock ${lockFile}).`);
    }
    await fs.unlink(lockFile).catch(() => undefined);
    if (!(await tryCreate())) {
      throw new Error(`Could not acquire orchestrator lock at ${lockFile}.`);
    }
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        const raw = await fs.readFile(lockFile, "utf8");
        const pid = Number(JSON.parse(raw)?.pid ?? 0);
        if (pid === process.pid) await fs.unlink(lockFile);
      } catch {
        // Ignore already-removed lock
      }
    },
  };
}
