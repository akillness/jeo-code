import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DISCORD_THINKING_DEBOUNCE_MS } from "../../src/agent/notify/discord-thinking";
import { executeOrchAction } from "../../src/commands/orch";
import {
  createOrchWorkerBackend,
  isWorkerStatusSnapshotFresh,
  readWorkerStatusSnapshot,
  resolveOrchBackendKind,
  workerStatusFilePath,
  writeWorkerStatusSnapshot,
  type ExecCommandFn,
  type OrchWorkerBackend,
  type OrchWorkerInfo,
  type OrchWorkerInspection,
  type OrchWorkerStatusSnapshot,
  type WorkerTerminalState,
} from "../../src/orch/backend";
import type { DiscordClient } from "../../src/orch/discord-api";
import { OrchEngine } from "../../src/orch/engine";
import {
  HeadlessWorkerBackend,
  parseHeadlessWorkerHandle,
  type HeadlessWorkerRecord,
  type SpawnHeadlessProcessRequest,
} from "../../src/orch/headless-backend";
import { compareSnowflakes } from "../../src/orch/matcher";
import { createEmptyOrchState, loadOrchConfig, saveOrchConfig, saveOrchState } from "../../src/orch/store";
import {
  parseTmuxWorkerHandle,
  tmuxSessionNameForRepo,
  TmuxWorkerBackend,
} from "../../src/orch/tmux-backend";
import type {
  DiscordChannel,
  DiscordMessage,
  DiscordThread,
  OrchBackendKind,
  OrchConfig,
  ProjectRoute,
  ResolvedOrchBackendKind,
  VerificationSummary,
} from "../../src/orch/types";
import type { GateVerifier } from "../../src/orch/verifier";

// ============================================================================
// Shared hermetic helpers & fakes (zero timers, zero network, zero live daemons)
// ============================================================================

async function waitForFsCondition(predicate: () => Promise<boolean>, maxAttempts = 200): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await predicate()) return true;
    await Promise.resolve();
  }
  return false;
}

class FakeDiscordClient implements DiscordClient {
  public selfUser = { id: "bot-orch", username: "JeoOrch" };
  public threads: DiscordThread[] = [];
  public messagesByThread = new Map<string, DiscordMessage[]>();
  public postedMessages: Array<{ id: string; channelId: string; content: string; flags?: number }> = [];
  public editedMessages: Array<{ channelId: string; messageId: string; content: string }> = [];
  public addedReactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  public removedReactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  public typingTriggers: string[] = [];
  public dmChannels = new Map<string, string>();
  private nextId = 5000n;

  async getSelfUser(): Promise<{ id: string; username: string }> {
    return this.selfUser;
  }

  async listGuilds(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: "guild-1", name: "TestGuild" }];
  }

  async listGuildChannels(_guildId: string): Promise<DiscordChannel[]> {
    return [];
  }

  async listActiveThreads(_guildId: string): Promise<DiscordThread[]> {
    return [...this.threads];
  }

  async listThreadMessages(threadId: string, opts?: { after?: string; limit?: number }): Promise<DiscordMessage[]> {
    const all = this.messagesByThread.get(threadId) ?? [];
    const filtered = opts?.after ? all.filter(m => compareSnowflakes(m.id, opts.after!) > 0) : all;
    return filtered.slice(-(opts?.limit ?? 50));
  }

  async postMessage(channelId: string, content: string, opts?: { flags?: number }): Promise<string[]> {
    const id = `msg-${this.nextId++}`;
    this.postedMessages.push({
      id,
      channelId,
      content,
      ...(opts?.flags !== undefined ? { flags: opts.flags } : {}),
    });
    return [id];
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    this.editedMessages.push({ channelId, messageId, content });
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.addedReactions.push({ channelId, messageId, emoji });
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.removedReactions.push({ channelId, messageId, emoji });
  }

  async triggerTyping(channelId: string): Promise<void> {
    this.typingTriggers.push(channelId);
  }

  async ensureDmChannel(userId: string): Promise<string> {
    const existing = this.dmChannels.get(userId);
    if (existing) return existing;
    const created = `dm-${userId}`;
    this.dmChannels.set(userId, created);
    return created;
  }

  addThread(thread: DiscordThread): void {
    this.threads.push(thread);
    if (!this.messagesByThread.has(thread.id)) {
      this.messagesByThread.set(thread.id, []);
    }
  }

  addHumanMessage(threadId: string, content: string, customId?: string): DiscordMessage {
    const id = customId ?? String(this.nextId++);
    const msg: DiscordMessage = {
      id,
      channel_id: threadId,
      content,
      timestamp: new Date(1_700_000_000_000).toISOString(),
      author: { id: "owner-1", username: "owner", bot: false },
    };
    const list = this.messagesByThread.get(threadId) ?? [];
    list.push(msg);
    this.messagesByThread.set(threadId, list);
    return msg;
  }
}

interface FakeWorkerRecord {
  info: OrchWorkerInfo;
  inspection: OrchWorkerInspection;
}

class FakeWorkerBackend implements OrchWorkerBackend {
  public readonly workers = new Map<string, FakeWorkerRecord>();
  public readonly dispatched: Array<{ handle: string; prompt: string }> = [];
  public readonly spawned: Array<{ repoPath: string; title: string; prompt: string }> = [];

  constructor(public readonly kind: ResolvedOrchBackendKind) {}

  addWorker(handle: string, repoPath: string, inspection: Partial<OrchWorkerInspection> = {}): void {
    this.workers.set(handle, {
      info: {
        handle,
        worktreePath: repoPath,
        title: `${this.kind}:${handle}`,
        connected: true,
        writable: true,
        orphaned: false,
        backend: this.kind,
      },
      inspection: {
        state: "IDLE",
        tail: ["Type your next message..."],
        ...inspection,
      },
    });
  }

  setInspection(handle: string, inspection: OrchWorkerInspection): void {
    const entry = this.workers.get(handle);
    if (!entry) throw new Error(`Missing fake worker: ${handle}`);
    entry.inspection = inspection;
  }

  async listRepoWorkers(repoPath: string): Promise<OrchWorkerInfo[]> {
    const matched: OrchWorkerInfo[] = [];
    for (const entry of this.workers.values()) {
      if (entry.info.worktreePath === repoPath) matched.push(entry.info);
    }
    return matched;
  }

  async inspectWorkerState(handle: string): Promise<OrchWorkerInspection> {
    return this.workers.get(handle)?.inspection ?? { state: "UNKNOWN", tail: [] };
  }

  async dispatchToWorker(handle: string, prompt: string): Promise<{ ok: boolean; detail: string }> {
    const entry = this.workers.get(handle);
    if (!entry || entry.inspection.state !== "IDLE") {
      return { ok: false, detail: `Refused: ${handle} not IDLE` };
    }
    this.dispatched.push({ handle, prompt });
    entry.inspection = {
      state: "BUSY",
      tail: ["Thinking · working"],
      phase: "thinking",
    };
    return { ok: true, detail: `dispatched to ${handle}` };
  }

  async spawnWorker(
    repoPath: string,
    title: string,
    prompt: string,
  ): Promise<{ ok: boolean; handle?: string; detail: string }> {
    const handle = `${this.kind}:spawn-${this.spawned.length + 1}`;
    this.spawned.push({ repoPath, title, prompt });
    this.addWorker(handle, repoPath, { state: "BUSY", tail: ["Thinking · booted"], phase: "thinking" });
    return { ok: true, handle, detail: `spawned ${handle}` };
  }
}

class ScriptedVerifier implements GateVerifier {
  public readonly queue: VerificationSummary[] = [];

  enqueue(summary: VerificationSummary): void {
    this.queue.push(summary);
  }

  async verifyRoute(_route: ProjectRoute): Promise<VerificationSummary> {
    const next = this.queue.shift();
    if (!next) {
      return { passed: true, results: [], summaryText: "All gates passed" };
    }
    return next;
  }
}

function makeTestConfig(routes: ProjectRoute[], overrides: Partial<OrchConfig> = {}): OrchConfig {
  return {
    version: 1,
    guildId: "guild-1",
    ownerUserIds: ["owner-1"],
    ownerDmChannelId: "dm-owner-1",
    tokenFile: "/tmp/unused-token",
    tokenEnv: "JEO_DISCORD_BOT_TOKEN",
    backend: "tmux",
    pollIntervalMs: 10_000,
    debounceMs: 0,
    routes,
    ...overrides,
  };
}

// ============================================================================
// 1. resolveOrchBackendKind & createOrchWorkerBackend
// ============================================================================

describe("resolveOrchBackendKind and createOrchWorkerBackend", () => {
  it("resolves auto to tmux when tmux -V succeeds and falls back to headless when unavailable or throwing", async () => {
    const calls: string[][] = [];
    const tmuxPresent: ExecCommandFn = async cmd => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "tmux 3.4\n", stderr: "" };
    };
    const tmuxMissing: ExecCommandFn = async cmd => {
      calls.push(cmd);
      return { exitCode: 127, stdout: "", stderr: "command not found" };
    };
    const tmuxThrows: ExecCommandFn = async () => {
      throw new Error("ENOENT");
    };

    expect(await resolveOrchBackendKind("auto", { env: {}, exec: tmuxPresent })).toBe("tmux");
    expect(calls[0]).toEqual(["tmux", "-V"]);

    expect(await resolveOrchBackendKind(undefined, { env: {}, exec: tmuxMissing })).toBe("headless");
    expect(await resolveOrchBackendKind("auto", { env: {}, exec: tmuxThrows })).toBe("headless");
  });

  it("selects explicit orca / JEO_ORCH_BACKEND=orca without probing tmux, and enforces arg > env > auto precedence", async () => {
    let probed = false;
    const probeExec: ExecCommandFn = async () => {
      probed = true;
      return { exitCode: 0, stdout: "tmux 3.4\n", stderr: "" };
    };

    // Explicit argument overrides env and never probes tmux.
    expect(await resolveOrchBackendKind("orca", { env: { JEO_ORCH_BACKEND: "headless" }, exec: probeExec })).toBe(
      "orca",
    );
    expect(await resolveOrchBackendKind("headless", { env: { JEO_ORCH_BACKEND: "orca" }, exec: probeExec })).toBe(
      "headless",
    );
    expect(probed).toBe(false);

    // Env selects orca when requested is "auto" or omitted (case/whitespace insensitive).
    expect(await resolveOrchBackendKind("auto", { env: { JEO_ORCH_BACKEND: "  ORCA " }, exec: probeExec })).toBe(
      "orca",
    );
    expect(probed).toBe(false);

    // Invalid env value is ignored and falls back to auto-detection.
    expect(await resolveOrchBackendKind("auto", { env: { JEO_ORCH_BACKEND: "unknown-backend" }, exec: probeExec })).toBe(
      "tmux",
    );
    expect(probed).toBe(true);
  });

  it("constructs matching concrete worker backends via createOrchWorkerBackend", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-backend-factory-"));
    try {
      const noTmux: ExecCommandFn = async () => ({ exitCode: 127, stdout: "", stderr: "missing" });
      const withTmux: ExecCommandFn = async () => ({ exitCode: 0, stdout: "tmux 3.4", stderr: "" });

      const tmux = await createOrchWorkerBackend({ backend: "auto", orchHome: tmpHome, env: {}, exec: withTmux });
      const headless = await createOrchWorkerBackend({ backend: "auto", orchHome: tmpHome, env: {}, exec: noTmux });
      const orca = await createOrchWorkerBackend({ backend: "orca", orchHome: tmpHome, env: {}, exec: noTmux });

      expect(tmux.kind).toBe("tmux");
      expect(headless.kind).toBe("headless");
      expect(orca.kind).toBe("orca");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 2. Atomic sidecar status snapshots
// ============================================================================

describe("worker status sidecar snapshots", () => {
  let tmpHome = "";

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-snapshot-test-"));
  });

  afterEach(async () => {
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("writes atomically with 0600 permissions, leaves no .tmp artifacts, and prevents path traversal", async () => {
    const traversalPath = workerStatusFilePath(tmpHome, "../../etc/passwd");
    const statusDir = path.join(tmpHome, "worker-status");
    expect(path.dirname(traversalPath)).toBe(statusDir);
    expect(traversalPath.startsWith(`${statusDir}${path.sep}`)).toBe(true);

    // Distinct handles with similar punctuation must not collide.
    expect(workerStatusFilePath(tmpHome, "tmux:%1")).not.toBe(workerStatusFilePath(tmpHome, "tmux:%2"));
    expect(workerStatusFilePath(tmpHome, "a/b")).not.toBe(workerStatusFilePath(tmpHome, "a-b"));

    const snap1: OrchWorkerStatusSnapshot = {
      version: 1,
      workerHandle: "tmux:%4",
      sessionId: "sess-1",
      pid: 4242,
      state: "BUSY",
      phase: "executing",
      currentTool: "edit",
      thinkingExcerpt: "Updating parser boundary checks",
      completedTasks: ["Read parser"],
      remainingTasks: ["Run tests"],
      summary: "In progress",
      updatedAt: "2026-11-24T10:00:00.000Z",
    };

    const filePath = workerStatusFilePath(tmpHome, "tmux:%4");
    await writeWorkerStatusSnapshot(filePath, snap1);

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);

    const read1 = await readWorkerStatusSnapshot(filePath);
    expect(read1).toEqual(snap1);

    // Overwrite atomically and confirm no stale temp files remain.
    const snap2: OrchWorkerStatusSnapshot = {
      ...snap1,
      state: "IDLE",
      phase: "reporting",
      completedTasks: ["Read parser", "Run tests"],
      remainingTasks: undefined,
      updatedAt: "2026-11-24T10:01:00.000Z",
    };
    await writeWorkerStatusSnapshot(filePath, snap2);
    expect(await readWorkerStatusSnapshot(filePath)).toEqual({
      version: 1,
      workerHandle: "tmux:%4",
      sessionId: "sess-1",
      pid: 4242,
      state: "IDLE",
      phase: "reporting",
      currentTool: "edit",
      thinkingExcerpt: "Updating parser boundary checks",
      completedTasks: ["Read parser", "Run tests"],
      summary: "In progress",
      updatedAt: "2026-11-24T10:01:00.000Z",
    });

    const entries = await fs.readdir(statusDir);
    expect(entries.some(name => name.endsWith(".tmp"))).toBe(false);
  });

  it("validates schema strictly, sanitizes optional fields, and returns undefined on corrupt/missing files", async () => {
    const filePath = workerStatusFilePath(tmpHome, "tmux:%9");
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Missing file
    expect(await readWorkerStatusSnapshot(filePath)).toBeUndefined();

    // Corrupt JSON
    await fs.writeFile(filePath, "{broken json", "utf8");
    expect(await readWorkerStatusSnapshot(filePath)).toBeUndefined();

    // Invalid schema cases
    const invalidPayloads: unknown[] = [
      ["not", "an", "object"],
      { version: 2, state: "BUSY", updatedAt: "2026-11-24T10:00:00.000Z" },
      { version: 1, state: "UNKNOWN", updatedAt: "2026-11-24T10:00:00.000Z" },
      { version: 1, state: "IDLE", updatedAt: "   " },
    ];
    for (const payload of invalidPayloads) {
      await fs.writeFile(filePath, JSON.stringify(payload), "utf8");
      expect(await readWorkerStatusSnapshot(filePath)).toBeUndefined();
    }

    // Valid core payload with malformed optional fields -> malformed optionals dropped, valid preserved.
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        state: "BUSY",
        phase: "invalid-phase",
        pid: -5,
        currentTool: "  bash  ",
        completedTasks: ["  done-1 ", "", 123, "done-2"],
        remainingTasks: ["   "],
        updatedAt: "2026-11-24T10:00:00.000Z",
      }),
      "utf8",
    );
    expect(await readWorkerStatusSnapshot(filePath)).toEqual({
      version: 1,
      state: "BUSY",
      currentTool: "bash",
      completedTasks: ["done-1", "done-2"],
      updatedAt: "2026-11-24T10:00:00.000Z",
    });
  });

  it("enforces exact staleness boundary in isWorkerStatusSnapshotFresh", () => {
    const baseMs = Date.parse("2026-11-24T12:00:00.000Z");
    const snap: OrchWorkerStatusSnapshot = {
      version: 1,
      state: "BUSY",
      updatedAt: new Date(baseMs).toISOString(),
    };

    expect(isWorkerStatusSnapshotFresh(undefined, 60_000, baseMs)).toBe(false);
    expect(isWorkerStatusSnapshotFresh({ ...snap, updatedAt: "not-a-date" }, 60_000, baseMs)).toBe(false);
    expect(isWorkerStatusSnapshotFresh(snap, 60_000, baseMs + 60_000)).toBe(true);
    expect(isWorkerStatusSnapshotFresh(snap, 60_000, baseMs + 60_001)).toBe(false);
  });
});

// ============================================================================
// 3. TmuxWorkerBackend (mock exec)
// ============================================================================

describe("TmuxWorkerBackend", () => {
  let tmpHome = "";

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-tmux-backend-"));
  });

  afterEach(async () => {
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("derives deterministic <=48-char tmux session names and parses tmux worker handles strictly", () => {
    const a = tmuxSessionNameForRepo("/tmp/work/My App!!");
    const b = tmuxSessionNameForRepo("/tmp/work/My App!!/../My App!!/");
    expect(a).toBe(b);
    expect(a).toMatch(/^jeo-orch-[a-z0-9-]+-[0-9a-f]{8}$/);
    expect(a.length).toBeLessThanOrEqual(48);

    // Distinct parent paths with same basename must produce distinct session names.
    expect(tmuxSessionNameForRepo("/tmp/org-a/service")).not.toBe(tmuxSessionNameForRepo("/tmp/org-b/service"));

    // Very long names and non-ASCII-only basenames still satisfy constraints.
    const veryLong = tmuxSessionNameForRepo(`/tmp/${"super-long-repository-name-segment-".repeat(4)}`);
    expect(veryLong.length).toBeLessThanOrEqual(48);
    expect(veryLong).toMatch(/^jeo-orch-[a-z0-9-]+-[0-9a-f]{8}$/);
    expect(tmuxSessionNameForRepo("/tmp/한글프로젝트")).toMatch(/^jeo-orch-repo-[0-9a-f]{8}$/);

    // Handle parser edge cases
    expect(parseTmuxWorkerHandle("tmux:%12")).toEqual({ paneId: "%12" });
    expect(parseTmuxWorkerHandle("tmux:jeo-orch-app-1234abcd:%12")).toEqual({
      sessionName: "jeo-orch-app-1234abcd",
      paneId: "%12",
    });
    expect(parseTmuxWorkerHandle("%7")).toEqual({ paneId: "%7" });
    expect(parseTmuxWorkerHandle("")).toBeUndefined();
    expect(parseTmuxWorkerHandle("tmux:")).toBeUndefined();
    expect(parseTmuxWorkerHandle("tmux:sess:not-a-pane")).toBeUndefined();
    expect(parseTmuxWorkerHandle("headless:w-1")).toBeUndefined();
  });

  it("filters listRepoWorkers by tagged repo and jeo-orch session heuristics, and populates attachCommand cache", async () => {
    const repoPath = "/tmp/projects/alpha";
    const expectedSession = tmuxSessionNameForRepo(repoPath);
    const stdout = [
      // 1. Explicitly tagged exact repo pane
      `${expectedSession}\t@1\tworker-1\t%10\t/tmp/elsewhere\tzsh\t${repoPath}\tjeo`,
      // 2. Tagged nested worktree subdir
      `custom-sess\t@2\tworktree-a\t%11\t${repoPath}/wt1\tbun\t${repoPath}/wt1\tclaude`,
      // 3. Untagged pane in jeo-orch session running agent command inside repo
      `${expectedSession}\t@3\tjeo-fix\t%12\t${repoPath}\tjeo\t\t`,
      // 4. Plain idle zsh shell in jeo-orch session (must be excluded)
      `${expectedSession}\t@4\tshell\t%13\t${repoPath}\tzsh\t\t`,
      // 5. Different repo (must be excluded)
      `jeo-orch-beta-00000000\t@5\tbeta\t%14\t/tmp/projects/beta\tjeo\t/tmp/projects/beta\tjeo`,
      // 6. Malformed pane id (must be excluded)
      `${expectedSession}\t@6\tbad\tnotpane\t${repoPath}\tjeo\t${repoPath}\tjeo`,
    ].join("\n");

    const backend = new TmuxWorkerBackend({
      orchHome: tmpHome,
      exec: async cmd => {
        expect(cmd[0]).toBe("tmux");
        expect(cmd[1]).toBe("list-panes");
        return { exitCode: 0, stdout, stderr: "" };
      },
    });

    const workers = await backend.listRepoWorkers(repoPath);
    expect(workers.map(w => w.handle)).toEqual(["tmux:%10", "tmux:%11", "tmux:%12"]);
    expect(workers[0]).toMatchObject({
      handle: "tmux:%10",
      worktreePath: path.resolve(repoPath),
      backend: "tmux",
      sessionName: expectedSession,
      windowName: "worker-1",
    });

    // Cached pane->session mapping powers attachCommand without extra tmux queries.
    expect(backend.attachCommand("tmux:%10")).toEqual(["tmux", "attach-session", "-t", expectedSession]);
    expect(backend.attachCommand("tmux:%11")).toEqual(["tmux", "attach-session", "-t", "custom-sess"]);
  });

  it("enriches inspectWorkerState with fresh sidecar snapshot and falls back to pane capture when stale", async () => {
    let captureOutput = "Thinking · inspecting parser\nesc to interrupt\n";
    let captureExit = 0;

    const backend = new TmuxWorkerBackend({
      orchHome: tmpHome,
      snapshotMaxAgeMs: 60_000,
      exec: async cmd => {
        if (cmd[1] === "capture-pane") {
          return { exitCode: captureExit, stdout: captureOutput, stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected" };
      },
    });

    const handle = "tmux:%21";
    const statusPath = workerStatusFilePath(tmpHome, handle);

    // 1. Fresh BUSY snapshot enriches phase, currentTool, thinkingExcerpt, and tasks.
    await writeWorkerStatusSnapshot(statusPath, {
      version: 1,
      workerHandle: handle,
      state: "BUSY",
      phase: "executing",
      currentTool: "bash",
      thinkingExcerpt: "Running focused unit tests",
      completedTasks: ["Refactor backend"],
      remainingTasks: ["Verify edge cases"],
      updatedAt: new Date().toISOString(),
    });

    const busyFresh = await backend.inspectWorkerState(handle);
    expect(busyFresh.state).toBe("BUSY");
    expect(busyFresh.phase).toBe("executing");
    expect(busyFresh.currentTool).toBe("bash");
    expect(busyFresh.thinkingExcerpt).toBe("Running focused unit tests");
    expect(busyFresh.completedTasks).toEqual(["Refactor backend"]);
    expect(busyFresh.remainingTasks).toEqual(["Verify edge cases"]);
    expect(busyFresh.activity).toContain("Thinking");

    // 2. UNKNOWN pane text promoted to BUSY when fresh sidecar says BUSY.
    captureOutput = "plain output without spinner markers\n";
    const promoted = await backend.inspectWorkerState(handle);
    expect(promoted.state).toBe("BUSY");
    expect(promoted.phase).toBe("executing");

    // 3. Stale snapshot (> snapshotMaxAgeMs) is ignored; falls back to pane capture.
    await writeWorkerStatusSnapshot(statusPath, {
      version: 1,
      workerHandle: handle,
      state: "BUSY",
      phase: "reporting",
      currentTool: "stale-tool",
      thinkingExcerpt: "stale excerpt",
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    captureOutput = "Running bash\nesc to interrupt\n";
    const busyStale = await backend.inspectWorkerState(handle);
    expect(busyStale.state).toBe("BUSY");
    expect(busyStale.phase).toBe("executing");
    expect(busyStale.currentTool).toBeUndefined();
    expect(busyStale.thinkingExcerpt).toBeUndefined();

    // 4. IDLE pane preserves completed/remaining summary from IDLE sidecar snapshot.
    await writeWorkerStatusSnapshot(statusPath, {
      version: 1,
      workerHandle: handle,
      state: "IDLE",
      completedTasks: ["Refactor backend", "Verify edge cases"],
      summary: "All done",
      updatedAt: new Date().toISOString(),
    });
    captureOutput = "◆ hud · ● done\nType your next message...\n";
    const idleInspected = await backend.inspectWorkerState(handle);
    expect(idleInspected.state).toBe("IDLE");
    expect(idleInspected.completedTasks).toEqual(["Refactor backend", "Verify edge cases"]);
    expect(idleInspected.summary).toBe("All done");

    // 5. Failed capture-pane returns UNKNOWN.
    captureExit = 1;
    expect((await backend.inspectWorkerState(handle)).state).toBe("UNKNOWN");
  });

  it("delivers multi-line prompts via load-buffer/paste-buffer, enforces BUSY guard, and cleans up temp/buffer on failure", async () => {
    const commands: string[][] = [];
    let paneState: WorkerTerminalState = "BUSY";
    let failPaste = false;
    let observedPromptContent = "";
    let observedPromptMode = 0;
    let observedTmpFile = "";

    const backend = new TmuxWorkerBackend({
      orchHome: tmpHome,
      exec: async cmd => {
        commands.push(cmd);
        const sub = cmd[1];
        if (sub === "capture-pane") {
          const stdout =
            paneState === "IDLE"
              ? "◆ hud · ● done\nType your next message...\n"
              : "Thinking · busy\nesc to interrupt\n";
          return { exitCode: 0, stdout, stderr: "" };
        }
        if (sub === "load-buffer") {
          observedTmpFile = cmd[4] ?? "";
          observedPromptContent = await fs.readFile(observedTmpFile, "utf8");
          observedPromptMode = (await fs.stat(observedTmpFile)).mode & 0o777;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (sub === "paste-buffer") {
          if (failPaste) return { exitCode: 1, stdout: "", stderr: "pane dead" };
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (sub === "delete-buffer" || sub === "send-keys") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected" };
      },
    });

    // 1. BUSY guard refuses dispatch before touching buffers.
    const refused = await backend.dispatchToWorker("tmux:%5", "line 1\nline 2");
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("BUSY");
    expect(commands.map(c => c[1])).toEqual(["capture-pane"]);

    // 2. IDLE multi-line dispatch uses load-buffer + paste-buffer -d -p + send-keys Enter and unlinks tmp file.
    commands.length = 0;
    paneState = "IDLE";
    const multilinePrompt = "First line with 'single' & \"double\" quotes\nSecond line\n- bullet";
    const okRes = await backend.dispatchToWorker("tmux:%5", multilinePrompt);
    expect(okRes.ok).toBe(true);
    expect(commands.map(c => c[1])).toEqual(["capture-pane", "load-buffer", "paste-buffer", "send-keys"]);
    expect(observedPromptContent).toBe(multilinePrompt);
    expect(observedPromptMode).toBe(0o600);
    expect(commands[2]).toContain("-p");
    expect(commands[2]).toContain("-d");
    expect(commands[2]).toContain("%5");
    expect(commands[3]).toEqual(["tmux", "send-keys", "-t", "%5", "Enter"]);
    await expect(fs.stat(observedTmpFile)).rejects.toThrow();

    // 3. paste-buffer failure deletes the named tmux buffer and removes the temp file.
    commands.length = 0;
    failPaste = true;
    const failRes = await backend.dispatchToWorker("tmux:%5", "retry prompt");
    expect(failRes.ok).toBe(false);
    expect(failRes.detail).toContain("pane dead");
    expect(commands.map(c => c[1])).toEqual(["capture-pane", "load-buffer", "paste-buffer", "delete-buffer"]);
    await expect(fs.stat(observedTmpFile)).rejects.toThrow();
  });

  it("spawns persistent tmux session/window, injects status env vars, rejects unsafe agent names, and resolves attach commands", async () => {
    const repoPath = "/tmp/projects/spawn-repo";
    const expectedSession = tmuxSessionNameForRepo(repoPath);
    const commands: string[][] = [];
    let sessionExists = false;
    let booted = true;

    const backend = new TmuxWorkerBackend({
      orchHome: tmpHome,
      jeoBin: "/opt/bin/jeo",
      bootTimeoutMs: 200,
      bootPollIntervalMs: 0,
      exec: async cmd => {
        commands.push(cmd);
        const sub = cmd[1];
        if (sub === "has-session") {
          return sessionExists ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 1, stdout: "", stderr: "no" };
        }
        if (sub === "new-session") {
          sessionExists = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (sub === "new-window") {
          return { exitCode: 0, stdout: "%42\n", stderr: "" };
        }
        if (sub === "set-option" || sub === "send-keys" || sub === "load-buffer" || sub === "paste-buffer") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (sub === "capture-pane") {
          return {
            exitCode: 0,
            stdout: booted ? "Type your next message...\n" : "Starting jeo...\n",
            stderr: "",
          };
        }
        if (sub === "display-message") {
          return { exitCode: 0, stdout: "jeo-orch-queried-11223344\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected" };
      },
    });

    // Unsafe agent command is rejected before any tmux call.
    const unsafe = await backend.spawnWorker(repoPath, "bad", "hi", "jeo; rm -rf /");
    expect(unsafe.ok).toBe(false);
    expect(unsafe.error).toContain("Unsupported agent command");
    expect(commands).toHaveLength(0);

    // First spawn creates persistent session, tags pane, passes status env vars, and dispatches prompt.
    const spawned = await backend.spawnWorker(repoPath, "Fix Auth", "Run auth fix");
    expect(spawned.ok).toBe(true);
    expect(spawned.handle).toBe("tmux:%42");
    expect(commands.some(c => c[1] === "new-session" && c.includes(expectedSession))).toBe(true);
    expect(commands.some(c => c[1] === "set-option" && c.includes("@jeo_orch_repo") && c.includes(path.resolve(repoPath)))).toBe(
      true,
    );
    const launchSend = commands.find(c => c[1] === "send-keys" && c.includes("-l"));
    expect(launchSend?.[5]).toContain("JEO_ORCH_STATUS_FILE=");
    expect(launchSend?.[5]).toContain("JEO_ORCH_WORKER_HANDLE='tmux:%42'");
    expect(launchSend?.[5]).toContain("'/opt/bin/jeo'");
    expect(backend.attachCommand("tmux:%42")).toEqual(["tmux", "attach-session", "-t", expectedSession]);

    // Second spawn reuses existing session (no new-session call).
    commands.length = 0;
    const second = await backend.spawnWorker(repoPath, "Followup", "Second prompt");
    expect(second.ok).toBe(true);
    expect(commands.some(c => c[1] === "new-session")).toBe(false);

    // Boot timeout defers dispatch while returning the created handle.
    const slowBackend = new TmuxWorkerBackend({
      orchHome: tmpHome,
      bootTimeoutMs: 0,
      bootPollIntervalMs: 0,
      exec: async cmd => {
        if (cmd[1] === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
        if (cmd[1] === "new-window") return { exitCode: 0, stdout: "%43\n", stderr: "" };
        if (cmd[1] === "set-option" || cmd[1] === "send-keys") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: "booting...", stderr: "" };
      },
    });
    booted = false;
    const deferred = await slowBackend.spawnWorker(repoPath, "Slow", "Wait");
    expect(deferred.ok).toBe(false);
    expect(deferred.handle).toBe("tmux:%43");
    expect(deferred.detail).toContain("still booting");

    // resolveAttachCommand queries tmux display-message when uncached, and ignores non-tmux handles.
    expect(await backend.resolveAttachCommand("tmux:%99")).toEqual([
      "tmux",
      "attach-session",
      "-t",
      "jeo-orch-queried-11223344",
    ]);
    expect(await backend.resolveAttachCommand("headless:w-1")).toBeUndefined();
  });
});

// ============================================================================
// 4. HeadlessWorkerBackend (injectable spawn + isPidAlive + temp dir)
// ============================================================================

describe("HeadlessWorkerBackend", () => {
  let tmpHome = "";
  let repoDir = "";

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-headless-home-"));
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-headless-repo-"));
  });

  afterEach(async () => {
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
    if (repoDir) await fs.rm(repoDir, { recursive: true, force: true });
  });

  it("validates headless handles against traversal and invalid prefixes", () => {
    expect(parseHeadlessWorkerHandle("headless:w-abc_1.2")).toBe("w-abc_1.2");
    expect(parseHeadlessWorkerHandle("headless:../escape")).toBeUndefined();
    expect(parseHeadlessWorkerHandle("headless:nested/id")).toBeUndefined();
    expect(parseHeadlessWorkerHandle("tmux:%1")).toBeUndefined();
    expect(parseHeadlessWorkerHandle("headless:")).toBeUndefined();
  });

  it("manages spawn + PID liveness, BUSY double-dispatch refusal, IDLE recovery + --resume reuse, and dead PID cleanup", async () => {
    let clockMs = Date.parse("2026-11-24T15:00:00.000Z");
    let nextPid = 9001;
    const alivePids = new Set<number>();
    const spawnCalls: Array<{ pid: number; req: SpawnHeadlessProcessRequest }> = [];

    const backend = new HeadlessWorkerBackend({
      orchHome: tmpHome,
      jeoBin: "/usr/local/bin/jeo",
      now: () => clockMs,
      isPidAlive: pid => alivePids.has(pid),
      spawnProcess: async req => {
        const pid = nextPid++;
        alivePids.add(pid);
        spawnCalls.push({ pid, req });
        return { pid };
      },
    });

    // 1. Spawn worker and verify command, env, PID liveness, and BUSY sidecar inspection.
    const spawned = await backend.spawnWorker(repoDir, "Fix payments", "Resolve webhook retry bug");
    expect(spawned.ok).toBe(true);
    expect(spawned.handle).toMatch(/^headless:w-/);
    const handle = spawned.handle!;
    expect(backend.attachCommand(handle)).toBeUndefined();

    expect(spawnCalls).toHaveLength(1);
    const firstCall = spawnCalls[0]!;
    const resumeIdx = firstCall.req.cmd.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThan(0);
    const sessionId = firstCall.req.cmd[resumeIdx + 1]!;
    expect(sessionId).toMatch(/^orch-/);
    expect(firstCall.req.cmd).toEqual([
      "/usr/local/bin/jeo",
      "launch",
      "--print",
      "--no-tui",
      "--resume",
      sessionId,
      "Resolve webhook retry bug",
    ]);
    expect(firstCall.req.cwd).toBe(path.resolve(repoDir));
    expect(firstCall.req.env.JEO_ORCH_WORKER_HANDLE).toBe(handle);
    expect(firstCall.req.env.JEO_ORCH_STATUS_FILE).toBe(workerStatusFilePath(tmpHome, handle));

    // Write live progress into the sidecar snapshot & log file while PID is alive.
    await fs.writeFile(firstCall.req.logFile, "step 1\nstep 2\n", "utf8");
    await writeWorkerStatusSnapshot(firstCall.req.env.JEO_ORCH_STATUS_FILE!, {
      version: 1,
      workerHandle: handle,
      sessionId,
      pid: firstCall.pid,
      state: "BUSY",
      phase: "executing",
      currentTool: "edit",
      thinkingExcerpt: "Patching retry backoff calculation",
      completedTasks: ["Reproduce bug"],
      remainingTasks: ["Add regression test"],
      updatedAt: new Date(clockMs).toISOString(),
    });

    const busyState = await backend.inspectWorkerState(handle);
    expect(busyState.state).toBe("BUSY");
    expect(busyState.phase).toBe("executing");
    expect(busyState.currentTool).toBe("edit");
    expect(busyState.activity).toBe("Running edit");
    expect(busyState.thinkingExcerpt).toBe("Patching retry backoff calculation");
    expect(busyState.tail).toContain("step 2");

    const listedBusy = await backend.listRepoWorkers(repoDir);
    expect(listedBusy.map(w => w.handle)).toEqual([handle]);
    expect(await backend.listRepoWorkers("/tmp/unrelated-repo")).toEqual([]);

    // 2. BUSY guard refuses double-dispatch without spawning a second process.
    const doubleDispatch = await backend.dispatchToWorker(handle, "Second concurrent prompt");
    expect(doubleDispatch.ok).toBe(false);
    expect(doubleDispatch.detail).toContain("BUSY");
    expect(spawnCalls).toHaveLength(1);

    // 3. Clean exit (code 0) transitions worker to IDLE and preserves reuse via --resume <sessionId>.
    clockMs += 5_000;
    alivePids.delete(firstCall.pid);
    firstCall.req.onExit?.(0);

    const statusFile = workerStatusFilePath(tmpHome, handle);
    const settledIdle = await waitForFsCondition(async () => {
      const snap = await readWorkerStatusSnapshot(statusFile);
      return snap?.state === "IDLE";
    });
    expect(settledIdle).toBe(true);

    const idleState = await backend.inspectWorkerState(handle);
    expect(idleState.state).toBe("IDLE");
    expect(idleState.completedTasks).toEqual(["Reproduce bug"]);

    // Dispatch next turn onto the same IDLE worker -> reuses exact sessionId via --resume.
    clockMs += 2_000;
    const resumed = await backend.dispatchToWorker(handle, "Add final edge-case assertion");
    expect(resumed.ok).toBe(true);
    expect(spawnCalls).toHaveLength(2);
    const secondCall = spawnCalls[1]!;
    expect(secondCall.req.cmd).toEqual([
      "/usr/local/bin/jeo",
      "launch",
      "--print",
      "--no-tui",
      "--resume",
      sessionId,
      "Add final edge-case assertion",
    ]);
    expect((await backend.inspectWorkerState(handle)).state).toBe("BUSY");

    // 4. Crash / dead PID (non-zero exit 137) -> inspectWorkerState returns UNKNOWN and listRepoWorkers excludes it.
    clockMs += 3_000;
    alivePids.delete(secondCall.pid);
    secondCall.req.onExit?.(137);

    const workerId = parseHeadlessWorkerHandle(handle)!;
    const recordFile = path.join(tmpHome, "headless-workers", `${workerId}.json`);
    const settledCrash = await waitForFsCondition(async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(recordFile, "utf8")) as HeadlessWorkerRecord;
        return parsed.exitCode === 137;
      } catch {
        return false;
      }
    });
    expect(settledCrash).toBe(true);

    expect((await backend.inspectWorkerState(handle)).state).toBe("UNKNOWN");
    expect(await backend.listRepoWorkers(repoDir)).toEqual([]);

    // Dispatching to dead/UNKNOWN worker is also refused.
    const deadDispatch = await backend.dispatchToWorker(handle, "Should not run");
    expect(deadDispatch.ok).toBe(false);
    expect(deadDispatch.detail).toContain("UNKNOWN");
    expect(spawnCalls).toHaveLength(2);
  });
});

// ============================================================================
// 5. OrchEngine integration: per-route backend, thinking PATCH debounce, unified reports
// ============================================================================

describe("OrchEngine backend routing, live thinking debounce, and unified completion reports", () => {
  let tmpHome = "";
  let clockMs = 0;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-engine-backends-"));
    clockMs = Date.parse("2026-11-24T16:00:00.000Z");
  });

  afterEach(async () => {
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("routes default projects to primary tmux backend and per-route overrides via resolveBackend (cached)", async () => {
    const discord = new FakeDiscordClient();
    const tmuxBackend = new FakeWorkerBackend("tmux");
    const orcaBackend = new FakeWorkerBackend("orca");
    const verifier = new ScriptedVerifier();

    const routeTmux: ProjectRoute = {
      id: "repo-tmux",
      name: "TmuxRepo",
      enabled: true,
      parentChannelIds: ["ch-1"],
      titleKeywords: ["tmux"],
      repoPath: "/tmp/repo-tmux",
      maxIterations: 3,
      sameFailureLimit: 2,
      maxWorkers: 2,
      spawnIfBusy: false,
      verificationGates: [],
    };
    const routeOrca: ProjectRoute = {
      id: "repo-orca",
      name: "OrcaRepo",
      enabled: true,
      parentChannelIds: ["ch-1"],
      titleKeywords: ["orca"],
      repoPath: "/tmp/repo-orca",
      backend: "orca",
      maxIterations: 3,
      sameFailureLimit: 2,
      maxWorkers: 2,
      spawnIfBusy: false,
      verificationGates: [],
    };

    tmuxBackend.addWorker("tmux:%1", routeTmux.repoPath);
    orcaBackend.addWorker("orca-term-9", routeOrca.repoPath);

    await saveOrchConfig(makeTestConfig([routeTmux, routeOrca]), tmpHome);

    const resolvedCalls: OrchBackendKind[] = [];
    const engine = new OrchEngine({
      discord,
      backend: tmuxBackend,
      resolveBackend: async kind => {
        resolvedCalls.push(kind);
        if (kind === "orca") return orcaBackend;
        throw new Error(`Unexpected backend resolution: ${kind}`);
      },
      verifier,
      orchHome: tmpHome,
      now: () => clockMs,
    });

    discord.addThread({ id: "th-tmux", parent_id: "ch-1", name: "tmux build fix", last_message_id: "100" });
    discord.addThread({ id: "th-orca", parent_id: "ch-1", name: "orca ui fix", last_message_id: "100" });

    // Tick 1: discover both threads
    await engine.tick();

    // Tick 2: enqueue human triggers -> dispatch on distinct backends
    discord.addHumanMessage("th-tmux", "Fix tmux build", "101");
    discord.addHumanMessage("th-orca", "Fix orca layout", "102");
    const summary = await engine.tick();

    expect(summary.dispatched).toBe(2);
    expect(tmuxBackend.dispatched).toHaveLength(1);
    expect(tmuxBackend.dispatched[0]?.handle).toBe("tmux:%1");
    expect(orcaBackend.dispatched).toHaveLength(1);
    expect(orcaBackend.dispatched[0]?.handle).toBe("orca-term-9");

    // Tick 3: checkDispatchedThread reuses cached override backend (resolveBackend called only once total).
    clockMs += 3_000;
    await engine.tick();
    expect(resolvedCalls).toEqual(["orca"]);

    const state = JSON.parse(await fs.readFile(path.join(tmpHome, "state.json"), "utf8"));
    expect(state.threads["th-tmux"].activeBackend).toBe("tmux");
    expect(state.threads["th-orca"].activeBackend).toBe("orca");
  });

  it("debounces same-phase thinking PATCH updates within 1800ms, redacts secrets, and flushes immediately on phase change", async () => {
    const discord = new FakeDiscordClient();
    const tmuxBackend = new FakeWorkerBackend("tmux");
    const verifier = new ScriptedVerifier();

    const route: ProjectRoute = {
      id: "app",
      name: "DemoApp",
      enabled: true,
      parentChannelIds: ["ch-1"],
      titleKeywords: ["demo"],
      repoPath: "/tmp/demo-app",
      maxIterations: 3,
      sameFailureLimit: 2,
      maxWorkers: 2,
      spawnIfBusy: false,
      verificationGates: [],
    };
    tmuxBackend.addWorker("tmux:%3", route.repoPath);
    await saveOrchConfig(makeTestConfig([route]), tmpHome);

    const engine = new OrchEngine({
      discord,
      backend: tmuxBackend,
      verifier,
      orchHome: tmpHome,
      now: () => clockMs,
    });

    discord.addThread({ id: "th-1", parent_id: "ch-1", name: "demo live thinking", last_message_id: "100" });
    await engine.tick();

    discord.addHumanMessage("th-1", "Investigate crash", "101");
    await engine.tick();
    expect(discord.postedMessages).toHaveLength(1);
    expect(discord.editedMessages).toHaveLength(0);

    // +500ms (< 1800ms) with SAME phase "thinking" -> PATCH suppressed by debounce.
    clockMs += 500;
    tmuxBackend.setInspection("tmux:%3", {
      state: "BUSY",
      tail: ["Thinking · step 1"],
      phase: "thinking",
      currentTool: "read",
      thinkingExcerpt: "Checking config with token sk-ant-api03-supersecretvalue9999",
    });
    await engine.tick();
    expect(discord.editedMessages).toHaveLength(0);

    // Reach exact debounce threshold (total 1800ms since initial post) -> PATCH fires with redacted secret & currentTool.
    clockMs += DISCORD_THINKING_DEBOUNCE_MS - 500;
    await engine.tick();
    expect(discord.editedMessages).toHaveLength(1);
    const edit1 = discord.editedMessages[0]!.content;
    expect(edit1).toContain("🔧 실행 중: `read`");
    expect(edit1).toContain("[REDACTED]");
    expect(edit1).not.toContain("sk-ant-api03-supersecretvalue9999");
    expect(edit1).toContain("[tmux]");

    // +200ms (< 1800ms) with PHASE TRANSITION ("thinking" -> "executing") -> bypasses debounce via force.
    clockMs += 200;
    tmuxBackend.setInspection("tmux:%3", {
      state: "BUSY",
      tail: ["Running edit"],
      phase: "executing",
      currentTool: "edit",
      thinkingExcerpt: "Applying patch to handler",
    });
    await engine.tick();
    expect(discord.editedMessages).toHaveLength(2);
    const edit2 = discord.editedMessages[1]!.content;
    expect(edit2).toContain("Executing...");
    expect(edit2).toContain("🔧 실행 중: `edit`");
    expect(edit2).toContain("Applying patch to handler");
  });

  it("posts unified completed/remaining reports in thread and compact DM summaries across pass, requeue, and escalation", async () => {
    const discord = new FakeDiscordClient();
    const tmuxBackend = new FakeWorkerBackend("tmux");
    const verifier = new ScriptedVerifier();

    const route: ProjectRoute = {
      id: "payments",
      name: "Payments",
      enabled: true,
      parentChannelIds: ["ch-1"],
      titleKeywords: ["pay"],
      repoPath: "/tmp/payments",
      maxIterations: 4,
      sameFailureLimit: 2,
      maxWorkers: 2,
      spawnIfBusy: false,
      verificationGates: [{ name: "unit", command: "bun test" }],
    };
    tmuxBackend.addWorker("tmux:%8", route.repoPath);
    await saveOrchConfig(makeTestConfig([route]), tmpHome);

    const engine = new OrchEngine({
      discord,
      backend: tmuxBackend,
      verifier,
      orchHome: tmpHome,
      now: () => clockMs,
    });

    // ---- Case A: PASS ----
    discord.addThread({ id: "th-pass", parent_id: "ch-1", name: "pay pass flow", last_message_id: "100" });
    await engine.tick();
    discord.addHumanMessage("th-pass", "Fix tax rounding", "101");
    await engine.tick();

    clockMs += 5_000;
    tmuxBackend.setInspection("tmux:%8", {
      state: "BUSY",
      tail: ["Thinking · rounding"],
      phase: "executing",
      completedTasks: ["Patch tax helper"],
      remainingTasks: [],
    });
    await engine.tick();

    clockMs += 5_000;
    tmuxBackend.setInspection("tmux:%8", {
      state: "IDLE",
      tail: ["Type your next message..."],
      completedTasks: ["Patch tax helper"],
      remainingTasks: [],
    });
    verifier.enqueue({
      passed: true,
      results: [{ name: "unit", command: "bun test", passed: true, exitCode: 0, durationMs: 420, outputExcerpt: "ok" }],
      summaryText: "- PASS unit (420ms)",
    });

    const passTick = await engine.tick();
    expect(passTick.verified).toBe(1);

    const passThreadPosts = discord.postedMessages.filter(m => m.channelId === "th-pass");
    const passReport = passThreadPosts.at(-1)!.content;
    expect(passReport).toContain("**완료된 작업**");
    expect(passReport).toContain("✅ [Todo] Patch tax helper");
    expect(passReport).toContain("✔ [Gate] unit — 420ms");
    expect(passReport).toContain("**남은 작업**");
    expect(passReport).toContain("없음 (모든 작업 완료)");

    const dmPostsAfterPass = discord.postedMessages.filter(m => m.channelId === "dm-owner-1");
    expect(dmPostsAfterPass).toHaveLength(1);
    expect(dmPostsAfterPass[0]!.content).toContain("완료 2건 · 남은 작업 0건");

    // ---- Case B: REQUEUE then ESCALATION (sameFailureLimit = 2) ----
    discord.addThread({ id: "th-fail", parent_id: "ch-1", name: "pay fail flow", last_message_id: "200" });
    await engine.tick();
    discord.addHumanMessage("th-fail", "Fix ledger precision", "201");
    await engine.tick();

    // Cycle 1: BUSY -> IDLE -> Gate fails (1st failure -> requeue, no DM)
    clockMs += 5_000;
    tmuxBackend.setInspection("tmux:%8", {
      state: "BUSY",
      tail: ["Running edit"],
      phase: "executing",
      completedTasks: ["Update schema"],
      remainingTasks: ["Fix failing assertion"],
    });
    await engine.tick();

    clockMs += 5_000;
    tmuxBackend.setInspection("tmux:%8", {
      state: "IDLE",
      tail: ["Type your next message..."],
      completedTasks: ["Update schema"],
      remainingTasks: ["Fix failing assertion"],
    });
    verifier.enqueue({
      passed: false,
      failureHash: "sig-deadbeef",
      results: [
        {
          name: "unit",
          command: "bun test",
          passed: false,
          exitCode: 1,
          durationMs: 310,
          outputExcerpt: "expected 100 received 99",
        },
      ],
      summaryText: "- FAIL unit (exit 1): expected 100 received 99",
    });

    const requeueTick = await engine.tick();
    expect(requeueTick.verified).toBe(1);
    expect(requeueTick.escalated).toBe(0);
    // Note: same tick step 4 also dispatches the newly re-queued cycle 2 onto IDLE worker tmux:%8!
    expect(requeueTick.dispatched).toBe(1);

    const failThreadPostsAfterRequeue = discord.postedMessages.filter(m => m.channelId === "th-fail");
    const requeuePost = failThreadPostsAfterRequeue.find(m => m.content.includes("자동 재수정 예약"))!.content;
    expect(requeuePost).toContain("⚠️ 부분 완료");
    expect(requeuePost).toContain("✅ [Todo] Update schema");
    expect(requeuePost).toContain("❌ [Gate] unit (exit 1)");
    expect(requeuePost).toContain("⬜ [Todo] Fix failing assertion");
    expect(requeuePost).toContain("자동 재수정 사이클 2/4 실행 대기");

    // Requeue does NOT spam owner DM.
    expect(discord.postedMessages.filter(m => m.channelId === "dm-owner-1")).toHaveLength(1);

    // Cycle 2: BUSY -> IDLE -> Same failure signature again -> ESCALATION to thread + owner DM
    clockMs += 5_000;
    tmuxBackend.setInspection("tmux:%8", {
      state: "BUSY",
      tail: ["Running edit"],
      phase: "executing",
      completedTasks: ["Retry fix"],
      remainingTasks: ["Unresolved precision drift"],
    });
    await engine.tick();

    clockMs += 5_000;
    tmuxBackend.setInspection("tmux:%8", {
      state: "IDLE",
      tail: ["Type your next message..."],
      completedTasks: ["Retry fix"],
      remainingTasks: ["Unresolved precision drift"],
    });
    verifier.enqueue({
      passed: false,
      failureHash: "sig-deadbeef",
      results: [
        {
          name: "unit",
          command: "bun test",
          passed: false,
          exitCode: 1,
          durationMs: 290,
          outputExcerpt: "expected 100 received 99",
        },
      ],
      summaryText: "- FAIL unit (exit 1): expected 100 received 99",
    });

    const escalatedTick = await engine.tick();
    expect(escalatedTick.escalated).toBe(1);

    const escalationThreadPost = discord.postedMessages
      .filter(m => m.channelId === "th-fail")
      .at(-1)!.content;
    expect(escalationThreadPost).toContain("🚨 사람 확인 필요");
    expect(escalationThreadPost).toContain("**완료된 작업**");
    expect(escalationThreadPost).toContain("✅ [Todo] Retry fix");
    expect(escalationThreadPost).toContain("**남은 작업**");
    expect(escalationThreadPost).toContain("❌ [Gate] unit (exit 1)");
    expect(escalationThreadPost).toContain("⬜ [Todo] Unresolved precision drift");
    expect(escalationThreadPost).toContain("🛡️ [승인 대기]");

    const dmPostsAfterEscalation = discord.postedMessages.filter(m => m.channelId === "dm-owner-1");
    expect(dmPostsAfterEscalation).toHaveLength(2);
    expect(dmPostsAfterEscalation[1]!.content).toContain("🚨 사람 확인 필요");
    expect(dmPostsAfterEscalation[1]!.content).toContain("Retry fix");
    expect(dmPostsAfterEscalation[1]!.content).toContain("unit (exit 1)");
  });
});

// ============================================================================
// 6. executeOrchAction CLI (--backend persistence & attach command resolution)
// ============================================================================

describe("executeOrchAction CLI --backend and attach", () => {
  let tmpHome = "";
  let repoDir = "";

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-cli-backend-home-"));
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-cli-backend-repo-"));
  });

  afterEach(async () => {
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
    if (repoDir) await fs.rm(repoDir, { recursive: true, force: true });
  });

  it("persists --backend across init (global and --local) and assign, and rejects invalid backend values", async () => {
    for (const kind of ["tmux", "headless", "orca", "auto"] as const) {
      const initRes = await executeOrchAction(["init", "1234567890", "--backend", kind], {
        orchHome: tmpHome,
        cwd: repoDir,
      });
      expect(initRes.exitCode ?? 0).toBe(0);
      expect(initRes.lines.join("\n")).toContain(`backend=${kind}`);
      const loaded = await loadOrchConfig(tmpHome);
      expect(loaded.backend).toBe(kind);
    }

    // Per-route --backend override persists on assign and renders in routes listing.
    const assignRes = await executeOrchAction(
      ["assign", "--id", "svc-a", "--parent", "999", "--repo", repoDir, "--backend", "orca"],
      { orchHome: tmpHome, cwd: repoDir },
    );
    expect(assignRes.exitCode ?? 0).toBe(0);

    const cfgAfterAssign = await loadOrchConfig(tmpHome);
    const route = cfgAfterAssign.routes.find(r => r.id === "svc-a");
    expect(route?.backend).toBe("orca");

    const routesOutput = await executeOrchAction(["routes"], { orchHome: tmpHome, cwd: repoDir });
    expect(routesOutput.lines.join("\n")).toContain("backend=orca");

    // Local repo config (--local) persists backend into <repo>/.jeo/orch.json.
    const localInit = await executeOrchAction(["init", "555666777", "--backend", "headless", "--local"], {
      orchHome: tmpHome,
      cwd: repoDir,
    });
    expect(localInit.exitCode ?? 0).toBe(0);
    const localRaw = JSON.parse(await fs.readFile(path.join(repoDir, ".jeo", "orch.json"), "utf8"));
    expect(localRaw.backend).toBe("headless");

    // Invalid --backend throws a clear error listing valid choices.
    await expect(
      executeOrchAction(["init", "123", "--backend", "screen"], { orchHome: tmpHome, cwd: repoDir }),
    ).rejects.toThrow(/Invalid --backend 'screen'.*auto, tmux, headless, orca/);

    await expect(
      executeOrchAction(
        ["assign", "--id", "bad", "--parent", "999", "--repo", repoDir, "--backend", "invalid"],
        { orchHome: tmpHome, cwd: repoDir },
      ),
    ).rejects.toThrow(/Invalid --backend 'invalid'/);
  });

  it("returns deterministic backend attach commands from orch attach without spawning live tmux", async () => {
    const sessionName = "jeo-orch-myrepo-1234abcd";

    // 1. Direct session-qualified tmux worker handle
    const byHandle = await executeOrchAction(["attach", `tmux:${sessionName}:%7`, "--print"], {
      orchHome: tmpHome,
      cwd: repoDir,
    });
    expect(byHandle.exitCode ?? 0).toBe(0);
    expect(byHandle.attachCommand).toEqual(["tmux", "attach-session", "-t", sessionName]);
    expect(byHandle.lines.join("\n")).toContain(`tmux attach-session -t ${sessionName}`);

    // 2. Direct jeo-orch-* session name
    const bySession = await executeOrchAction(["attach", sessionName], {
      orchHome: tmpHome,
      cwd: repoDir,
    });
    expect(bySession.exitCode ?? 0).toBe(0);
    expect(bySession.attachCommand).toEqual(["tmux", "attach-session", "-t", sessionName]);

    // 3. Resolution via tracked thread ID in state.json (assignedWorkerHandle includes session)
    const state = createEmptyOrchState();
    state.threads["thread-42"] = {
      threadId: "thread-42",
      parentId: "ch-1",
      name: "demo thread",
      routeId: "svc-a",
      status: "DISPATCHED",
      iteration: 1,
      consecutiveSameFailures: 0,
      assignedWorkerHandle: `tmux:${sessionName}:%9`,
      pendingMessages: [],
      createdAt: "2026-11-24T16:00:00.000Z",
      updatedAt: "2026-11-24T16:00:00.000Z",
    };
    await saveOrchState(state, tmpHome);

    const byThread = await executeOrchAction(["attach", "thread-42"], {
      orchHome: tmpHome,
      cwd: repoDir,
    });
    expect(byThread.exitCode ?? 0).toBe(0);
    expect(byThread.attachCommand).toEqual(["tmux", "attach-session", "-t", sessionName]);
    expect(byThread.lines.join("\n")).toContain("thread=thread-42");

    // 4. Omitted target picks the active tracked tmux thread automatically
    const autoAttach = await executeOrchAction(["attach"], {
      orchHome: tmpHome,
      cwd: repoDir,
    });
    expect(autoAttach.exitCode ?? 0).toBe(0);
    expect(autoAttach.attachCommand).toEqual(["tmux", "attach-session", "-t", sessionName]);

    // 5. Unknown target returns non-zero exitCode and no attachCommand
    const missing = await executeOrchAction(["attach", "nonexistent-route"], {
      orchHome: tmpHome,
      cwd: repoDir,
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.attachCommand).toBeUndefined();
  });
});
