/**
 * Persistent per-project tmux worker backend for the Thread Orchestrator.
 * Zero dependency on Orca; workers survive terminal/daemon restarts and can be attached via `tmux attach-session`.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultExecCommand,
  isWorkerStatusSnapshotFresh,
  readWorkerStatusSnapshot,
  shellQuote,
  workerStatusFilePath,
  type ExecCommandFn,
  type OrchWorkerBackend,
  type OrchWorkerInfo,
  type OrchWorkerInspection,
} from "./backend";
import { classifyTerminalScreen, extractWorkerActivity } from "./orca";
import { expandTilde, resolveOrchHome } from "./store";

const TMUX_LIST_FORMAT =
  "#{session_name}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{@jeo_orch_repo}\t#{@jeo_orch_agent}";

function sleepMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Deterministic, tmux-safe persistent session name for a canonical repository path.
 * Always <= 48 chars and uses only `[a-z0-9-]`.
 */
export function tmuxSessionNameForRepo(repoPath: string): string {
  const resolved = path.resolve(expandTilde(repoPath));
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  const rawSlug = path
    .basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = (rawSlug || "repo").slice(0, 30).replace(/-+$/g, "") || "repo";
  return `jeo-orch-${slug}-${hash}`;
}

/**
 * Parse a tmux worker handle (`tmux:%12`, `tmux:<session>:%12`, or bare `%12`).
 */
export function parseTmuxWorkerHandle(handle: string): { paneId: string; sessionName?: string } | undefined {
  const trimmed = handle.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("tmux:")) {
    const rest = trimmed.slice("tmux:".length).trim();
    if (!rest) return undefined;
    if (rest.startsWith("%")) {
      return { paneId: rest };
    }
    const colonIdx = rest.lastIndexOf(":");
    if (colonIdx > 0) {
      const sessionName = rest.slice(0, colonIdx).trim();
      const paneId = rest.slice(colonIdx + 1).trim();
      if (paneId.startsWith("%")) {
        return { paneId, ...(sessionName ? { sessionName } : {}) };
      }
    }
    return undefined;
  }
  if (trimmed.startsWith("%")) {
    return { paneId: trimmed };
  }
  return undefined;
}

function isJeoOrAgentPane(currentCommand: string, windowName: string, taggedAgent: string): boolean {
  if (taggedAgent.trim()) return true;
  if (/^(?:jeo|bun|node|claude|codex|cursor|gemini|opencode|opencode2|antigravity|muse|zcode)$/i.test(currentCommand.trim())) {
    return true;
  }
  if (/\bjeo\b/i.test(windowName)) return true;
  return false;
}

function isSafeAgentCommand(agent: string): boolean {
  return /^[a-z0-9._-]+$/i.test(agent);
}

export interface TmuxWorkerBackendOptions {
  orchHome?: string;
  exec?: ExecCommandFn;
  jeoBin?: string;
  bootTimeoutMs?: number;
  bootPollIntervalMs?: number;
  snapshotMaxAgeMs?: number;
}

export class TmuxWorkerBackend implements OrchWorkerBackend {
  readonly kind = "tmux" as const;

  private readonly orchHome: string;
  private readonly exec: ExecCommandFn;
  private readonly jeoBin: string;
  private readonly bootTimeoutMs: number;
  private readonly bootPollIntervalMs: number;
  private readonly snapshotMaxAgeMs: number;
  private readonly paneSessionCache = new Map<string, string>();

  constructor(options: TmuxWorkerBackendOptions = {}) {
    this.orchHome = resolveOrchHome(options.orchHome);
    this.exec = options.exec ?? defaultExecCommand;
    this.jeoBin = options.jeoBin?.trim() ? shellQuote(expandTilde(options.jeoBin.trim())) : "jeo";
    this.bootTimeoutMs = options.bootTimeoutMs ?? 15_000;
    this.bootPollIntervalMs = options.bootPollIntervalMs ?? 500;
    this.snapshotMaxAgeMs = options.snapshotMaxAgeMs ?? 600_000;
  }

  async listRepoWorkers(repoPath: string): Promise<OrchWorkerInfo[]> {
    const res = await this.exec(["tmux", "list-panes", "-a", "-F", TMUX_LIST_FORMAT]);
    if (res.exitCode !== 0 || !res.stdout.trim()) return [];

    const target = path.resolve(expandTilde(repoPath));
    const expectedSession = tmuxSessionNameForRepo(target);
    const workers: OrchWorkerInfo[] = [];

    for (const line of res.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const [
        sessionName = "",
        _windowId = "",
        windowName = "",
        paneId = "",
        currentPath = "",
        currentCommand = "",
        taggedRepo = "",
        taggedAgent = "",
      ] = parts;

      if (!paneId.startsWith("%")) continue;

      let matches = false;
      let resolvedWorktree = target;

      if (taggedRepo.trim()) {
        resolvedWorktree = path.resolve(expandTilde(taggedRepo.trim()));
        matches = resolvedWorktree === target || resolvedWorktree.startsWith(`${target}${path.sep}`);
      } else if (
        (sessionName === expectedSession || sessionName.startsWith("jeo-orch-")) &&
        currentPath.trim() &&
        isJeoOrAgentPane(currentCommand, windowName, taggedAgent)
      ) {
        resolvedWorktree = path.resolve(expandTilde(currentPath.trim()));
        matches = resolvedWorktree === target || resolvedWorktree.startsWith(`${target}${path.sep}`);
      }

      if (!matches) continue;

      if (sessionName) {
        this.paneSessionCache.set(paneId, sessionName);
      }

      workers.push({
        handle: `tmux:${paneId}`,
        worktreePath: resolvedWorktree,
        title: windowName.trim() || `${taggedAgent.trim() || "jeo"} (${paneId})`,
        connected: true,
        writable: true,
        orphaned: false,
        backend: "tmux",
        ...(sessionName ? { sessionName } : {}),
        ...(windowName.trim() ? { windowName: windowName.trim() } : {}),
      });
    }

    return workers;
  }

  async inspectWorkerState(handle: string): Promise<OrchWorkerInspection> {
    const parsed = parseTmuxWorkerHandle(handle);
    if (!parsed) return { state: "UNKNOWN", tail: [] };

    const canonicalHandle = `tmux:${parsed.paneId}`;
    const res = await this.exec(["tmux", "capture-pane", "-p", "-t", parsed.paneId, "-S", "-60"]);
    if (res.exitCode !== 0) return { state: "UNKNOWN", tail: [] };

    const tail = res.stdout.replace(/\r\n/g, "\n").split("\n");
    const screenState = classifyTerminalScreen(tail, "jeo");

    const snapshot =
      (await readWorkerStatusSnapshot(workerStatusFilePath(this.orchHome, canonicalHandle))) ??
      (handle !== canonicalHandle
        ? await readWorkerStatusSnapshot(workerStatusFilePath(this.orchHome, handle))
        : undefined);
    const freshSnapshot = isWorkerStatusSnapshotFresh(snapshot, this.snapshotMaxAgeMs) ? snapshot : undefined;

    let effectiveState = screenState;
    if (effectiveState === "UNKNOWN" && freshSnapshot?.state === "BUSY") {
      effectiveState = "BUSY";
    }

    if (effectiveState === "BUSY") {
      const activityInfo = extractWorkerActivity(tail);
      return {
        state: "BUSY",
        tail,
        phase: freshSnapshot?.phase ?? activityInfo?.phase ?? "working",
        ...(activityInfo?.detail ? { activity: activityInfo.detail } : {}),
        ...(freshSnapshot?.thinkingExcerpt ? { thinkingExcerpt: freshSnapshot.thinkingExcerpt } : {}),
        ...(freshSnapshot?.currentTool ? { currentTool: freshSnapshot.currentTool } : {}),
        ...(freshSnapshot?.completedTasks ? { completedTasks: freshSnapshot.completedTasks } : {}),
        ...(freshSnapshot?.remainingTasks ? { remainingTasks: freshSnapshot.remainingTasks } : {}),
        ...(freshSnapshot?.summary ? { summary: freshSnapshot.summary } : {}),
      };
    }

    if (effectiveState === "IDLE") {
      const idleSnapshot = snapshot?.state === "IDLE" ? snapshot : freshSnapshot;
      return {
        state: "IDLE",
        tail,
        ...(idleSnapshot?.completedTasks ? { completedTasks: idleSnapshot.completedTasks } : {}),
        ...(idleSnapshot?.remainingTasks ? { remainingTasks: idleSnapshot.remainingTasks } : {}),
        ...(idleSnapshot?.summary ? { summary: idleSnapshot.summary } : {}),
        ...(idleSnapshot?.thinkingExcerpt ? { thinkingExcerpt: idleSnapshot.thinkingExcerpt } : {}),
      };
    }

    return { state: "UNKNOWN", tail };
  }

  async dispatchToWorker(handle: string, prompt: string): Promise<{ ok: boolean; detail: string }> {
    const parsed = parseTmuxWorkerHandle(handle);
    if (!parsed) {
      return { ok: false, detail: `Invalid tmux worker handle: ${handle}` };
    }

    // Strict non-interruption guard: re-verify IDLE immediately before pasting.
    const check = await this.inspectWorkerState(handle);
    if (check.state !== "IDLE") {
      return { ok: false, detail: `Refused to dispatch: tmux worker ${handle} is ${check.state}` };
    }

    const tmpFile = path.join(
      os.tmpdir(),
      `jeo-tmux-prompt-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.txt`,
    );
    const bufName = `jeo-orch-${process.pid}-${randomBytes(4).toString("hex")}`;

    try {
      await fs.writeFile(tmpFile, prompt, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(tmpFile, 0o600).catch(() => undefined);

      const loadRes = await this.exec(["tmux", "load-buffer", "-b", bufName, tmpFile]);
      if (loadRes.exitCode !== 0) {
        const msg = (loadRes.stderr || loadRes.stdout || "tmux load-buffer failed").trim();
        return { ok: false, detail: msg };
      }

      const pasteRes = await this.exec(["tmux", "paste-buffer", "-d", "-p", "-b", bufName, "-t", parsed.paneId]);
      if (pasteRes.exitCode !== 0) {
        await this.exec(["tmux", "delete-buffer", "-b", bufName]).catch(() => undefined);
        const msg = (pasteRes.stderr || pasteRes.stdout || "tmux paste-buffer failed").trim();
        return { ok: false, detail: msg };
      }

      const enterRes = await this.exec(["tmux", "send-keys", "-t", parsed.paneId, "Enter"]);
      if (enterRes.exitCode !== 0) {
        const msg = (enterRes.stderr || enterRes.stdout || "tmux send-keys Enter failed").trim();
        return { ok: false, detail: msg };
      }

      return { ok: true, detail: `dispatched to ${handle}` };
    } finally {
      await fs.unlink(tmpFile).catch(() => undefined);
    }
  }

  async spawnWorker(
    repoPath: string,
    title: string,
    prompt: string,
    agent?: string,
  ): Promise<{ ok: boolean; handle?: string; detail: string; error?: string }> {
    const resolvedRepoPath = path.resolve(expandTilde(repoPath));
    const normalizedAgent = (agent ?? "jeo").trim().toLowerCase() || "jeo";
    if (normalizedAgent !== "jeo" && !isSafeAgentCommand(normalizedAgent)) {
      const error = `Unsupported agent command: ${agent}`;
      return { ok: false, detail: error, error };
    }

    const sessionName = tmuxSessionNameForRepo(resolvedRepoPath);
    const shortTitle = (title.trim() || normalizedAgent).replace(/[\r\n\t]+/g, " ").slice(0, 40);

    // Ensure persistent per-project session exists.
    const hasRes = await this.exec(["tmux", "has-session", "-t", sessionName]);
    if (hasRes.exitCode !== 0) {
      const createSessRes = await this.exec(["tmux", "new-session", "-d", "-s", sessionName, "-c", resolvedRepoPath]);
      if (createSessRes.exitCode !== 0) {
        const error = (createSessRes.stderr || createSessRes.stdout || "tmux new-session failed").trim();
        return { ok: false, detail: error, error };
      }
    }

    // Create a dedicated window for this worker and capture its pane id.
    const winRes = await this.exec([
      "tmux",
      "new-window",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      sessionName,
      "-n",
      shortTitle,
      "-c",
      resolvedRepoPath,
    ]);
    if (winRes.exitCode !== 0) {
      const error = (winRes.stderr || winRes.stdout || "tmux new-window failed").trim();
      return { ok: false, detail: error, error };
    }

    const paneId = winRes.stdout.trim().split(/\s+/)[0] ?? "";
    if (!paneId.startsWith("%")) {
      const error = `Unexpected tmux pane id returned by new-window: ${winRes.stdout.trim().slice(0, 120)}`;
      return { ok: false, detail: error, error };
    }

    const handle = `tmux:${paneId}`;
    this.paneSessionCache.set(paneId, sessionName);

    // Tag pane with canonical repo path and agent identifier for discovery.
    await this.exec(["tmux", "set-option", "-p", "-t", paneId, "@jeo_orch_repo", resolvedRepoPath]);
    await this.exec(["tmux", "set-option", "-p", "-t", paneId, "@jeo_orch_agent", normalizedAgent]);

    const statusFile = workerStatusFilePath(this.orchHome, handle);
    await fs.mkdir(path.dirname(statusFile), { recursive: true });

    const agentCmd = normalizedAgent === "jeo" ? this.jeoBin : normalizedAgent;
    const launchCmd = `JEO_ORCH_STATUS_FILE=${shellQuote(statusFile)} JEO_ORCH_WORKER_HANDLE=${shellQuote(handle)} ${agentCmd}`;

    const sendCmdRes = await this.exec(["tmux", "send-keys", "-t", paneId, "-l", launchCmd]);
    if (sendCmdRes.exitCode !== 0) {
      const error = (sendCmdRes.stderr || sendCmdRes.stdout || "tmux send-keys launch failed").trim();
      return { ok: false, handle, detail: error, error };
    }
    const enterRes = await this.exec(["tmux", "send-keys", "-t", paneId, "Enter"]);
    if (enterRes.exitCode !== 0) {
      const error = (enterRes.stderr || enterRes.stdout || "tmux send-keys Enter failed").trim();
      return { ok: false, handle, detail: error, error };
    }

    // Poll until the newly launched TUI reports IDLE, then dispatch the prompt safely.
    const bootDeadline = Date.now() + this.bootTimeoutMs;
    let ready = false;
    while (Date.now() < bootDeadline) {
      await sleepMs(this.bootPollIntervalMs);
      const inspected = await this.inspectWorkerState(handle);
      if (inspected.state === "IDLE") {
        ready = true;
        break;
      }
    }

    if (!ready) {
      const error = `Spawned tmux ${normalizedAgent} worker ${handle} is still booting; deferring prompt dispatch to next tick`;
      return { ok: false, handle, detail: error, error };
    }

    const delivered = await this.dispatchToWorker(handle, prompt);
    if (!delivered.ok) {
      return {
        ok: false,
        handle,
        detail: delivered.detail,
        error: delivered.detail,
      };
    }

    return {
      ok: true,
      handle,
      detail: `spawned and dispatched tmux worker ${handle} (session ${sessionName})`,
    };
  }

  attachCommand(handle: string): string[] | undefined {
    const trimmed = handle.trim();
    if (!trimmed) return undefined;

    const parsed = parseTmuxWorkerHandle(trimmed);
    if (parsed) {
      const sessionName = parsed.sessionName ?? this.paneSessionCache.get(parsed.paneId);
      if (sessionName) {
        return ["tmux", "attach-session", "-t", sessionName];
      }
      return ["tmux", "attach-session", "-t", parsed.paneId];
    }

    if (trimmed.startsWith("jeo-orch-")) {
      return ["tmux", "attach-session", "-t", trimmed];
    }

    return undefined;
  }

  /**
   * Resolve the exact `tmux attach-session -t <sessionName>` command by querying tmux
   * if the pane's session is not yet in memory cache.
   */
  async resolveAttachCommand(handleOrSession: string): Promise<string[] | undefined> {
    const trimmed = handleOrSession.trim();
    if (!trimmed) return undefined;

    const parsed = parseTmuxWorkerHandle(trimmed);
    if (!parsed) {
      if (trimmed.startsWith("jeo-orch-")) {
        return ["tmux", "attach-session", "-t", trimmed];
      }
      return undefined;
    }

    const cached = parsed.sessionName ?? this.paneSessionCache.get(parsed.paneId);
    if (cached) {
      return ["tmux", "attach-session", "-t", cached];
    }

    const res = await this.exec(["tmux", "display-message", "-p", "-t", parsed.paneId, "#{session_name}"]);
    if (res.exitCode === 0 && res.stdout.trim()) {
      const sessionName = res.stdout.trim().split(/\r?\n/)[0]!.trim();
      if (sessionName) {
        this.paneSessionCache.set(parsed.paneId, sessionName);
        return ["tmux", "attach-session", "-t", sessionName];
      }
    }

    return undefined;
  }
}
