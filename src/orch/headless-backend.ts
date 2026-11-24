/**
 * Zero-dependency headless worker backend for the Thread Orchestrator.
 * Runs `jeo launch --print --no-tui --resume <sessionId> <prompt>` in detached background processes,
 * tracking live progress and completion summaries via `JEO_ORCH_STATUS_FILE` sidecar JSON.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  readWorkerStatusSnapshot,
  workerStatusFilePath,
  writeWorkerStatusSnapshot,
  type OrchWorkerBackend,
  type OrchWorkerInfo,
  type OrchWorkerInspection,
} from "./backend";
import { currentJeoCommand } from "./launchd";
import { expandTilde, resolveOrchHome } from "./store";

export interface HeadlessWorkerRecord {
  version: 1;
  workerId: string;
  handle: string;
  repoPath: string;
  title: string;
  agent: string;
  sessionId: string;
  pid?: number;
  statusFile: string;
  logFile: string;
  exitCode?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpawnHeadlessProcessRequest {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logFile: string;
  onExit?: (exitCode: number | null) => void;
}

export type SpawnHeadlessProcessFn = (req: SpawnHeadlessProcessRequest) => Promise<{ pid: number }>;
export type IsPidAliveFn = (pid: number) => boolean;

export function parseHeadlessWorkerHandle(handle: string): string | undefined {
  const trimmed = handle.trim();
  if (!trimmed.startsWith("headless:")) return undefined;
  const workerId = trimmed.slice("headless:".length).trim();
  if (!workerId || !/^[a-zA-Z0-9._-]+$/.test(workerId) || workerId.includes("..")) {
    return undefined;
  }
  return workerId;
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function defaultSpawnHeadlessProcess(req: SpawnHeadlessProcessRequest): Promise<{ pid: number }> {
  const [binary, ...args] = req.cmd;
  if (!binary) {
    throw new Error("Headless spawn command must not be empty.");
  }
  await fs.mkdir(path.dirname(req.logFile), { recursive: true });
  const logFd = fsSync.openSync(req.logFile, "a", 0o600);
  try {
    const child = nodeSpawn(binary, args, {
      cwd: req.cwd,
      env: req.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    const pid = child.pid;
    if (!pid || pid <= 0) {
      throw new Error(`Failed to spawn headless worker process: ${binary}`);
    }
    child.once("exit", code => {
      req.onExit?.(code);
    });
    child.unref();
    return { pid };
  } finally {
    fsSync.closeSync(logFd);
  }
}

async function writeAtomicRecord(filePath: string, record: HeadlessWorkerRecord): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => undefined);
  await fs.rename(tmp, filePath);
}

async function readLogTail(logFile: string, maxLines = 60): Promise<string[]> {
  try {
    const raw = await fs.readFile(logFile, "utf8");
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    return lines.slice(Math.max(0, lines.length - maxLines));
  } catch {
    return [];
  }
}

export interface HeadlessWorkerBackendOptions {
  orchHome?: string;
  jeoBin?: string;
  spawnProcess?: SpawnHeadlessProcessFn;
  isPidAlive?: IsPidAliveFn;
  now?: () => number;
}

export class HeadlessWorkerBackend implements OrchWorkerBackend {
  readonly kind = "headless" as const;

  private readonly orchHome: string;
  private readonly workersDir: string;
  private readonly jeoCommand: string[];
  private readonly spawnProcess: SpawnHeadlessProcessFn;
  private readonly isPidAlive: IsPidAliveFn;
  private readonly now: () => number;

  constructor(options: HeadlessWorkerBackendOptions = {}) {
    this.orchHome = resolveOrchHome(options.orchHome);
    this.workersDir = path.join(this.orchHome, "headless-workers");
    this.jeoCommand = options.jeoBin?.trim() ? [expandTilde(options.jeoBin.trim())] : currentJeoCommand();
    this.spawnProcess = options.spawnProcess ?? defaultSpawnHeadlessProcess;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.now = options.now ?? (() => Date.now());
  }

  private recordPath(workerId: string): string {
    return path.join(this.workersDir, `${workerId}.json`);
  }

  private async readRecord(workerId: string): Promise<HeadlessWorkerRecord | undefined> {
    try {
      const raw = await fs.readFile(this.recordPath(workerId), "utf8");
      const parsed = JSON.parse(raw) as Partial<HeadlessWorkerRecord>;
      if (
        !parsed ||
        parsed.version !== 1 ||
        typeof parsed.workerId !== "string" ||
        typeof parsed.handle !== "string" ||
        typeof parsed.repoPath !== "string" ||
        typeof parsed.sessionId !== "string" ||
        typeof parsed.statusFile !== "string" ||
        typeof parsed.logFile !== "string"
      ) {
        return undefined;
      }
      return parsed as HeadlessWorkerRecord;
    } catch {
      return undefined;
    }
  }

  async listRepoWorkers(repoPath: string): Promise<OrchWorkerInfo[]> {
    const target = path.resolve(expandTilde(repoPath));
    let entries: string[];
    try {
      entries = await fs.readdir(this.workersDir);
    } catch {
      return [];
    }

    const workers: OrchWorkerInfo[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const workerId = entry.slice(0, -".json".length);
      const record = await this.readRecord(workerId);
      if (!record) continue;

      const resolvedRepo = path.resolve(expandTilde(record.repoPath));
      if (resolvedRepo !== target && !resolvedRepo.startsWith(`${target}${path.sep}`)) {
        continue;
      }

      const alive = typeof record.pid === "number" && record.pid > 0 && this.isPidAlive(record.pid);
      const snapshot = await readWorkerStatusSnapshot(record.statusFile);
      const reusableIdle = !alive && (record.exitCode === 0 || snapshot?.state === "IDLE");

      // Exclude crashed/dead workers whose state is UNKNOWN so engine recovery triggers cleanly.
      if (!alive && !reusableIdle) {
        continue;
      }

      const updatedMs = Date.parse(snapshot?.updatedAt ?? record.updatedAt);
      workers.push({
        handle: record.handle,
        worktreePath: resolvedRepo,
        title: record.title,
        connected: true,
        writable: true,
        orphaned: false,
        backend: "headless",
        ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
        ...(Number.isFinite(updatedMs) ? { lastOutputAt: updatedMs } : {}),
        ...(snapshot?.summary ? { preview: snapshot.summary } : {}),
      });
    }

    return workers;
  }

  async inspectWorkerState(handle: string): Promise<OrchWorkerInspection> {
    const workerId = parseHeadlessWorkerHandle(handle);
    if (!workerId) return { state: "UNKNOWN", tail: [] };

    const record = await this.readRecord(workerId);
    if (!record) return { state: "UNKNOWN", tail: [] };

    const [tail, snapshot] = await Promise.all([
      readLogTail(record.logFile),
      readWorkerStatusSnapshot(record.statusFile),
    ]);

    const alive = typeof record.pid === "number" && record.pid > 0 && this.isPidAlive(record.pid);
    if (alive) {
      return {
        state: "BUSY",
        tail,
        phase: snapshot?.phase ?? "working",
        ...(snapshot?.currentTool ? { activity: `Running ${snapshot.currentTool}` } : {}),
        ...(snapshot?.thinkingExcerpt ? { thinkingExcerpt: snapshot.thinkingExcerpt } : {}),
        ...(snapshot?.currentTool ? { currentTool: snapshot.currentTool } : {}),
        ...(snapshot?.completedTasks ? { completedTasks: snapshot.completedTasks } : {}),
        ...(snapshot?.remainingTasks ? { remainingTasks: snapshot.remainingTasks } : {}),
        ...(snapshot?.summary ? { summary: snapshot.summary } : {}),
      };
    }

    if (record.exitCode === 0 || snapshot?.state === "IDLE") {
      return {
        state: "IDLE",
        tail,
        ...(snapshot?.completedTasks ? { completedTasks: snapshot.completedTasks } : {}),
        ...(snapshot?.remainingTasks ? { remainingTasks: snapshot.remainingTasks } : {}),
        ...(snapshot?.summary ? { summary: snapshot.summary } : {}),
        ...(snapshot?.thinkingExcerpt ? { thinkingExcerpt: snapshot.thinkingExcerpt } : {}),
      };
    }

    return {
      state: "UNKNOWN",
      tail,
      ...(snapshot?.summary ? { summary: snapshot.summary } : {}),
    };
  }

  async dispatchToWorker(handle: string, prompt: string): Promise<{ ok: boolean; detail: string }> {
    const workerId = parseHeadlessWorkerHandle(handle);
    if (!workerId) {
      return { ok: false, detail: `Invalid headless worker handle: ${handle}` };
    }

    const record = await this.readRecord(workerId);
    if (!record) {
      return { ok: false, detail: `Headless worker ${handle} not found` };
    }

    // Strict non-interruption guard: re-verify IDLE before spawning a new turn.
    const check = await this.inspectWorkerState(handle);
    if (check.state !== "IDLE") {
      return { ok: false, detail: `Refused to dispatch: headless worker ${handle} is ${check.state}` };
    }

    const cmd = [
      ...this.jeoCommand,
      "launch",
      "--print",
      "--no-tui",
      "--resume",
      record.sessionId,
      prompt,
    ];
    const env: Record<string, string | undefined> = {
      ...process.env,
      JEO_ORCH_STATUS_FILE: record.statusFile,
      JEO_ORCH_WORKER_HANDLE: record.handle,
    };

    try {
      const spawned = await this.spawnProcess({
        cmd,
        cwd: record.repoPath,
        env,
        logFile: record.logFile,
        onExit: exitCode => {
          void this.recordProcessExit(workerId, spawned.pid, exitCode);
        },
      });

      const nowIso = new Date(this.now()).toISOString();
      const updatedRecord: HeadlessWorkerRecord = {
        ...record,
        pid: spawned.pid,
        exitCode: undefined,
        updatedAt: nowIso,
      };
      await writeAtomicRecord(this.recordPath(workerId), updatedRecord);
      await writeWorkerStatusSnapshot(record.statusFile, {
        version: 1,
        workerHandle: record.handle,
        sessionId: record.sessionId,
        pid: spawned.pid,
        state: "BUSY",
        phase: "thinking",
        updatedAt: nowIso,
      });

      return { ok: true, detail: `dispatched to ${handle} (pid=${spawned.pid})` };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async spawnWorker(
    repoPath: string,
    title: string,
    prompt: string,
    agent = "jeo",
  ): Promise<{ ok: boolean; handle?: string; detail: string; error?: string }> {
    const resolvedRepoPath = path.resolve(expandTilde(repoPath));
    const workerId = `w-${this.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const handle = `headless:${workerId}`;
    const sessionId = `orch-${randomBytes(6).toString("hex")}`;
    const statusFile = workerStatusFilePath(this.orchHome, handle);
    const logFile = path.join(this.workersDir, `${workerId}.log`);
    const nowIso = new Date(this.now()).toISOString();

    const record: HeadlessWorkerRecord = {
      version: 1,
      workerId,
      handle,
      repoPath: resolvedRepoPath,
      title: (title.trim() || "jeo headless").slice(0, 80),
      agent: (agent ?? "jeo").trim().toLowerCase() || "jeo",
      sessionId,
      statusFile,
      logFile,
      exitCode: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await writeAtomicRecord(this.recordPath(workerId), record);

    const dispatched = await this.dispatchToWorker(handle, prompt);
    if (!dispatched.ok) {
      return {
        ok: false,
        handle,
        detail: dispatched.detail,
        error: dispatched.detail,
      };
    }

    return {
      ok: true,
      handle,
      detail: `spawned and dispatched headless worker ${handle} (${dispatched.detail})`,
    };
  }

  attachCommand(_handle: string): string[] | undefined {
    return undefined;
  }

  private async recordProcessExit(workerId: string, pid: number, exitCode: number | null): Promise<void> {
    try {
      const current = await this.readRecord(workerId);
      if (!current || current.pid !== pid) return;
      const nowIso = new Date(this.now()).toISOString();
      await writeAtomicRecord(this.recordPath(workerId), {
        ...current,
        exitCode,
        updatedAt: nowIso,
      });

      if (exitCode === 0) {
        const snap = await readWorkerStatusSnapshot(current.statusFile);
        if (!snap || (snap.state === "BUSY" && (!snap.pid || snap.pid === pid))) {
          await writeWorkerStatusSnapshot(current.statusFile, {
            ...(snap ?? { version: 1 as const }),
            version: 1,
            workerHandle: current.handle,
            sessionId: current.sessionId,
            pid,
            state: "IDLE",
            updatedAt: nowIso,
          });
        }
      }
    } catch {
      // Best-effort exit metadata persistence.
    }
  }
}
