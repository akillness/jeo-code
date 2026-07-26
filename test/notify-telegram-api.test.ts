import { test, expect } from "bun:test";
import { TelegramApi, maskToken, MAX_TELEGRAM_DOWNLOAD_BYTES } from "../src/agent/notify/telegram-api";

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

// ── Tier 2: forum topics, file download, chat lookup, reactions, HTML parse mode ──

function fakeBytesFetch(bytes: Uint8Array, options?: { ok?: boolean; throws?: boolean }): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (options?.throws) throw new Error("network down");
    return new Response(bytes, { status: options?.ok === false ? 500 : 200 });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

test("createForumTopic POSTs chat_id + name to /createForumTopic", async () => {
  const { calls, fetch } = fakeFetch({ createForumTopic: { ok: true, result: { message_thread_id: 42 } } });
  const api = new TelegramApi("TOKEN123", fetch);
  const res = await api.createForumTopic("999", "session abcd1234");
  expect(res.ok).toBe(true);
  expect(res.result?.message_thread_id).toBe(42);
  expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN123/createForumTopic");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.chat_id).toBe("999");
  expect(body.name).toBe("session abcd1234");
});

test("editForumTopic POSTs chat_id + message_thread_id + name to /editForumTopic", async () => {
  const { calls, fetch } = fakeFetch({ editForumTopic: { ok: true } });
  const api = new TelegramApi("TOKEN123", fetch);
  await api.editForumTopic("999", 42, "my-repo@main");
  expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN123/editForumTopic");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.chat_id).toBe("999");
  expect(body.message_thread_id).toBe(42);
  expect(body.name).toBe("my-repo@main");
});

test("getFile POSTs file_id to /getFile and returns the resolved file_path", async () => {
  const { calls, fetch } = fakeFetch({ getFile: { ok: true, result: { file_path: "photos/file_1.jpg" } } });
  const api = new TelegramApi("TOKEN123", fetch);
  const res = await api.getFile("file-id-1");
  expect(res.result?.file_path).toBe("photos/file_1.jpg");
  expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN123/getFile");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.file_id).toBe("file-id-1");
});

test("getChat POSTs chat_id to /getChat and returns the chat type", async () => {
  const { calls, fetch } = fakeFetch({ getChat: { ok: true, result: { type: "private" } } });
  const api = new TelegramApi("TOKEN123", fetch);
  const res = await api.getChat("999");
  expect(res.result?.type).toBe("private");
  expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN123/getChat");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.chat_id).toBe("999");
});

test("setMessageReaction POSTs chat_id + message_id + an emoji reaction to /setMessageReaction", async () => {
  const { calls, fetch } = fakeFetch({ setMessageReaction: { ok: true } });
  const api = new TelegramApi("TOKEN123", fetch);
  await api.setMessageReaction("999", 7, "👀");
  expect(calls[0]!.url).toBe("https://api.telegram.org/botTOKEN123/setMessageReaction");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.chat_id).toBe("999");
  expect(body.message_id).toBe(7);
  expect(body.reaction).toEqual([{ type: "emoji", emoji: "👀" }]);
});

test("sendMessage includes parse_mode HTML in the body when parseMode is set", async () => {
  const { calls, fetch } = fakeFetch({ sendMessage: { ok: true } });
  const api = new TelegramApi("TOKEN123", fetch);
  await api.sendMessage("999", "<b>hi</b>", { parseMode: "HTML" });
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.parse_mode).toBe("HTML");
});

test("sendMessage omits parse_mode entirely (no key, not undefined-valued) when not set", async () => {
  const { calls, fetch } = fakeFetch({ sendMessage: { ok: true } });
  const api = new TelegramApi("TOKEN123", fetch);
  await api.sendMessage("999", "hi");
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect("parse_mode" in body).toBe(false);
});

test("downloadFile fetches from the FILE api base path (distinct from the bot API base path) and returns bytes", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { calls, fetch } = fakeBytesFetch(bytes);
  const api = new TelegramApi("TOKEN123", fetch);
  const result = await api.downloadFile("photos/file_1.jpg");
  expect(result).toBeInstanceOf(Uint8Array);
  expect(Array.from(result!)).toEqual([1, 2, 3, 4]);
  expect(calls[0]).toBe("https://api.telegram.org/file/botTOKEN123/photos/file_1.jpg");
  expect(calls[0]).not.toBe("https://api.telegram.org/botTOKEN123/photos/file_1.jpg");
});

test("downloadFile rejects a path-traversal filePath WITHOUT ever calling fetch", async () => {
  const { calls, fetch } = fakeBytesFetch(new Uint8Array());
  const api = new TelegramApi("TOKEN123", fetch);
  const result = await api.downloadFile("../../etc/passwd");
  expect(result).toBeUndefined();
  expect(calls.length).toBe(0);
});

test("downloadFile rejects a leading-slash filePath WITHOUT ever calling fetch", async () => {
  const { calls, fetch } = fakeBytesFetch(new Uint8Array());
  const api = new TelegramApi("TOKEN123", fetch);
  const result = await api.downloadFile("/etc/passwd");
  expect(result).toBeUndefined();
  expect(calls.length).toBe(0);
});

test("downloadFile rejects a filePath containing a backslash WITHOUT ever calling fetch", async () => {
  const { calls, fetch } = fakeBytesFetch(new Uint8Array());
  const api = new TelegramApi("TOKEN123", fetch);
  const result = await api.downloadFile("photos\\file.jpg");
  expect(result).toBeUndefined();
  expect(calls.length).toBe(0);
});

test("downloadFile percent-encodes a special character within a path segment in the actual fetched URL", async () => {
  const { calls, fetch } = fakeBytesFetch(new Uint8Array([9]));
  const api = new TelegramApi("TOKEN123", fetch);
  await api.downloadFile("photos/file #1 name.jpg");
  expect(calls[0]).toBe(`https://api.telegram.org/file/botTOKEN123/photos/${encodeURIComponent("file #1 name.jpg")}`);
});

test("downloadFile returns undefined (not a throw) when fetch itself throws", async () => {
  const { fetch } = fakeBytesFetch(new Uint8Array(), { throws: true });
  const api = new TelegramApi("TOKEN123", fetch);
  const result = await api.downloadFile("photos/file.jpg");
  expect(result).toBeUndefined();
});

test("downloadFile returns undefined (not a throw) on a non-ok response", async () => {
  const { fetch } = fakeBytesFetch(new Uint8Array(), { ok: false });
  const api = new TelegramApi("TOKEN123", fetch);
  const result = await api.downloadFile("photos/file.jpg");
  expect(result).toBeUndefined();
});

// ── Bounded download size (jeo-native subset of GJC #2714) ──────────────────────

test("downloadFile rejects a response whose body exceeds an injected maxBytes cap, without ever returning the oversized bytes", async () => {
  const bytes = new Uint8Array(2048).fill(7);
  const { fetch } = fakeBytesFetch(bytes);
  const api = new TelegramApi("TOKEN123", fetch);
  const result = await api.downloadFile("photos/file.jpg", 1024);
  expect(result).toBeUndefined();
});

test("downloadFile returns the full bytes for a normal image within an injected maxBytes cap", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const { fetch } = fakeBytesFetch(bytes);
  const api = new TelegramApi("TOKEN123", fetch);
  const result = await api.downloadFile("photos/file.jpg", 1024);
  expect(result).toBeInstanceOf(Uint8Array);
  expect(Array.from(result!)).toEqual([1, 2, 3, 4, 5]);
});

// Real filesystem/bytes analogue of test/file-attachment.test.ts's oversized-source
// check, but bounding the NETWORK download instead of a local `stat`+`readFile` — a
// remote server can't lie its way past this by omitting/understating `content-length`
// since the cap is enforced while streaming, not from the header alone.
test("downloadFile rejects a response over the default MAX_TELEGRAM_DOWNLOAD_BYTES cap when no maxBytes is given", async () => {
  const bytes = new Uint8Array(MAX_TELEGRAM_DOWNLOAD_BYTES + 1024).fill(9);
  const { fetch } = fakeBytesFetch(bytes);
  const api = new TelegramApi("TOKEN123", fetch);
  const result = await api.downloadFile("photos/huge.jpg");
  expect(result).toBeUndefined();
});
