import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyMessage,
  compareSnowflakes,
  DEFAULT_BOT_QA_MARKERS,
  detectRiskyOperation,
  hashFailureSignature,
  matchRoute,
  parseOrchCommand,
} from "../../src/orch/matcher";
import { resolveDiscordToken } from "../../src/orch/daemon";
import { DISCORD_SILENT_FLAGS, RestDiscordClient } from "../../src/orch/discord-api";
import { classifyTerminalScreen, CliOrcaClient, extractWorkerActivity, resolveOrcaBin } from "../../src/orch/orca";

import {
  appendLedger,
  createDefaultOrchConfig,
  createEmptyOrchState,
  expandTilde,
  loadOrchConfig,
  loadOrchState,
  readRecentLedger,
  removeRoute,
  resolveOrchHome,
  saveOrchConfig,
  saveOrchState,
  upsertRoute,
} from "../../src/orch/store";
import type {
  DiscordMessage,
  DiscordThread,
  GateRunResult,
  LedgerEntry,
  OrchConfig,
  OrchState,
  ProjectRoute,
} from "../../src/orch/types";

describe("matcher", () => {
  const baseRoute: ProjectRoute = {
    id: "sample-game",
    name: "샘플게임",
    enabled: true,
    parentChannelIds: ["channel-sample-1"],
    titleKeywords: ["샘플", "게임", "sample"],
    repoPath: "/tmp/workspace/sample-game",
    maxIterations: 4,
    sameFailureLimit: 2,
    maxWorkers: 3,
    spawnIfBusy: true,
    verificationGates: [],
  };

  describe("matchRoute", () => {
    it("matches thread with Korean keyword '샘플' (case-insensitive)", () => {
      const thread: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "channel-sample-1",
        name: "샘플 스테이지 나루터 단서 버그 제보",
      };
      const matched = matchRoute(thread, [baseRoute]);
      expect(matched?.id).toBe("sample-game");
    });

    it("matches thread with Korean keyword '게임'", () => {
      const thread: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "channel-sample-1",
        name: "미니 게임 챕터 2 진행 불가",
      };
      const matched = matchRoute(thread, [baseRoute]);
      expect(matched?.id).toBe("sample-game");
    });

    it("matches thread with English keyword 'sample' case-insensitively", () => {
      const uppercaseThread: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "channel-sample-1",
        name: "[SAMPLE] Fix inventory sync regression",
      };
      const mixedThread: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "channel-sample-1",
        name: "Sample regression test run",
      };
      expect(matchRoute(uppercaseThread, [baseRoute])?.id).toBe("sample-game");
      expect(matchRoute(mixedThread, [baseRoute])?.id).toBe("sample-game");
    });

    it("skips disabled route even when title and channel match", () => {
      const disabledRoute: ProjectRoute = { ...baseRoute, enabled: false };
      const thread: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "channel-sample-1",
        name: "샘플게임 퀘스트 수정",
      };
      const matched = matchRoute(thread, [disabledRoute]);
      expect(matched).toBeUndefined();
    });

    it("breaks ties by route array priority (first match wins)", () => {
      const specificRoute: ProjectRoute = {
        ...baseRoute,
        id: "sample-game-special",
        name: "샘플게임 특수",
        titleKeywords: ["단서"],
      };
      const routes = [specificRoute, baseRoute];
      const thread: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "channel-sample-1",
        name: "샘플 스테이지 단서 버그",
      };
      const matched = matchRoute(thread, routes);
      expect(matched?.id).toBe("sample-game-special");
    });

    it("rejects thread when parent channel ID does not match", () => {
      const thread: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "channel-other-999",
        name: "샘플게임 이슈",
      };
      const matched = matchRoute(thread, [baseRoute]);
      expect(matched).toBeUndefined();
    });

    it("matches any channel when parentChannelIds is empty", () => {
      const globalRoute: ProjectRoute = {
        ...baseRoute,
        id: "global-route",
        parentChannelIds: [],
        titleKeywords: ["샘플"],
      };
      const thread: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "any-random-channel",
        name: "샘플 이야기",
      };
      expect(matchRoute(thread, [globalRoute])?.id).toBe("global-route");
    });

    it("matches thread by titlePrefixes case-insensitively", () => {
      const prefixRoute: ProjectRoute = {
        ...baseRoute,
        id: "prefix-route",
        titleKeywords: [],
        titlePrefixes: ["[dev]", "feat:"],
      };
      const thread1: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "channel-sample-1",
        name: "[DEV] test runner fix",
      };
      const thread2: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "channel-sample-1",
        name: "FEAT: new dialogue tree",
      };
      const thread3: Pick<DiscordThread, "parent_id" | "name"> = {
        parent_id: "channel-sample-1",
        name: "fix: dialogue tree",
      };
      expect(matchRoute(thread1, [prefixRoute])?.id).toBe("prefix-route");
      expect(matchRoute(thread2, [prefixRoute])?.id).toBe("prefix-route");
      expect(matchRoute(thread3, [prefixRoute])).toBeUndefined();
    });
  });


  describe("classifyMessage", () => {
    const config: Pick<OrchConfig, "ownerUserIds"> = {
      ownerUserIds: ["owner-user-123"],
    };
    const route: Pick<ProjectRoute, "allowBotQaMarkers"> = {
      allowBotQaMarkers: undefined,
    };
    const botUserId = "orch-bot-self";

    it("ignores orchestrator self bot messages (hard bot-loop guard)", () => {
      const msg: DiscordMessage = {
        id: "msg-1",
        channel_id: "thread-1",
        content: "🚀 [사이클 1/4 시작] 워커에 배정했습니다.",
        timestamp: new Date().toISOString(),
        author: { id: botUserId, username: "JeoOrch", bot: true },
      };
      const res = classifyMessage(msg, config, route, botUserId);
      expect(res).toEqual({ kind: "ignore", reason: "self_message" });
    });

    it("ignores regular messages from other bots to prevent loops", () => {
      const msg: DiscordMessage = {
        id: "msg-2",
        channel_id: "thread-1",
        content: "HelperBot: 요청하신 태스크 처리를 시작합니다.",
        timestamp: new Date().toISOString(),
        author: { id: "helper-bot-id", username: "HelperBot", bot: true },
      };
      const res = classifyMessage(msg, config, route, botUserId);
      expect(res).toEqual({ kind: "ignore", reason: "bot_non_qa_message" });
    });

    it("accepts structured bot QA failure markers as qa_fail_trigger", () => {
      const markers = ["[QA_FAIL]", "[VERIFICATION_FAIL]", "[ORCH_RETRY]"];
      for (const marker of markers) {
        const msg: DiscordMessage = {
          id: `msg-${marker}`,
          channel_id: "thread-1",
          content: `Automated test run finished: ${marker} in tests/e2e/inventory.test.ts`,
          timestamp: new Date().toISOString(),
          author: { id: "ci-bot", username: "CI-Runner", bot: true },
        };
        const res = classifyMessage(msg, config, route, botUserId);
        expect(res.kind).toBe("qa_fail_trigger");
        if (res.kind === "qa_fail_trigger") {
          expect(res.marker).toBe(marker);
        }
      }
    });

    it("accepts regex-matched structured gate failures (e.g. gate_build: FAIL)", () => {
      const testCases = [
        "gate_build: FAIL",
        "gate_3d_albedo_10: FAIL",
        "gate_pytest_v2 = FAIL",
        "Pipeline result: gate_unit_test : FAIL (exit code 1)",
      ];

      for (const text of testCases) {
        const msg: DiscordMessage = {
          id: "msg-gate-fail",
          channel_id: "thread-1",
          content: text,
          timestamp: new Date().toISOString(),
          author: { id: "ci-bot", username: "CI-Runner", bot: true },
        };
        const res = classifyMessage(msg, config, route, botUserId);
        expect(res.kind).toBe("qa_fail_trigger");
      }
    });

    it("respects custom allowBotQaMarkers on the route", () => {
      const customRoute: Pick<ProjectRoute, "allowBotQaMarkers"> = {
        allowBotQaMarkers: ["[CUSTOM_RETRY_SIGNAL]"],
      };
      const msg: DiscordMessage = {
        id: "msg-custom-qa",
        channel_id: "thread-1",
        content: "Alert: [CUSTOM_RETRY_SIGNAL] detected on worker node",
        timestamp: new Date().toISOString(),
        author: { id: "ci-bot", username: "CI-Runner", bot: true },
      };
      const res = classifyMessage(msg, config, customRoute, botUserId);
      expect(res).toEqual({ kind: "qa_fail_trigger", marker: "[CUSTOM_RETRY_SIGNAL]" });
    });

    it("accepts human messages from configured owner as human_trigger", () => {
      const msg: DiscordMessage = {
        id: "msg-human-1",
        channel_id: "thread-1",
        content: "상점 대화 선택지 버그 고쳐주세요",
        timestamp: new Date().toISOString(),
        author: { id: "owner-user-123", username: "owner-dev", bot: false },
      };
      const res = classifyMessage(msg, config, route, botUserId);

      expect(res).toEqual({ kind: "human_trigger" });
    });

    it("ignores human messages from non-owner when ownerUserIds is non-empty", () => {
      const msg: DiscordMessage = {
        id: "msg-stranger",
        channel_id: "thread-1",
        content: "Hello from random guest",
        timestamp: new Date().toISOString(),
        author: { id: "stranger-999", username: "stranger", bot: false },
      };
      const res = classifyMessage(msg, config, route, botUserId);
      expect(res).toEqual({ kind: "ignore", reason: "non_owner_human" });
    });

    it("accepts human messages from anyone when ownerUserIds is empty", () => {
      const openConfig: Pick<OrchConfig, "ownerUserIds"> = { ownerUserIds: [] };
      const msg: DiscordMessage = {
        id: "msg-anyone",
        channel_id: "thread-1",
        content: "버그 수정 요청",
        timestamp: new Date().toISOString(),
        author: { id: "user-456", username: "user456", bot: false },
      };
      const res = classifyMessage(msg, openConfig, route, botUserId);
      expect(res).toEqual({ kind: "human_trigger" });
    });

    it("ignores empty or whitespace-only messages", () => {
      const msg: DiscordMessage = {
        id: "msg-empty",
        channel_id: "thread-1",
        content: "   \n\t  ",
        timestamp: new Date().toISOString(),
        author: { id: "owner-user-123", username: "owner-dev", bot: false },
      };
      const res = classifyMessage(msg, config, route, botUserId);
      expect(res).toEqual({ kind: "ignore", reason: "empty" });
    });

    it("parses !orch commands correctly", () => {
      const commands: Array<{ text: string; expected: ReturnType<typeof parseOrchCommand> }> = [
        { text: "!orch status", expected: { verb: "status" } },
        { text: "!orch pause", expected: { verb: "pause" } },
        { text: "!orch resume", expected: { verb: "resume" } },
        { text: "!orch stop", expected: { verb: "stop" } },
        { text: "!orch retry", expected: { verb: "retry" } },
        { text: "!orch approve gate_abc", expected: { verb: "approve", gateId: "gate_abc" } },
        { text: "!orch deny gate_abc", expected: { verb: "deny", gateId: "gate_abc" } },
        { text: "!orch approve", expected: { verb: "help" } },
        { text: "!orch deny", expected: { verb: "help" } },
        { text: "!orch foobar", expected: { verb: "help" } },
      ];

      for (const { text, expected } of commands) {
        const msg: DiscordMessage = {
          id: "msg-cmd",
          channel_id: "thread-1",
          content: text,
          timestamp: new Date().toISOString(),
          author: { id: "owner-user-123", username: "owner-dev", bot: false },
        };
        const res = classifyMessage(msg, config, route, botUserId);

        expect(res).toEqual({ kind: "command", command: expected! });
      }
    });
  });

  describe("detectRiskyOperation", () => {
    it("catches force git push variants", () => {
      expect(detectRiskyOperation("git push --force origin main")?.reason).toContain("Force git push");
      expect(detectRiskyOperation("git push origin feature -f")?.reason).toContain("Force git push");
      expect(detectRiskyOperation("git push --force-with-lease origin branch")?.reason).toContain("Force git push");
    });

    it("catches recursive force delete patterns", () => {
      expect(detectRiskyOperation("rm -rf /")?.reason).toContain("Recursive force delete");
      expect(detectRiskyOperation("rm -rf ~")?.reason).toContain("Recursive force delete");
      expect(detectRiskyOperation("rm -rf .")?.reason).toContain("Recursive force delete");
      expect(detectRiskyOperation("rm -rf ..")?.reason).toContain("Recursive force delete");
      expect(detectRiskyOperation("rm -rf *")?.reason).toContain("Recursive force delete");
    });


    it("catches git reset --hard and git clean -fd", () => {
      expect(detectRiskyOperation("git reset --hard HEAD~1")?.reason).toContain("Destructive git reset");
      expect(detectRiskyOperation("git clean -fd")?.reason).toContain("Destructive working-tree wipe");
    });

    it("catches production deploy commands and package publishes", () => {
      expect(detectRiskyOperation("kubectl apply -f deployment.yaml")?.reason).toContain("production deploy");
      expect(detectRiskyOperation("terraform apply")?.reason).toContain("production deploy");
      expect(detectRiskyOperation("vercel --prod")?.reason).toContain("production deploy");
      expect(detectRiskyOperation("fly deploy")?.reason).toContain("production deploy");
      expect(detectRiskyOperation("wrangler deploy")?.reason).toContain("production deploy");
      expect(detectRiskyOperation("gh release create v1.0.0")?.reason).toContain("production deploy");
      expect(detectRiskyOperation("npm publish")?.reason).toContain("package publish");
      expect(detectRiskyOperation("bun publish")?.reason).toContain("package publish");
    });

    it("catches explicit high-risk Korean requests", () => {
      expect(detectRiskyOperation("지금 바로 강제 푸시 진행해주세요")?.reason).toContain("Explicit high-risk");
      expect(detectRiskyOperation("불필요 파일 대량 삭제 부탁합니다")?.reason).toContain("Explicit high-risk");
      expect(detectRiskyOperation("외부 배포 진행할까요?")?.reason).toContain("Explicit high-risk");
      expect(detectRiskyOperation("프로덕션 배포 시작")?.reason).toContain("Explicit high-risk");
    });

    it("returns undefined on normal feature and bugfix requests", () => {
      const benignRequests = [
        "Please fix the dialogue box clipping bug in chapter 3",
        "Add unit test for compareSnowflakes in matcher.ts",
        "git push origin fix/dialogue-box",
        "git reset HEAD~1",
        "rm test.log",
        "bun test test/orch/",
        "npm run build",
        "Refactor inventory system with clean architecture",
      ];

      for (const text of benignRequests) {
        expect(detectRiskyOperation(text)).toBeUndefined();
      }
    });
  });

  describe("compareSnowflakes & hashFailureSignature", () => {
    it("compares 64-bit Discord snowflakes accurately without float precision loss", () => {
      expect(compareSnowflakes("100000000000000000", "100000000000000001")).toBe(-1);
      expect(compareSnowflakes("100000000000000001", "100000000000000001")).toBe(0);
      expect(compareSnowflakes("100000000000000002", "100000000000000001")).toBe(1);
    });

    it("produces deterministic hashes that ignore timestamps and run durations", () => {
      const run1: GateRunResult[] = [
        {
          name: "pytest",
          command: "pytest -v",
          passed: false,
          exitCode: 1,
          durationMs: 4200,
          outputExcerpt: "FAILED tests/test_flow.py::test_dialogue - AssertionError 2026-03-01T12:00:00Z in 4.20s pid 1234",
        },
      ];
      const run2: GateRunResult[] = [
        {
          name: "pytest",
          command: "pytest -v",
          passed: false,
          exitCode: 1,
          durationMs: 8900,
          outputExcerpt: "FAILED tests/test_flow.py::test_dialogue - AssertionError 2026-03-02T18:30:15Z in 8.90s pid 5678",
        },
      ];
      const hash1 = hashFailureSignature(run1);
      const hash2 = hashFailureSignature(run2);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(16);
    });
  });
});

describe("store", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orch-store-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("loadOrchConfig returns default config when routes.json does not exist", async () => {
    const config = await loadOrchConfig(tmpDir);
    expect(config.version).toBe(1);
    expect(config.guildId).toBe("");
    expect(config.routes).toEqual([]);
    expect(config.pollIntervalMs).toBe(10_000);
    expect(config.debounceMs).toBe(12_000);
  });

  it("saveOrchConfig and loadOrchConfig persist and normalize configuration", async () => {
    const config: OrchConfig = {
      version: 1,
      guildId: "guild-sample-1",
      ownerUserIds: ["user-owner-1"],
      ownerDmChannelId: "dm-channel-1",
      tokenFile: path.join(tmpDir, "token"),
      tokenEnv: "CUSTOM_TOKEN",
      pollIntervalMs: 5_000,
      debounceMs: 8_000,
      routes: [
        {
          id: "Sample Game",
          name: "샘플게임",
          enabled: true,
          parentChannelIds: ["chan-1", "chan-1"],
          titleKeywords: ["샘플", "게임"],
          repoPath: "/tmp/repo",
          maxIterations: 6,
          sameFailureLimit: 3,
          maxWorkers: 4,
          spawnIfBusy: true,
          verificationGates: [
            { name: "pytest", command: "pytest -v" },
          ],
        },
      ],
    };

    await saveOrchConfig(config, tmpDir);
    const loaded = await loadOrchConfig(tmpDir);

    expect(loaded.guildId).toBe("guild-sample-1");
    expect(loaded.ownerUserIds).toEqual(["user-owner-1"]);
    expect(loaded.ownerDmChannelId).toBe("dm-channel-1");
    expect(loaded.pollIntervalMs).toBe(5_000);
    expect(loaded.debounceMs).toBe(8_000);
    expect(loaded.routes.length).toBe(1);
    expect(loaded.routes[0]!.id).toBe("sample-game"); // slugified
    expect(loaded.routes[0]!.parentChannelIds).toEqual(["chan-1"]); // deduped
  });

  it("loadOrchState returns empty state when state.json does not exist", async () => {
    const state = await loadOrchState(tmpDir);
    expect(state.version).toBe(1);
    expect(state.threads).toEqual({});
    expect(state.gates).toEqual({});
  });

  it("saveOrchState and loadOrchState persist thread loop state atomically", async () => {
    const state: OrchState = {
      version: 1,
      botUserId: "orch-bot-123",
      lastPollAt: "2026-03-01T00:00:00.000Z",
      threads: {
        "thread-1": {
          threadId: "thread-1",
          parentId: "parent-1",
          name: "버그 제보",
          routeId: "sample-game",
          status: "QUEUED",
          lastSeenMessageId: "msg-999",
          iteration: 1,
          consecutiveSameFailures: 0,
          pendingMessages: [],
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      },
      gates: {},
    };

    await saveOrchState(state, tmpDir);
    const loaded = await loadOrchState(tmpDir);

    expect(loaded.botUserId).toBe("orch-bot-123");
    expect(loaded.threads["thread-1"]?.status).toBe("QUEUED");
    expect(loaded.threads["thread-1"]?.lastSeenMessageId).toBe("msg-999");
  });

  it("appendLedger and readRecentLedger record and retrieve chronological entries", async () => {
    const entries: LedgerEntry[] = [
      {
        ts: "2026-03-01T01:00:00Z",
        event: "thread_discovered",
        threadId: "t-1",
        routeId: "r-1",
        detail: { name: "Thread 1" },
      },
      {
        ts: "2026-03-01T01:01:00Z",
        event: "message_queued",
        threadId: "t-1",
        routeId: "r-1",
        detail: { author: "owner-dev" },
      },
      {
        ts: "2026-03-01T01:02:00Z",
        event: "worker_dispatched",

        threadId: "t-1",
        routeId: "r-1",
        iteration: 1,
        detail: { handle: "worker-1" },
      },
    ];

    for (const e of entries) {
      await appendLedger(e, tmpDir);
    }

    const all = await readRecentLedger(10, tmpDir);
    expect(all.length).toBe(3);
    expect(all[0]?.event).toBe("thread_discovered");
    expect(all[2]?.event).toBe("worker_dispatched");

    const recentTwo = await readRecentLedger(2, tmpDir);
    expect(recentTwo.length).toBe(2);
    expect(recentTwo[0]?.event).toBe("message_queued");
    expect(recentTwo[1]?.event).toBe("worker_dispatched");
  });

  it("upsertRoute and removeRoute modify config idempotently", async () => {
    const route = {
      id: "test-route",
      name: "테스트 라우트",
      repoPath: tmpDir,
    };

    const res1 = await upsertRoute(route, tmpDir);
    expect(res1.created).toBe(true);
    expect(res1.config.routes.length).toBe(1);

    const res2 = await upsertRoute({ ...route, name: "테스트 라우트 변경" }, tmpDir);
    expect(res2.created).toBe(false);
    expect(res2.config.routes.length).toBe(1);
    expect(res2.config.routes[0]!.name).toBe("테스트 라우트 변경");

    const removeRes = await removeRoute("test-route", tmpDir);
    expect(removeRes.removed).toBe(true);
    expect(removeRes.config.routes.length).toBe(0);
  });
});

describe("orca terminal classifier", () => {
  it("accurately classifies screens with active turn / thinking / HUD as BUSY", () => {
    const busyTails: string[][] = [
      ["[agent] starting step", "Thinking · reasoning about dialogue node 12..."],
      ["◰ thinking about graph connectivity"],
      ["◆ hud ● executing bash command"],
      ["◆ hud ● thinking next action"],
      ["Running bash command `pytest`..."],
      ["Press esc to interrupt current generation"],
      ["Output paused. Press ⟦esc⟧ to return"],
      ["Processing AST rewrite ⠋ checking nodes"],
      ["Searching codebase ⠙ resolving symbols"],
      ["Executing tool ⠹ running pytest"],
      [
        " ⠘ executing · bash: $ bun test",
        "◆ hud ✔ thinking → ✔ planning → ● executing → ○ reporting → ○ done",
        "│> Type your next message...                                                    │",
      ],
    ];

    for (const tail of busyTails) {
      const state = classifyTerminalScreen(tail, "jeo-agent-terminal");
      expect(state).toBe("BUSY");
    }
  });

  it("accurately classifies screens with idle prompts as IDLE", () => {
    const idleTails: string[][] = [
      ["[tool] completed successfully", "Type your next message..."],
      ["[DONE] 46 steps · 12m 25s", "╭──────╮", "│> Type your message... │", "╰──────╯"],
      ["◆ hud 5 turns ● done in 12.4s", "Ready for next instruction."],
    ];

    for (const tail of idleTails) {
      const state = classifyTerminalScreen(tail, "jeo-agent-terminal");
      expect(state).toBe("IDLE");
    }
  });

  it("rejects bare '>' prompt, non-jeo titles, and stale idle lines >6 lines above bottom", () => {
    expect(classifyTerminalScreen(["Task finished.", "> "], "jeo-agent-terminal")).toBe("UNKNOWN");
    expect(classifyTerminalScreen(["Type your next message..."], "zsh")).toBe("UNKNOWN");
    const staleTail = [
      "Type your next message...",
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
    ];
    expect(classifyTerminalScreen(staleTail, "jeo-agent-terminal")).toBe("UNKNOWN");
  });

  it("classifies plain zsh / shell prompts or non-jeo screens as UNKNOWN", () => {
    const unknownTails: Array<{ tail: string[]; title: string }> = [
      {
        tail: ["Last login: Sun Mar 1 12:00:00 on ttys001", "dev@workstation ~ % "],

        title: "zsh",
      },
      {
        tail: ["bash-5.2$ echo 'hello'"],
        title: "bash",
      },
      {
        tail: [],
        title: "terminal",
      },
    ];

    for (const { tail, title } of unknownTails) {
      const state = classifyTerminalScreen(tail, title);
      expect(state).toBe("UNKNOWN");
    }
  });

  it("prioritizes active turn markers over trailing idle prompts when both appear", () => {
    // If an agent is actively thinking or running a tool, even if previous turn text had "Type your next message"
    const mixedTail = [
      "Type your next message...",
      "Thinking ·",
    ];
    expect(classifyTerminalScreen(mixedTail, "jeo-agent")).toBe("BUSY");
  });
});

describe("RestDiscordClient", () => {
  it("retries HTTP 429 honoring JSON retry_after and succeeds on retry", async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(JSON.stringify({ retry_after: 0.01 }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "999", username: "jeo-bot" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new RestDiscordClient("test-token", fakeFetch);
    const user = await client.getSelfUser();
    expect(attempts).toBe(2);
    expect(user.id).toBe("999");
  });

  it("caches ensureDmChannel per userId and deduplicates concurrent calls", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ id: "dm_chan_42" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new RestDiscordClient("test-token", fakeFetch);
    const [a, b] = await Promise.all([
      client.ensureDmChannel("user_1"),
      client.ensureDmChannel("user_1"),
    ]);
    const c = await client.ensureDmChannel("user_1");
    expect(a).toBe("dm_chan_42");
    expect(b).toBe("dm_chan_42");
    expect(c).toBe("dm_chan_42");
    expect(calls).toBe(1);
  });
});

describe("CliOrcaClient.spawnWorker", () => {
  it("spawns jeo via terminal create + send, waits until IDLE, and dispatches prompt", async () => {
    const calls: string[][] = [];
    let readCount = 0;
    const fakeExec = async (cmd: string[]) => {
      calls.push(cmd);
      if (cmd[1] === "terminal" && cmd[2] === "create") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, result: { handle: "term_new_1" } }),
          stderr: "",
        };
      }
      if (cmd[1] === "terminal" && cmd[2] === "read") {
        readCount++;
        const tail = readCount < 2
          ? ["Booting jeo..."]
          : ["◆ hud 0 turns ● done", "Type your next message..."];
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            result: { terminal: { handle: "term_new_1", title: "jeo", tail } },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    };

    const client = new CliOrcaClient(fakeExec, "/usr/local/bin/orca", {
      bootTimeoutMs: 500,
      bootPollIntervalMs: 5,
    });
    const res = await client.spawnWorker("/tmp/repo", "task title", "fix the bug", "jeo");
    expect(res.ok).toBe(true);
    expect(res.handle).toBe("term_new_1");
    expect(calls.some(c => c.includes("create"))).toBe(true);
    expect(calls.some(c => c.includes("send") && c.includes("jeo"))).toBe(true);
    expect(calls.some(c => c.includes("send") && c.includes("fix the bug"))).toBe(true);
  });

  it("returns ok:false when spawned jeo terminal does not reach IDLE before timeout", async () => {
    const calls: string[][] = [];
    const fakeExec = async (cmd: string[]) => {
      calls.push(cmd);
      if (cmd[1] === "terminal" && cmd[2] === "create") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, result: { handle: "term_slow_1" } }),
          stderr: "",
        };
      }
      if (cmd[1] === "terminal" && cmd[2] === "read") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            result: { terminal: { handle: "term_slow_1", title: "jeo", tail: ["Starting jeo..."] } },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    };

    const client = new CliOrcaClient(fakeExec, "/usr/local/bin/orca", {
      bootTimeoutMs: 30,
      bootPollIntervalMs: 10,
    });
    const res = await client.spawnWorker("/tmp/repo", "task title", "fix the bug", "jeo");
    expect(res.ok).toBe(false);
    expect(res.handle).toBe("term_slow_1");
    // Prompt should NOT have been dispatched while jeo was still booting
    expect(calls.some(c => c.includes("send") && c.includes("fix the bug"))).toBe(false);
  });

  it("passes --worktree path:<absPath> and --title (never --worktree-path), parses nested terminal.handle and object error", async () => {
    const calls: string[][] = [];
    const fakeExec = async (cmd: string[]) => {
      calls.push(cmd);
      if (cmd[1] === "terminal" && cmd[2] === "create") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "term_nested_9" } } }),
          stderr: "",
        };
      }
      if (cmd[1] === "terminal" && cmd[2] === "read") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            result: { terminal: { handle: "term_nested_9", title: "jeo: test", tail: ["◆ hud 0 turns ● done", "Type your next message..."] } },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    };

    const client = new CliOrcaClient(fakeExec, "/usr/local/bin/orca", {
      bootTimeoutMs: 200,
      bootPollIntervalMs: 5,
    });
    const res = await client.spawnWorker("~/my-repo", "Fix login", "please fix", "jeo");
    expect(res.ok).toBe(true);
    expect(res.handle).toBe("term_nested_9");
    const createCall = calls.find(c => c[1] === "terminal" && c[2] === "create")!;
    expect(createCall).not.toContain("--worktree-path");
    expect(createCall).toContain("--worktree");
    expect(createCall[createCall.indexOf("--worktree") + 1]).toBe(`path:${path.join(os.homedir(), "my-repo")}`);
    expect(createCall).toContain("--title");
    expect(createCall[createCall.indexOf("--title") + 1]).toBe("jeo: Fix login");

    // Object-shaped error on non-zero exit AND ok:false in non-jeo worker-start
    const failExec = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: false, error: { code: "E_WORKTREE", message: "Worktree not registered" } }),
      stderr: "",
    });
    const failClient = new CliOrcaClient(failExec, "/usr/local/bin/orca");
    const jeoFail = await failClient.spawnWorker("/tmp/repo", "t", "p", "jeo");
    expect(jeoFail.ok).toBe(false);
    expect(jeoFail.error).toBe("Worktree not registered");
    const claudeFail = await failClient.spawnWorker("/tmp/repo", "t", "p", "claude");
    expect(claudeFail.ok).toBe(false);
    expect(claudeFail.error).toBe("Worktree not registered");
  });
});

describe("ANSI-safe classifier, extractWorkerActivity, tilde expansion, and Discord REST v10 endpoints", () => {
  it("strips ANSI escapes, lets bottom `◆ hud ... ● done` override stale scrollback busy lines, and extracts live phases", () => {
    const ansiBusy = [
      "\x1b[36m◱ planning\x1b[0m · inspecting router",
      "\x1b[1m◆ hud\x1b[0m · 2 steps · \x1b[33m● planning\x1b[0m",
    ];
    expect(classifyTerminalScreen(ansiBusy, "jeo: repo")).toBe("BUSY");
    const planInfo = extractWorkerActivity(ansiBusy);
    expect(planInfo?.phase).toBe("planning");
    expect(planInfo?.detail).toContain("planning");

    // Stale scrollback `Running bash` 8 lines above an explicit bottom `◆ hud ... ● done` footer is IDLE
    const completedScrollback = [
      "\x1b[2mRunning bash `bun test`\x1b[0m",
      "⠋ checking results",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "\x1b[32m◆ hud\x1b[0m · 4 steps · \x1b[32m● done\x1b[0m",
      "│> Type your next message... │",
    ];
    expect(classifyTerminalScreen(completedScrollback, "jeo: repo")).toBe("IDLE");

    expect(extractWorkerActivity(["Thinking · analyzing auth flow"])?.phase).toBe("thinking");
    expect(extractWorkerActivity(["Running edit src/app.ts"])?.phase).toBe("executing");
    expect(extractWorkerActivity(["◆ hud · ● reporting", "◳ reporting summary"])?.phase).toBe("reporting");
  });

  it("expands tilde (~) in store paths, resolveOrcaBin, and resolveDiscordToken", async () => {
    const home = os.homedir();
    expect(expandTilde("~/foo/bar")).toBe(path.join(home, "foo/bar"));
    expect(expandTilde("~")).toBe(home);
    expect(resolveOrchHome("~/.jeo/custom-orch")).toBe(path.join(home, ".jeo/custom-orch"));
    expect(resolveOrcaBin("~/bin/orca")).toBe(path.join(home, "bin/orca"));

    // Verify tokenFile with ~/... resolves relative to home via resolveDiscordToken
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "orch-tilde-tok-"));
    const relUnderHome = path.relative(home, path.join(tmpHome, "my-secret-token"));
    try {
      await fs.writeFile(path.join(tmpHome, "my-secret-token"), "tilde-token-xyz\n", "utf8");
      const tokenFileSpec = relUnderHome.startsWith("..") ? path.join(tmpHome, "my-secret-token") : `~/${relUnderHome}`;
      const cfg = createDefaultOrchConfig();
      cfg.tokenFile = tokenFileSpec;
      cfg.orcaBin = "~/custom/orca";
      cfg.routes = [{ id: "r1", name: "R1", enabled: true, parentChannelIds: ["p1"], titleKeywords: ["k"], repoPath: "~/proj/r1", maxIterations: 3, sameFailureLimit: 2, maxWorkers: 1, spawnIfBusy: false, verificationGates: [] }];
      await saveOrchConfig(cfg, tmpHome);

      const reloaded = await loadOrchConfig(tmpHome);
      expect(reloaded.orcaBin).toBe(path.join(home, "custom/orca"));
      expect(reloaded.routes[0]!.repoPath).toBe(path.join(home, "proj/r1"));

      const tok = await resolveDiscordToken(tmpHome, {});
      expect(tok).toBe("tilde-token-xyz");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("exercises RestDiscordClient postMessage(flags), editMessage(PATCH+clamp), addReaction(PUT), removeReaction(DELETE), triggerTyping(POST) over real HTTP", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const text = await req.text();
        let body: unknown;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        requests.push({ method: req.method, path: url.pathname, body });

        if (req.method === "POST" && url.pathname.endsWith("/messages")) {
          return Response.json({ id: "msg_live_1" });
        }
        if (req.method === "PATCH" && url.pathname.includes("/messages/")) {
          return Response.json({ id: "msg_live_1" });
        }
        if (req.method === "PUT" && url.pathname.includes("/reactions/")) {
          return new Response(null, { status: 204 });
        }
        if (req.method === "DELETE" && url.pathname.includes("/reactions/")) {
          return new Response(null, { status: 204 });
        }
        if (req.method === "POST" && url.pathname.endsWith("/typing")) {
          return new Response(null, { status: 204 });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}/api/v10`;
      const routedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const rewritten = raw.replace("https://discord.com/api/v10", baseUrl);
        return fetch(rewritten, init);
      }) as typeof fetch;

      const client = new RestDiscordClient("live-http-token", routedFetch);
      const ids = await client.postMessage("chan-1", "🧠 Thinking...", { flags: DISCORD_SILENT_FLAGS });
      expect(ids).toEqual(["msg_live_1"]);

      await client.editMessage("chan-1", "msg_live_1", "x".repeat(2500));
      await client.addReaction("chan-1", "msg_live_1", "🧠");
      await client.removeReaction("chan-1", "msg_live_1", "🧠");
      await client.triggerTyping("chan-1");

      const postReq = requests.find(r => r.method === "POST" && r.path.endsWith("/messages"))!;
      expect((postReq.body as { flags?: number }).flags).toBe(DISCORD_SILENT_FLAGS);

      const patchReq = requests.find(r => r.method === "PATCH")!;
      expect((patchReq.body as { content: string }).content.length).toBeLessThanOrEqual(1900);

      const putReq = requests.find(r => r.method === "PUT")!;
      expect(putReq.path).toContain(encodeURIComponent("🧠"));

      const delReq = requests.find(r => r.method === "DELETE")!;
      expect(delReq.path).toContain(encodeURIComponent("🧠"));

      expect(requests.some(r => r.method === "POST" && r.path.endsWith("/typing"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});