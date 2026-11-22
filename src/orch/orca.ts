/**
 * Orca worker pool adapter for the Thread Orchestrator.
 * Reuses open IDLE `jeo` terminals for a route's worktree/repo,
 * NEVER interrupts BUSY terminals, and optionally spawns a new supervised worker.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandTilde } from "./store";
import type { WorkerActivityPhase } from "./types";

export interface OrcaTerminalInfo {
  handle: string;
  worktreePath: string;
  title: string;
  connected: boolean;
  writable: boolean;
  orphaned: boolean;
  lastOutputAt?: number;
  preview?: string;
}

export type WorkerTerminalState = "IDLE" | "BUSY" | "UNKNOWN";

export interface WorkerActivityInfo {
  phase: WorkerActivityPhase;
  detail?: string;
}

export interface OrcaClient {
  listRepoWorkers(repoPath: string): Promise<OrcaTerminalInfo[]>;
  inspectWorkerState(handle: string): Promise<{
    state: WorkerTerminalState;
    tail: string[];
    phase?: WorkerActivityPhase;
    activity?: string;
  }>;
  dispatchToWorker(handle: string, prompt: string): Promise<{ ok: boolean; detail: string }>;
  spawnWorker(
    repoPath: string,
    title: string,
    prompt: string,
    agent?: string,
  ): Promise<{ ok: boolean; handle?: string; detail: string; error?: string }>;
  setOrcaBin?(bin?: string): void;
}
export const MAC_ORCA_APP_BIN = "/Applications/Orca.app/Contents/Resources/bin/orca";

export function resolveOrcaBin(customPath?: string, env: Record<string, string | undefined> = process.env): string {
  if (customPath?.trim()) return expandTilde(customPath.trim());
  if (env.JEO_ORCA_BIN?.trim()) return expandTilde(env.JEO_ORCA_BIN.trim());
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    const onPath = Bun.which("orca");
    if (onPath) return onPath;
  } else {
    const pathDirs = (env.PATH ?? "").split(path.delimiter);
    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = path.join(dir, "orca");
      if (fsSync.existsSync(candidate)) return candidate;
    }
  }
  if (fsSync.existsSync(MAC_ORCA_APP_BIN)) {
    return MAC_ORCA_APP_BIN;
  }
  return "orca";
}

function stripAnsi(raw: string): string {
  return raw.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, "");
}

/**
 * Conservatively classify an Orca `jeo` terminal screen tail as IDLE, BUSY, or UNKNOWN.
 * Rule: if ANY active-turn indicator appears (or no idle prompt marker is visible),
 * treat as BUSY/UNKNOWN so we NEVER interrupt an in-flight worker turn.
 */
export function classifyTerminalScreen(tail: readonly string[], title = ""): WorkerTerminalState {
  const nonEmpty = tail.map(l => stripAnsi(l).trim()).filter(Boolean);
  const busyWindow = nonEmpty.slice(-18).join("\n");
  const idleWindow = nonEmpty.slice(-6).join("\n");

  // Active turn / spinner / HUD indicators in jeo / Claude / Codex / Pi TUIs
  const busyPatterns = [
    /Thinking\s*·/i,
    /[◰◱◲◳▲]\s*(?:thinking|planning|executing|reporting)\b/i,
    /◆\s*hud\b.*●\s*(?:thinking|planning|executing|reporting)\b/i,
    /\besc\s+to\s+interrupt\b/i,
    /⟦esc⟧|\[esc\]/i,
    /\bRunning\s+(?:bash|read|edit|write|tool)\b/i,
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
    /[⠁-⣿]\s*(?:thinking|planning|executing|reporting|running|streaming|loading|connecting)\b/i,
  ];
  // Active indicators in the live bottom viewport always win immediately.
  if (busyPatterns.some(re => re.test(idleWindow))) {
    return "BUSY";
  }

  // An explicit completed HUD footer (`◆ hud ... ● done`) in the bottom 6 lines is authoritative
  // even if earlier inline scrollback lines above it still show `Running bash` or a spinner.
  if (/◆\s*hud\s*.*●\s*done\b/i.test(idleWindow)) {
    if (title && !/jeo/i.test(title)) {
      return "UNKNOWN";
    }
    return "IDLE";
  }

  if (busyPatterns.some(re => re.test(busyWindow))) {
    return "BUSY";
  }

  // If title clearly identifies a plain idle shell (not jeo), treat as UNKNOWN so we don't type prompts into zsh.
  if (title && !/jeo/i.test(title)) {
    return "UNKNOWN";
  }

  // Idle prompt indicators in jeo TUI (checked ONLY across last 6 non-empty lines)
  const idlePatterns = [
    /Type your (?:next )?message\.\.\./i,
    /◆\s*hud\s*.*●\s*done\b/i,
  ];
  if (idlePatterns.some(re => re.test(idleWindow))) {
    return "IDLE";
  }

  return "UNKNOWN";
}

function sanitizeActivityLine(raw: string): string {
  return stripAnsi(raw)
    .replace(/[│╭╮╰╯─━┃┌┐└┘├┤┬┴┼]+/g, " ")
    .replace(/⟦esc⟧|\[esc\]|\besc\s+to\s+interrupt\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}

/**
 * Extract the live thinking/execution phase and a short sanitized status line from
 * a BUSY Orca `jeo` terminal screen tail (used for Discord live thinking visibility).
 */
export function extractWorkerActivity(tail: readonly string[]): WorkerActivityInfo | undefined {
  const recent = tail
    .map(l => stripAnsi(l).trim())
    .filter(Boolean)
    .slice(-18);
  if (recent.length === 0) return undefined;

  for (let i = recent.length - 1; i >= 0; i--) {
    const line = recent[i]!;
    const hudMatch = line.match(/◆\s*hud\b.*●\s*(thinking|planning|executing|reporting)\b/i);
    if (hudMatch?.[1]) {
      const phase = hudMatch[1].toLowerCase() as WorkerActivityPhase;
      const spinnerLine = [...recent]
        .reverse()
        .find(l =>
          /[◰◱◲◳▲⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠁-⣿]\s*(?:thinking|planning|executing|reporting)\b|Thinking\s*·|\bRunning\s+(?:bash|read|edit|write|tool)\b/i.test(
            l,
          ),
        );
      const detail = spinnerLine ? sanitizeActivityLine(spinnerLine) : undefined;
      return { phase, ...(detail ? { detail } : {}) };
    }
    const spinnerMatch = line.match(/[◰◱◲◳▲⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠁-⣿]\s*(thinking|planning|executing|reporting)\b/i);
    if (spinnerMatch?.[1]) {
      return {
        phase: spinnerMatch[1].toLowerCase() as WorkerActivityPhase,
        detail: sanitizeActivityLine(line),
      };
    }
    if (/Thinking\s*·/i.test(line)) {
      return { phase: "thinking", detail: sanitizeActivityLine(line) };
    }
    if (/\bRunning\s+(?:bash|read|edit|write|tool)\b/i.test(line)) {
      return { phase: "executing", detail: sanitizeActivityLine(line) };
    }
  }

  return { phase: "working" };
}

function extractOrcaError(parsed: unknown, fallback: string): string {
  if (!parsed || typeof parsed !== "object") return fallback;
  const obj = parsed as { error?: unknown; detail?: unknown; message?: unknown };
  if (typeof obj.error === "string" && obj.error.trim()) return obj.error.trim();
  if (obj.error && typeof obj.error === "object") {
    const errObj = obj.error as { message?: unknown; code?: unknown };
    if (typeof errObj.message === "string" && errObj.message.trim()) return errObj.message.trim();
    if (typeof errObj.code === "string" && errObj.code.trim()) return errObj.code.trim();
  }
  if (typeof obj.detail === "string" && obj.detail.trim()) return obj.detail.trim();
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
  return fallback;
}

function extractCommandError(res: { stdout: string; stderr: string }, fallback: string): string {
  const raw = (res.stderr || res.stdout).trim().slice(0, 240);
  if (res.stdout.trim()) {
    try {
      return extractOrcaError(JSON.parse(res.stdout), raw || fallback);
    } catch {
      // fall back to stderr/stdout text
    }
  }
  return raw || fallback;
}

function isJeoAgentTerminal(term: OrcaTerminalInfo): boolean {
  if (!term.connected || !term.writable || term.orphaned) return false;
  if (/jeo/i.test(term.title)) return true;
  if (term.preview && /Type your (?:next )?message|jeo|antigravity|hud/i.test(term.preview)) return true;
  return false;
}

export type ExecCommandFn = (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

async function defaultExecCommand(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export class CliOrcaClient implements OrcaClient {
  private orcaBin: string;
  private readonly bootTimeoutMs: number;
  private readonly bootPollIntervalMs: number;

  constructor(
    private readonly exec: ExecCommandFn = defaultExecCommand,
    orcaBin?: string,
    options?: { bootTimeoutMs?: number; bootPollIntervalMs?: number },
  ) {
    this.orcaBin = resolveOrcaBin(orcaBin);
    this.bootTimeoutMs = options?.bootTimeoutMs ?? 15_000;
    this.bootPollIntervalMs = options?.bootPollIntervalMs ?? 500;
  }

  setOrcaBin(bin?: string): void {
    this.orcaBin = resolveOrcaBin(bin);
  }

  async listRepoWorkers(repoPath: string): Promise<OrcaTerminalInfo[]> {
    const res = await this.exec([this.orcaBin, "terminal", "list", "--json"]);
    if (res.exitCode !== 0) return [];
    let parsed: {
      ok?: boolean;
      result?: { terminals?: OrcaTerminalInfo[] };
      data?: { terminals?: OrcaTerminalInfo[] };
    };
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return [];
    }
    const target = path.resolve(expandTilde(repoPath));
    const terminals = parsed?.result?.terminals ?? parsed?.data?.terminals ?? [];
    return terminals.filter(t => {
      if (!t.worktreePath) return false;
      const resolved = path.resolve(t.worktreePath);
      return (resolved === target || resolved.startsWith(`${target}${path.sep}`)) && isJeoAgentTerminal(t);
    });
  }

  async inspectWorkerState(handle: string): Promise<{
    state: WorkerTerminalState;
    tail: string[];
    phase?: WorkerActivityPhase;
    activity?: string;
  }> {
    const res = await this.exec([this.orcaBin, "terminal", "read", "--terminal", handle, "--screen", "--json"]);
    if (res.exitCode !== 0) return { state: "UNKNOWN", tail: [] };
    try {
      const parsed = JSON.parse(res.stdout) as {
        result?: { terminal?: { tail?: string[]; title?: string }; lines?: string[]; title?: string };
        data?: { terminal?: { tail?: string[]; title?: string }; lines?: string[]; title?: string };
      };
      const tail =
        parsed?.result?.terminal?.tail ??
        parsed?.result?.lines ??
        parsed?.data?.lines ??
        parsed?.data?.terminal?.tail ??
        [];
      const title =
        parsed?.result?.terminal?.title ??
        parsed?.result?.title ??
        parsed?.data?.terminal?.title ??
        parsed?.data?.title ??
        "";
      const state = classifyTerminalScreen(tail, title);
      if (state === "BUSY") {
        const info = extractWorkerActivity(tail);
        return {
          state,
          tail,
          phase: info?.phase ?? "working",
          ...(info?.detail ? { activity: info.detail } : {}),
        };
      }
      return { state, tail };
    } catch {
      return { state: "UNKNOWN", tail: [] };
    }
  }

  async dispatchToWorker(handle: string, prompt: string): Promise<{ ok: boolean; detail: string }> {
    // Re-verify IDLE immediately before sending — strict non-interruption guard.
    const check = await this.inspectWorkerState(handle);
    if (check.state !== "IDLE") {
      return { ok: false, detail: `Refused to dispatch: terminal ${handle} is ${check.state}` };
    }

    const res = await this.exec([
      this.orcaBin,
      "terminal",
      "send",
      "--terminal",
      handle,
      "--text",
      prompt,
      "--enter",
      "--wait-submit",
      "5",
      "--json",
    ]);
    if (res.exitCode !== 0) {
      return { ok: false, detail: extractCommandError(res, "orca terminal send failed") };
    }
    try {
      const parsed = JSON.parse(res.stdout) as { ok?: boolean; error?: unknown; detail?: string };
      if (parsed?.ok === false) {
        return { ok: false, detail: extractOrcaError(parsed, "orca terminal send failed") };
      }
    } catch {
      // Non-JSON with exitCode 0 is treated as ok
    }
    return { ok: true, detail: `dispatched to ${handle}` };
  }

  async spawnWorker(
    repoPath: string,
    title: string,
    prompt: string,
    agent?: string,
  ): Promise<{ ok: boolean; handle?: string; detail: string; error?: string }> {
    const resolvedRepoPath = path.resolve(expandTilde(repoPath));
    const normalizedAgent = (agent ?? "jeo").toLowerCase();
    const recognizedAgents = new Set([
      "claude",
      "codex",
      "cursor",
      "antigravity",
      "opencode",
      "opencode2",
      "gemini",
      "muse",
      "zcode",
    ]);

    if (normalizedAgent === "jeo") {
      const tabTitle = (title.trim() ? `jeo: ${title.trim()}` : "jeo").slice(0, 80);
      const createRes = await this.exec([
        this.orcaBin,
        "terminal",
        "create",
        "--worktree",
        `path:${resolvedRepoPath}`,
        "--title",
        tabTitle,
        "--json",
      ]);
      if (createRes.exitCode !== 0) {
        const error = extractCommandError(createRes, "orca terminal create failed");
        return { ok: false, detail: error, error };
      }
      let parsed: {
        ok?: boolean;
        error?: unknown;
        result?: { handle?: string; terminal?: { handle?: string } };
        data?: { handle?: string };
      };
      try {
        parsed = JSON.parse(createRes.stdout);
      } catch {
        const error = `Failed to parse orca terminal create output: ${createRes.stdout.slice(0, 240)}`;
        return { ok: false, detail: error, error };
      }
      if (parsed?.ok === false) {
        const error = extractOrcaError(parsed, "orca terminal create returned ok: false");
        return { ok: false, detail: error, error };
      }
      const handle = parsed?.result?.handle ?? parsed?.result?.terminal?.handle ?? parsed?.data?.handle;
      if (!handle) {
        const error = extractOrcaError(parsed, "No terminal handle returned by orca terminal create");
        return { ok: false, detail: error, error };
      }

      const sendRes = await this.exec([
        this.orcaBin,
        "terminal",
        "send",
        "--terminal",
        handle,
        "--text",
        "jeo",
        "--enter",
        "--json",
      ]);
      if (sendRes.exitCode !== 0) {
        const error = extractCommandError(sendRes, "orca terminal send failed");
        return { ok: false, handle, detail: error, error };
      }
      try {
        const sendParsed = JSON.parse(sendRes.stdout) as { ok?: boolean; error?: unknown };
        if (sendParsed?.ok === false) {
          const error = extractOrcaError(sendParsed, "orca terminal send failed");
          return { ok: false, handle, detail: error, error };
        }
      } catch {
        // Non-JSON with exitCode 0 is acceptable
      }

      // Wait briefly for the newly launched `jeo` TUI to reach IDLE, then deliver the prompt.
      // If it is still booting after the wait window, return ok: false so the engine keeps
      // pendingMessages intact and dispatches once the worker appears IDLE on the next tick.
      const bootDeadline = Date.now() + this.bootTimeoutMs;
      let ready = false;
      while (Date.now() < bootDeadline) {
        await new Promise((resolve) => setTimeout(resolve, this.bootPollIntervalMs));
        const inspected = await this.inspectWorkerState(handle);
        if (inspected.state === "IDLE") {
          ready = true;
          break;
        }
      }
      if (!ready) {
        const error = `Spawned jeo worker ${handle} is still booting; deferring prompt dispatch to next tick`;
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
      return { ok: true, handle, detail: `spawned and dispatched jeo worker ${handle}` };
    }

    if (recognizedAgents.has(normalizedAgent)) {
      const specFile = path.join(os.tmpdir(), `jeo-orch-spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      await fs.writeFile(specFile, prompt, { encoding: "utf8", mode: 0o600 });

      // Keep specFile around; do not unlink immediately in finally so async initialization can read it.
      const res = await this.exec([
        this.orcaBin,
        "orchestration",
        "worker-start",
        "--worktree",
        `path:${resolvedRepoPath}`,
        "--agent",
        normalizedAgent,
        "--task-title",
        title.slice(0, 80),
        "--spec-file",
        specFile,
        "--keep-open",
        "--json",
      ]);
      if (res.exitCode !== 0) {
        const error = extractCommandError(res, "orca orchestration worker-start failed");
        return { ok: false, detail: error, error };
      }
      try {
        const parsed = JSON.parse(res.stdout) as {
          ok?: boolean;
          error?: unknown;
          result?: { terminalHandle?: string; dispatch?: { terminalHandle?: string } };
          data?: { terminalHandle?: string };
        };
        if (parsed?.ok === false) {
          const error = extractOrcaError(parsed, "orca orchestration worker-start returned ok: false");
          return { ok: false, detail: error, error };
        }
        const handle = parsed?.result?.terminalHandle ?? parsed?.result?.dispatch?.terminalHandle ?? parsed?.data?.terminalHandle;
        return { ok: true, handle, detail: handle ? `spawned worker ${handle}` : "spawned supervised worker" };
      } catch {
        return { ok: true, detail: "spawned supervised worker" };
      }
    }

    const error = `Unsupported agent: ${agent}`;
    return { ok: false, detail: error, error };
  }
}
