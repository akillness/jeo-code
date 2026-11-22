import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DISCORD_SILENT_FLAGS, type DiscordClient } from "../../src/orch/discord-api";
import { buildWorkerPrompt, OrchEngine } from "../../src/orch/engine";
import { compareSnowflakes } from "../../src/orch/matcher";
import type { OrcaClient, OrcaTerminalInfo, WorkerTerminalState } from "../../src/orch/orca";
import { saveOrchConfig } from "../../src/orch/store";
import type {
  DiscordChannel,
  DiscordMessage,
  DiscordThread,
  OrchConfig,
  ProjectRoute,
  VerificationSummary,
  WorkerActivityPhase,
} from "../../src/orch/types";
import type { GateVerifier } from "../../src/orch/verifier";

// ============================================================================
// Clean in-memory fakes for Discord, Orca, GateVerifier, and controllable clock
// ============================================================================

class FakeDiscordClient implements DiscordClient {
  public selfUser = { id: "orch-bot-user", username: "JeoOrch" };
  public threads: DiscordThread[] = [];
  public messagesByThread = new Map<string, DiscordMessage[]>();
  public postedMessages: Array<{ id: string; channelId: string; content: string; flags?: number }> = [];
  public editedMessages: Array<{ channelId: string; messageId: string; content: string }> = [];
  public addedReactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  public removedReactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  public typingTriggers: string[] = [];
  public editError?: Error;
  public dmChannels = new Map<string, string>();
  private nextMessageId = 2000n;


  async getSelfUser(): Promise<{ id: string; username: string }> {
    return this.selfUser;
  }

  async listGuilds(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: "guild-test", name: "가재촌" }];
  }

  async listGuildChannels(_guildId: string): Promise<DiscordChannel[]> {
    return [];
  }

  async listActiveThreads(_guildId: string): Promise<DiscordThread[]> {
    return [...this.threads];
  }

  async listThreadMessages(threadId: string, opts?: { after?: string; limit?: number }): Promise<DiscordMessage[]> {
    const list = this.messagesByThread.get(threadId) ?? [];
    let filtered = list;
    if (opts?.after) {
      const after = opts.after;
      filtered = filtered.filter(m => compareSnowflakes(m.id, after) > 0);
    }
    const limit = opts?.limit ?? 50;
    return filtered.slice(-limit);
  }

  async postMessage(channelId: string, content: string, opts?: { flags?: number }): Promise<string[]> {
    const id = `msg-${this.nextMessageId++}`;
    this.postedMessages.push({ id, channelId, content, ...(opts?.flags !== undefined ? { flags: opts.flags } : {}) });
    return [id];
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (this.editError) throw this.editError;
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
    const dmId = `dm-channel-${userId}`;
    this.dmChannels.set(userId, dmId);
    return dmId;
  }

  // --- Helper methods for test fixtures ---

  addThread(thread: DiscordThread): void {
    this.threads.push(thread);
    if (!this.messagesByThread.has(thread.id)) {
      this.messagesByThread.set(thread.id, []);
    }
  }

  addMessage(
    threadId: string,
    content: string,
    author: { id: string; username: string; bot?: boolean; global_name?: string } = {
      id: "owner-user-1",
      username: "owner-dev",
      bot: false,
    },
    customId?: string,
  ): DiscordMessage {
    const id = customId ?? (this.nextMessageId++).toString();
    const msg: DiscordMessage = {
      id,
      channel_id: threadId,
      content,
      timestamp: new Date().toISOString(),
      author: {
        id: author.id,
        username: author.username,
        global_name: author.global_name,
        bot: author.bot,
      },
    };
    const list = this.messagesByThread.get(threadId) ?? [];
    list.push(msg);
    this.messagesByThread.set(threadId, list);
    return msg;
  }
}

class FakeOrcaClient implements OrcaClient {
  public workers = new Map<string, {
    info: OrcaTerminalInfo;
    state: WorkerTerminalState;
    tail: string[];
    phase?: WorkerActivityPhase;
    activity?: string;
  }>();

  public dispatched: Array<{ handle: string; prompt: string }> = [];
  public spawned: Array<{ repoPath: string; title: string; prompt: string }> = [];
  public orcaBinCalls: Array<string | undefined> = [];
  private nextSpawnId = 1;

  setOrcaBin(bin?: string): void {
    this.orcaBinCalls.push(bin);
  }

  addWorker(
    handle: string,
    repoPath: string,
    state: WorkerTerminalState = "IDLE",
    tail: string[] = ["Type your next message..."],
  ): void {
    this.workers.set(handle, {
      info: {
        handle,
        worktreePath: repoPath,
        title: `jeo (${handle})`,
        connected: true,
        writable: true,
        orphaned: false,
      },
      state,
      tail,
    });
  }

  setWorkerState(
    handle: string,
    state: WorkerTerminalState,
    tail?: string[],
    phase?: WorkerActivityPhase,
    activity?: string,
  ): void {
    const w = this.workers.get(handle);
    if (!w) throw new Error(`Unknown worker handle: ${handle}`);
    w.state = state;
    w.phase = state === "BUSY" ? (phase ?? "thinking") : undefined;
    w.activity = state === "BUSY" ? activity : undefined;
    if (tail) {
      w.tail = tail;
    } else if (state === "BUSY") {
      w.tail = ["Thinking · executing task", "esc to interrupt"];
    } else if (state === "IDLE") {
      w.tail = ["Type your next message..."];
    } else {
      w.tail = ["owner-dev@host % "];
    }
  }

  async listRepoWorkers(repoPath: string): Promise<OrcaTerminalInfo[]> {
    const res: OrcaTerminalInfo[] = [];
    for (const w of this.workers.values()) {
      if (w.info.worktreePath === repoPath) {
        res.push(w.info);
      }
    }
    return res;
  }

  async inspectWorkerState(handle: string): Promise<{
    state: WorkerTerminalState;
    tail: string[];
    phase?: WorkerActivityPhase;
    activity?: string;
  }> {
    const w = this.workers.get(handle);
    if (!w) return { state: "UNKNOWN", tail: [] };
    return {
      state: w.state,
      tail: [...w.tail],
      ...(w.phase ? { phase: w.phase } : {}),
      ...(w.activity ? { activity: w.activity } : {}),
    };
  }

  async dispatchToWorker(handle: string, prompt: string): Promise<{ ok: boolean; detail: string }> {
    const w = this.workers.get(handle);
    if (!w) return { ok: false, detail: "Worker not found" };
    if (w.state !== "IDLE") {
      return { ok: false, detail: `Refused to dispatch: terminal ${handle} is ${w.state}` };
    }
    this.dispatched.push({ handle, prompt });
    // In real life, dispatch immediately transitions the worker terminal to BUSY
    w.state = "BUSY";
    w.phase = "thinking";
    w.tail = ["Thinking · dispatched task", "esc to interrupt"];
    return { ok: true, detail: `dispatched to ${handle}` };
  }

  async spawnWorker(repoPath: string, title: string, prompt: string): Promise<{ ok: boolean; handle?: string; detail: string }> {
    const handle = `spawned-worker-${this.nextSpawnId++}`;
    this.spawned.push({ repoPath, title, prompt });
    this.addWorker(handle, repoPath, "BUSY", ["Thinking · spawned worker starting", "esc to interrupt"]);
    return { ok: true, handle, detail: `spawned worker ${handle}` };
  }
}

class FakeGateVerifier implements GateVerifier {
  public verifiedRoutes: ProjectRoute[] = [];
  public nextResults: VerificationSummary[] = [];
  public defaultResult: VerificationSummary = {
    passed: true,
    results: [
      {
        name: "pytest",
        command: "pytest -v",
        passed: true,
        exitCode: 0,
        durationMs: 45,
        outputExcerpt: "1 passed in 0.05s",
      },
    ],
    summaryText: "pytest: PASS (1 passed)",
  };

  async verifyRoute(route: ProjectRoute): Promise<VerificationSummary> {
    this.verifiedRoutes.push(route);
    if (this.nextResults.length > 0) {
      return this.nextResults.shift()!;
    }
    return this.defaultResult;
  }
}

// ============================================================================
// Orchestrator Engine Test Suite
// ============================================================================

describe("OrchEngine", () => {
  let tmpHome: string;
  let fakeDiscord: FakeDiscordClient;
  let fakeOrca: FakeOrcaClient;
  let fakeVerifier: FakeGateVerifier;
  let currentTimeMs: number;
  let defaultRoute: ProjectRoute;
  let baseConfig: OrchConfig;

  const now = () => currentTimeMs;
  const advanceTime = (ms: number) => {
    currentTimeMs += ms;
  };

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "orch-engine-test-"));
    fakeDiscord = new FakeDiscordClient();
    fakeOrca = new FakeOrcaClient();
    fakeVerifier = new FakeGateVerifier();
    currentTimeMs = 1_000_000;

    defaultRoute = {
      id: "sample-app",
      name: "샘플앱",
      enabled: true,
      parentChannelIds: ["channel-sample-parent"],
      titleKeywords: ["샘플", "앱", "sample"],
      repoPath: "/tmp/workspace/sample-app",
      maxIterations: 4,
      sameFailureLimit: 2,
      maxWorkers: 3,
      spawnIfBusy: false,
      verificationGates: [
        { name: "pytest", command: "pytest -v" },
      ],
    };

    baseConfig = {
      version: 1,
      guildId: "guild-test",
      ownerUserIds: ["owner-user-1"],
      ownerDmChannelId: "dm-owner-direct",
      tokenFile: path.join(tmpHome, "token"),
      tokenEnv: "JEO_DISCORD_BOT_TOKEN",
      pollIntervalMs: 10_000,
      debounceMs: 12_000,
      routes: [defaultRoute],
    };

    await saveOrchConfig(baseConfig, tmpHome);
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined);
  });

  function createEngine(): OrchEngine {
    return new OrchEngine({
      discord: fakeDiscord,
      orca: fakeOrca,
      verifier: fakeVerifier,
      orchHome: tmpHome,
      now,
    });
  }

  // --------------------------------------------------------------------------
  // Test 1: Discovery initializes lastSeenMessageId to latest message
  // and does NOT trigger spurious runs on historical messages.
  // --------------------------------------------------------------------------
  it("Test 1: Discovery initializes lastSeenMessageId to latest message and does NOT trigger spurious runs on historical messages", async () => {
    const threadId = "thread-101";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 스테이지1 단서 버그 제보",
      last_message_id: "1002",
    });

    // Add historical messages existing prior to orchestrator discovery
    fakeDiscord.addMessage(threadId, "오래된 메시지 1: 게임 실행 오류", undefined, "1001");
    fakeDiscord.addMessage(threadId, "오래된 메시지 2: 인벤토리 동기화 실패", undefined, "1002");

    // Existing IDLE worker in repo
    fakeOrca.addWorker("worker-1", defaultRoute.repoPath, "IDLE");

    // Step 1: Discover

    const engine = createEngine();
    const summary1 = await engine.tick();
    expect(summary1.discovered).toBe(1);
    expect(summary1.queued).toBe(0);
    expect(summary1.dispatched).toBe(0);
    expect(fakeOrca.dispatched.length).toBe(0);

    // Now a NEW human message arrives AFTER discovery
    fakeDiscord.addMessage(threadId, "새로운 버그: 퀘스트 진행 중 대화창 멈춤", undefined, "1003");
    const summary2 = await engine.tick();
    expect(summary2.queued).toBe(1);
    expect(summary2.dispatched).toBe(0);
  });


  // --------------------------------------------------------------------------
  // Test 2: Debounce coalescing merges rapid user messages and only dispatches
  // after debounceMs elapses.
  // --------------------------------------------------------------------------
  it("Test 2: Debounce coalescing merges rapid user messages and only dispatches after debounceMs elapses", async () => {
    const threadId = "thread-102";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 연속 제보",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-1", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    // Step 1: Discover thread
    await engine.tick();

    // Step 2: First message arrives at t = 10_000
    advanceTime(10_000);
    fakeDiscord.addMessage(threadId, "첫 번째 증상: 스테이지1 상인 대사 누락");
    const summary1 = await engine.tick();
    expect(summary1.queued).toBe(1);
    expect(summary1.dispatched).toBe(0); // Debounce waiting
    expect(fakeOrca.dispatched.length).toBe(0);

    // Step 3: Rapid follow-up message arrives at t = 15_000 (5s later, debounceMs is 12s)
    advanceTime(5_000);
    fakeDiscord.addMessage(threadId, "두 번째 추가 설명: 야간 시간대에만 발생함");
    const summary2 = await engine.tick();
    expect(summary2.queued).toBe(1);
    expect(summary2.dispatched).toBe(0); // Debounce reset/waiting
    expect(fakeOrca.dispatched.length).toBe(0);

    // Step 4: Advance 6s to t = 21_000 (elapsed 6s < debounceMs 12s)
    advanceTime(6_000);
    const summary3 = await engine.tick();
    expect(summary3.dispatched).toBe(0);
    expect(fakeOrca.dispatched.length).toBe(0);

    // Step 5: Advance 7s to t = 28_000 (elapsed 13s > debounceMs 12s) -> Dispatch!
    advanceTime(7_000);
    const summary4 = await engine.tick();
    expect(summary4.dispatched).toBe(1);
    expect(fakeOrca.dispatched.length).toBe(1);

    const dispatchedItem = fakeOrca.dispatched[0]!;
    expect(dispatchedItem.handle).toBe("worker-1");
    // Verify prompt coalesced BOTH messages
    expect(dispatchedItem.prompt).toContain("첫 번째 증상: 스테이지1 상인 대사 누락");
    expect(dispatchedItem.prompt).toContain("두 번째 추가 설명: 야간 시간대에만 발생함");

    // Thread received dispatch announcement message
    expect(fakeDiscord.postedMessages.some(m => m.channelId === threadId && m.content.includes("사이클 1/4 시작"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Test 3: BUSY Orca workers are NEVER interrupted; engine waits while all
  // workers are BUSY, dispatches once IDLE, and never double-assigns the same
  // worker handle to two threads concurrently.
  // --------------------------------------------------------------------------
  it("Test 3: BUSY Orca workers are NEVER interrupted; engine waits while all workers are BUSY, dispatches once IDLE, and never double-assigns the same worker handle to two threads concurrently", async () => {
    const threadA = "thread-201";
    const threadB = "thread-202";

    fakeDiscord.addThread({
      id: threadA,
      parent_id: "channel-sample-parent",
      name: "샘플앱 이슈 A",
      last_message_id: "1000",
    });
    fakeDiscord.addThread({
      id: threadB,
      parent_id: "channel-sample-parent",
      name: "샘플앱 이슈 B",
      last_message_id: "1000",
    });

    // Only 1 worker available, initially BUSY
    fakeOrca.addWorker("worker-busy-1", defaultRoute.repoPath, "BUSY", ["Thinking · running heavy task", "esc to interrupt"]);

    const engine = createEngine();
    await engine.tick(); // Discover both threads

    // Add messages to both threads and elapse debounce window
    fakeDiscord.addMessage(threadA, "이슈 A 처리 요청");
    fakeDiscord.addMessage(threadB, "이슈 B 처리 요청");
    await engine.tick(); // Queue both messages

    advanceTime(20_000); // Past debounceMs

    // Sub-part A: Worker is BUSY -> NEVER interrupted, engine waits
    const summaryBusy = await engine.tick();
    expect(summaryBusy.dispatched).toBe(0);
    expect(fakeOrca.dispatched.length).toBe(0);

    // Sub-part B: Worker becomes IDLE -> exactly ONE thread gets dispatched, never double-assigned
    fakeOrca.setWorkerState("worker-busy-1", "IDLE");

    const summaryIdle = await engine.tick();
    expect(summaryIdle.dispatched).toBe(1); // Only 1 dispatched
    expect(fakeOrca.dispatched.length).toBe(1);

    const firstDispatchedHandle = fakeOrca.dispatched[0]!.handle;
    expect(firstDispatchedHandle).toBe("worker-busy-1");

    // Next tick: thread A is DISPATCHED, so thread B must NOT be assigned the busy worker
    const summarySecondTick = await engine.tick();
    expect(summarySecondTick.dispatched).toBe(0);
    expect(fakeOrca.dispatched.length).toBe(1); // Still only 1 total dispatch
  });

  // --------------------------------------------------------------------------
  // Test 4: Worker returns to IDLE after grace/observed BUSY -> verification PASS
  // -> posts thread reply + sends owner DM; live human feedback arriving while
  // DISPATCHED is preserved and automatically queues a follow-up cycle.
  // --------------------------------------------------------------------------
  it("Test 4: Worker returns to IDLE after grace/observed BUSY -> verification PASS -> posts thread reply + sends owner DM; live human feedback arriving while DISPATCHED is preserved and automatically queues a follow-up cycle", async () => {
    const threadId = "thread-301";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 단서 조사",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-1", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick(); // Discover

    fakeDiscord.addMessage(threadId, "초기 요청: 단서 인덱스 갱신");
    await engine.tick(); // Queue
    advanceTime(20_000); // Debounce
    await engine.tick(); // Dispatched to worker-1 (iteration 1)

    // Phase 1: Worker is running (BUSY)
    fakeOrca.setWorkerState("worker-1", "BUSY");
    await engine.tick(); // Observes worker BUSY

    // Live human feedback arrives WHILE worker is running mid-turn!
    advanceTime(5_000);
    fakeDiscord.addMessage(threadId, "추가 요청: 검색 인덱스에도 한글 초성 캐시 추가해주세요");
    const pollTick = await engine.tick();
    expect(pollTick.queued).toBe(1); // Preserved in pendingMessages!

    // Phase 2: Worker returns to IDLE & verification PASSES
    fakeOrca.setWorkerState("worker-1", "IDLE");
    fakeVerifier.defaultResult = {
      passed: true,
      results: [
        {
          name: "pytest",
          command: "pytest -v",
          passed: true,
          exitCode: 0,
          durationMs: 80,
          outputExcerpt: "12 passed in 0.08s",
        },
      ],
      summaryText: "pytest: PASS (12 passed)",
    };

    const verifyTick = await engine.tick();
    expect(verifyTick.verified).toBe(1);

    // Verification 1: Thread message posted with completion and follow-up announcement
    const threadMessages = fakeDiscord.postedMessages.filter(m => m.channelId === threadId);
    expect(threadMessages.some(m => m.content.includes("검증 통과"))).toBe(true);
    expect(threadMessages.some(m => m.content.includes("후속 사이클을 이어서 진행합니다"))).toBe(true);

    // Verification 2: Owner DM sent
    const dmMessage = fakeDiscord.postedMessages.find(m => m.channelId === "dm-owner-direct");
    expect(dmMessage).toBeDefined();
    expect(dmMessage?.content).toContain("✅ [orch 완료]");

    // Verification 3: Thread automatically re-queued for the live follow-up message!
    // Next tick will dispatch cycle 2 with the live human feedback
    fakeOrca.setWorkerState("worker-1", "IDLE");
    advanceTime(15_000);
    const followUpTick = await engine.tick();
    expect(followUpTick.dispatched).toBe(1);

    const followUpPrompt = fakeOrca.dispatched[1]!.prompt;
    expect(followUpPrompt).toContain("추가 요청: 검색 인덱스에도 한글 초성 캐시 추가해주세요");
  });

  // --------------------------------------------------------------------------
  // Test 5: Verification FAIL -> automatically re-queues recursive cycle up to
  // maxIterations, and 2 consecutive identical failure hashes immediately halt
  // into PAUSED_NEEDS_HUMAN with thread & DM alert.
  // --------------------------------------------------------------------------
  it("Test 5: Verification FAIL -> automatically re-queues recursive cycle up to maxIterations, and 2 consecutive identical failure hashes immediately halt into PAUSED_NEEDS_HUMAN with thread & DM alert", async () => {
    const threadId = "thread-401";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 버그 재귀 수정",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-1", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick(); // Discover

    fakeDiscord.addMessage(threadId, "버그 수정 요청: 다이얼로그 노드 12");
    await engine.tick(); // Queue
    advanceTime(20_000); // Debounce
    await engine.tick(); // Dispatch cycle 1

    // Step 1: Cycle 1 worker BUSY -> IDLE, fails verification
    fakeOrca.setWorkerState("worker-1", "BUSY");
    await engine.tick(); // observe busy
    fakeOrca.setWorkerState("worker-1", "IDLE");

    const failureHash = "fail-hash-node12";
    fakeVerifier.defaultResult = {
      passed: false,
      failureHash,
      results: [
        {
          name: "pytest",
          command: "pytest -v",
          passed: false,
          exitCode: 1,
          durationMs: 120,
          outputExcerpt: "FAILED tests/dialogue.py - KeyError: 'node_12'",
        },
      ],
      summaryText: "pytest: FAILED (KeyError: 'node_12')",
    };

    const failTick1 = await engine.tick();
    expect(failTick1.verified).toBe(1);
    expect(failTick1.escalated).toBe(0); // Not escalated yet: 1st failure
    expect(failTick1.dispatched).toBe(1); // Auto-requeued and dispatched cycle 2 immediately!

    // Thread received auto-requeue notice
    expect(fakeDiscord.postedMessages.some(m => m.channelId === threadId && m.content.includes("자동 재수정 예약"))).toBe(true);
    expect(fakeOrca.dispatched[1]!.prompt).toContain("KeyError: 'node_12'");
    // Step 3: Cycle 2 worker BUSY -> IDLE, fails with THE EXACT SAME signature
    fakeOrca.setWorkerState("worker-1", "BUSY");
    await engine.tick();
    fakeOrca.setWorkerState("worker-1", "IDLE");

    const failTick2 = await engine.tick();
    expect(failTick2.verified).toBe(1);
    expect(failTick2.escalated).toBe(1); // 2 consecutive identical failures -> HALT & ESCALATE!

    // Verify Thread escalation alert
    const escalationThreadMsg = fakeDiscord.postedMessages.find(
      m => m.channelId === threadId && m.content.includes("자동 재귀 중단 — 사람 확인 필요"),
    );
    expect(escalationThreadMsg).toBeDefined();
    expect(escalationThreadMsg?.content).toContain(failureHash);

    // Verify Owner DM escalation alert
    const escalationDmMsg = fakeDiscord.postedMessages.find(
      m => m.channelId === "dm-owner-direct" && m.content.includes("자동 재귀 중단 — 사람 확인 필요"),
    );
    expect(escalationDmMsg).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Test 6: Risky operation (`git push --force`) creates ApprovalGate
  // (PAUSED_NEEDS_HUMAN) + DM alert; `!orch approve <id>` resumes and dispatches;
  // `!orch deny <id>` cancels and returns thread to IDLE.
  // --------------------------------------------------------------------------
  it("Test 6: Risky operation creates ApprovalGate + DM alert; !orch approve resumes and dispatches; !orch deny cancels and returns thread to IDLE", async () => {
    const threadId = "thread-501";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 위험 작업 테스트",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-1", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick(); // Discover

    // --- Sub-test 6A: Risky git push --force creates ApprovalGate ---
    fakeDiscord.addMessage(threadId, "긴급 핫픽스 완료했으니 git push --force origin main 실행해주세요");
    await engine.tick(); // Queue
    advanceTime(20_000); // Past debounce

    const riskyTick = await engine.tick();
    expect(riskyTick.escalated).toBe(1);
    expect(riskyTick.dispatched).toBe(0); // Worker was NOT dispatched!

    // Find the gate ID from the approval request alert
    const gateAlert = fakeDiscord.postedMessages.find(
      m => m.channelId === threadId && m.content.includes("[승인 필요] 위험 작업이 감지되어"),
    );
    expect(gateAlert).toBeDefined();
    expect(gateAlert?.content).toContain("Force git push");

    const gateIdMatch = gateAlert!.content.match(/!orch approve (gate_[a-f0-9]+)/);
    expect(gateIdMatch).toBeDefined();
    const gateId = gateIdMatch![1]!;

    // DM alert sent to owner
    const dmAlert = fakeDiscord.postedMessages.find(
      m => m.channelId === "dm-owner-direct" && m.content.includes("[승인 필요] 위험 작업이 감지되어"),
    );
    expect(dmAlert).toBeDefined();

    // --- Sub-test 6B: !orch approve <gateId> resumes and dispatches ---
    fakeDiscord.addMessage(threadId, `!orch approve ${gateId}`);
    const approveTick = await engine.tick();

    // Verification: command executed, gate approved, and immediately dispatched!
    expect(approveTick.dispatched).toBe(1);
    expect(fakeOrca.dispatched.length).toBe(1);
    expect(fakeDiscord.postedMessages.some(m => m.channelId === threadId && m.content.includes("승인됨"))).toBe(true);

    // --- Sub-test 6C: Risky operation with !orch deny <gateId> cancels to IDLE ---
    const threadDeny = "thread-502";
    fakeDiscord.addThread({
      id: threadDeny,
      parent_id: "channel-sample-parent",
      name: "샘플앱 삭제 위험 테스트",
      last_message_id: "1000",
    });
    await engine.tick(); // Discover

    fakeDiscord.addMessage(threadDeny, "임시 파일 정리를 위해 rm -rf / 실행 요청");
    await engine.tick(); // Queue
    advanceTime(20_000);

    const denyGateTick = await engine.tick();
    expect(denyGateTick.escalated).toBe(1);

    const denyAlert = fakeDiscord.postedMessages.find(
      m => m.channelId === threadDeny && m.content.includes("[승인 필요] 위험 작업이 감지되어"),
    );
    const denyGateId = denyAlert!.content.match(/!orch deny (gate_[a-f0-9]+)/)![1]!;

    // Owner denies the request
    fakeDiscord.addMessage(threadDeny, `!orch deny ${denyGateId}`);
    fakeOrca.setWorkerState("worker-1", "IDLE"); // Ensure worker is idle to confirm we don't dispatch
    const initialDispatchedCount = fakeOrca.dispatched.length;

    await engine.tick();

    // Verification: Deny message posted, no dispatch happened, thread returned to IDLE
    expect(fakeDiscord.postedMessages.some(m => m.channelId === threadDeny && m.content.includes("거절됨"))).toBe(true);
    expect(fakeOrca.dispatched.length).toBe(initialDispatchedCount); // Unchanged!
  });
  // --------------------------------------------------------------------------
  // Test 7: Disappeared/closed Orca worker while DISPATCHED recovers cleanly
  // after the 15s grace period (re-queues or escalates instead of hanging
  // forever in DISPATCHED when inspectWorkerState returns UNKNOWN and
  // listRepoWorkers no longer contains that handle).
  // --------------------------------------------------------------------------
  it("Test 7: Disappeared/closed Orca worker while DISPATCHED recovers cleanly after the 15s grace period", async () => {
    const threadId = "thread-701";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 워커 비정상 종료 복구",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-vanish", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick(); // Discover

    fakeDiscord.addMessage(threadId, "작업 요청: 맵 데이터 검증");
    await engine.tick(); // Queue
    advanceTime(20_000); // Debounce
    const dispatchTick = await engine.tick();
    expect(dispatchTick.dispatched).toBe(1);
    expect(fakeOrca.dispatched[0]!.handle).toBe("worker-vanish");

    // Worker process is killed or closed unexpectedly
    fakeOrca.workers.delete("worker-vanish");

    // Case A: Within 15s grace period (elapsed = 5s), engine does NOT declare disappeared yet
    advanceTime(5_000);
    const graceTick = await engine.tick();
    expect(graceTick.dispatched).toBe(0);
    expect(graceTick.escalated).toBe(0);

    // Case B: Past 15s grace period (elapsed = 5s + 11s = 16s > 15s) -> cleanly re-queues
    advanceTime(11_000);
    const recoverTick = await engine.tick();

    // Verify: recovered cleanly by re-queueing (since iteration 1 < maxIterations 4)
    expect(fakeDiscord.postedMessages.some(m => m.channelId === threadId && m.content.includes("워커 비정상 종료 감지"))).toBe(true);

    // Provide a replacement idle worker and verify dispatch succeeds
    fakeOrca.addWorker("worker-replacement", defaultRoute.repoPath, "IDLE");
    const reDispatchTick = await engine.tick();
    expect(reDispatchTick.dispatched).toBe(1);
    expect(fakeOrca.dispatched[1]!.handle).toBe("worker-replacement");
    expect(fakeOrca.dispatched[1]!.prompt).toContain("작업 요청: 맵 데이터 검증");
    // Case C: When iteration reaches maxIterations and worker disappears -> escalates to PAUSED_NEEDS_HUMAN
    const threadEscalate = "thread-702";
    fakeDiscord.addThread({
      id: threadEscalate,
      parent_id: "channel-sample-parent",
      name: "샘플앱 최대 반복 후 종료",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-cap", defaultRoute.repoPath, "IDLE");
    await engine.tick(); // Discover

    const { loadOrchState, saveOrchState } = await import("../../src/orch/store");
    const curState = await loadOrchState(tmpHome);
    // Simulate thread already at maxIterations (4) and currently DISPATCHED to worker-cap
    const tEsc = curState.threads[threadEscalate]!;
    tEsc.status = "DISPATCHED";
    tEsc.iteration = defaultRoute.maxIterations;
    tEsc.assignedWorkerHandle = "worker-cap";
    tEsc.dispatchedAt = new Date(currentTimeMs).toISOString();
    await saveOrchState(curState, tmpHome);

    // Worker terminates and disappears
    fakeOrca.workers.delete("worker-cap");
    advanceTime(20_000); // Past 15s grace period

    const capTick = await engine.tick();
    expect(capTick.escalated).toBe(1);
    const updatedState = await loadOrchState(tmpHome);
    expect(updatedState.threads[threadEscalate]!.status).toBe("PAUSED_NEEDS_HUMAN");
    expect(fakeDiscord.postedMessages.some(m => m.channelId === threadEscalate && m.content.includes("워커 비정상 종료 — 사람 확인 필요"))).toBe(true);
    expect(fakeDiscord.postedMessages.some(m => m.channelId === "dm-owner-direct" && m.content.includes("워커 비정상 종료 — 사람 확인 필요"))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Test 8: Pre-existing VERIFYING state persisted on disk recovers on the next
  // tick() and completes verification cleanly.
  // --------------------------------------------------------------------------
  it("Test 8: Pre-existing VERIFYING state persisted on disk recovers on the next tick() and completes verification cleanly", async () => {
    const threadId = "thread-801";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 검증 중단 복구",
      last_message_id: "1000",
    });

    const { saveOrchState, loadOrchState } = await import("../../src/orch/store");
    const preState = {
      version: 1,
      threads: {
        [threadId]: {
          threadId,
          parentId: "channel-sample-parent",
          name: "샘플앱 검증 중단 복구",
          routeId: defaultRoute.id,
          status: "VERIFYING" as const,
          lastSeenMessageId: "1000",
          iteration: 1,
          consecutiveSameFailures: 0,
          pendingMessages: [],
          createdAt: new Date(currentTimeMs).toISOString(),
          updatedAt: new Date(currentTimeMs).toISOString(),
        },
      },
      gates: {},
    };
    await saveOrchState(preState as any, tmpHome);

    const engine = createEngine();
    const tickSummary = await engine.tick();

    expect(tickSummary.verified).toBe(1);
    expect(fakeVerifier.verifiedRoutes.length).toBe(1);
    expect(fakeVerifier.verifiedRoutes[0]!.id).toBe(defaultRoute.id);

    // Verify completion message posted to thread and owner DM sent
    expect(fakeDiscord.postedMessages.some(m => m.channelId === threadId && m.content.includes("검증 통과"))).toBe(true);
    expect(fakeDiscord.postedMessages.some(m => m.channelId === "dm-owner-direct" && m.content.includes("✅ [orch 완료]"))).toBe(true);

    // Verify thread transitioned cleanly from VERIFYING to IDLE
    const updatedState = await loadOrchState(tmpHome);
    expect(updatedState.threads[threadId]?.status).toBe("IDLE");
  });

  // --------------------------------------------------------------------------
  // Test 9: Post-PASS live human feedback resets thread.iteration to 0 and clears
  // consecutiveSameFailures so the follow-up gets a fresh iteration budget.
  // --------------------------------------------------------------------------
  it("Test 9: Post-PASS live human feedback resets thread.iteration to 0 and clears consecutiveSameFailures so the follow-up gets a fresh iteration budget", async () => {
    const threadId = "thread-901";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 반복 예산 리셋 테스트",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-1", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick(); // Discover

    // Cycle 1: Request initial task
    fakeDiscord.addMessage(threadId, "초기 요청: 단서 추적 로직 구현");
    await engine.tick(); // Queue
    advanceTime(20_000); // Debounce
    await engine.tick(); // Dispatched -> cycle 1 (iteration becomes 1)

    // Worker runs and becomes BUSY
    fakeOrca.setWorkerState("worker-1", "BUSY");
    await engine.tick(); // Observe busy

    // User sends live human feedback while worker is mid-turn
    advanceTime(5_000);
    fakeDiscord.addMessage(threadId, "추가 피드백: 스테이지1 NPC 상호작용 추가");
    await engine.tick(); // Polls message into pendingMessages

    // Worker finishes and becomes IDLE
    fakeOrca.setWorkerState("worker-1", "IDLE");

    // Verification PASSES
    const passTick = await engine.tick();
    expect(passTick.verified).toBe(1);

    // Verify: thread.iteration reset to 0, consecutiveSameFailures cleared, status QUEUED
    const { loadOrchState } = await import("../../src/orch/store");
    const midState = await loadOrchState(tmpHome);
    const threadState = midState.threads[threadId]!;
    expect(threadState.status).toBe("QUEUED");
    expect(threadState.iteration).toBe(0);
    expect(threadState.consecutiveSameFailures).toBe(0);
    expect(threadState.pendingMessages.length).toBe(1);

    // Debounce elapses for the follow-up request
    advanceTime(20_000);
    const followUpTick = await engine.tick();
    expect(followUpTick.dispatched).toBe(1);

    // Crucial check: the follow-up starts as Cycle 1 (fresh iteration budget), NOT cycle 2!
    const postDispatchState = await loadOrchState(tmpHome);
    expect(postDispatchState.threads[threadId]!.iteration).toBe(1);
    expect(fakeDiscord.postedMessages.some(m => m.channelId === threadId && m.content.includes("사이클 1/4 시작"))).toBe(true);
    expect(fakeOrca.dispatched[1]!.prompt).toContain("추가 피드백: 스테이지1 NPC 상호작용 추가");
  });

  // --------------------------------------------------------------------------
  // Test 10: A PAUSED thread advances lastSeenMessageId on regular user messages
  // without appending them to pendingMessages, while still honoring !orch resume.
  // --------------------------------------------------------------------------
  it("Test 10: A PAUSED thread advances lastSeenMessageId on regular user messages without appending them to pendingMessages, while still honoring !orch resume", async () => {
    const threadId = "thread-1001";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 PAUSED 처리 테스트",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-1", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick(); // Discover

    // Pause the thread via command
    fakeDiscord.addMessage(threadId, "!orch pause", undefined, "1001");
    await engine.tick();

    const { loadOrchState } = await import("../../src/orch/store");
    let state = await loadOrchState(tmpHome);
    expect(state.threads[threadId]!.status).toBe("PAUSED");
    expect(fakeDiscord.postedMessages.some(m => m.channelId === threadId && m.content.includes("일시중지됨"))).toBe(true);

    // Regular user messages arrive while thread is PAUSED
    fakeDiscord.addMessage(threadId, "일반 사용자 메시지 A", undefined, "1002");
    fakeDiscord.addMessage(threadId, "일반 사용자 메시지 B", undefined, "1003");
    const pausedPollTick = await engine.tick();

    // Verify: Messages were polled and lastSeenMessageId advanced to 1003, but NOT appended to pendingMessages
    expect(pausedPollTick.queued).toBe(0);
    state = await loadOrchState(tmpHome);
    expect(state.threads[threadId]!.lastSeenMessageId).toBe("1003");
    expect(state.threads[threadId]!.pendingMessages.length).toBe(0);
    expect(state.threads[threadId]!.status).toBe("PAUSED");
    expect(fakeOrca.dispatched.length).toBe(0); // Nothing dispatched

    // Advance time and tick again - still nothing queued or dispatched
    advanceTime(20_000);
    await engine.tick();
    expect(fakeOrca.dispatched.length).toBe(0);

    // Thread honors !orch resume
    fakeDiscord.addMessage(threadId, "!orch resume", undefined, "1004");
    await engine.tick();

    state = await loadOrchState(tmpHome);
    expect(state.threads[threadId]!.status).toBe("IDLE");
    expect(state.threads[threadId]!.lastSeenMessageId).toBe("1004");
    expect(fakeDiscord.postedMessages.some(m => m.channelId === threadId && m.content.includes("재개됨"))).toBe(true);

    // After resume, regular messages are queued normally
    fakeDiscord.addMessage(threadId, "재개 후 정상 작업 요청", undefined, "1005");
    const resumePollTick = await engine.tick();
    expect(resumePollTick.queued).toBe(1);

    state = await loadOrchState(tmpHome);
    expect(state.threads[threadId]!.status).toBe("QUEUED");
    expect(state.threads[threadId]!.pendingMessages.length).toBe(1);
    expect(state.threads[threadId]!.pendingMessages[0]!.content).toBe("재개 후 정상 작업 요청");
  });

  // --------------------------------------------------------------------------
  // Test 11: Live feedback verification details — PASS reports completedIter (not 0),
  // and non-human bot_qa feedback does not bypass circuit-breaker escalation.
  // --------------------------------------------------------------------------
  it("Test 11: Reports completedIter accurately on PASS with follow-up and prevents bot_qa feedback from bypassing circuit breaker", async () => {
    const threadId = "thread-1101";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 봇피드백 회로차단 테스트",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-cb", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick(); // Discover

    // Dispatch cycle 1
    fakeDiscord.addMessage(threadId, "초기 요청: 씬 전환 수정");
    await engine.tick();
    advanceTime(20_000);
    await engine.tick(); // Dispatched (iter 1)

    fakeOrca.setWorkerState("worker-cb", "BUSY");
    await engine.tick();

    // Human follow-up arrives mid-turn
    advanceTime(5_000);
    fakeDiscord.addMessage(threadId, "후속 요청: HUD 폰트 수정");
    await engine.tick();

    // Worker completes and PASSES -> report must show completedIter=1 (not 0!)
    fakeOrca.setWorkerState("worker-cb", "IDLE");
    const passTick = await engine.tick();
    expect(passTick.verified).toBe(1);
    expect(
      fakeDiscord.postedMessages.some(
        m => m.channelId === threadId && m.content.includes("사이클 1/4 검증 통과"),
      ),
    ).toBe(true);

    // Now test circuit-breaker with bot_qa follow-up when at maxIterations
    const threadBot = "thread-1102";
    fakeDiscord.addThread({
      id: threadBot,
      parent_id: "channel-sample-parent",
      name: "샘플앱 봇QA 한도 도달 테스트",
      last_message_id: "2000",
    });
    const { saveOrchState, loadOrchState } = await import("../../src/orch/store");
    const curState = await loadOrchState(tmpHome);
    curState.threads[threadBot] = {
      threadId: threadBot,
      parentId: "channel-sample-parent",
      name: "샘플앱 봇QA 한도 도달 테스트",
      routeId: defaultRoute.id,
      status: "VERIFYING",
      lastSeenMessageId: "2001",
      iteration: defaultRoute.maxIterations,
      consecutiveSameFailures: 1,
      pendingMessages: [
        {
          id: "2001",
          authorId: "qa-bot-99",
          authorName: "qa-bot",
          content: "QA FAIL: UI overlap still present",
          timestamp: new Date(currentTimeMs).toISOString(),
          kind: "bot_qa",
        },
      ],
      createdAt: new Date(currentTimeMs).toISOString(),
      updatedAt: new Date(currentTimeMs).toISOString(),
    };
    await saveOrchState(curState, tmpHome);

    fakeVerifier.nextResults.push({
      passed: false,
      failureHash: "fail-ui-overlap",
      summaryText: "UI overlap failed",
      results: [{ name: "ui-check", command: "pytest", exitCode: 1, passed: false, durationMs: 100, outputTail: "UI overlap" }],
    });

    const escalateTick = await engine.tick();
    expect(escalateTick.escalated).toBe(1);
    const afterState = await loadOrchState(tmpHome);
    expect(afterState.threads[threadBot]!.status).toBe("PAUSED_NEEDS_HUMAN");
  });

  it("Test 12: Skips inactive DISCOVERED threads and auto-stops threads returning 404 Unknown Channel without tick error storm", async () => {
    const threadArchived = "thread-1201";
    const threadDeleted = "thread-1202";
    fakeDiscord.addThread({
      id: threadArchived,
      parent_id: "channel-sample-parent",
      name: "샘플앱 아카이브 테스트",
      last_message_id: "1000",
    });
    fakeDiscord.addThread({
      id: threadDeleted,
      parent_id: "channel-sample-parent",
      name: "샘플앱 삭제 테스트",
      last_message_id: "2000",
    });

    const engine = createEngine();
    await engine.tick(); // Discover both

    // Queue a message on threadDeleted so it is in QUEUED state
    fakeDiscord.addMessage(threadDeleted, "삭제 직전 메시지", undefined, "2001");
    await engine.tick();

    // Remove threadArchived from active list and make listThreadMessages throw 404 for both
    fakeDiscord.threads = fakeDiscord.threads.filter(t => t.id !== threadArchived && t.id !== threadDeleted);
    const origList = fakeDiscord.listThreadMessages.bind(fakeDiscord);
    let polledArchived = 0;
    fakeDiscord.listThreadMessages = async (channelId: string, opts?: { after?: string; limit?: number }) => {
      if (channelId === threadArchived) {
        polledArchived++;
        throw new Error('Discord API GET failed (404): {"message": "Unknown Channel", "code": 10003}');
      }
      if (channelId === threadDeleted) {
        throw new Error('Discord API GET failed (404): {"message": "Unknown Channel", "code": 10003}');
      }
      return origList(channelId, opts);
    };

    const tickRes = await engine.tick();
    expect(polledArchived).toBe(0); // DISCOVERED inactive thread was skipped
    expect(tickRes.errors.length).toBe(0); // 404 auto-stopped without polluting errors / backoff

    const { loadOrchState, readRecentLedger } = await import("../../src/orch/store");
    const state = await loadOrchState(tmpHome);
    expect(state.threads[threadDeleted]!.status).toBe("STOPPED");
    expect(state.threads[threadDeleted]!.statusReason).toContain("404");
    const ledger = await readRecentLedger(10, tmpHome);
    expect(ledger.some(e => e.event === "thread_deleted" && e.threadId === threadDeleted)).toBe(true);
  });

  it("Test 13: Discord reaction lifecycle (👀 -> 🧠 -> 🔍 -> ✅), typing indicator, editable live Thinking status, and mid-turn follow-up preservation", async () => {
    const threadId = "thread-1301";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 리액션+Thinking 테스트",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-rx", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick(); // Discover

    // 1. User message arrives -> immediately receives 👀 reaction
    const msg1 = fakeDiscord.addMessage(threadId, "로그인 화면 버튼 정렬 수정해줘", undefined, "1001");
    await engine.tick();
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: msg1.id, emoji: "👀" });

    // 2. After debounce -> dispatches worker, swaps 👀 -> 🧠, triggers typing, posts live Thinking card
    advanceTime(20_000);
    await engine.tick();
    expect(fakeDiscord.removedReactions).toContainEqual({ channelId: threadId, messageId: msg1.id, emoji: "👀" });
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: msg1.id, emoji: "🧠" });
    expect(fakeDiscord.typingTriggers).toContain(threadId);
    const statusPost = fakeDiscord.postedMessages.find(m => m.channelId === threadId && m.content.includes("Thinking..."));
    expect(statusPost).toBeDefined();

    // 3. Worker transitions through planning -> executing -> reporting -> edits SAME status message in place
    fakeOrca.setWorkerState("worker-rx", "BUSY", ["◆ hud · planning ● planning"], "planning", "◱ planning layout");
    advanceTime(20_000);
    await engine.tick();
    expect(fakeDiscord.editedMessages.some(e => e.messageId === statusPost!.id && e.content.includes("Planning..."))).toBe(true);

    // Mid-turn human message arrives -> gets 👀 WITHOUT hijacking msg1's active reactionMessageId
    const msg2 = fakeDiscord.addMessage(threadId, "다크모드 색상도 같이 맞춰줘", undefined, "1002");
    fakeOrca.setWorkerState("worker-rx", "BUSY", ["◆ hud · executing ● executing"], "executing", "Running edit src/login.tsx");
    advanceTime(20_000);
    await engine.tick();
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: msg2.id, emoji: "👀" });
    expect(fakeDiscord.editedMessages.some(e => e.messageId === statusPost!.id && e.content.includes("Executing..."))).toBe(true);
    // Still only 1 live status message posted (all updates via PATCH)
    expect(fakeDiscord.postedMessages.filter(m => m.channelId === threadId).length).toBe(1);

    // 4. Worker finishes -> 🔍 during verify -> ✅ on msg1 (NOT msg2!), status finalized cleanly
    fakeOrca.setWorkerState("worker-rx", "IDLE");
    await engine.tick();
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: msg1.id, emoji: "🔍" });
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: msg1.id, emoji: "✅" });
    expect(fakeDiscord.editedMessages.some(e => e.messageId === statusPost!.id && e.content.includes("Thinking 완료"))).toBe(true);

    // 5. Follow-up batch (msg2) dispatches -> preserves ✅ on msg1, cleans 👀 on msg2, sets 🧠 on msg2
    advanceTime(20_000);
    await engine.tick();
    expect(fakeDiscord.removedReactions).not.toContainEqual({ channelId: threadId, messageId: msg1.id, emoji: "✅" });
    expect(fakeDiscord.removedReactions).toContainEqual({ channelId: threadId, messageId: msg2.id, emoji: "👀" });
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: msg2.id, emoji: "🧠" });
  });

  it("Test 14: Fail retry (🔄), escalation (❌), command reactions, and dry-run zero Discord side effects", async () => {
    const threadId = "thread-1401";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 실패+명령 리액션 테스트",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-fail", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick();

    // Dry-run message polling should NOT send reactions, typing, or posts
    fakeDiscord.addMessage(threadId, "빌드 오류 고쳐줘", undefined, "1001");
    await engine.tick({ dryRun: true });
    expect(fakeDiscord.addedReactions.length).toBe(0);
    expect(fakeDiscord.typingTriggers.length).toBe(0);
    expect(fakeDiscord.postedMessages.length).toBe(0);

    // Real tick queues and dispatches
    await engine.tick();
    advanceTime(20_000);
    await engine.tick();
    fakeOrca.setWorkerState("worker-fail", "BUSY");
    await engine.tick();

    // First failure -> 🔄 reaction and re-queue
    fakeVerifier.nextResults.push({
      passed: false,
      failureHash: "hash-same",
      summaryText: "tsc failed",
      results: [{ name: "typecheck", command: "tsc", exitCode: 1, passed: false, durationMs: 50, outputExcerpt: "TS error" }],
    });
    fakeOrca.setWorkerState("worker-fail", "IDLE");
    await engine.tick();
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: "1001", emoji: "🔄" });

    // Second identical failure -> escalation with ❌ reaction
    advanceTime(20_000);
    await engine.tick();
    fakeOrca.setWorkerState("worker-fail", "BUSY");
    await engine.tick();
    fakeVerifier.nextResults.push({
      passed: false,
      failureHash: "hash-same",
      summaryText: "tsc failed",
      results: [{ name: "typecheck", command: "tsc", exitCode: 1, passed: false, durationMs: 50, outputExcerpt: "TS error" }],
    });
    fakeOrca.setWorkerState("worker-fail", "IDLE");
    await engine.tick();
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: "1001", emoji: "❌" });

    // !orch stop command gets 🛑 command reaction and clears worker phase/status
    const stopMsg = fakeDiscord.addMessage(threadId, "!orch stop", undefined, "1002");
    await engine.tick();
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: stopMsg.id, emoji: "🛑" });
  });

  it("Test 15: Thinking status deduplicates identical edits, ignores transient edit errors without duplicating cards, and reposts only on 404/10008", async () => {
    const threadId = "thread-1501";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 상태편집 내성 테스트",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-edit", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick();

    fakeDiscord.addMessage(threadId, "테스트 실행해줘", undefined, "1001");
    await engine.tick();
    advanceTime(20_000);
    await engine.tick(); // Dispatches and posts 1 status card
    const postsAfterDispatch = fakeDiscord.postedMessages.filter(m => m.channelId === threadId).length;
    expect(postsAfterDispatch).toBe(1);

    // Same phase & same compact elapsed bucket -> only 1 edit, second tick is deduped
    fakeOrca.setWorkerState("worker-edit", "BUSY", ["◆ hud · executing ● executing"], "executing", "Running bun test");
    advanceTime(10_000);
    await engine.tick();
    const editsAfterFirst = fakeDiscord.editedMessages.length;
    advanceTime(10_000);
    await engine.tick();
    expect(fakeDiscord.editedMessages.length).toBe(editsAfterFirst);

    // Transient 429 error on editMessage must NOT post a duplicate status card
    fakeDiscord.editError = new Error("Discord API PATCH failed (429): rate limited");
    fakeOrca.setWorkerState("worker-edit", "BUSY", ["◆ hud · reporting ● reporting"], "reporting", "Writing summary");
    advanceTime(10_000);
    await engine.tick();
    expect(fakeDiscord.postedMessages.filter(m => m.channelId === threadId).length).toBe(postsAfterDispatch);

    // 404 Unknown Message (10008) DOES recover by posting a fresh silent status card
    fakeDiscord.editError = new Error('Discord API PATCH failed (404): {"message": "Unknown Message", "code": 10008}');
    advanceTime(10_000);
    await engine.tick();
    fakeDiscord.editError = undefined;
    const allPosts = fakeDiscord.postedMessages.filter(m => m.channelId === threadId);
    expect(allPosts.length).toBe(postsAfterDispatch + 1);
    expect(allPosts[allPosts.length - 1]!.flags).toBe(DISCORD_SILENT_FLAGS);
  });

  it("Test 16: Pending risk gate ignores plain follow-up messages with 🛑 instead of clobbering the gate, and live orcaBin reload resets when cleared", async () => {
    const threadId = "thread-1601";
    fakeDiscord.addThread({
      id: threadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 위험게이트 보호 테스트",
      last_message_id: "1000",
    });
    fakeOrca.addWorker("worker-gate", defaultRoute.repoPath, "IDLE");

    const engine = createEngine();
    await engine.tick();

    // Risky message creates pendingGate
    fakeDiscord.addMessage(threadId, "git push --force origin main 실행해줘", undefined, "1001");
    await engine.tick();
    advanceTime(20_000);
    await engine.tick();

    const { loadOrchState } = await import("../../src/orch/store");
    const gateBefore = (await loadOrchState(tmpHome)).threads[threadId]!.pendingGate;
    expect(gateBefore?.status).toBe("pending");
    const postsBefore = fakeDiscord.postedMessages.length;

    // Plain user message while pendingGate is active gets 🛑 and does NOT clobber gate or spam alerts
    const plainMsg = fakeDiscord.addMessage(threadId, "잠깐만 기다려봐", undefined, "1002");
    await engine.tick();
    const gateAfter = (await loadOrchState(tmpHome)).threads[threadId]!.pendingGate;
    expect(gateAfter?.id).toBe(gateBefore?.id);
    expect(fakeDiscord.postedMessages.length).toBe(postsBefore);
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: plainMsg.id, emoji: "🛑" });

    // !orch retry while pendingGate is active is rejected with ⚠️ and keeps gate intact
    const retryMsg = fakeDiscord.addMessage(threadId, "!orch retry", undefined, "1003");
    await engine.tick();
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: threadId, messageId: retryMsg.id, emoji: "⚠️" });
    expect((await loadOrchState(tmpHome)).threads[threadId]!.pendingGate?.status).toBe("pending");

    // Cross-thread !orch approve <gateId> from another thread MUST be rejected with ❌
    const otherThreadId = "thread-1602";
    fakeDiscord.addThread({
      id: otherThreadId,
      parent_id: "channel-sample-parent",
      name: "샘플앱 다른 쓰레드",
      last_message_id: "2000",
    });
    await engine.tick();
    const crossApprove = fakeDiscord.addMessage(otherThreadId, `!orch approve ${gateBefore!.id}`, undefined, "2001");
    await engine.tick();
    expect(fakeDiscord.addedReactions).toContainEqual({ channelId: otherThreadId, messageId: crossApprove.id, emoji: "❌" });
    expect((await loadOrchState(tmpHome)).gates[gateBefore!.id]!.status).toBe("pending");

    // Live orcaBin reload: setting and clearing orcaBin in config propagates to orca.setOrcaBin
    await saveOrchConfig({ ...baseConfig, orcaBin: "/custom/bin/orca" }, tmpHome);
    await engine.tick();
    expect(fakeOrca.orcaBinCalls[fakeOrca.orcaBinCalls.length - 1]).toBe("/custom/bin/orca");

    await saveOrchConfig({ ...baseConfig, orcaBin: undefined }, tmpHome);
    await engine.tick();
    expect(fakeOrca.orcaBinCalls[fakeOrca.orcaBinCalls.length - 1]).toBeUndefined();
  });
});