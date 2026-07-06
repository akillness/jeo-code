import { test, expect } from "bun:test";
import { TelegramApi, maskToken } from "../src/agent/notify/telegram-api";

function fakeFetch(responses: Record<string, unknown>): { calls: { url: string; init?: RequestInit }[]; fetch: typeof fetch } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [key, body] of Object.entries(responses)) {
      if (url.includes(key)) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ ok: false, description: "not stubbed" }), { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

test("getMe hits /bot<token>/getMe and parses the identity result", async () => {
  const { calls, fetch } = fakeFetch({ getMe: { ok: true, result: { id: 1, is_bot: true, username: "jeo_bot" } } });
  const api = new TelegramApi("TOKEN123", fetch);
  const me = await api.getMe();
  expect(me.ok).toBe(true);
  expect(me.result?.username).toBe("jeo_bot");
  expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN123/getMe");
});

test("sendMessage POSTs chat_id + text as JSON", async () => {
  const { calls, fetch } = fakeFetch({ sendMessage: { ok: true } });
  const api = new TelegramApi("TOKEN123", fetch);
  const res = await api.sendMessage("999", "hello world");
  expect(res.ok).toBe(true);
  expect(calls[0]!.init?.method).toBe("POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.chat_id).toBe("999");
  expect(body.text).toBe("hello world");
});

test("sendMessage threads message_thread_id + reply_markup into the body when given", async () => {
  const { calls, fetch } = fakeFetch({ sendMessage: { ok: true } });
  const api = new TelegramApi("TOKEN123", fetch);
  const replyMarkup = { inline_keyboard: [[{ text: "⏹ Cancel", callback_data: "cancel:abcd:executor-1" }]] };
  await api.sendMessage("999", "hi", { messageThreadId: 42, replyMarkup });
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.message_thread_id).toBe(42);
  expect(body.reply_markup).toEqual(replyMarkup);
});

test("sendMessage omits message_thread_id + reply_markup when not given", async () => {
  const { calls, fetch } = fakeFetch({ sendMessage: { ok: true } });
  const api = new TelegramApi("TOKEN123", fetch);
  await api.sendMessage("999", "hi");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect("message_thread_id" in body).toBe(false);
  expect("reply_markup" in body).toBe(false);
  expect(body.disable_web_page_preview).toBe(true);
});

test("sendPhoto POSTs chat_id + photo (+caption/thread) to /sendPhoto", async () => {
  const { calls, fetch } = fakeFetch({ sendPhoto: { ok: true } });
  const api = new TelegramApi("TOKEN123", fetch);
  const res = await api.sendPhoto("999", "https://example.com/x.png", { caption: "a shot", messageThreadId: 7 });
  expect(res.ok).toBe(true);
  expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN123/sendPhoto");
  expect(calls[0]!.init?.method).toBe("POST");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.chat_id).toBe("999");
  expect(body.photo).toBe("https://example.com/x.png");
  expect(body.caption).toBe("a shot");
  expect(body.message_thread_id).toBe(7);
});

test("answerCallbackQuery POSTs callback_query_id + optional text/show_alert", async () => {
  const { calls, fetch } = fakeFetch({ answerCallbackQuery: { ok: true } });
  const api = new TelegramApi("TOKEN123", fetch);
  await api.answerCallbackQuery("cbq-1", { text: "done", showAlert: true });
  expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN123/answerCallbackQuery");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.callback_query_id).toBe("cbq-1");
  expect(body.text).toBe("done");
  expect(body.show_alert).toBe(true);
});

test("getUpdates parses a callback_query update", async () => {
  const update = {
    update_id: 9,
    callback_query: { id: "cbq-1", from: { id: 7, is_bot: false }, data: "cancel:abcd:executor-1", message: { message_id: 2, chat: { id: 999, type: "supergroup" }, message_thread_id: 3 } },
  };
  const { fetch } = fakeFetch({ getUpdates: { ok: true, result: [update] } });
  const api = new TelegramApi("TOKEN123", fetch);
  const res = await api.getUpdates();
  expect(res.result[0]!.callback_query?.data).toBe("cancel:abcd:executor-1");
});

test("getUpdates includes offset + timeout query params when offset is given", async () => {
  const { calls, fetch } = fakeFetch({ getUpdates: { ok: true, result: [] } });
  const api = new TelegramApi("TOKEN123", fetch);
  await api.getUpdates(42, 10);
  expect(calls[0]!.url).toContain("offset=42");
  expect(calls[0]!.url).toContain("timeout=10");
});

test("getUpdates omits offset when not given", async () => {
  const { calls, fetch } = fakeFetch({ getUpdates: { ok: true, result: [] } });
  const api = new TelegramApi("TOKEN123", fetch);
  await api.getUpdates();
  expect(calls[0]!.url).not.toContain("offset=");
});

test("getUpdates returns parsed updates", async () => {
  const update = { update_id: 5, message: { message_id: 1, date: 0, chat: { id: 7, type: "private" }, text: "/help" } };
  const { fetch } = fakeFetch({ getUpdates: { ok: true, result: [update] } });
  const api = new TelegramApi("TOKEN123", fetch);
  const res = await api.getUpdates();
  expect(res.result).toEqual([update]);
});

test("maskToken shows only the first 4 chars + length", () => {
  expect(maskToken("1234567890:ABCDEF")).toBe("1234…(len 17)");

});

test("maskToken on empty string returns empty string", () => {
  expect(maskToken("")).toBe("");
});
