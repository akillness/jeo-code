/**
 * Pluggable worker backend abstraction for the Thread Orchestrator.
 * Default resolution: `tmux` (if available) -> `headless` (zero-dependency fallback).
 * `orca` is explicit opt-in only (`--backend orca` / `backend: "orca"` / `JEO_ORCH_BACKEND=orca`).
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HeadlessWorkerBackend } from "./headless-backend";
import { CliOrcaClient } from "./orca";
import { resolveOrchHome } from "./store";
import { TmuxWorkerBackend } from "./tmux-backend";
import type { OrchBackendKind, ResolvedOrchBackendKind, WorkerActivityPhase } from "./types";

export type WorkerTerminalState = "IDLE" | "BUSY" | "UNKNOWN";

export interface OrchWorkerInfo {
  handle: string;
  worktreePath: string;
  title: string;
  connected: boolean;
  writable: boolean;
  orphaned: boolean;
  lastOutputAt?: number;
  preview?: string;
  backend?: ResolvedOrchBackendKind;
  sessionName?: string;
  windowName?: string;
  pid?: number;
}

export type OrchWorkerOutcome = "completed" | "partial" | "failed" | "cancelled";

export interface OrchWorkerInspection {
  state: WorkerTerminalState;
  tail: string[];
  phase?: WorkerActivityPhase;
  activity?: string;
  thinkingExcerpt?: string;
  currentTool?: string;
  completedTasks?: string[];
  remainingTasks?: string[];
  summary?: string;
  outcome?: OrchWorkerOutcome;
  blockers?: string[];
  /** Timestamp of the associated sidecar telemetry, when available. */
  statusUpdatedAt?: string;
  dispatchId?: string;
}

export interface OrchWorkerStatusSnapshot {
  version: 1;
  workerHandle?: string;
  sessionId?: string;
  pid?: number;
  state: "IDLE" | "BUSY";
  phase?: "thinking" | "planning" | "executing" | "reporting" | "working";
  currentTool?: string;
  thinkingExcerpt?: string;
  completedTasks?: string[];
  remainingTasks?: string[];
  summary?: string;
  outcome?: OrchWorkerOutcome;
  blockers?: string[];
  dispatchId?: string;
  updatedAt: string;
}

export interface ExecCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type ExecCommandFn = (cmd: string[]) => Promise<ExecCommandResult>;

export async function defaultExecCommand(
  cmd: string[],
  timeoutMs = 15_000,
): Promise<ExecCommandResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const completed = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      .then(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr }));
    const timedOut = new Promise<ExecCommandResult>(resolve => {
      timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already settled */ }
        resolve({ exitCode: 124, stdout: "", stderr: `Worker backend command timed out after ${timeoutMs} ms`, timedOut: true });
      }, timeoutMs);
    });
    return await Promise.race([completed, timedOut]);
  } catch (err) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface OrchWorkerBackend {
  readonly kind?: ResolvedOrchBackendKind;
  /** Native workers must return the dispatch's matching terminal receipt. */
  readonly requiresDispatchReceipt?: boolean;
  listRepoWorkers(repoPath: string): Promise<OrchWorkerInfo[]>;
  inspectWorkerState(handle: string): Promise<OrchWorkerInspection>;
  dispatchToWorker(handle: string, prompt: string): Promise<{ ok: boolean; detail: string }>;
  spawnWorker(
    repoPath: string,
    title: string,
    prompt: string,
    agent?: string,
  ): Promise<{ ok: boolean; handle?: string; detail: string; error?: string }>;
  attachCommand?(handle: string): string[] | undefined;
  setOrcaBin?(bin?: string): void;
}

const VALID_PHASES = new Set<WorkerActivityPhase>(["thinking", "planning", "executing", "reporting", "working"]);
const VALID_BACKENDS = new Set<OrchBackendKind>(["auto", "tmux", "headless", "orca"]);

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function normalizeOrchBackendKind(raw?: unknown): OrchBackendKind | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase() as OrchBackendKind;
  return VALID_BACKENDS.has(trimmed) ? trimmed : undefined;
}

export function sanitizeWorkerHandleForFilename(handle: string): string {
  const trimmed = handle.trim() || "worker";
  const readable =
    trimmed
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "worker";
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
  return `${readable}-${hash}`;
}

/** Deterministic, path-traversal-safe sidecar JSON path: `<orchHome>/worker-status/<safe>.json`. */
export function workerStatusFilePath(orchHome: string, handle: string): string {
  const resolvedHome = resolveOrchHome(orchHome);
  return path.join(resolvedHome, "worker-status", `${sanitizeWorkerHandleForFilename(handle)}.json`);
}

function sanitizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .filter((v): v is string => typeof v === "string")
    .map(s => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export async function readWorkerStatusSnapshot(filePath: string): Promise<OrchWorkerStatusSnapshot | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (parsed.version !== 1) return undefined;
    if (parsed.state !== "IDLE" && parsed.state !== "BUSY") return undefined;
    if (typeof parsed.updatedAt !== "string" || !parsed.updatedAt.trim()) return undefined;

    const phase =
      typeof parsed.phase === "string" && VALID_PHASES.has(parsed.phase as WorkerActivityPhase)
        ? (parsed.phase as WorkerActivityPhase)
        : undefined;
    const completedTasks = sanitizeStringArray(parsed.completedTasks);
    const remainingTasks = sanitizeStringArray(parsed.remainingTasks);
    const outcome = parsed.outcome === "completed" || parsed.outcome === "partial" ||
      parsed.outcome === "failed" || parsed.outcome === "cancelled" ? parsed.outcome : undefined;
    const blockers = sanitizeStringArray(parsed.blockers);

    return {
      version: 1,
      ...(typeof parsed.workerHandle === "string" && parsed.workerHandle.trim()
        ? { workerHandle: parsed.workerHandle.trim() }
        : {}),
      ...(typeof parsed.sessionId === "string" && parsed.sessionId.trim()
        ? { sessionId: parsed.sessionId.trim() }
        : {}),
      ...(typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
        ? { pid: parsed.pid }
        : {}),
      state: parsed.state,
      ...(phase ? { phase } : {}),
      ...(typeof parsed.currentTool === "string" && parsed.currentTool.trim()
        ? { currentTool: parsed.currentTool.trim() }
        : {}),
      ...(typeof parsed.thinkingExcerpt === "string" && parsed.thinkingExcerpt.trim()
        ? { thinkingExcerpt: parsed.thinkingExcerpt.trim() }
        : {}),
      ...(completedTasks ? { completedTasks } : {}),
      ...(remainingTasks ? { remainingTasks } : {}),
      ...(Array.isArray(parsed.remainingTasks) && parsed.remainingTasks.length === 0 ? { remainingTasks: [] } : {}),
      ...(outcome ? { outcome } : {}),
      ...(blockers ? { blockers } : {}),
      ...(typeof parsed.dispatchId === "string" && /^[a-f0-9]{32}$/.test(parsed.dispatchId) ? { dispatchId: parsed.dispatchId } : {}),
      ...(typeof parsed.summary === "string" && parsed.summary.trim()
        ? { summary: parsed.summary.trim() }
        : {}),
      updatedAt: parsed.updatedAt.trim(),
    };
  } catch {
    return undefined;
  }
}

/** Atomically persist a worker status sidecar snapshot with 0600 permissions. */
export async function writeWorkerStatusSnapshot(
  filePath: string,
  snapshot: OrchWorkerStatusSnapshot,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => undefined);
  await fs.rename(tmp, filePath);
}

export function isWorkerStatusSnapshotFresh(
  snapshot: OrchWorkerStatusSnapshot | undefined,
  maxAgeMs = 600_000,
  nowMs = Date.now(),
): boolean {
  if (!snapshot) return false;
  const ts = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts <= maxAgeMs;
}

export async function detectTmuxAvailable(exec: ExecCommandFn = defaultExecCommand): Promise<boolean> {
  try {
    const res = await exec(["tmux", "-V"]);
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve effective worker backend kind:
 *   1. Explicit `requested` (if not `"auto"`)
 *   2. `env.JEO_ORCH_BACKEND` (if valid and not `"auto"`)
 *   3. Auto-detect: `"tmux"` if `tmux -V` succeeds, else `"headless"`.
 * NEVER defaults to `"orca"`; Orca is explicit opt-in only.
 */
export async function resolveOrchBackendKind(
  requested?: OrchBackendKind,
  opts: { env?: Record<string, string | undefined>; exec?: ExecCommandFn } = {},
): Promise<ResolvedOrchBackendKind> {
  const normalizedRequested = normalizeOrchBackendKind(requested);
  if (normalizedRequested && normalizedRequested !== "auto") {
    return normalizedRequested;
  }

  const env = opts.env ?? process.env;
  const fromEnv = normalizeOrchBackendKind(env.JEO_ORCH_BACKEND);
  if (fromEnv && fromEnv !== "auto") {
    return fromEnv;
  }

  return (await detectTmuxAvailable(opts.exec)) ? "tmux" : "headless";
}

export interface CreateOrchWorkerBackendOptions {
  backend?: OrchBackendKind;
  orchHome?: string;
  orcaBin?: string;
  exec?: ExecCommandFn;
  env?: Record<string, string | undefined>;
  jeoBin?: string;
}

export async function createOrchWorkerBackend(
  opts: CreateOrchWorkerBackendOptions = {},
): Promise<OrchWorkerBackend> {
  const resolved = await resolveOrchBackendKind(opts.backend, { env: opts.env, exec: opts.exec });
  if (resolved === "tmux") {
    return new TmuxWorkerBackend({
      orchHome: opts.orchHome,
      exec: opts.exec,
      jeoBin: opts.jeoBin,
    });
  }
  if (resolved === "headless") {
    return new HeadlessWorkerBackend({
      orchHome: opts.orchHome,
      jeoBin: opts.jeoBin,
    });
  }
  return new CliOrcaClient(opts.exec, opts.orcaBin, {
    orchHome: opts.orchHome,
  });
}
