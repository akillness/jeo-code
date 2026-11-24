/**
 * Orchestrator daemon runner, single-instance status inspection, and token resolution.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMessengerToken } from "../messenger/config";
import { createOrchWorkerBackend } from "./backend";
import { RestDiscordClient } from "./discord-api";
import { OrchEngine, type TickSummary } from "./engine";
import { acquireInstanceLock, expandTilde, loadOrchConfig, orchPaths, resolveOrchHome } from "./store";
import type { OrchBackendKind } from "./types";
import { ShellGateVerifier } from "./verifier";

export interface DaemonLockInfo {
  pid: number;
  startedAt: string;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function readTokenFile(filePath: string): Promise<string | undefined> {
  try {
    const raw = (await fs.readFile(filePath, "utf8")).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve Discord bot token from env vars, `<orchHome>/discord-token`, configured `tokenFile`,
 * or `~/.jeo/{discord,messenger}/discord-token`. Never logs the secret value.
 */
export async function resolveDiscordToken(
  orchHome = resolveOrchHome(),
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const resolvedHome = resolveOrchHome(orchHome);
  const config = await loadOrchConfig(resolvedHome);
  const fromEnv =
    env.JEO_ORCH_DISCORD_TOKEN?.trim() ||
    resolveMessengerToken(config.tokenEnv, env)?.trim() ||
    resolveMessengerToken("JEO_DISCORD_BOT_TOKEN", env)?.trim() ||
    env.DISCORD_BOT_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const expandedTokenFile = config.tokenFile ? expandTilde(config.tokenFile) : undefined;
  const candidates = [
    path.join(resolvedHome, "discord-token"),
    expandedTokenFile,
    path.join(os.homedir(), ".jeo", "discord", "discord-token"),
    path.join(os.homedir(), ".jeo", "messenger", "discord-token"),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    const tok = await readTokenFile(file);
    if (tok) return tok;
  }

  return undefined;
}

/** Save a Discord bot token into `<orchHome>/discord-token` with 0600 permissions. */
export async function saveDiscordToken(token: string, orchHome = resolveOrchHome()): Promise<string> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Discord bot token must not be empty.");
  const resolvedHome = resolveOrchHome(orchHome);
  await fs.mkdir(resolvedHome, { recursive: true });
  const target = path.join(resolvedHome, "discord-token");
  await fs.writeFile(target, `${trimmed}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(target, 0o600).catch(() => undefined);
  return target;
}

export async function isDaemonRunning(
  orchHome = resolveOrchHome(),
): Promise<{ running: boolean; lock?: DaemonLockInfo }> {
  const { lockFile } = orchPaths(resolveOrchHome(orchHome));
  try {
    const raw = await fs.readFile(lockFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonLockInfo>;
    const pid = Number(parsed.pid ?? 0);
    if (pid > 0 && isPidAlive(pid)) {
      return { running: true, lock: { pid, startedAt: String(parsed.startedAt ?? "") } };
    }
    return { running: false };
  } catch {
    return { running: false };
  }
}

export async function runOrchOnce(opts: {
  dryRun?: boolean;
  orchHome?: string;
  token?: string;
  backend?: OrchBackendKind;
  log?: (msg: string) => void;
} = {}): Promise<TickSummary> {
  const orchHome = resolveOrchHome(opts.orchHome);
  if (!opts.dryRun) {
    const daemon = await isDaemonRunning(orchHome);
    if (daemon.running) {
      throw new Error(
        `Cannot run non-dry-run tick while orchestrator daemon is active (pid=${daemon.lock?.pid ?? "unknown"}). Stop daemon or use --dry-run.`,
      );
    }
  }
  const token = opts.token?.trim() || (await resolveDiscordToken(orchHome));
  if (!token) {
    throw new Error(
      "Discord bot token not found. Set JEO_DISCORD_BOT_TOKEN or DISCORD_BOT_TOKEN, or run `jeo orch token --set <token>`.",
    );
  }
  const lock = opts.dryRun ? undefined : await acquireInstanceLock(orchHome);
  try {
    const config = await loadOrchConfig(orchHome);
    const workerBackend = await createOrchWorkerBackend({
      backend: opts.backend ?? config.backend,
      orchHome,
      orcaBin: config.orcaBin,
    });
    const engine = new OrchEngine({
      discord: new RestDiscordClient(token),
      orca: workerBackend,
      verifier: new ShellGateVerifier(),
      orchHome,
      log: opts.log,
    });
    return await engine.tick({ dryRun: opts.dryRun });
  } finally {
    await lock?.release();
  }
}


function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runOrchDaemon(opts: {
  orchHome?: string;
  token?: string;
  pollIntervalMs?: number;
  backend?: OrchBackendKind;
  log?: (msg: string) => void;
  signal?: AbortSignal;
} = {}): Promise<void> {
  if (opts.signal?.aborted) return;

  const orchHome = resolveOrchHome(opts.orchHome);
  const log = opts.log ?? ((m: string) => console.log(`[${new Date().toISOString()}] ${m}`));
  const token = opts.token?.trim() || (await resolveDiscordToken(orchHome));
  if (!token) {
    throw new Error(
      "Discord bot token not found. Set JEO_DISCORD_BOT_TOKEN or DISCORD_BOT_TOKEN, or run `jeo orch token --set <token>`.",
    );
  }

  const lock = await acquireInstanceLock(orchHome);
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  const onSignal = (sig: string) => {
    log(`Received ${sig}, shutting down thread orchestrator...`);
    controller.abort();
  };

  try {
    opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    if (opts.signal?.aborted || controller.signal.aborted) return;

    const config = await loadOrchConfig(orchHome);
    const discord = new RestDiscordClient(token, { signal: controller.signal });
    const verifier = new ShellGateVerifier();
    let activeBackendSetting: OrchBackendKind = opts.backend ?? config.backend ?? "auto";
    let activeOrcaBin = config.orcaBin;
    let workerBackend = await createOrchWorkerBackend({
      backend: activeBackendSetting,
      orchHome,
      orcaBin: activeOrcaBin,
    });
    let engine = new OrchEngine({
      discord,
      orca: workerBackend,
      verifier,
      orchHome,
      log,
    });

    const intervalMs = Math.max(2000, opts.pollIntervalMs ?? config.pollIntervalMs);

    log(
      `Thread orchestrator daemon started (pid=${process.pid}, home=${orchHome}, backend=${workerBackend.kind}, interval=${intervalMs}ms)`,
    );
    let consecutiveErrors = 0;
    while (!controller.signal.aborted) {
      let tickHadError = false;
      try {
        const res = await engine.tick();
        if (res.discovered || res.queued || res.dispatched || res.verified || res.escalated || res.errors.length) {
          log(
            `tick: discovered=${res.discovered} queued=${res.queued} dispatched=${res.dispatched} verified=${res.verified} escalated=${res.escalated}` +
              (res.errors.length ? ` errors=${res.errors.join("; ")}` : ""),
          );
        }
        if (res.errors.length > 0) {
          tickHadError = true;
        }
      } catch (err) {
        tickHadError = true;
        log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (controller.signal.aborted) break;

      if (tickHadError) {
        consecutiveErrors++;
      } else {
        consecutiveErrors = 0;
      }

      const latestConfig = await loadOrchConfig(orchHome).catch(() => config);
      const nextBackendSetting: OrchBackendKind = opts.backend ?? latestConfig.backend ?? "auto";
      if (nextBackendSetting !== activeBackendSetting) {
        activeBackendSetting = nextBackendSetting;
        activeOrcaBin = latestConfig.orcaBin;
        workerBackend = await createOrchWorkerBackend({
          backend: activeBackendSetting,
          orchHome,
          orcaBin: activeOrcaBin,
        });
        engine = new OrchEngine({
          discord,
          orca: workerBackend,
          verifier,
          orchHome,
          log,
        });
        log(`Reloaded orchestrator worker backend -> ${workerBackend.kind}`);
      } else if (latestConfig.orcaBin !== activeOrcaBin) {
        activeOrcaBin = latestConfig.orcaBin;
        workerBackend.setOrcaBin?.(activeOrcaBin);
      }

      const baseWait = Math.max(2000, opts.pollIntervalMs ?? latestConfig.pollIntervalMs);
      const nextWait = consecutiveErrors > 0
        ? Math.min(60_000, baseWait * Math.pow(2, consecutiveErrors))
        : baseWait;
      await sleep(nextWait, controller.signal);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    await lock.release();
    log("Thread orchestrator daemon stopped.");
  }
}
