import { expect, test } from "bun:test";
import { TelegramDaemon } from "../src/agent/notify/telegram-daemon";
import type { TelegramApi, TelegramUpdate } from "../src/agent/notify/telegram-api";

const sessionId = "abcd1234-0000-0000-0000-000000000000";
const update: TelegramUpdate = {
  update_id: 77,
  message: { message_id: 8, date: 0, chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false }, message_thread_id: 55, text: "hello" },
};
const overflowText = "Message not delivered: the session queue is full. Please retry later.";

test.each(["delivered", "undelivered", "transient-notice", "transient-nack"] as const)("remote queue %s controls the polling checkpoint", async scenario => {
  const offsets: (number | undefined)[] = [];
  const saved: number[] = [];
  const messages: { text: string; topic: number | undefined }[] = [];
  const savedDuringSend: number[][] = [];
  const frames: { type: string; reqId: string }[] = [];
  const reactions: number[] = [];
  let daemon!: TelegramDaemon;
  const telegram = {
    getChat: async () => ({ ok: true, result: { type: "private" } }),
    getUpdates: async (offset?: number) => {
      offsets.push(offset);
      if (offset === 78 || offsets.length === 3) {
        daemon.stop();
        return { ok: true as const, result: [] };
      }
      return { ok: true as const, result: [update] };
    },
    sendMessage: async (_chatId: string, text: string, options?: { messageThreadId?: number }) => {
      messages.push({ text, topic: options?.messageThreadId });
      savedDuringSend.push([...saved]);
      return { ok: scenario !== "undelivered" && !(scenario === "transient-notice" && messages.length === 1) };
    },
    setMessageReaction: async (_chatId: string, messageId: number) => { reactions.push(messageId); return { ok: true }; },
  };
  const ws = {
    send(raw: string) {
      const frame = JSON.parse(raw) as { type: string; reqId: string };
      frames.push(frame);
      void daemon.handleSessionMessage(conn, JSON.stringify({ type: "ack", reqId: frame.reqId, ok: false, ...(scenario === "transient-nack" ? {} : { reason: "queue_full" }) }));
    },
    close() {},
  };
  const conn = { sessionId, cwd: "/tmp/project", pid: 1, ws: ws as unknown as WebSocket, lastRecords: [] };
  daemon = new TelegramDaemon({
    chatId: "999",
    telegram: telegram as unknown as TelegramApi,
    perSessionTopics: true,
    loadTopicState: async () => ({ topics: { [sessionId]: { topicId: 55, createdAt: 123, name: "session" } } }),
    saveTopicState: async () => {},
    loadUpdateOffset: async () => 77,
    saveUpdateOffset: async next => { saved.push(next); },
    readdir: async () => [],
    sleep: async () => {},
    ackTimeoutMs: 30,
  });
  daemon.sessions.set(sessionId, conn);
  await daemon.handleSessionMessage(conn, JSON.stringify({ type: "snapshot", sessionId, pid: 1, subagents: [] }));
  await daemon.start();

  expect(reactions).toEqual([]);
  expect(frames.every(frame => frame.type === "user_message")).toBe(true);
  if (scenario === "delivered" || scenario === "transient-notice") {
    expect(frames).toHaveLength(1);
    expect(messages).toEqual(Array.from({ length: scenario === "delivered" ? 1 : 2 }, () => ({ text: overflowText, topic: 55 })));
    expect(savedDuringSend.every(snapshot => snapshot.length === 0)).toBe(true);
    expect(saved).toEqual([78]);
    expect(offsets).toEqual([77, 78]);
  } else {
    expect(frames).toHaveLength(2);
    expect(saved).toEqual([]);
    expect(offsets).toEqual([77, 77, 77]);
    if (scenario === "undelivered") {
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.every(message => message.text === overflowText && message.topic === 55)).toBe(true);
    } else {
      expect(messages).toEqual([]);
    }
  }
}, 15000);
