import { test, expect } from "bun:test";
import {
  diffSubagentTransitions,
  formatNotifyEvent,
  formatSubagentsList,
  parseSteerCommand,
  parseCancelCommand,
  shortSessionId,
  HELP_TEXT,
  TelegramDaemon,
  type NotifyEvent,
} from "../src/agent/notify/telegram-daemon";
import type { SubagentRecord } from "../src/agent/subagent-registry";
import type { TelegramApi } from "../src/agent/notify/telegram-api";

function rec(over: Partial<SubagentRecord>): SubagentRecord {
  return { id: "executor-1", role: "executor", task: "do a thing", status: "running", startedAt: 0, ...over };
}

// ── Pure helpers ────────────────────────────────────────────────────────────────

test("diffSubagentTransitions reports a new running record as 'started'", () => {
  const events = diffSubagentTransitions([], [rec({ status: "running" })]);
  expect(events).toEqual([{ kind: "started", record: rec({ status: "running" }) }]);
});

test("diffSubagentTransitions reports running→completed as an edge, not a level", () => {
  const before = rec({ status: "running" });
  const after = rec({ status: "completed", finishedAt: 5, success: true, result: "done" });
  const events = diffSubagentTransitions([before], [after]);
  expect(events).toEqual([{ kind: "completed", record: after }]);
});

test("diffSubagentTransitions does NOT re-report an unchanged running record", () => {
  const running = rec({ status: "running" });
  expect(diffSubagentTransitions([running], [running])).toEqual([]);
});

test("diffSubagentTransitions does NOT re-report an already-terminal record", () => {
  const done = rec({ status: "completed" });
  expect(diffSubagentTransitions([done], [done])).toEqual([]);
});

test("diffSubagentTransitions ignores a record that only appears already-finished (no start event synthesized)", () => {
  const done = rec({ status: "completed" });
  expect(diffSubagentTransitions([], [done])).toEqual([]);
});

test("formatNotifyEvent includes the icon, short session id, project name, role/id, and task on start", () => {
  const ev: NotifyEvent = { kind: "started", record: rec({ task: "refactor the parser" }) };
  const text = formatNotifyEvent("abcd1234", "/home/user/my-repo", ev);
  expect(text).toContain("▶");
  expect(text).toContain("[abcd1234]");
  expect(text).toContain("my-repo");
  expect(text).toContain("executor 'executor-1' started");
  expect(text).toContain("refactor the parser");
});

test("formatNotifyEvent includes a truncated result preview on completion", () => {
  const ev: NotifyEvent = { kind: "completed", record: rec({ status: "completed", result: "x".repeat(1000) }) };
  const text = formatNotifyEvent("abcd1234", "/tmp/proj", ev);
  expect(text).toContain("✅");
  expect(text.split("\n")[1]!.length).toBe(500);
});

test("formatSubagentsList reports 'No subagents running.' when every session is empty", () => {
  expect(formatSubagentsList([{ sessionId: "aaaa", cwd: "/tmp/a", records: [] }])).toBe("No subagents running.");
});

test("formatSubagentsList groups by session with status icons", () => {
  const text = formatSubagentsList([
    { sessionId: "aaaabbbb-0000", cwd: "/tmp/repo-a", records: [rec({ status: "running" })] },
    { sessionId: "ccccdddd-0000", cwd: "/tmp/repo-b", records: [] },
  ]);
  expect(text).toContain("aaaabbbb (repo-a)");
  expect(text).not.toContain("ccccdddd");
  expect(text).toContain("▶ executor 'executor-1'");
});

test("parseSteerCommand extracts shortId/subagentId/free-text message", () => {
  const parsed = parseSteerCommand("/steer abcd1234 executor-1 please hurry, focus on tests");
  expect(parsed).toEqual({ shortId: "abcd1234", subagentId: "executor-1", message: "please hurry, focus on tests" });
});

test("parseSteerCommand returns undefined for a malformed command", () => {
  expect(parseSteerCommand("/steer abcd1234")).toBeUndefined();
  expect(parseSteerCommand("not a command")).toBeUndefined();
});

test("parseCancelCommand extracts shortId/subagentId", () => {
  expect(parseCancelCommand("/cancel abcd1234 executor-1")).toEqual({ shortId: "abcd1234", subagentId: "executor-1" });
});

test("parseCancelCommand rejects trailing garbage (that would be a steer message, not a cancel)", () => {
  expect(parseCancelCommand("/cancel abcd1234 executor-1 extra")).toBeUndefined();
});

test("shortSessionId strips dashes and takes the first 8 chars", () => {
  expect(shortSessionId("abcd1234-5678-90ab-cdef-000000000000")).toBe("abcd1234");
});

// ── TelegramDaemon (fakes for network + ws) ──────────────────────────────────────

class FakeTelegramApi {
  sent: { chatId: string | number; text: string }[] = [];
  async sendMessage(chatId: string | number, text: string) {
    this.sent.push({ chatId, text });
    return { ok: true };
  }
  async getMe() {
    return { ok: true, result: { id: 1, is_bot: true, username: "bot" } };
  }
  async getUpdates() {
    return { ok: true, result: [] };
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: { data?: string }) => void>> = {};
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: { data?: string }) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    for (const cb of this.listeners.close ?? []) cb({});
  }
  emitMessage(data: string): void {
    for (const cb of this.listeners.message ?? []) cb({ data });
  }
}

function makeDaemon(telegram: FakeTelegramApi = new FakeTelegramApi()): TelegramDaemon {
  FakeWebSocket.instances = [];
  return new TelegramDaemon({
    chatId: "999",
    telegram: telegram as unknown as TelegramApi,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    ackTimeoutMs: 200,
  });
}

test("scanSessions connects to live sessions and deletes stale (dead-pid) discovery files", async () => {
  const unlinked: string[] = [];
  const daemon = new TelegramDaemon({
    chatId: "999",
    telegram: new FakeTelegramApi() as unknown as TelegramApi,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    readdir: async () => ["alive.json", "dead.json", "not-json.txt"],
    readFile: async (p: string) => {
      if (p.endsWith("alive.json")) return JSON.stringify({ url: "ws://127.0.0.1:9", token: "t", pid: 111, cwd: "/tmp/a" });
      return JSON.stringify({ url: "ws://127.0.0.1:9", token: "t", pid: 222, cwd: "/tmp/b" });
    },
    unlink: async (p: string) => {
      unlinked.push(p);
    },
    isPidAlive: (pid: number) => pid === 111,
  });
  await daemon.scanSessions();
  expect(daemon.sessions.size).toBe(1);
  expect(daemon.sessions.has("alive")).toBe(true);
  expect(unlinked.some(p => p.endsWith("dead.json"))).toBe(true);
});

test("handleSessionMessage sends a Telegram push on a status edge (not on every snapshot)", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const conn = { sessionId: "abcd1234-0000", cwd: "/tmp/proj", pid: 1, ws: new FakeWebSocket("x") as unknown as WebSocket, lastRecords: [] };
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));
  expect(telegram.sent.length).toBe(1);
  expect(telegram.sent[0]!.text).toContain("started");

  // Unchanged snapshot: no new push.
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));
  expect(telegram.sent.length).toBe(1);

  // Terminal transition: one more push.
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "completed", result: "done" })] }));
  expect(telegram.sent.length).toBe(2);
  expect(telegram.sent[1]!.text).toContain("completed");
});

test("handleInboundText: /help replies with the command reference", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  await daemon.handleInboundText("/help");
  expect(telegram.sent[0]!.text).toBe(HELP_TEXT);
});

test("handleInboundText: /subagents lists across every connected session", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const conn = { sessionId: "abcd1234-0000", cwd: "/tmp/proj", pid: 1, ws: new FakeWebSocket("x") as unknown as WebSocket, lastRecords: [rec({ status: "running" })] };
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleInboundText("/subagents");
  expect(telegram.sent[0]!.text).toContain("abcd1234");
});

test("handleInboundText: /steer to an unknown session id reports no match", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  await daemon.handleInboundText("/steer zzzzzzzz executor-1 hi");
  expect(telegram.sent[0]!.text).toContain("No connected session matches");
});

test("handleInboundText: /steer to a real session round-trips over the ws and reports success", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const fakeWs = new FakeWebSocket("ws://x");
  const sessionId = "abcd1234-0000-0000-0000-000000000000";
  daemon.sessions.set(sessionId, { sessionId, cwd: "/tmp/proj", pid: 1, ws: fakeWs as unknown as WebSocket, lastRecords: [] });

  const promise = daemon.handleInboundText("/steer abcd1234 executor-1 please hurry");
  const sentFrame = JSON.parse(fakeWs.sent.at(-1)!);
  expect(sentFrame.type).toBe("steer");
  expect(sentFrame.id).toBe("executor-1");
  expect(sentFrame.message).toBe("please hurry");

  const conn = daemon.sessions.get(sessionId)!;
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "ack", reqId: sentFrame.reqId, ok: true }));
  await promise;
  expect(telegram.sent.at(-1)!.text).toContain("Steered 'executor-1'");
});

test("handleInboundText: /steer times out (no ack) and reports failure", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const fakeWs = new FakeWebSocket("ws://x");
  const sessionId = "abcd1234-0000-0000-0000-000000000000";
  daemon.sessions.set(sessionId, { sessionId, cwd: "/tmp/proj", pid: 1, ws: fakeWs as unknown as WebSocket, lastRecords: [] });
  await daemon.handleInboundText("/steer abcd1234 executor-1 hello");
  expect(telegram.sent.at(-1)!.text).toContain("Steer failed");
});

test("handleInboundText: /cancel round-trips and reports success", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const fakeWs = new FakeWebSocket("ws://x");
  const sessionId = "abcd1234-0000-0000-0000-000000000000";
  daemon.sessions.set(sessionId, { sessionId, cwd: "/tmp/proj", pid: 1, ws: fakeWs as unknown as WebSocket, lastRecords: [] });

  const promise = daemon.handleInboundText("/cancel abcd1234 executor-1");
  const sentFrame = JSON.parse(fakeWs.sent.at(-1)!);
  expect(sentFrame.type).toBe("cancel");
  expect(sentFrame.ids).toEqual(["executor-1"]);
  const conn = daemon.sessions.get(sessionId)!;
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "ack", reqId: sentFrame.reqId, ok: true }));
  await promise;
  expect(telegram.sent.at(-1)!.text).toContain("Cancelled 'executor-1'");
});

test("handleInboundText: an unrecognized slash command gets the help text appended", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  await daemon.handleInboundText("/bogus");
  expect(telegram.sent[0]!.text).toContain("Unrecognized command");
});

test("handleInboundText: plain (non-slash) text is ignored", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  await daemon.handleInboundText("just chatting, not a command");
  expect(telegram.sent.length).toBe(0);
});

test("stop() closes every connected session's socket", () => {
  const daemon = makeDaemon();
  const fakeWs = new FakeWebSocket("ws://x");
  daemon.sessions.set("s1", { sessionId: "s1", cwd: "/tmp", pid: 1, ws: fakeWs as unknown as WebSocket, lastRecords: [] });
  daemon.stop();
  expect(fakeWs.closed).toBe(true);
  expect(daemon.sessions.size).toBe(0);
});
