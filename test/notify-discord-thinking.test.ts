import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DISCORD_MAX_MESSAGE_CHARS,
  DISCORD_SILENT_MESSAGE_FLAGS,
  DISCORD_THINKING_DEBOUNCE_MS,
  DISCORD_THINKING_MAX_EXCERPT_CHARS,
  extractThinkingExcerpt,
  formatCompactDmCompletionSummary,
  formatDiscordCompletionReport,
  formatDiscordThinkingMessage,
  redactDiscordSecrets,
  type ThinkingPhase,
  type UnifiedCompletionReportInput,
  type UnifiedCompletionStatus,
  type UnifiedTaskReportItem,
  type UnifiedTaskReportSource,
} from "../src/agent/notify/discord-thinking";
import { DiscordApi, DiscordApiError } from "../src/agent/notify/discord-api";
import { DiscordDaemon, type DiscordDaemonDependencies } from "../src/agent/notify/discord-daemon";
import { SessionNotifyEndpoint } from "../src/agent/notify/session-endpoint";
import { notifySessionEndpointPath } from "../src/agent/notify/paths";

// ---------------------------------------------------------------------------
// Test helpers (zero network calls; deterministic injected clock & fake API)
// ---------------------------------------------------------------------------

const CHANNEL = "111111111111111111";
const USER = "222222222222222222";
const BOT = "333333333333333333";
const TEST_BOT_TOKEN = "offline-test-bot-token-secret-xyz";
const DAEMON_CONFIG = {
  botToken: TEST_BOT_TOKEN,
  channelId: CHANNEL,
  allowedUserIds: [USER, BOT],
};

class FakeClock {
  now = 1_000;
  private nextId = 0;
  private jobs = new Map<number, { at: number; callback: () => void }>();

  set = (callback: () => void, ms: number): Timer => {
    const id = ++this.nextId;
    this.jobs.set(id, { at: this.now + ms, callback });
    return id as unknown as Timer;
  };

  clear = (timer: Timer): void => {
    this.jobs.delete(Number(timer));
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.jobs]
        .filter(([, job]) => job.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.jobs.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

function createFakeSockets() {
  const instances: FakeSocket[] = [];
  class FakeSocket {
    readyState = 1;
    sent: unknown[] = [];
    onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
      instances.push(this);
    }

    send(raw: string): void {
      this.sent.push(JSON.parse(raw));
    }

    close(code = 1000): void {
      this.readyState = 3;
      this.onclose?.({ code });
    }

    async receive(payload: unknown): Promise<void> {
      await this.onmessage?.({ data: JSON.stringify(payload) });
    }
  }
  return { instances, Impl: FakeSocket as unknown as typeof WebSocket };
}

interface SentCall {
  id: string;
  channel: string;
  content: string;
  flags?: number;
}

interface EditCall {
  channel: string;
  messageId: string;
  content: string;
}

class FakeDiscordService {
  sent: SentCall[] = [];
  edits: EditCall[] = [];
  stopped = false;
  sendHandler?: (call: { channel: string; content: string; flags?: number }) => Promise<{ id: string }[]>;
  editHandler?: (call: EditCall) => Promise<{ id: string }>;
  private nextMsgId = 1000;

  async getMe() {
    return { id: BOT, username: "test-bot", bot: true };
  }
  async getChannel(id: string) {
    return { id, type: 0 };
  }
  async getGatewayBot() {
    return {
      url: "wss://gateway.discord.gg",
      session_start_limit: { remaining: 10, reset_after: 60_000, total: 10, max_concurrency: 1 },
    };
  }
  async createThread(_channel: string, message: string, _name: string) {
    return { id: `9${message}` };
  }
  async addReaction(_channel: string, _message: string, _emoji: string) {}
  async removeReaction(_channel: string, _message: string, _emoji: string) {}
  async sendFile(_channel: string, _name: string, _data: Uint8Array) {
    return [{ id: String(++this.nextMsgId) }];
  }

  async sendMessage(
    channel: string,
    content: string,
    eligible?: () => boolean,
    flags?: number,
  ): Promise<{ id: string }[]> {
    if (eligible && !eligible()) {
      throw new DiscordApiError("Discord delivery no longer eligible");
    }
    if (this.sendHandler) {
      const result = await this.sendHandler({ channel, content, flags });
      for (const msg of result) {
        this.sent.push({ id: msg.id, channel, content, flags });
      }
      return result;
    }
    const id = String(++this.nextMsgId);
    this.sent.push({ id, channel, content, flags });
    return [{ id }];
  }

  async editMessage(
    channel: string,
    messageId: string,
    content: string,
    eligible?: () => boolean,
  ): Promise<{ id: string }> {
    if (eligible && !eligible()) {
      throw new DiscordApiError("Discord delivery no longer eligible");
    }
    if (this.editHandler) {
      const res = await this.editHandler({ channel, messageId, content });
      this.edits.push({ channel, messageId, content });
      return res;
    }
    this.edits.push({ channel, messageId, content });
    return { id: messageId };
  }

  stop(): void {
    this.stopped = true;
  }
}

function createDaemonFixture(sessionId = "sess-think", overrides: DiscordDaemonDependencies = {}) {
  const api = new FakeDiscordService();
  const gateway = createFakeSockets();
  const local = createFakeSockets();
  const clock = new FakeClock();
  const errors: string[] = [];
  const fatals: string[] = [];

  const daemon = new DiscordDaemon(DAEMON_CONFIG, {
    api,
    GatewayWebSocketImpl: gateway.Impl,
    WebSocketImpl: local.Impl,
    readdir: async () => [`${sessionId}.json`],
    readFile: async () =>
      JSON.stringify({ url: "ws://127.0.0.1:9001", token: "local-test-token", cwd: "/repo", pid: 4321 }),
    isPidAlive: () => true,
    now: () => clock.now,
    random: () => 0.5,
    setTimeout: clock.set,
    clearTimeout: clock.clear,
    scanIntervalMs: 1_000_000,
    ackTimeoutMs: 250,
    onError: msg => errors.push(msg),
    onFatal: msg => fatals.push(msg),
    ...overrides,
  });

  const ready = async () => {
    await daemon.start();
    await gateway.instances[0]!.receive({ op: 10, d: { heartbeat_interval: 10_000 } });
    await gateway.instances[0]!.receive({
      op: 0,
      t: "READY",
      s: 1,
      d: { session_id: "gw-1", resume_gateway_url: "wss://gateway.discord.gg" },
    });
    await local.instances[0]!.receive({
      type: "snapshot",
      sessionId,
      pid: 4321,
      subagents: [],
    });
  };

  const pushFrame = async (frame: Record<string, unknown>) => {
    await local.instances[0]!.receive({ sessionId, ...frame });
    await flushMicrotasks();
  };

  return { daemon, api, gateway, local, clock, errors, fatals, sessionId, ready, pushFrame };
}

// ---------------------------------------------------------------------------
// 1. redactDiscordSecrets
// ---------------------------------------------------------------------------

describe("redactDiscordSecrets", () => {
  const secretCases: Array<{ name: string; input: string; secret: string; expectedSubstring?: string }> = [
    {
      name: "OpenAI sk- key",
      input: "calling openai with sk-proj-AbCdEf1234567890xyz now",
      secret: "sk-proj-AbCdEf1234567890xyz",
      expectedSubstring: "calling openai with [REDACTED] now",
    },
    {
      name: "Anthropic sk-ant- key",
      input: "key=sk-ant-api03-AbCdEf1234567890_xyz",
      secret: "sk-ant-api03-AbCdEf1234567890_xyz",
      expectedSubstring: "[REDACTED]",
    },
    {
      name: "GitHub classic token (ghp_)",
      input: "token ghp_1234567890abcdefABCDEF1234567890",
      secret: "ghp_1234567890abcdefABCDEF1234567890",
      expectedSubstring: "token [REDACTED]",
    },
    {
      name: "GitHub fine-grained PAT (github_pat_)",
      input: "auth github_pat_11ABCDEF0123456789_abcdefghij",
      secret: "github_pat_11ABCDEF0123456789_abcdefghij",
      expectedSubstring: "auth [REDACTED]",
    },
    {
      name: "Slack bot token (xoxb-)",
      input: "slack xoxb-123456789012-abcdefABCDEF",
      secret: "xoxb-123456789012-abcdefABCDEF",
      expectedSubstring: "slack [REDACTED]",
    },
    {
      name: "Slack webhook URL",
      input: "notify https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX",
      secret: "XXXXXXXXXXXXXXXXXXXX",
      expectedSubstring: "notify [REDACTED]",
    },
    {
      name: "Discord webhook URL",
      input: "hook https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-123",
      secret: "AbCdEfGhIjKlMnOpQrStUvWxYz-123",
      expectedSubstring: "hook [REDACTED]",
    },
    {
      name: "Discord bot token",
      input: "bot MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0.AbCdEf.0123456789abcdef0123456789abcdef",
      secret: "0123456789abcdef0123456789abcdef",
      expectedSubstring: "bot [REDACTED]",
    },
    {
      name: "Bearer Authorization header",
      input: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig12345",
      secret: "eyJhbGciOiJIUzI1NiJ9",
      expectedSubstring: "Authorization: Bearer [REDACTED]",
    },
    {
      name: "Basic Authorization header",
      input: "Authorization: Basic dXNlcjpzdXBlcnNlY3JldA==",
      secret: "dXNlcjpzdXBlcnNlY3JldA==",
      expectedSubstring: "Authorization: Basic [REDACTED]",
    },
    {
      name: "AWS Access Key ID",
      input: "aws AKIAIOSFODNN7EXAMPLE in config",
      secret: "AKIAIOSFODNN7EXAMPLE",
      expectedSubstring: "aws [REDACTED] in config",
    },
    {
      name: "PEM private key block",
      input: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretdata\n-----END RSA PRIVATE KEY-----",
      secret: "MIIEowIBAAKCAQEAsecretdata",
      expectedSubstring: "[REDACTED]",
    },
    {
      name: "Env-style unquoted API_KEY",
      input: "OPENAI_API_KEY=plain_secret_value_99",
      secret: "plain_secret_value_99",
      expectedSubstring: "OPENAI_API_KEY=[REDACTED]",
    },
    {
      name: "Env-style quoted PASSWORD",
      input: 'DB_PASSWORD="p@ssw0rd!hidden"',
      secret: "p@ssw0rd!hidden",
      expectedSubstring: 'DB_PASSWORD="[REDACTED]"',
    },
    {
      name: "Env-style colon-separated ACCESS_TOKEN",
      input: "access_token: tok_live_sensitive_8877",
      secret: "tok_live_sensitive_8877",
      expectedSubstring: "access_token: [REDACTED]",
    },
    {
      name: "Env-style single-quoted WEBHOOK_URL",
      input: "WEBHOOK_URL='https://internal.example.com/hook/secret'",
      secret: "https://internal.example.com/hook/secret",
      expectedSubstring: "WEBHOOK_URL='[REDACTED]'",
    },
  ];

  for (const row of secretCases) {
    test(`redacts ${row.name}`, () => {
      const out = redactDiscordSecrets(row.input);
      expect(out).not.toContain(row.secret);
      if (row.expectedSubstring) {
        expect(out).toContain(row.expectedSubstring);
      }
    });
  }

  test("preserves normal Korean/English prose, code identifiers, and safe URLs", () => {
    const safeInputs = [
      "",
      "테스트 실행 중: src/agent/notify/discord-thinking.ts (line 42)",
      "Refactoring formatDiscordThinkingMessage & extractThinkingExcerpt for task-123.",
      "참고 PR: https://github.com/org/repo/pull/42 — sk-short 와 user_id 는 비밀이 아님",
      "const status = ['thinking', 'planning', 'executing'];",
    ];
    for (const input of safeInputs) {
      expect(redactDiscordSecrets(input)).toBe(input);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. extractThinkingExcerpt
// ---------------------------------------------------------------------------

describe("extractThinkingExcerpt", () => {
  test("returns empty string for empty, whitespace-only, ANSI-only, or non-positive maxChars", () => {
    expect(extractThinkingExcerpt("")).toBe("");
    expect(extractThinkingExcerpt("   \n\t\r\n  ")).toBe("");
    expect(extractThinkingExcerpt("\x1B[32m   \x1B[0m\n\x1B[1m\t\x1B[0m")).toBe("");
    expect(extractThinkingExcerpt("valid reasoning", 0)).toBe("");
    expect(extractThinkingExcerpt("valid reasoning", -5)).toBe("");
  });

  test("normalizes CRLF, strips ANSI escapes, collapses excess blank lines, and redacts secrets", () => {
    const raw =
      "  \x1B[36mStep 1:\x1B[0m checking API_KEY=super_secret_123   \r\n\r\n\r\n\r\nStep 2: using sk-ant-api03-AbCdEf1234567890  \rStep 3: 완료\t  ";
    const out = extractThinkingExcerpt(raw);
    expect(out).toBe("Step 1: checking API_KEY=[REDACTED]\n\nStep 2: using [REDACTED]\nStep 3: 완료");
    expect(out).not.toContain("\x1B");
    expect(out).not.toContain("super_secret_123");
    expect(out).not.toContain("sk-ant-");
  });

  test("applies tail-biased truncation to <= 600 chars with ellipsis prefix while keeping latest reasoning", () => {
    const oldPart = Array.from({ length: 40 }, (_, i) => `old-line-${i} analyzing legacy module`).join("\n");
    const tailMarker = "FINAL_REASONING_TAIL: patching discord-daemon.ts debounce timer";
    const full = `${oldPart}\n${tailMarker}`;
    expect(full.length).toBeGreaterThan(DISCORD_THINKING_MAX_EXCERPT_CHARS);

    const excerpt = extractThinkingExcerpt(full);
    expect(excerpt.length).toBeLessThanOrEqual(DISCORD_THINKING_MAX_EXCERPT_CHARS);
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt).toContain(tailMarker);
    expect(excerpt).not.toContain("old-line-0");
  });

  test("snaps cleanly to whitespace/newline when slicing mid-word and handles exact boundary + surrogate pairs", () => {
    const exact = "a".repeat(DISCORD_THINKING_MAX_EXCERPT_CHARS);
    expect(extractThinkingExcerpt(exact)).toBe(exact);
    expect(extractThinkingExcerpt("abcdef", 1)).toBe("…");

    // Mid-word cut within the leading lookahead window snaps to the next whitespace boundary.
    const spaced = `${"alpha ".repeat(20)}LONGPREFIX target-tail-sentence-value`;
    const snapped = extractThinkingExcerpt(spaced, 35);
    expect(snapped.length).toBeLessThanOrEqual(35);
    expect(snapped.startsWith("…")).toBe(true);
    expect(snapped).toBe("…target-tail-sentence-value");

    // Astral emoji at cut boundary must never produce an unpaired surrogate.
    const emojis = "🧠".repeat(400);
    const emojiExcerpt = extractThinkingExcerpt(emojis, 600);
    expect(emojiExcerpt.length).toBeLessThanOrEqual(600);
    expect(emojiExcerpt.startsWith("…")).toBe(true);
    expect(emojiExcerpt.isWellFormed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. formatDiscordThinkingMessage
// ---------------------------------------------------------------------------

describe("formatDiscordThinkingMessage", () => {
  const phaseCases: Array<[ThinkingPhase, string]> = [
    ["thinking", "🧠 Thinking"],
    ["planning", "🗺️ Planning"],
    ["executing", "⚙️ Executing"],
    ["verifying", "🔍 Verifying"],
    ["reporting", "📝 Reporting"],
    ["working", "⏳ Working"],
  ];

  for (const [phase, expectedBadge] of phaseCases) {
    test(`renders phase badge for ${phase}`, () => {
      const msg = formatDiscordThinkingMessage({
        title: "[sess-1]",
        phase,
        elapsedLabel: "12s",
      });
      expect(msg).toContain(`**${expectedBadge}**`);
      expect(msg).toContain("[sess-1]");
      expect(msg).toContain("⏱ 12s");
    });
  }

  test("renders workerLabel, activeSubagents, currentTool, and fenced reasoning with secret redaction & fence escaping", () => {
    const msg = formatDiscordThinkingMessage({
      title: "[sess-2]",
      workerLabel: "orch-worker-1",
      phase: "executing",
      elapsedLabel: "1m 5s",
      activeSubagents: 3,
      currentTool: "bash `echo sk-proj-AbCdEf1234567890`",
      reasoning: "Checking ```nested``` fence with token ghp_1234567890abcdefABCDEF1234567890",
    });

    expect(msg).toContain("[sess-2] (orch-worker-1)");
    expect(msg).toContain("⏱ 1m 5s");
    expect(msg).toContain("🤖 3");
    expect(msg).toContain("🔧 실행 중: `bash 'echo [REDACTED]'`");
    expect(msg).toContain("```text\n");
    expect(msg).toContain("``\u200b`nested``\u200b`");
    expect(msg).not.toContain("sk-proj-");
    expect(msg).not.toContain("ghp_1234567890abcdefABCDEF1234567890");
    expect(msg.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_CHARS);
  });

  test("omits activeSubagents when zero and suppresses currentTool when finalized", () => {
    const active = formatDiscordThinkingMessage({
      title: "[sess-3]",
      phase: "working",
      elapsedLabel: "4s",
      activeSubagents: 0,
      currentTool: "read",
    });
    expect(active).not.toContain("🤖");
    expect(active).toContain("🔧 실행 중: `read`");

    const finalizedDefault = formatDiscordThinkingMessage({
      title: "[sess-3]",
      phase: "executing",
      elapsedLabel: "9s",
      currentTool: "read",
      finalized: true,
    });
    expect(finalizedDefault).toContain("**✅ Thinking 완료**");
    expect(finalizedDefault).not.toContain("⚙️ Executing");
    expect(finalizedDefault).not.toContain("🔧 실행 중:");

    const finalizedCustom = formatDiscordThinkingMessage({
      title: "[sess-3]",
      phase: "reporting",
      elapsedLabel: "9s",
      currentTool: "bash",
      finalized: true,
      outcomeBadge: "❌ Thinking 실패",
    });
    expect(finalizedCustom).toContain("**❌ Thinking 실패**");
    expect(finalizedCustom).not.toContain("🔧 실행 중:");
  });

  test("enforces <= 2000 char Discord limit even with oversized inputs", () => {
    const msg = formatDiscordThinkingMessage({
      title: "T".repeat(500),
      workerLabel: "W".repeat(300),
      phase: "thinking",
      elapsedLabel: "99m 59s",
      activeSubagents: 8,
      currentTool: "tool-".repeat(200),
      reasoning: "상세 사고 과정 ".repeat(1_000),
    });
    expect(msg.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_CHARS);
    expect(msg.isWellFormed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. formatDiscordCompletionReport & formatCompactDmCompletionSummary
// ---------------------------------------------------------------------------

describe("formatDiscordCompletionReport & formatCompactDmCompletionSummary", () => {
  const ALL_SOURCES: UnifiedTaskReportSource[] = ["todo", "subagent", "gate", "queue", "approval", "job"];

  const statusCases: Array<[UnifiedCompletionStatus, string]> = [
    ["completed", "✅ 완료"],
    ["partial", "⚠️ 부분 완료"],
    ["failed", "❌ 실패"],
    ["escalated", "🚨 사람 확인 필요"],
    ["cancelled", "⏹ 중단"],
  ];

  for (const [status, badge] of statusCases) {
    test(`renders status badge for ${status} in full report and compact DM summary`, () => {
      const input: UnifiedCompletionReportInput = {
        title: "deploy-pipeline",
        status,
        elapsedLabel: "42s",
        completed: [{ label: "step-a", source: "todo" }],
        remaining: [],
      };
      expect(formatDiscordCompletionReport(input)).toContain(`**${badge}**`);
      expect(formatCompactDmCompletionSummary(input)).toContain(badge);
    });
  }

  test("renders completed and remaining items across all 6 sources with details and secret redaction", () => {
    const completed: UnifiedTaskReportItem[] = ALL_SOURCES.map(source => ({
      label: `done-${source}`,
      source,
      detail: `ok-${source} key=sk-ant-api03-AbCdEf1234567890`,
    }));
    const remaining: UnifiedTaskReportItem[] = ALL_SOURCES.map(source => ({
      label: `left-${source}`,
      source,
      detail: `pending-${source} Bearer secret_jwt_token_12345`,
    }));

    const report = formatDiscordCompletionReport({
      title: "orch-run AWS AKIAIOSFODNN7EXAMPLE",
      status: "partial",
      elapsedLabel: "2m 10s",
      summary: "요약: API_KEY=hidden_val_999 처리 완료",
      completed,
      remaining,
      changedFiles: ["src/agent/notify/discord-thinking.ts", "test/`quoted`.ts"],
    });

    // Completed source tags
    expect(report).toContain("✅ [Todo] done-todo");
    expect(report).toContain("🤖 [Subagent] done-subagent");
    expect(report).toContain("✔ [Gate] done-gate");
    expect(report).toContain("💬 [대기 큐] done-queue");
    expect(report).toContain("🛡️ [승인] done-approval");
    expect(report).toContain("⚙️ [백그라운드 작업] done-job");

    // Remaining source tags
    expect(report).toContain("⬜ [Todo] left-todo");
    expect(report).toContain("⚠️ [Subagent] left-subagent");
    expect(report).toContain("❌ [Gate] left-gate");
    expect(report).toContain("💬 [대기 큐] left-queue");
    expect(report).toContain("🛡️ [승인 대기] left-approval");
    expect(report).toContain("⏳ [백그라운드 작업] left-job");

    // Changed files & backtick escaping
    expect(report).toContain("📁 변경 파일 (2):");
    expect(report).toContain("`src/agent/notify/discord-thinking.ts`");
    expect(report).toContain("`test/'quoted'.ts`");

    // Secrets scrubbed across all fields
    expect(report).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(report).not.toContain("hidden_val_999");
    expect(report).not.toContain("sk-ant-api03-");
    expect(report).not.toContain("secret_jwt_token_12345");
    expect(report.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_CHARS);

    // Compact DM summary shows counts and top 2 remaining + overflow
    const dm = formatCompactDmCompletionSummary({
      title: "orch-run",
      status: "partial",
      elapsedLabel: "2m 10s",
      completed,
      remaining,
    });
    expect(dm).toContain("완료 6건 · 남은 작업 6건");
    expect(dm).toContain("남음: left-todo, left-subagent 외 4건");
    expect(dm.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_CHARS);
  });

  test("explicitly reports empty remaining and empty completed states", () => {
    const allDoneInput: UnifiedCompletionReportInput = {
      title: "clean-finish",
      status: "completed",
      elapsedLabel: "15s",
      summary: "모든 테스트 통과",
      completed: [{ label: "Unit tests", source: "gate" }],
      remaining: [],
    };

    const report = formatDiscordCompletionReport(allDoneInput);
    expect(report).toContain("**남은 작업**\n- 없음 (모든 작업 완료)");

    const dm = formatCompactDmCompletionSummary(allDoneInput);
    expect(dm).toContain("완료 1건 · 남은 작업 0건");
    expect(dm).toContain("모든 테스트 통과");
    expect(dm).not.toContain("남음:");

    const nothingDoneReport = formatDiscordCompletionReport({
      title: "early-abort",
      status: "cancelled",
      completed: [],
      remaining: [{ label: "Start build", source: "todo" }],
    });
    expect(nothingDoneReport).toContain("**완료된 작업**\n- (없음)");
    expect(nothingDoneReport).toContain("⬜ [Todo] Start build");
  });

  test("bounds long item/file lists and stays strictly within Discord 2000-char limit", () => {
    const manyCompleted: UnifiedTaskReportItem[] = Array.from({ length: 18 }, (_, i) => ({
      label: `completed-task-${i + 1}-${"x".repeat(120)}`,
      source: ALL_SOURCES[i % ALL_SOURCES.length]!,
      detail: `detail-${i + 1}-${"d".repeat(90)}`,
    }));
    const manyRemaining: UnifiedTaskReportItem[] = Array.from({ length: 15 }, (_, i) => ({
      label: `remaining-task-${i + 1}-${"y".repeat(120)}`,
      source: ALL_SOURCES[i % ALL_SOURCES.length]!,
      detail: `reason-${i + 1}-${"r".repeat(90)}`,
    }));
    const manyFiles = Array.from({ length: 14 }, (_, i) => `src/module-${i + 1}/component-${i + 1}.ts`);

    const report = formatDiscordCompletionReport({
      title: "massive-release",
      status: "partial",
      elapsedLabel: "18m 30s",
      summary: "긴 요약 내용 ".repeat(80),
      completed: manyCompleted,
      remaining: manyRemaining,
      changedFiles: manyFiles,
    });

    expect(report.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_CHARS);
    expect(report.endsWith("…")).toBe(true);
    expect(report.isWellFormed()).toBe(true);

    // Moderate length items verify both overflow counters and file overflow without hitting 2000-char clip
    const moderateReport = formatDiscordCompletionReport({
      title: "bounded-lists",
      status: "partial",
      completed: Array.from({ length: 15 }, (_, i) => ({ label: `c${i + 1}`, source: "todo" })),
      remaining: Array.from({ length: 14 }, (_, i) => ({ label: `r${i + 1}`, source: "gate" })),
      changedFiles: Array.from({ length: 11 }, (_, i) => `file-${i + 1}.ts`),
    });
    expect(moderateReport).toContain("- … 외 3건");
    expect(moderateReport).toContain("- … 외 2건");
    expect(moderateReport).toContain("📁 변경 파일 (11):");
    expect(moderateReport).toContain("외 3개");
    expect(moderateReport).not.toContain("file-9.ts");
    expect(moderateReport.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_CHARS);
  });
});

// ---------------------------------------------------------------------------
// 5. DiscordApi silent flags & editMessage PATCH contract (mock fetch)
// ---------------------------------------------------------------------------

describe("DiscordApi thinking PATCH & silent message flags", () => {
  test("sendMessage forwards DISCORD_SILENT_MESSAGE_FLAGS and editMessage sends PATCH with 2000-char clipping", async () => {
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const api = new DiscordApi("offline-token", {
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ method: init?.method ?? "GET", path: url.pathname, body });
        return new Response(JSON.stringify({ id: "555555" }), { status: 200 });
      }) as typeof fetch,
    });

    try {
      const sent = await api.sendMessage(CHANNEL, "thinking...", undefined, DISCORD_SILENT_MESSAGE_FLAGS);
      expect(sent).toEqual([{ id: "555555" }]);
      expect(requests[0]).toEqual({
        method: "POST",
        path: `/api/v10/channels/${CHANNEL}/messages`,
        body: {
          content: "thinking...",
          allowed_mentions: { parse: [], replied_user: false },
          flags: 1 << 12,
        },
      });

      const oversized = `${"a".repeat(1999)}🧠tail`;
      const edited = await api.editMessage(CHANNEL, "555555", oversized);
      expect(edited).toEqual({ id: "555555" });
      expect(requests[1]?.method).toBe("PATCH");
      expect(requests[1]?.path).toBe(`/api/v10/channels/${CHANNEL}/messages/555555`);
      const editedContent = String(requests[1]?.body.content ?? "");
      expect(editedContent.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_CHARS);
      expect(editedContent.isWellFormed()).toBe(true);
      expect(requests[1]?.body.allowed_mentions).toEqual({ parse: [], replied_user: false });
    } finally {
      api.stop();
    }
  });

  test("editMessage surfaces HTTP 404 (Discord 10008 Unknown Message) as DiscordApiError with status 404", async () => {
    const api = new DiscordApi("offline-token", {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: 10008, message: "Unknown Message" }), { status: 404 })) as typeof fetch,
    });

    try {
      let caught: unknown;
      try {
        await api.editMessage(CHANNEL, "555555", "updated");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DiscordApiError);
      expect((caught as DiscordApiError).status).toBe(404);
    } finally {
      api.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. DiscordDaemon live thinking PATCH lifecycle & completion_report
// ---------------------------------------------------------------------------

describe("DiscordDaemon live thinking PATCH lifecycle", () => {
  test("creates one silent status message, debounces rapid updates within 1800ms, and edits in place", async () => {
    const f = createDaemonFixture();
    try {
      await f.ready();

      // First thinking_update creates one silent message immediately
      await f.pushFrame({
        type: "thinking_update",
        phase: "thinking",
        reasoning: `Inspecting logs with ${TEST_BOT_TOKEN} and sk-ant-api03-AbCdEf1234567890`,
        currentTool: "read",
        activeSubagents: 2,
        elapsedMs: 1_000,
        turnId: "turn-1",
      });

      expect(f.api.sent).toHaveLength(1);
      expect(f.api.edits).toHaveLength(0);
      expect(f.api.sent[0]!.flags).toBe(DISCORD_SILENT_MESSAGE_FLAGS);
      expect(f.api.sent[0]!.content).toContain("🧠 Thinking");
      expect(f.api.sent[0]!.content).toContain("🤖 2");
      expect(f.api.sent[0]!.content).toContain("🔧 실행 중: `read`");
      expect(f.api.sent[0]!.content).not.toContain(TEST_BOT_TOKEN);
      expect(f.api.sent[0]!.content).not.toContain("sk-ant-api03-");
      const thinkingMsgId = f.api.sent[0]!.id;

      // Rapid updates within 1800ms are coalesced — zero edits before debounce expires
      f.clock.advance(400);
      await f.pushFrame({
        type: "thinking_update",
        phase: "planning",
        reasoning: "Intermediate plan step",
        elapsedMs: 1_400,
        turnId: "turn-1",
      });
      f.clock.advance(600);
      await f.pushFrame({
        type: "thinking_update",
        phase: "executing",
        reasoning: "Latest execution reasoning",
        currentTool: "edit",
        elapsedMs: 2_000,
        turnId: "turn-1",
      });

      expect(f.api.sent).toHaveLength(1);
      expect(f.api.edits).toHaveLength(0);

      // 1ms before 1800ms boundary -> still debounced
      f.clock.advance(DISCORD_THINKING_DEBOUNCE_MS - 1_000 - 1);
      await flushMicrotasks();
      expect(f.api.edits).toHaveLength(0);

      // Crossing exact 1800ms boundary -> flushes ONE PATCH with the latest coalesced state
      f.clock.advance(1);
      await flushMicrotasks();
      expect(f.api.sent).toHaveLength(1);
      expect(f.api.edits).toHaveLength(1);
      expect(f.api.edits[0]!.messageId).toBe(thinkingMsgId);
      expect(f.api.edits[0]!.content).toContain("⚙️ Executing");
      expect(f.api.edits[0]!.content).toContain("Latest execution reasoning");
      expect(f.api.edits[0]!.content).not.toContain("Intermediate plan step");

      // Duplicate content after >= 1800ms does not trigger redundant PATCH
      f.clock.advance(DISCORD_THINKING_DEBOUNCE_MS);
      await f.pushFrame({
        type: "thinking_update",
        phase: "executing",
        reasoning: "Latest execution reasoning",
        currentTool: "edit",
        elapsedMs: 2_000,
        turnId: "turn-1",
      });
      expect(f.api.edits).toHaveLength(1);

      // Changed content after >= 1800ms edits in place immediately
      await f.pushFrame({
        type: "thinking_update",
        phase: "verifying",
        reasoning: "Running targeted unit tests",
        currentTool: "bash",
        elapsedMs: 5_000,
        turnId: "turn-1",
      });
      expect(f.api.sent).toHaveLength(1);
      expect(f.api.edits).toHaveLength(2);
      expect(f.api.edits[1]!.messageId).toBe(thinkingMsgId);
      expect(f.api.edits[1]!.content).toContain("🔍 Verifying");
    } finally {
      f.daemon.stop();
    }
  });

  test("serializes updates arriving while initial silent POST is still in flight", async () => {
    const f = createDaemonFixture();
    const firstSend = Promise.withResolvers<{ id: string }[]>();
    f.api.sendHandler = async () => firstSend.promise;

    try {
      await f.ready();

      await f.pushFrame({
        type: "thinking_update",
        phase: "thinking",
        reasoning: "first",
        elapsedMs: 0,
        turnId: "turn-inflight",
      });
      // Second update arrives before first POST resolves
      f.clock.advance(300);
      await f.pushFrame({
        type: "thinking_update",
        phase: "executing",
        reasoning: "second-while-inflight",
        elapsedMs: 300,
        turnId: "turn-inflight",
      });

      // Only one POST in flight, no premature edits or duplicate posts
      expect(f.api.sent).toHaveLength(0);
      expect(f.api.edits).toHaveLength(0);

      firstSend.resolve([{ id: "7001" }]);
      await flushMicrotasks();
      expect(f.api.sent).toHaveLength(1);
      expect(f.api.sent[0]!.id).toBe("7001");
      expect(f.api.edits).toHaveLength(0);

      // Once remaining debounce window elapses (1800 - 300 = 1500ms), queued update patches message 7001
      f.clock.advance(1_500);
      await flushMicrotasks();
      expect(f.api.edits).toHaveLength(1);
      expect(f.api.edits[0]!.messageId).toBe("7001");
      expect(f.api.edits[0]!.content).toContain("second-while-inflight");
    } finally {
      f.daemon.stop();
    }
  });

  test("reposts cleanly on 404 (Unknown Message 10008) and edits the replacement message afterward", async () => {
    const f = createDaemonFixture();
    let failNextEditWith404 = true;
    f.api.editHandler = async ({ messageId }) => {
      if (failNextEditWith404) {
        failNextEditWith404 = false;
        throw new DiscordApiError("Discord HTTP 404 (10008 Unknown Message)", 404);
      }
      return { id: messageId };
    };

    try {
      await f.ready();

      await f.pushFrame({
        type: "thinking_update",
        phase: "thinking",
        reasoning: "initial status",
        elapsedMs: 1_000,
        turnId: "turn-404",
      });
      expect(f.api.sent).toHaveLength(1);
      const deletedMsgId = f.api.sent[0]!.id;

      // Advance past debounce; PATCH fails with 404 -> daemon reposts a new silent status message
      f.clock.advance(DISCORD_THINKING_DEBOUNCE_MS);
      await f.pushFrame({
        type: "thinking_update",
        phase: "executing",
        reasoning: "recovered after deletion",
        elapsedMs: 3_000,
        turnId: "turn-404",
      });

      expect(f.errors).toEqual([]);
      expect(f.api.sent).toHaveLength(2);
      const replacementMsgId = f.api.sent[1]!.id;
      expect(replacementMsgId).not.toBe(deletedMsgId);
      expect(f.api.sent[1]!.flags).toBe(DISCORD_SILENT_MESSAGE_FLAGS);
      expect(f.api.sent[1]!.content).toContain("recovered after deletion");

      // Subsequent update edits the replacement message ID in place
      f.clock.advance(DISCORD_THINKING_DEBOUNCE_MS);
      await f.pushFrame({
        type: "thinking_update",
        phase: "verifying",
        reasoning: "editing replacement cleanly",
        elapsedMs: 5_000,
        turnId: "turn-404",
      });

      expect(f.api.sent).toHaveLength(2);
      expect(f.api.edits).toHaveLength(1);
      expect(f.api.edits[0]!.messageId).toBe(replacementMsgId);
      expect(f.api.edits[0]!.content).toContain("editing replacement cleanly");
    } finally {
      f.daemon.stop();
    }
  });

  test("ignores stale 404 edit rejection from a previous generation after completion_report", async () => {
    const f = createDaemonFixture();
    const staleEdit = Promise.withResolvers<{ id: string }>();
    let editCount = 0;
    f.api.editHandler = async ({ messageId }) => {
      editCount++;
      if (editCount === 1) return staleEdit.promise;
      return { id: messageId };
    };

    try {
      await f.ready();

      await f.pushFrame({
        type: "thinking_update",
        phase: "thinking",
        reasoning: "step 1",
        elapsedMs: 1_000,
        turnId: "turn-gen",
      });
      f.clock.advance(DISCORD_THINKING_DEBOUNCE_MS);
      await f.pushFrame({
        type: "thinking_update",
        phase: "executing",
        reasoning: "step 2 in-flight",
        elapsedMs: 3_000,
        turnId: "turn-gen",
      });

      // completion_report arrives before the earlier PATCH settles
      await f.pushFrame({
        type: "completion_report",
        status: "completed",
        elapsedMs: 4_000,
        completed: [{ label: "Done", source: "todo" }],
        remaining: [],
      });
      const sendsAfterReport = f.api.sent.length;

      // Now the stale PATCH rejects with 404 -> must NOT repost an orphan thinking message
      staleEdit.reject(new DiscordApiError("Discord HTTP 404", 404));
      await flushMicrotasks();

      expect(f.api.sent).toHaveLength(sendsAfterReport);
    } finally {
      f.daemon.stop();
    }
  });

  test("finalizes thinking message, cancels pending debounce timer, and posts unified completion_report", async () => {
    const f = createDaemonFixture();
    try {
      await f.ready();

      await f.pushFrame({
        type: "thinking_update",
        phase: "executing",
        reasoning: "Working on task",
        currentTool: "bash",
        elapsedMs: 2_000,
        turnId: "turn-done",
      });
      const thinkingMsgId = f.api.sent[0]!.id;

      // Queue a debounced update that should be cancelled by completion_report
      f.clock.advance(500);
      await f.pushFrame({
        type: "thinking_update",
        phase: "verifying",
        reasoning: "Should be superseded by completion",
        currentTool: "bash",
        elapsedMs: 2_500,
        turnId: "turn-done",
      });

      await f.pushFrame({
        type: "completion_report",
        status: "completed",
        summary: "모든 작업이 정상 완료되었습니다.",
        elapsedMs: 65_000,
        completed: [
          { label: "구현 완료", source: "todo", detail: "discord-thinking.ts" },
          { label: "검증 통과", source: "gate" },
          // Malformed entry should be safely dropped
          { label: 123, source: "todo" },
          { label: "bad source", source: "unknown_source" },
        ],
        remaining: [],
        changedFiles: ["src/agent/notify/discord-thinking.ts"],
      });

      // Thinking message finalized in place without currentTool
      expect(f.api.edits).toHaveLength(1);
      expect(f.api.edits[0]!.messageId).toBe(thinkingMsgId);
      expect(f.api.edits[0]!.content).toContain("**✅ Thinking 완료**");
      expect(f.api.edits[0]!.content).toContain("⏱ 1m 5s");
      expect(f.api.edits[0]!.content).not.toContain("🔧 실행 중:");

      // Unified completion report posted as a normal (non-silent) message
      expect(f.api.sent).toHaveLength(2);
      expect(f.api.sent[1]!.flags).toBeUndefined();
      expect(f.api.sent[1]!.content).toContain("**✅ 완료**");
      expect(f.api.sent[1]!.content).toContain("✅ [Todo] 구현 완료 — discord-thinking.ts");
      expect(f.api.sent[1]!.content).toContain("✔ [Gate] 검증 통과");
      expect(f.api.sent[1]!.content).not.toContain("bad source");
      expect(f.api.sent[1]!.content).toContain("**남은 작업**\n- 없음 (모든 작업 완료)");
      expect(f.api.sent[1]!.content).toContain("📁 변경 파일 (1):");

      // Advancing clock past old debounce window must NOT emit a stale PATCH
      f.clock.advance(DISCORD_THINKING_DEBOUNCE_MS * 2);
      await flushMicrotasks();
      expect(f.api.edits).toHaveLength(1);

      // Next turn creates a fresh silent thinking message
      await f.pushFrame({
        type: "thinking_update",
        phase: "thinking",
        reasoning: "Next turn reasoning",
        elapsedMs: 0,
        turnId: "turn-next",
      });
      expect(f.api.sent).toHaveLength(3);
      expect(f.api.sent[2]!.flags).toBe(DISCORD_SILENT_MESSAGE_FLAGS);
      expect(f.api.sent[2]!.id).not.toBe(thinkingMsgId);
    } finally {
      f.daemon.stop();
    }
  });

  test("maps non-completed statuses to finalized outcome badges, handles report without prior thinking, and ignores invalid frames", async () => {
    const f = createDaemonFixture();
    try {
      await f.ready();

      // Invalid frames are ignored safely
      await f.pushFrame({ type: "thinking_update", phase: "bogus_phase" });
      await f.pushFrame({ type: "completion_report", status: "bogus_status", completed: [], remaining: [] });
      expect(f.api.sent).toHaveLength(0);
      expect(f.api.edits).toHaveLength(0);

      // Completion report with no active thinking message posts report without calling editMessage
      await f.pushFrame({
        type: "completion_report",
        status: "partial",
        completed: [{ label: "Step 1", source: "todo" }],
        remaining: [{ label: "Approve deploy", source: "approval" }],
      });
      expect(f.api.edits).toHaveLength(0);
      expect(f.api.sent).toHaveLength(1);
      expect(f.api.sent[0]!.content).toContain("**⚠️ 부분 완료**");
      expect(f.api.sent[0]!.content).toContain("🛡️ [승인 대기] Approve deploy");

      // Failed status finalizes thinking message with failure badge
      await f.pushFrame({ type: "thinking_update", phase: "executing", reasoning: "running", turnId: "t-fail" });
      await f.pushFrame({ type: "completion_report", status: "failed", completed: [], remaining: [{ label: "Fix error", source: "gate" }] });
      expect(f.api.edits.at(-1)!.content).toContain("**❌ Thinking 실패**");

      // Cancelled status finalizes thinking message with cancelled badge
      await f.pushFrame({ type: "thinking_update", phase: "executing", reasoning: "running", turnId: "t-cancel" });
      await f.pushFrame({ type: "completion_report", status: "cancelled", completed: [], remaining: [] });
      expect(f.api.edits.at(-1)!.content).toContain("**⏹ Thinking 중단**");

      // New turnId mid-stream starts a new thinking message instead of overwriting the old one
      await f.pushFrame({ type: "thinking_update", phase: "thinking", reasoning: "turn A", turnId: "turn-A" });
      const turnAMsgId = f.api.sent.at(-1)!.id;
      await f.pushFrame({ type: "thinking_update", phase: "thinking", reasoning: "turn B", turnId: "turn-B" });
      const turnBMsgId = f.api.sent.at(-1)!.id;
      expect(turnBMsgId).not.toBe(turnAMsgId);
    } finally {
      f.daemon.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. SessionNotifyEndpoint thinking_update & completion_report framing
// ---------------------------------------------------------------------------

describe("SessionNotifyEndpoint telemetry broadcast", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;
  let endpoint: SessionNotifyEndpoint | undefined;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    prevConfigDir = process.env.JEO_CONFIG_DIR;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-thinking-"));
    process.env.JEO_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    for (const ws of openSockets) {
      try {
        ws.close();
      } catch {}
    }
    openSockets.length = 0;
    if (endpoint) {
      await endpoint.stop();
      endpoint = undefined;
    }
    if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevConfigDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("broadcasts thinking_update and completion_report frames with sessionId and is safe when idle", async () => {
    const sessionId = "think-wire-1";
    endpoint = new SessionNotifyEndpoint("/tmp/proj", sessionId);
    await endpoint.start();

    // Safe no-op with zero connected sockets
    endpoint.sendThinkingUpdate({ phase: "thinking", reasoning: "nobody listening" });
    endpoint.sendCompletionReport({ status: "completed", completed: [], remaining: [] });

    const discovery = JSON.parse(await fs.readFile(notifySessionEndpointPath(sessionId), "utf8")) as {
      url: string;
      token: string;
    };
    const ws = new WebSocket(`${discovery.url}/?token=${encodeURIComponent(discovery.token)}`);
    openSockets.push(ws);

    const received: Record<string, unknown>[] = [];
    const gotCompletion = Promise.withResolvers<void>();
    const gotSnapshot = Promise.withResolvers<void>();
    ws.addEventListener("message", ev => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      received.push(frame);
      if (frame.type === "snapshot") gotSnapshot.resolve();
      if (frame.type === "completion_report") gotCompletion.resolve();
    });

    await gotSnapshot.promise;

    endpoint.sendThinkingUpdate({
      phase: "verifying",
      reasoning: "Checking invariants",
      currentTool: "bash",
      activeSubagents: 1,
      elapsedMs: 3_200,
      turnId: "wire-turn-1",
    });
    endpoint.sendCompletionReport({
      status: "completed",
      summary: "All green",
      elapsedMs: 5_000,
      completed: [{ label: "Tests", source: "gate" }],
      remaining: [],
      changedFiles: ["test/notify-discord-thinking.test.ts"],
      turnId: "wire-turn-1",
    });

    await gotCompletion.promise;

    const thinkingFrame = received.find(f => f.type === "thinking_update");
    const completionFrame = received.find(f => f.type === "completion_report");

    expect(thinkingFrame).toEqual({
      type: "thinking_update",
      sessionId,
      phase: "verifying",
      reasoning: "Checking invariants",
      currentTool: "bash",
      activeSubagents: 1,
      elapsedMs: 3_200,
      turnId: "wire-turn-1",
    });
    expect(completionFrame).toEqual({
      type: "completion_report",
      sessionId,
      status: "completed",
      summary: "All green",
      elapsedMs: 5_000,
      completed: [{ label: "Tests", source: "gate" }],
      remaining: [],
      changedFiles: ["test/notify-discord-thinking.test.ts"],
      turnId: "wire-turn-1",
    });
  });
});
