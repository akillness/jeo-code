import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { notifyTopicsPath } from "../src/agent/notify/paths";
import {
  diffSubagentTransitions,
  formatNotifyEvent,
  formatSubagentsList,
  parseSteerCommand,
  parseCancelCommand,
  shortSessionId,
  cancelCallbackData,
  parseCallbackData,
  buildSubagentsKeyboard,
  HELP_TEXT,
  TelegramDaemon,
  type TelegramDaemonOptions,
  type NotifyEvent,
} from "../src/agent/notify/telegram-daemon";
import type { SubagentRecord } from "../src/agent/subagent-registry";
import type { TelegramApi, TelegramGetUpdatesResult } from "../src/agent/notify/telegram-api";

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
  sent: { chatId: string | number; text: string; options?: any }[] = [];
  photos: { chatId: string | number; photo: string; options?: any }[] = [];
  answered: { id: string; options?: any }[] = [];
  topicsCreated: { chatId: string | number; name: string }[] = [];
  topicsEdited: { chatId: string | number; messageThreadId: number; name: string }[] = [];
  filesFetched: string[] = [];
  filesDownloaded: string[] = [];
  chatsChecked: (string | number)[] = [];
  reactions: { chatId: string | number; messageId: number; emoji: string }[] = [];
  private nextTopicId = 1000;
  /** Overridable per-test to simulate a failed topic creation (Threaded Mode off). */
  createForumTopicImpl: (chatId: string | number, name: string) => Promise<{ ok: boolean; result?: { message_thread_id: number } }> =
    async () => ({ ok: true, result: { message_thread_id: this.nextTopicId++ } });
  async sendMessage(chatId: string | number, text: string, options?: any) {
    this.sent.push({ chatId, text, options });
    return { ok: true };
  }
  async sendPhoto(chatId: string | number, photo: string, options?: any) {
    this.photos.push({ chatId, photo, options });
    return { ok: true };
  }
  async answerCallbackQuery(id: string, options?: any) {
    this.answered.push({ id, options });
    return { ok: true };
  }
  async getMe() {
    return { ok: true, result: { id: 1, is_bot: true, username: "bot" } };
  }
  async getUpdates(): Promise<TelegramGetUpdatesResult> {
    return { ok: true, result: [] };
  }
  async createForumTopic(chatId: string | number, name: string): Promise<{ ok: boolean; result?: { message_thread_id: number } }> {
    this.topicsCreated.push({ chatId, name });
    return this.createForumTopicImpl(chatId, name);
  }
  /** Overridable per-test to simulate a transient rename failure (e.g. a rate-limited editForumTopic call). */
  editForumTopicImpl: (chatId: string | number, messageThreadId: number, name: string) => Promise<{ ok: boolean }> =
    async () => ({ ok: true });
  async editForumTopic(chatId: string | number, messageThreadId: number, name: string): Promise<{ ok: boolean }> {
    this.topicsEdited.push({ chatId, messageThreadId, name });
    return this.editForumTopicImpl(chatId, messageThreadId, name);
  }
  async getFile(fileId: string): Promise<{ ok: boolean; result?: { file_path?: string } }> {
    this.filesFetched.push(fileId);
    return { ok: true, result: { file_path: `photos/${fileId}.jpg` } };
  }
  /** Overridable per-test to simulate an oversized/rejected download (mirrors
   *  `TelegramApi.downloadFile` returning `undefined` when the response exceeds
   *  its byte cap) without needing real network bytes here. */
  downloadFileImpl: (filePath: string, maxBytes?: number) => Promise<Uint8Array | undefined> =
    async () => new Uint8Array([1, 2, 3]);
  async downloadFile(filePath: string, maxBytes?: number): Promise<Uint8Array | undefined> {
    this.filesDownloaded.push(filePath);
    return this.downloadFileImpl(filePath, maxBytes);
  }
  /** Overridable per-test to simulate a paired chat that is NOT private (e.g. a group). */
  getChatImpl: (chatId: string | number) => Promise<{ ok: boolean; result?: { type?: string } }> =
    async () => ({ ok: true, result: { type: "private" } });
  async getChat(chatId: string | number): Promise<{ ok: boolean; result?: { type?: string } }> {
    this.chatsChecked.push(chatId);
    return this.getChatImpl(chatId);
  }
  async setMessageReaction(chatId: string | number, messageId: number, emoji: string): Promise<{ ok: boolean }> {
    this.reactions.push({ chatId, messageId, emoji });
    return { ok: true };
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onSend?: (data: string) => void;
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
    this.onSend?.(data);
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

async function authenticate(daemon: TelegramDaemon, conn: Parameters<TelegramDaemon["handleSessionMessage"]>[0]): Promise<void> {
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [] }));
}

async function updateWithAck(daemon: TelegramDaemon, update: Parameters<TelegramDaemon["handleUpdate"]>[0]): Promise<void> {
  for (const conn of daemon.sessions.values()) {
    const socket = conn.ws as unknown as FakeWebSocket;
    socket.onSend = raw => {
      const frame = JSON.parse(raw);
      if (frame.type === "user_message") void daemon.handleSessionMessage(conn, JSON.stringify({ type: "ack", reqId: frame.reqId, ok: true }));
    };
  }
  await daemon.handleUpdate(update);
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));
  expect(telegram.sent.length).toBe(1);
  expect(telegram.sent[0]!.text).toContain("started");

  // Unchanged snapshot: no new push.
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));
  expect(telegram.sent.length).toBe(1);

  // Terminal transition: one more push.
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "completed", result: "done" })] }));
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
  await authenticate(daemon, daemon.sessions.get(sessionId)!);

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
  await authenticate(daemon, daemon.sessions.get(sessionId)!);
  await daemon.handleInboundText("/steer abcd1234 executor-1 hello");
  expect(telegram.sent.at(-1)!.text).toContain("Steer failed");
});

test("handleInboundText: /cancel round-trips and reports success", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const fakeWs = new FakeWebSocket("ws://x");
  const sessionId = "abcd1234-0000-0000-0000-000000000000";
  daemon.sessions.set(sessionId, { sessionId, cwd: "/tmp/proj", pid: 1, ws: fakeWs as unknown as WebSocket, lastRecords: [] });
  await authenticate(daemon, daemon.sessions.get(sessionId)!);

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

// ── handleUpdate (chat authorization trust boundary) ────────────────────────────

function update(chatId: number, text?: string) {
  return { update_id: 1, message: text === undefined ? undefined : { message_id: 1, date: 0, from: { id: chatId, is_bot: false }, chat: { id: chatId, type: "private" }, text } };
}

test("handleUpdate dispatches a command from the paired chat", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram); // paired chatId: "999"
  await daemon.handleUpdate(update(999, "/help"));
  expect(telegram.sent[0]!.text).toBe(HELP_TEXT);
});

test("handleUpdate silently drops a command from any OTHER chat (no reply — replying would leak that the bot is live)", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  await daemon.handleUpdate(update(31337, "/help"));
  await daemon.handleUpdate(update(31337, "/cancel abcd1234 executor-1"));
  expect(telegram.sent.length).toBe(0);
});

test("handleUpdate ignores updates without message text", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  await daemon.handleUpdate(update(999));
  expect(telegram.sent.length).toBe(0);
});
// ── Inline keyboards / callback data (gjc parity) ────────────────────────────────

test("cancelCallbackData round-trips through parseCallbackData", () => {
  const data = cancelCallbackData("abcd1234", "executor-1");
  expect(data).toBe("cancel:abcd1234:executor-1");
  expect(parseCallbackData(data)).toEqual({ action: "cancel", shortId: "abcd1234", subagentId: "executor-1" });
});

test("parseCallbackData rejects an unknown payload", () => {
  expect(parseCallbackData("nope")).toBeUndefined();
  expect(parseCallbackData("steer:abcd:executor-1")).toBeUndefined();
});

test("buildSubagentsKeyboard emits one cancel button per RUNNING subagent, undefined when none run", () => {
  expect(buildSubagentsKeyboard([{ sessionId: "aaaa", records: [rec({ status: "completed" })] }])).toBeUndefined();
  const kb = buildSubagentsKeyboard([
    { sessionId: "abcd1234-0000", records: [rec({ id: "executor-1", status: "running" }), rec({ id: "executor-2", status: "completed" })] },
  ]);
  expect(kb).toBeDefined();
  expect(kb!.inline_keyboard.length).toBe(1);
  expect(kb!.inline_keyboard[0]![0]!.callback_data).toBe("cancel:abcd1234:executor-1");
});

test("a 'started' status edge attaches an inline Cancel button", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const conn = { sessionId: "abcd1234-0000", cwd: "/tmp/proj", pid: 1, ws: new FakeWebSocket("x") as unknown as WebSocket, lastRecords: [] };
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ id: "executor-1", status: "running" })] }));
  const kb = telegram.sent[0]!.options?.replyMarkup;
  expect(kb.inline_keyboard[0][0].callback_data).toBe("cancel:abcd1234:executor-1");
});

test("/subagents attaches a cancel keyboard for running subagents", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const conn = { sessionId: "abcd1234-0000", cwd: "/tmp/proj", pid: 1, ws: new FakeWebSocket("x") as unknown as WebSocket, lastRecords: [rec({ status: "running" })] };
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleInboundText("/subagents");
  expect(telegram.sent[0]!.options?.replyMarkup?.inline_keyboard[0][0].callback_data).toBe("cancel:abcd1234:executor-1");
});

test("handleCallbackQuery cancels via button: round-trips over ws, answers the tap, and notifies", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const fakeWs = new FakeWebSocket("ws://x");
  const sessionId = "abcd1234-0000-0000-0000-000000000000";
  daemon.sessions.set(sessionId, { sessionId, cwd: "/tmp/proj", pid: 1, ws: fakeWs as unknown as WebSocket, lastRecords: [] });
  await authenticate(daemon, daemon.sessions.get(sessionId)!);

  const promise = daemon.handleCallbackQuery({
    id: "cbq-1",
    from: { id: 999, is_bot: false },
    data: "cancel:abcd1234:executor-1",
    message: { message_id: 2, chat: { id: 999, type: "private" } },
  });
  const sentFrame = JSON.parse(fakeWs.sent.at(-1)!);
  expect(sentFrame.type).toBe("cancel");
  expect(sentFrame.ids).toEqual(["executor-1"]);
  const conn = daemon.sessions.get(sessionId)!;
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "ack", reqId: sentFrame.reqId, ok: true }));
  await promise;
  expect(telegram.answered.at(-1)!.id).toBe("cbq-1");
  expect(telegram.answered.at(-1)!.options?.text).toContain("Cancelled 'executor-1'");
  expect(telegram.sent.at(-1)!.text).toContain("Cancelled 'executor-1' via button");
});

test("handleCallbackQuery from an unknown session answers with a no-match toast and sends no ws frame", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  await daemon.handleCallbackQuery({
    id: "cbq-1",
    from: { id: 999, is_bot: false },
    data: "cancel:zzzzzzzz:executor-1",
    message: { message_id: 2, chat: { id: 999, type: "private" } },
  });
  expect(telegram.answered.at(-1)!.options?.text).toContain("No connected session matches");
});

test("handleUpdate routes a callback_query from the paired chat", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  await daemon.handleUpdate({
    update_id: 1,
    callback_query: { id: "cbq-1", from: { id: 999, is_bot: false }, data: "bogus", message: { message_id: 2, chat: { id: 999, type: "private" } } },
  });
  expect(telegram.answered.at(-1)!.id).toBe("cbq-1");
});

test("handleCallbackQuery from any OTHER chat is dropped (only acknowledged, no ws frame, no push)", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const fakeWs = new FakeWebSocket("ws://x");
  daemon.sessions.set("abcd1234-0000", { sessionId: "abcd1234-0000", cwd: "/tmp", pid: 1, ws: fakeWs as unknown as WebSocket, lastRecords: [] });
  await daemon.handleCallbackQuery({
    id: "cbq-1",
    from: { id: 7, is_bot: false },
    data: "cancel:abcd1234:executor-1",
    message: { message_id: 2, chat: { id: 31337, type: "supergroup" } },
  });
  expect(fakeWs.sent.length).toBe(0);
  expect(telegram.sent.length).toBe(0);
});

// ── Forum topics ─────────────────────────────────────────────────────────────────

function makeTopicDaemon(telegram: FakeTelegramApi, topicId: number): TelegramDaemon {
  FakeWebSocket.instances = [];
  return new TelegramDaemon({
    chatId: "999",
    topicId,
    allowedUserIds: ["999"],
    telegram: telegram as unknown as TelegramApi,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    ackTimeoutMs: 200,
  });
}

test("configured topicId is threaded into every outbound push", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeTopicDaemon(telegram, 55);
  await daemon.handleInboundText("/help");
  expect(telegram.sent[0]!.options?.messageThreadId).toBe(55);
});

test("handleUpdate drops a message from a different forum topic", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeTopicDaemon(telegram, 55);
  await daemon.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, from: { id: 999, is_bot: false }, chat: { id: 999, type: "supergroup" }, text: "/help", message_thread_id: 77 } });
  expect(telegram.sent.length).toBe(0);
});

test("handleUpdate accepts a message from the configured forum topic", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeTopicDaemon(telegram, 55);
  await daemon.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, from: { id: 999, is_bot: false }, chat: { id: 999, type: "supergroup" }, text: "/help", message_thread_id: 55 } });
  expect(telegram.sent[0]!.text).toBe(HELP_TEXT);
});

// ── Image attachments ──────────────────────────────────────────────────────────

test("a session photo frame is relayed via sendPhoto with caption + topic", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeTopicDaemon(telegram, 55);
  const conn = { sessionId: "abcd1234-0000", cwd: "/tmp/proj", pid: 1, ws: new FakeWebSocket("x") as unknown as WebSocket, lastRecords: [] };
  await authenticate(daemon, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "photo", url: "https://example.com/shot.png", caption: "a screenshot" }));
  expect(telegram.photos.length).toBe(1);
  expect(telegram.photos[0]!.photo).toBe("https://example.com/shot.png");
  expect(telegram.photos[0]!.options?.caption).toBe("a screenshot");
  expect(telegram.photos[0]!.options?.messageThreadId).toBe(55);
});
test("a session photo frame is relayed via sendPhoto with caption, topic, and replyMarkup", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeTopicDaemon(telegram, 55);
  const conn = { sessionId: "abcd1234-0000", cwd: "/tmp/proj", pid: 1, ws: new FakeWebSocket("x") as unknown as WebSocket, lastRecords: [] };
  await authenticate(daemon, conn);
  const replyMarkup = { inline_keyboard: [[{ text: "click", callback_data: "data" }]] };
  await daemon.handleSessionMessage(conn, JSON.stringify({
      type: "photo",
      url: "https://example.com/shot.png",
      caption: "a screenshot",
      replyMarkup
  }));
  expect(telegram.photos.length).toBe(1);
  expect(telegram.photos[0]!.photo).toBe("https://example.com/shot.png");
  expect(telegram.photos[0]!.options?.caption).toBe("a screenshot");
  expect(telegram.photos[0]!.options?.messageThreadId).toBe(55);
  expect(telegram.photos[0]!.options?.replyMarkup).toEqual(replyMarkup);
});

// ── Per-session dynamic topics (Tier 2) ──────────────────────────────────────────

function makePerSessionDaemon(telegram: FakeTelegramApi, overrides: Partial<TelegramDaemonOptions> = {}): TelegramDaemon {
  FakeWebSocket.instances = [];
  return new TelegramDaemon({
    chatId: "999",
    telegram: telegram as unknown as TelegramApi,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    ackTimeoutMs: 200,
    perSessionTopics: true,
    saveTopicState: async () => {},
    loadTopicState: async () => ({ topics: {} }),
    ...overrides,
  });
}

function sessionConn(sessionId = "abcd1234-0000-0000-0000-000000000000", cwd = "/tmp/proj") {
  return { sessionId, cwd, pid: 1, ws: new FakeWebSocket("x") as unknown as WebSocket, lastRecords: [] as SubagentRecord[] };
}

test("perSessionTopics: a NEW status edge from a session calls createForumTopic with a provisional name containing its short id, not a flat sendMessage with a preset topicId", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(1);
  expect(telegram.topicsCreated[0]!.chatId).toBe("999");
  expect(telegram.topicsCreated[0]!.name).toBe(`session ${shortSessionId(conn.sessionId)}`);
  expect(telegram.sent.length).toBe(1);
  expect(telegram.sent[0]!.options?.messageThreadId).toBe(1000);
});

test("perSessionTopics: a SECOND frame from the SAME session reuses the cached topic (createForumTopic not called again)", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ id: "executor-1", status: "running" })] }));
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ id: "executor-1", status: "completed", result: "done" })] }));
  expect(telegram.topicsCreated.length).toBe(1);
  expect(telegram.sent.length).toBe(2);
  expect(telegram.sent[1]!.options?.messageThreadId).toBe(1000);
});

test("identity_header renames an already-created topic via editForumTopic ONCE, deduped on a repeated identical header", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(1);

  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "identity_header", sessionId: conn.sessionId, repo: "my-repo", branch: "main", cwd: "/tmp/x" }));
  expect(telegram.topicsEdited.length).toBe(1);
  expect(telegram.topicsEdited[0]!.messageThreadId).toBe(1000);
  expect(telegram.topicsEdited[0]!.name).toBe("my-repo@main");

  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "identity_header", sessionId: conn.sessionId, repo: "my-repo", branch: "main", cwd: "/tmp/x" }));
  expect(telegram.topicsEdited.length).toBe(1);
});

test("identity_header rename retries on the NEXT identical header after a transient editForumTopic failure (does not get stuck at the provisional name)", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(1);

  telegram.editForumTopicImpl = async () => {
    throw new Error("rate limited");
  };
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "identity_header", sessionId: conn.sessionId, repo: "my-repo", branch: "main", cwd: "/tmp/x" }));
  // The attempt happened (and failed) — the daemon must not have silently
  // skipped it.
  expect(telegram.topicsEdited.length).toBe(1);

  // The SAME identity is reasserted (e.g. the next context_update-adjacent
  // identity_header). Without the fix, the local registry would already
  // believe the rename applied and skip retrying — editForumTopic would
  // never be called again, leaving the remote topic stuck at its
  // provisional "session <shortId>" name forever.
  telegram.editForumTopicImpl = async () => ({ ok: true });
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "identity_header", sessionId: conn.sessionId, repo: "my-repo", branch: "main", cwd: "/tmp/x" }));
  expect(telegram.topicsEdited.length).toBe(2);
  expect(telegram.topicsEdited[1]!.name).toBe("my-repo@main");

  // Now that the rename has actually landed, a THIRD identical header is a
  // true no-op (no further editForumTopic calls).
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "identity_header", sessionId: conn.sessionId, repo: "my-repo", branch: "main", cwd: "/tmp/x" }));
  expect(telegram.topicsEdited.length).toBe(2);
});

test("context_update frame sends a message reflecting phase/summary/model", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  await authenticate(daemon, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "context_update", sessionId: conn.sessionId, phase: "turn_start", summary: "do a thing", model: "claude" }));
  expect(telegram.sent.length).toBe(1);
  expect(telegram.sent[0]!.text).toBe("▶ Turn started (claude)\ndo a thing");
});

test("turn_stream frame sends HTML-converted text with parse_mode HTML (markdownToTelegramHtml pipe-through)", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  await authenticate(daemon, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "turn_stream", sessionId: conn.sessionId, text: "**bold** reply" }));
  expect(telegram.sent.length).toBe(1);
  expect(telegram.sent[0]!.options?.parseMode).toBe("HTML");
  expect(telegram.sent[0]!.text).toBe("<b>bold</b> reply");
});

test("inbound message to a session's OWN topic (per-session-topics mode) sends a user_message frame over that session's ws", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(1);

  await updateWithAck(daemon, {
    update_id: 1,
    message: { message_id: 5, date: 0, from: { id: 999, is_bot: false }, chat: { id: 999, type: "private" }, text: "hello session", message_thread_id: 1000 },
  });
  const ws = conn.ws as unknown as FakeWebSocket;
  const frame = JSON.parse(ws.sent.at(-1)!);
  expect(frame).toEqual({ type: "user_message", sessionId: conn.sessionId, text: "hello session", reqId: expect.any(String) });
});

test("in-thread config command ('/verbose') routes as a config_command frame instead of user_message, and does not react", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));

  await daemon.handleUpdate({
    update_id: 1,
    message: { message_id: 6, date: 0, from: { id: 999, is_bot: false }, chat: { id: 999, type: "private" }, text: "/verbose", message_thread_id: 1000 },
  });
  const ws = conn.ws as unknown as FakeWebSocket;
  const frame = JSON.parse(ws.sent.at(-1)!);
  expect(frame).toEqual({ type: "config_command", sessionId: conn.sessionId, verbosity: "verbose" });
  expect(telegram.reactions.length).toBe(0);
});

test("a photo attachment in a session's topic is downloaded (getFile+downloadFile) and relayed as user_message with imagePaths via an injected writeTempFile", async () => {
  const telegram = new FakeTelegramApi();
  const written: { bytes: Uint8Array; suggestedName: string }[] = [];
  const daemon = makePerSessionDaemon(telegram, {
    writeTempFile: async (bytes, suggestedName) => {
      written.push({ bytes, suggestedName });
      return `/tmp/fake/${suggestedName}`;
    },
  });
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));

  await updateWithAck(daemon, {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      from: { id: 999, is_bot: false },
      chat: { id: 999, type: "private" },
      message_thread_id: 1000,
      photo: [
        { file_id: "small-1", width: 90, height: 90 },
        { file_id: "big-1", width: 800, height: 800 },
      ],
    },
  });

  expect(telegram.filesFetched).toEqual(["big-1"]);
  expect(telegram.filesDownloaded).toEqual(["photos/big-1.jpg"]);
  expect(written.length).toBe(1);
  expect(written[0]!.suggestedName).toBe("photo-big-1.jpg");
  const ws = conn.ws as unknown as FakeWebSocket;
  const frame = JSON.parse(ws.sent.at(-1)!);
  expect(frame.type).toBe("user_message");
  expect(frame.sessionId).toBe(conn.sessionId);
  expect(frame.text).toBe("");
  expect(frame.imagePaths).toEqual(["/tmp/fake/photo-big-1.jpg"]);
});

test("an image document attachment (sent 'as file') in a session's topic is also downloaded and relayed as user_message with imagePaths", async () => {
  const telegram = new FakeTelegramApi();
  const written: { bytes: Uint8Array; suggestedName: string }[] = [];
  const daemon = makePerSessionDaemon(telegram, {
    writeTempFile: async (bytes, suggestedName) => {
      written.push({ bytes, suggestedName });
      return `/tmp/fake/${suggestedName}`;
    },
  });
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));

  await updateWithAck(daemon, {
    update_id: 1,
    message: {
      message_id: 8,
      date: 0,
      from: { id: 999, is_bot: false },
      chat: { id: 999, type: "private" },
      message_thread_id: 1000,
      caption: "a diagram",
      document: { file_id: "doc-1", file_name: "diagram.png", mime_type: "image/png" },
    },
  });

  expect(telegram.filesFetched).toEqual(["doc-1"]);
  expect(telegram.filesDownloaded).toEqual(["photos/doc-1.jpg"]);
  expect(written[0]!.suggestedName).toBe("diagram.png");
  const ws = conn.ws as unknown as FakeWebSocket;
  const frame = JSON.parse(ws.sent.at(-1)!);
  expect(frame.type).toBe("user_message");
  expect(frame.text).toBe("a diagram");
  expect(frame.imagePaths).toEqual(["/tmp/fake/diagram.png"]);
});

// ── Bounded download size (jeo-native subset of GJC #2714) ──────────────────────

test("an oversized inbound photo (downloadFile rejected) still delivers as text-only, with no imagePaths and no written temp file", async () => {
  const telegram = new FakeTelegramApi();
  let seenMaxBytes: number | undefined;
  telegram.downloadFileImpl = async (_filePath, maxBytes) => {
    seenMaxBytes = maxBytes; // confirms opts.maxAttachmentBytes actually threads through to TelegramApi.downloadFile
    return undefined; // simulates TelegramApi.downloadFile rejecting an over-cap response
  };
  const written: { bytes: Uint8Array; suggestedName: string }[] = [];
  const daemon = makePerSessionDaemon(telegram, {
    maxAttachmentBytes: 1024,
    writeTempFile: async (bytes, suggestedName) => {
      written.push({ bytes, suggestedName });
      return `/tmp/fake/${suggestedName}`;
    },
  });
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));

  await updateWithAck(daemon, {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      from: { id: 999, is_bot: false },
      chat: { id: 999, type: "private" },
      message_thread_id: 1000,
      caption: "a screenshot",
      photo: [{ file_id: "huge-1", width: 4000, height: 4000 }],
    },
  });

  expect(seenMaxBytes).toBe(1024);
  expect(telegram.filesFetched).toEqual(["huge-1"]);
  expect(telegram.filesDownloaded).toEqual(["photos/huge-1.jpg"]);
  expect(written.length).toBe(0); // never reached writeTempFile — the oversized download was rejected first
  const ws = conn.ws as unknown as FakeWebSocket;
  const frame = JSON.parse(ws.sent.at(-1)!);
  expect(frame.type).toBe("user_message");
  expect(frame.text).toBe("a screenshot");
  expect(frame.imagePaths).toBeUndefined();
});

test("a plain-text inbound message that routes as user_message gets a 👀 reaction (setMessageReaction) confirming delivery", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));

  await updateWithAck(daemon, {
    update_id: 1,
    message: { message_id: 9, date: 0, from: { id: 999, is_bot: false }, chat: { id: 999, type: "private" }, text: "hello again", message_thread_id: 1000 },
  });
  expect(telegram.reactions.length).toBe(1);
  expect(telegram.reactions[0]).toEqual({ chatId: "999", messageId: 9, emoji: "👀" });
});

test("fail-closed: createForumTopic rejecting falls back to the flat/no topicId for that session's subsequent sends, without retrying createForumTopic on every frame", async () => {
  const telegram = new FakeTelegramApi();
  telegram.createForumTopicImpl = async () => {
    throw new Error("Threaded Mode off");
  };
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();

  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ id: "e1", status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(1);
  expect(telegram.sent.length).toBe(1);
  expect(telegram.sent[0]!.options?.messageThreadId).toBeUndefined();

  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ id: "e1", status: "completed", result: "done" })] }));
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ id: "e2", status: "running" })] }));

  expect(telegram.topicsCreated.length).toBe(1);
  expect(telegram.sent.length).toBe(3);
  expect(telegram.sent.every(s => s.options?.messageThreadId === undefined)).toBe(true);
});

test("fail-closed privacy gate: a non-private paired chat (group) blocks per-session topic creation, falls back to the flat path, and getChat is checked only ONCE (cached across sessions)", async () => {
  const telegram = new FakeTelegramApi();
  telegram.getChatImpl = async () => ({ ok: true, result: { type: "group" } });
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();

  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ id: "e1", status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(0);
  expect(telegram.sent.length).toBe(1);
  expect(telegram.sent[0]!.options?.messageThreadId).toBeUndefined();
  expect(telegram.chatsChecked.length).toBe(1);

  const conn2 = sessionConn("11112222-0000-0000-0000-000000000000");
  await daemon.handleSessionMessage(conn2, JSON.stringify({ type: "snapshot", sessionId: conn2.sessionId, pid: conn2.pid, subagents: [rec({ id: "e2", status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(0);
  expect(telegram.sent.length).toBe(2);
  expect(telegram.chatsChecked.length).toBe(1);
});
// ── pollTelegramLoop error backoff (jeo-native subset of GJC v0.11.10 #3048) ─────

/** Minimal daemon for exercising `start()`'s `pollTelegramLoop`: no real
 *  session scan (empty `readdir`) and an injected `sleep` so backoff delays
 *  are observed/controlled without real timers. `sleep` is responsible for
 *  calling `daemon.stop()` once the test has seen enough iterations — that's
 *  what lets `start()` (which blocks until stopped) resolve. */
function makePollDaemon(
  telegram: FakeTelegramApi,
  sleep: (ms: number) => Promise<void>,
): TelegramDaemon {
  return new TelegramDaemon({
    chatId: "999",
    telegram: telegram as unknown as TelegramApi,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    readdir: async () => [],
    sleep,
  });
}

test("pollTelegramLoop backs off starting near 1s, doubling on each consecutive non-ok getUpdates, capped at 10s", async () => {
  const telegram = new FakeTelegramApi();
  telegram.getUpdates = async () => ({ ok: false }) as any;
  const delays: number[] = [];
  let daemon: TelegramDaemon;
  daemon = makePollDaemon(telegram, async ms => {
    delays.push(ms);
    if (delays.length >= 5) daemon.stop();
  });
  await daemon.start();
  expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 10_000]);
});

test("pollTelegramLoop backs off on a thrown/rejected getUpdates the same way as a non-ok response", async () => {
  const telegram = new FakeTelegramApi();
  telegram.getUpdates = async () => {
    throw new Error("network blip");
  };
  const delays: number[] = [];
  let daemon: TelegramDaemon;
  daemon = makePollDaemon(telegram, async ms => {
    delays.push(ms);
    if (delays.length >= 3) daemon.stop();
  });
  await daemon.start();
  expect(delays).toEqual([1_000, 2_000, 4_000]);
});

test("pollTelegramLoop resets backoff to the initial ~1s delay after a successful getUpdates", async () => {
  const telegram = new FakeTelegramApi();
  let call = 0;
  telegram.getUpdates = async () => {
    call++;
    if (call === 3) return { ok: true, result: [] };
    return { ok: false } as any;
  };
  const delays: number[] = [];
  let daemon: TelegramDaemon;
  daemon = makePollDaemon(telegram, async ms => {
    delays.push(ms);
    if (delays.length >= 3) daemon.stop();
  });
  await daemon.start();
  // fail (1000, backoff->2000), fail (2000, backoff->4000), success (reset->1000), fail (1000)
  expect(delays).toEqual([1_000, 2_000, 1_000]);
});

test("pollTelegramLoop imposes no sleep/cooldown between consecutive successful getUpdates polls (long-polling stays exempt from backoff)", async () => {
  const telegram = new FakeTelegramApi();
  let call = 0;
  let daemon: TelegramDaemon;
  telegram.getUpdates = async () => {
    call++;
    if (call >= 3) daemon.stop();
    return { ok: true, result: [] };
  };
  const sleepCalls: number[] = [];
  daemon = makePollDaemon(telegram, async ms => {
    sleepCalls.push(ms);
  });
  await daemon.start();
  expect(call).toBeGreaterThanOrEqual(3);
  expect(sleepCalls).toEqual([]);
});

test("pollTelegramLoop remains stoppable mid-backoff (stop() during the error sleep still halts the loop)", async () => {
  const telegram = new FakeTelegramApi();
  telegram.getUpdates = async () => ({ ok: false }) as any;
  let daemon: TelegramDaemon;
  let sleepCallCount = 0;
  daemon = makePollDaemon(telegram, async () => {
    sleepCallCount++;
    daemon.stop();
  });
  await daemon.start();
  expect(sleepCallCount).toBe(1);
});

test.each([
  { name: "missing sender", from: undefined },
  { name: "different private user", from: { id: 7, is_bot: false } },
  { name: "bot impersonating owner", from: { id: 999, is_bot: true } },
])("private chat rejects $name before sending commands or attachments", async ({ from }) => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({})] }));
  telegram.sent = [];
  await daemon.handleUpdate({ update_id: 2, message: {
    message_id: 8, date: 0, from, chat: { id: 999, type: "private" },
    text: "run my instruction", photo: [{ file_id: "untrusted", width: 1, height: 1 }], message_thread_id: 1000,
  } });
  expect((conn.ws as unknown as FakeWebSocket).sent).toEqual([]);
  expect(telegram.sent).toEqual([]);
  expect(telegram.filesFetched).toEqual([]);
  daemon.stop();
});

test.each([
  { name: "owner in private chat", type: "private", actor: 999, allowedUserIds: undefined, accepted: true },
  { name: "owner absent from explicit allowlist", type: "private", actor: 999, allowedUserIds: ["7"], accepted: false },
  { name: "group without allowlist", type: "supergroup", actor: 999, allowedUserIds: undefined, accepted: false },
  { name: "group listed actor", type: "supergroup", actor: 7, allowedUserIds: ["7"], accepted: true },
  { name: "group unlisted actor", type: "supergroup", actor: 8, allowedUserIds: ["7"], accepted: false },
])("sender authorization: $name", async ({ type, actor, allowedUserIds, accepted }) => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram, { allowedUserIds });
  await daemon.handleUpdate({ update_id: 1, message: {
    message_id: 1, date: 0, from: { id: actor, is_bot: false }, chat: { id: 999, type }, text: "/help",
  } });
  expect(telegram.sent.map(message => message.text)).toEqual(accepted ? [HELP_TEXT] : []);
  daemon.stop();
});

test("configured topic rejects missing thread on both text and callback", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeTopicDaemon(telegram, 55);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await authenticate(daemon, conn);
  await daemon.handleUpdate(update(999, "/help"));
  await daemon.handleCallbackQuery({ id: "wrong-topic", from: { id: 999, is_bot: false },
    data: "cancel:abcd1234:executor-1", message: { message_id: 2, chat: { id: 999, type: "private" } } });
  expect((conn.ws as unknown as FakeWebSocket).sent).toEqual([]);
  expect(telegram.sent).toEqual([]);
  daemon.stop();
});

test.each([
  { name: "absent message", message: undefined, from: { id: 999, is_bot: false } },
  { name: "unlisted actor", message: { message_id: 2, chat: { id: 999, type: "private" } }, from: { id: 7, is_bot: false } },
])("callback rejects $name before session cancellation", async ({ message, from }) => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await authenticate(daemon, conn);
  await daemon.handleCallbackQuery({ id: "untrusted", from, data: "cancel:abcd1234:executor-1", message });
  expect((conn.ws as unknown as FakeWebSocket).sent).toEqual([]);
  expect(telegram.sent).toEqual([]);
  daemon.stop();
});

test("session topic cannot cancel another session through text or callback", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const first = sessionConn();
  const second = sessionConn("bbbb1234-0000-0000-0000-000000000000");
  for (const conn of [first, second]) {
    daemon.sessions.set(conn.sessionId, conn);
    await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({})] }));
  }
  await daemon.handleUpdate({ update_id: 1, message: {
    message_id: 1, date: 0, from: { id: 999, is_bot: false }, chat: { id: 999, type: "private" },
    text: "/cancel bbbb1234 executor-1", message_thread_id: 1000,
  } });
  await daemon.handleCallbackQuery({ id: "cross-topic", from: { id: 999, is_bot: false },
    data: "cancel:bbbb1234:executor-1", message: { message_id: 2, chat: { id: 999, type: "private" }, message_thread_id: 1000 } });
  expect((first.ws as unknown as FakeWebSocket).sent).toEqual([]);
  expect((second.ws as unknown as FakeWebSocket).sent).toEqual([]);
  daemon.stop();
});

test.each(["/shell rm -rf workspace", "  /unknown do something"])("session topic never forwards unsupported slash instruction %s", async text => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({})] }));
  await daemon.handleUpdate({ update_id: 1, message: {
    message_id: 1, date: 0, from: { id: 999, is_bot: false }, chat: { id: 999, type: "private" }, text, message_thread_id: 1000,
  } });
  expect((conn.ws as unknown as FakeWebSocket).sent).toEqual([]);
  expect(telegram.reactions).toEqual([]);
  daemon.stop();
});

test("discovery attaches authentication only to a validated loopback endpoint", async () => {
  FakeWebSocket.instances = [];
  const urls = ["ws://example.com:80", "wss://127.0.0.1:9", "ws://127.0.0.1.example.com:9", "ws://user@127.0.0.1:9", "ws://127.0.0.1:9/redirect", "ws://127.0.0.1:9?token=stolen", "ws://127.0.0.1:9"];
  const daemon = new TelegramDaemon({ chatId: "999", telegram: new FakeTelegramApi() as unknown as TelegramApi,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    readdir: async () => urls.map((_, index) => `${index}.json`),
    readFile: async file => JSON.stringify({ url: urls[Number(file.split("/").at(-1)!.split(".")[0])], token: "private-token", pid: 1, cwd: "/tmp/project" }),
    isPidAlive: () => true,
  });
  await daemon.scanSessions();
  expect(FakeWebSocket.instances.map(socket => socket.url)).toEqual(["ws://127.0.0.1:9/?token=private-token"]);
  daemon.stop();
});

test.each([
  { name: "different session", sessionId: "other-session", pid: 1 },
  { name: "different process", sessionId: "abcd1234-0000-0000-0000-000000000000", pid: 2 },
])("snapshot from $name cannot authenticate a discovered socket", async ({ sessionId, pid }) => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId, pid, subagents: [rec({})] }));
  await daemon.handleInboundText("/cancel abcd1234 executor-1");
  const socket = conn.ws as unknown as FakeWebSocket;
  expect(socket.closed).toBe(true);
  expect(socket.sent).toEqual([]);
  expect(telegram.sent.some(message => message.text.includes("started"))).toBe(false);
  daemon.stop();
});

test("malformed session frames cannot publish notifications before a valid snapshot", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const conn = sessionConn();
  for (const raw of ["null", "{", "[]", "42", JSON.stringify({ type: "turn_stream", text: "unverified secret" })]) {
    await daemon.handleSessionMessage(conn, raw);
  }
  expect(telegram.sent).toEqual([]);
  await authenticate(daemon, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "turn_stream", sessionId: conn.sessionId, text: "verified answer" }));
  expect(telegram.sent.map(message => message.text)).toEqual(["verified answer"]);
  daemon.stop();
});

test("another session cannot acknowledge a request and rejection never gets a success reaction", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const target = sessionConn();
  const stranger = sessionConn("bbbb1234-0000-0000-0000-000000000000");
  daemon.sessions.set(target.sessionId, target);
  daemon.sessions.set(stranger.sessionId, stranger);
  await authenticate(daemon, stranger);
  await daemon.handleSessionMessage(target, JSON.stringify({ type: "snapshot", sessionId: target.sessionId, pid: target.pid, subagents: [rec({})] }));
  const requested = Promise.withResolvers<string>();
  const socket = target.ws as unknown as FakeWebSocket;
  socket.onSend = requested.resolve;
  const inbound = daemon.handleUpdate({ update_id: 1, message: { message_id: 9, date: 0, from: { id: 999, is_bot: false }, chat: { id: 999, type: "private" }, text: "hello", message_thread_id: 1000 } });
  const frame = JSON.parse(await requested.promise);
  await daemon.handleSessionMessage(stranger, JSON.stringify({ type: "ack", reqId: frame.reqId, ok: true }));
  await daemon.handleSessionMessage(target, JSON.stringify({ type: "ack", reqId: frame.reqId, ok: false }));
  await inbound;
  expect(telegram.reactions).toEqual([]);
  daemon.stop();
});

test("ambiguous session prefixes cannot select either cancellation target", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const first = sessionConn("abcd1234-first");
  const second = sessionConn("abcd1234-second");
  for (const conn of [first, second]) {
    daemon.sessions.set(conn.sessionId, conn);
    await authenticate(daemon, conn);
  }
  await daemon.handleInboundText("/cancel abcd1234 executor-1");
  expect((first.ws as unknown as FakeWebSocket).sent).toEqual([]);
  expect((second.ws as unknown as FakeWebSocket).sent).toEqual([]);
  daemon.stop();
});

test.each([
  { name: "null record", raw: "null" },
  { name: "malformed JSON", raw: "{" },
  { name: "unsafe PID", raw: JSON.stringify({ url: "ws://127.0.0.1:9", token: "secret", pid: -1, cwd: "/tmp" }) },
  { name: "nonstring token", raw: JSON.stringify({ url: "ws://127.0.0.1:9", token: { value: "secret" }, pid: 1, cwd: "/tmp" }) },
])("discovery rejects $name without constructing a socket", async ({ raw }) => {
  FakeWebSocket.instances = [];
  const daemon = new TelegramDaemon({ chatId: "999", telegram: new FakeTelegramApi() as unknown as TelegramApi,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    readdir: async () => ["bad.json"], readFile: async () => raw, isPidAlive: () => true,
  });
  await daemon.scanSessions();
  expect(FakeWebSocket.instances).toEqual([]);
  expect(daemon.sessions.size).toBe(0);
  daemon.stop();
});

test("stop settles polling while an injected backoff remains unresolved", async () => {
  const telegram = new FakeTelegramApi();
  let polls = 0;
  telegram.getUpdates = async () => { polls++; throw new Error("offline"); };
  const sleeping = Promise.withResolvers<void>();
  const releaseSleep = Promise.withResolvers<void>();
  const daemon = makePollDaemon(telegram, () => { sleeping.resolve(); return releaseSleep.promise; });
  const running = daemon.start();
  try {
    await sleeping.promise;
    daemon.stop();
    await running;
    expect(polls).toBe(1);
    expect(telegram.sent).toEqual([]);
  } finally {
    releaseSleep.resolve();
    daemon.stop();
  }
});

test.each(["topic load", "directory scan", "discovery read"] as const)("stop during pending %s prevents subsequent connections and polling", async stage => {
  FakeWebSocket.instances = [];
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const pause = async (current: typeof stage) => {
    if (current === stage) { entered.resolve(); await resume.promise; }
  };
  const telegram = new FakeTelegramApi();
  let polls = 0;
  let reads = 0;
  let daemon: TelegramDaemon;
  telegram.getUpdates = async () => { polls++; daemon.stop(); return { ok: true, result: [] }; };
  daemon = makePerSessionDaemon(telegram, {
    loadTopicState: async () => { await pause("topic load"); return { topics: {} }; },
    readdir: async () => { await pause("directory scan"); return ["session.json"]; },
    readFile: async () => {
      reads++;
      await pause("discovery read");
      return JSON.stringify({ url: "ws://127.0.0.1:9", token: "private-token", pid: 1, cwd: "/tmp/project" });
    },
    isPidAlive: () => true,
  });
  const running = daemon.start();
  try {
    await entered.promise;
    daemon.stop();
    resume.resolve();
    await running;
    expect(FakeWebSocket.instances).toEqual([]);
    expect(polls).toBe(0);
    expect(reads).toBe(stage === "discovery read" ? 1 : 0);
    expect(telegram.topicsCreated).toEqual([]);
  } finally {
    resume.resolve();
    daemon.stop();
  }
});

test.each(["response", "failure"] as const)("a pending Telegram poll %s cannot trigger work after stop", async outcome => {
  const telegram = new FakeTelegramApi();
  const polling = Promise.withResolvers<void>();
  const response = Promise.withResolvers<TelegramGetUpdatesResult>();
  telegram.getUpdates = () => { polling.resolve(); return response.promise; };
  const sleeps: number[] = [];
  const daemon = makePollDaemon(telegram, async milliseconds => { sleeps.push(milliseconds); });
  const running = daemon.start();
  await polling.promise;
  daemon.stop();
  if (outcome === "failure") response.reject(new Error("aborted"));
  else response.resolve({ ok: true, result: [{ update_id: 1, message: { message_id: 1, date: 0, from: { id: 999, is_bot: false }, chat: { id: 999, type: "private" }, text: "/help" } }] });
  await running;
  expect(sleeps).toEqual([]);
  expect(telegram.sent).toEqual([]);
});

test("stop settles every pending command before another event-loop turn without waiting for ACK timeout", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await authenticate(daemon, conn);
  const settled: string[] = [];
  const commands = [
    daemon.handleInboundText("/steer abcd1234 executor-1 hurry").then(() => settled.push("steer")),
    daemon.handleInboundText("/cancel abcd1234 executor-1").then(() => settled.push("cancel")),
  ];
  daemon.stop();
  try {
    // A scheduler barrier, not a duration: all stop-triggered microtasks must
    // finish before the next event-loop turn, regardless of the ACK deadline.
    await nextEventLoopTurn();
    expect(settled.sort()).toEqual(["cancel", "steer"]);
    expect(telegram.sent.map(message => message.text)).toEqual([
      "Steer failed — 'executor-1' is unknown or not running.",
      "Cancel failed — 'executor-1' is unknown or already finished.",
    ]);
  } finally {
    await Promise.all(commands);
    daemon.stop();
  }
});

test("stop refuses a late successful ACK for an already pending command", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await authenticate(daemon, conn);
  const command = daemon.handleInboundText("/steer abcd1234 executor-1 hurry");
  const frame = JSON.parse((conn.ws as unknown as FakeWebSocket).sent.at(-1)!);
  daemon.stop();
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "ack", reqId: frame.reqId, ok: true }));
  await command;
  expect(telegram.sent.map(message => message.text)).toEqual(["Steer failed — 'executor-1' is unknown or not running."]);
});

test.each(["snapshot", "photo"] as const)("stop ignores a late %s frame from a previously authenticated session", async type => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await authenticate(daemon, conn);
  daemon.stop();
  await daemon.handleSessionMessage(conn, JSON.stringify({
    type, sessionId: conn.sessionId, pid: conn.pid,
    subagents: [rec({ status: "running" })], url: "https://example.com/late.png",
  }));
  expect(telegram.sent).toEqual([]);
  expect(telegram.photos).toEqual([]);
  expect(telegram.topicsCreated).toEqual([]);
});

test.each([
  { name: "same bot and chat", storedScope: { botId: "1", chatId: "999" }, reused: true },
  { name: "different bot", storedScope: { botId: "2", chatId: "999" }, reused: false },
  { name: "different chat", storedScope: { botId: "1", chatId: "888" }, reused: false },
  { name: "legacy unscoped cache", storedScope: {}, reused: false },
])("topic cache routes only within its destination: $name", async ({ storedScope, reused }) => {
  const savedConfigDir = process.env.JEO_CONFIG_DIR;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-topic-scope-"));
  process.env.JEO_CONFIG_DIR = directory;
  const telegram = new FakeTelegramApi();
  const polling = Promise.withResolvers<void>();
  const response = Promise.withResolvers<TelegramGetUpdatesResult>();
  telegram.getUpdates = () => { polling.resolve(); return response.promise; };
  const options = {
    botId: "1", chatId: "999", telegram: telegram as unknown as TelegramApi,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    perSessionTopics: true, readdir: async () => [], saveTopicState: async () => {},
  };
  const daemon = new TelegramDaemon(options);
  const conn = sessionConn();
  let running: Promise<void> | undefined;
  try {
    const target = notifyTopicsPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({ ...storedScope, topics: {
      [conn.sessionId]: { topicId: 55, createdAt: 123, name: "previous session" },
    } }));
    running = daemon.start();
    await polling.promise;
    await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId: conn.sessionId, pid: conn.pid, subagents: [rec({ status: "running" })] }));
    expect(telegram.sent.map(message => [message.chatId, message.options?.messageThreadId])).toEqual([["999", reused ? 55 : 1000]]);
    expect(telegram.topicsCreated).toEqual(reused ? [] : [{ chatId: "999", name: "session abcd1234" }]);
  } finally {
    daemon.stop();
    response.resolve({ ok: true, result: [] });
    await running;
    if (savedConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedConfigDir;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
