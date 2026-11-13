import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { discordHostActionDigest, isDiscordActionDecision, isDiscordHostBootstrap } from "../messenger/host-protocol";
import type { DiscordActionRequest, DiscordHostBootstrap } from "../messenger/types";
import { settlesWithin, type LeasedShell } from "./shell-lease";

export const DISCORD_HOST_BOOTSTRAP_ENV = "JEO_MESSENGER_HOST_BOOTSTRAP";

export interface DiscordHostExecution {
  signal: AbortSignal;
  authorizeTool(cwd: string, tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
  /** Forget a lease only after a delivered pinned kill and observed reap. */
  trackShell(shell: LeasedShell): () => void;
  reportCleanupFailure(error: Error): void;
}

const executions = new AsyncLocalStorage<DiscordHostExecution>();
export function withDiscordHostExecution<T>(scope: DiscordHostExecution, run: () => T): T {
  return executions.run(scope, run);
}
export function currentDiscordHostExecution(): DiscordHostExecution | undefined {
  return executions.getStore();
}

/** Consume the private capability before catalogs, tools, or child processes can inherit it. */
export function readDiscordHostBootstrap(
  env: NodeJS.ProcessEnv = process.env,
  options: { literalWorker: boolean; ipcAvailable: boolean } = { literalWorker: false, ipcAvailable: false },
): DiscordHostBootstrap | undefined {
  const raw = env[DISCORD_HOST_BOOTSTRAP_ENV];
  delete env[DISCORD_HOST_BOOTSTRAP_ENV];
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid Discord host bootstrap"); }
  if (!options.literalWorker || !options.ipcAvailable || !isDiscordHostBootstrap(value)) throw new Error("Discord host execution requires a private literal-worker bootstrap");
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) throw new Error("Discord host execution requires a non-root POSIX OS user");
  const root = path.resolve(value.workspaceRoot);
  if (!inside(root, value.cwd) || path.resolve(value.sourceRoot) === root || !inside(path.join(value.sessionDir, "host-runtime", value.scope.sessionId), value.cleanupReceipt)) throw new Error("Invalid Discord host workspace or receipt boundary");
  return structuredClone(value);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

interface ActionWaiter {
  runId: string;
  digest: string;
  settle(error?: Error): void;
}

export interface DiscordHostRuntime {
  readonly bootstrap: DiscordHostBootstrap;
  readonly send: (request: DiscordActionRequest) => void;
  readonly waiters: Map<string, ActionWaiter>;
  readonly turns: Map<string, { controller: AbortController; done: Promise<unknown> }>;
  readonly shells: Set<LeasedShell>;
  closed: boolean;
  closing?: Promise<void>;
  cleanupComplete: boolean;
  cleanupFailure?: Error;
}

export function createDiscordHostRuntime(bootstrap: DiscordHostBootstrap, send: (request: DiscordActionRequest) => void): DiscordHostRuntime {
  if (!isDiscordHostBootstrap(bootstrap)) throw new Error("Invalid Discord host bootstrap");
  return { bootstrap: structuredClone(bootstrap), send, waiters: new Map(), turns: new Map(), shells: new Set(), closed: false, cleanupComplete: false };
}

export function acceptDiscordHostDecision(runtime: DiscordHostRuntime, value: unknown): boolean {
  if (!isDiscordActionDecision(value) || runtime.closed || value.nonce !== runtime.bootstrap.nonce || value.epoch !== runtime.bootstrap.scope.epoch) return false;
  const waiter = runtime.waiters.get(value.requestId);
  if (!waiter || waiter.runId !== value.runId || waiter.digest !== value.actionDigest || !runtime.turns.has(value.runId)) return false;
  // Do not reflect untrusted parent text into a model/tool error.
  waiter.settle(value.decision === "allow" ? undefined : new Error("Discord host action denied"));
  return true;
}

export async function runDiscordHostTurn<T>(runtime: DiscordHostRuntime, runId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (runtime.closed || !runId || runtime.turns.size !== 0) throw new Error("Discord host runtime is closed or already running");
  const controller = new AbortController();
  const activeSignal = AbortSignal.any([signal, controller.signal]);
  const scope: DiscordHostExecution = {
    signal: activeSignal,
    authorizeTool: async (cwd, tool, args, toolSignal) => {
      if (runtime.closed) throw new Error("Discord host runtime is closed");
      const action = { kind: "tool" as const, tool, cwd, args: structuredClone(args) };
      const digest = discordHostActionDigest(action);
      const combined = AbortSignal.any([activeSignal, toolSignal]);
      combined.throwIfAborted();
      const requestId = randomUUID();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => settle(new Error("Discord host action cancelled"));
        const settle = (error?: Error) => {
          if (!runtime.waiters.delete(requestId)) return;
          combined.removeEventListener("abort", onAbort);
          error ? reject(error) : resolve();
        };
        runtime.waiters.set(requestId, { runId, digest, settle });
        combined.addEventListener("abort", onAbort, { once: true });
        if (combined.aborted) return onAbort();
        try { runtime.send({ type: "action_request", nonce: runtime.bootstrap.nonce, epoch: runtime.bootstrap.scope.epoch, runId, requestId, action }); }
        catch { settle(new Error("Discord host authorization transport unavailable")); }
      });
      combined.throwIfAborted();
      if (runtime.closed) throw new Error("Discord host runtime is closed");
    },
    trackShell: shell => {
      if (runtime.closed || activeSignal.aborted) throw new Error("Discord host execution cancelled");
      runtime.shells.add(shell);
      return () => { runtime.shells.delete(shell); };
    },
    reportCleanupFailure: error => { runtime.cleanupFailure = error; },
  };
  // Register before invoking user code: shutdown cannot race an unregistered turn.
  const done = Promise.resolve().then(() => {
    activeSignal.throwIfAborted();
    return withDiscordHostExecution(scope, run);
  });
  runtime.turns.set(runId, { controller, done });
  try { return await done; }
  finally {
    runtime.turns.delete(runId);
    for (const waiter of runtime.waiters.values()) if (waiter.runId === runId) waiter.settle(new Error("Discord host turn ended"));
  }
}

/** Never use an old numeric PID/PGID: the lease holder must still pin the whole group. */
export async function stopDiscordHostShell(shell: LeasedShell): Promise<void> {
  const killed = shell.killGroup();
  if (killed !== "delivered") throw new Error("Discord host shell termination is unconfirmed (unpinned or unsupported process group)");
  if (!await settlesWithin(shell.reaped, 3_000)) throw new Error("Discord host shell did not settle after its owned process group was killed");
}

/** Fence first; failed cleanup remains retryable and never produces a receipt. */
export async function closeDiscordHostRuntime(runtime: DiscordHostRuntime): Promise<void> {
  if (runtime.cleanupComplete) return;
  if (runtime.closing) return runtime.closing;
  runtime.closed = true;
  for (const turn of runtime.turns.values()) turn.controller.abort();
  for (const waiter of runtime.waiters.values()) waiter.settle(new Error("Discord host runtime closed"));
  const closing = (async () => {
    // Tool drains must observe genuine EOF; disposing here could hide an escaped descendant.
    const results = await Promise.allSettled([...runtime.shells].map(stopDiscordHostShell));
    await Promise.allSettled([...runtime.turns.values()].map(turn => turn.done));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    if (runtime.shells.size || runtime.turns.size || runtime.waiters.size) throw new Error("Discord host cleanup has unsettled work");
    if (runtime.cleanupFailure) throw runtime.cleanupFailure;
    runtime.cleanupComplete = true;
  })();
  runtime.closing = closing;
  try { await closing; } finally { if (!runtime.cleanupComplete) runtime.closing = undefined; }
}

/** Main calls this only AFTER subagent/job/monitor registries have genuinely settled. */
export async function writeDiscordHostCleanupReceipt(runtime: DiscordHostRuntime): Promise<void> {
  if (!runtime.cleanupComplete || runtime.shells.size || runtime.turns.size || runtime.waiters.size) throw new Error("Discord host cleanup is not complete");
  const bootstrap = runtime.bootstrap;
  const directory = path.dirname(bootstrap.cleanupReceipt);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const realSession = await fs.realpath(bootstrap.sessionDir);
  const realDirectory = await fs.realpath(directory);
  if (!inside(realSession, realDirectory)) throw new Error("Discord cleanup receipt escaped private storage");
  const temporary = `${bootstrap.cleanupReceipt}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, ...bootstrap.scope, pid: process.pid, gone: true, nonce: bootstrap.nonce }), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, bootstrap.cleanupReceipt);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

/** Digest effective inherited values without exposing them in IPC, prompts, or logs. */
export function discordHostEnvironmentDigest(env: Readonly<Record<string, string>>): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}
