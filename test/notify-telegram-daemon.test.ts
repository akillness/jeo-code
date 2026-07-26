import { test, expect } from "bun:test";
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
  async getUpdates() {
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

// ── handleUpdate (chat authorization trust boundary) ────────────────────────────

function update(chatId: number, text?: string) {
  return { update_id: 1, message: text === undefined ? undefined : { message_id: 1, date: 0, chat: { id: chatId, type: "private" }, text } };
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ id: "executor-1", status: "running" })] }));
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

  const promise = daemon.handleCallbackQuery({
    id: "cbq-1",
    from: { id: 7, is_bot: false },
    data: "cancel:abcd1234:executor-1",
    message: { message_id: 2, chat: { id: 999, type: "supergroup" } },
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
    from: { id: 7, is_bot: false },
    data: "cancel:zzzzzzzz:executor-1",
    message: { message_id: 2, chat: { id: 999, type: "supergroup" } },
  });
  expect(telegram.answered.at(-1)!.options?.text).toContain("No connected session matches");
});

test("handleUpdate routes a callback_query from the paired chat", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeDaemon(telegram);
  await daemon.handleUpdate({
    update_id: 1,
    callback_query: { id: "cbq-1", from: { id: 7, is_bot: false }, data: "bogus", message: { message_id: 2, chat: { id: 999, type: "supergroup" } } },
  } as any);
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
  await daemon.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 999, type: "supergroup" }, text: "/help", message_thread_id: 77 } } as any);
  expect(telegram.sent.length).toBe(0);
});

test("handleUpdate accepts a message from the configured forum topic", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeTopicDaemon(telegram, 55);
  await daemon.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 999, type: "supergroup" }, text: "/help", message_thread_id: 55 } } as any);
  expect(telegram.sent[0]!.text).toBe(HELP_TEXT);
});

// ── Image attachments ──────────────────────────────────────────────────────────

test("a session photo frame is relayed via sendPhoto with caption + topic", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makeTopicDaemon(telegram, 55);
  const conn = { sessionId: "abcd1234-0000", cwd: "/tmp/proj", pid: 1, ws: new FakeWebSocket("x") as unknown as WebSocket, lastRecords: [] };
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ id: "executor-1", status: "running" })] }));
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ id: "executor-1", status: "completed", result: "done" })] }));
  expect(telegram.topicsCreated.length).toBe(1);
  expect(telegram.sent.length).toBe(2);
  expect(telegram.sent[1]!.options?.messageThreadId).toBe(1000);
});

test("identity_header renames an already-created topic via editForumTopic ONCE, deduped on a repeated identical header", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "context_update", sessionId: conn.sessionId, phase: "turn_start", summary: "do a thing", model: "claude" }));
  expect(telegram.sent.length).toBe(1);
  expect(telegram.sent[0]!.text).toBe("▶ Turn started (claude)\ndo a thing");
});

test("turn_stream frame sends HTML-converted text with parse_mode HTML (markdownToTelegramHtml pipe-through)", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(1);

  await daemon.handleUpdate({
    update_id: 1,
    message: { message_id: 5, date: 0, chat: { id: 999, type: "private" }, text: "hello session", message_thread_id: 1000 },
  });
  const ws = conn.ws as unknown as FakeWebSocket;
  const frame = JSON.parse(ws.sent.at(-1)!);
  expect(frame).toEqual({ type: "user_message", sessionId: conn.sessionId, text: "hello session" });
});

test("in-thread config command ('/verbose') routes as a config_command frame instead of user_message, and does not react", async () => {
  const telegram = new FakeTelegramApi();
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();
  daemon.sessions.set(conn.sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));

  await daemon.handleUpdate({
    update_id: 1,
    message: { message_id: 6, date: 0, chat: { id: 999, type: "private" }, text: "/verbose", message_thread_id: 1000 },
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));

  await daemon.handleUpdate({
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));

  await daemon.handleUpdate({
    update_id: 1,
    message: {
      message_id: 8,
      date: 0,
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));

  await daemon.handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
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
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ status: "running" })] }));

  await daemon.handleUpdate({
    update_id: 1,
    message: { message_id: 9, date: 0, chat: { id: 999, type: "private" }, text: "hello again", message_thread_id: 1000 },
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

  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ id: "e1", status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(1);
  expect(telegram.sent.length).toBe(1);
  expect(telegram.sent[0]!.options?.messageThreadId).toBeUndefined();

  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ id: "e1", status: "completed", result: "done" })] }));
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ id: "e2", status: "running" })] }));

  expect(telegram.topicsCreated.length).toBe(1);
  expect(telegram.sent.length).toBe(3);
  expect(telegram.sent.every(s => s.options?.messageThreadId === undefined)).toBe(true);
});

test("fail-closed privacy gate: a non-private paired chat (group) blocks per-session topic creation, falls back to the flat path, and getChat is checked only ONCE (cached across sessions)", async () => {
  const telegram = new FakeTelegramApi();
  telegram.getChatImpl = async () => ({ ok: true, result: { type: "group" } });
  const daemon = makePerSessionDaemon(telegram);
  const conn = sessionConn();

  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", subagents: [rec({ id: "e1", status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(0);
  expect(telegram.sent.length).toBe(1);
  expect(telegram.sent[0]!.options?.messageThreadId).toBeUndefined();
  expect(telegram.chatsChecked.length).toBe(1);

  const conn2 = sessionConn("11112222-0000-0000-0000-000000000000");
  await daemon.handleSessionMessage(conn2, JSON.stringify({ type: "snapshot", subagents: [rec({ id: "e2", status: "running" })] }));
  expect(telegram.topicsCreated.length).toBe(0);
  expect(telegram.sent.length).toBe(2);
  expect(telegram.chatsChecked.length).toBe(1);
});
