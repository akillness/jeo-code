import { test, expect } from "bun:test";
import { TelegramApi, maskToken, MAX_TELEGRAM_DOWNLOAD_BYTES, TELEGRAM_COOLDOWN_MIN_SECONDS, TELEGRAM_COOLDOWN_MAX_SECONDS, TELEGRAM_COOLDOWN_FALLBACK_SECONDS, TELEGRAM_COOLDOWN_SUPPRESSED_DESCRIPTION } from "../src/agent/notify/telegram-api";

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

// ── Bot-wide 429 cooldown, injectable clock (jeo-native subset of GJC v0.11.10 PR #3048) ──

/** Scripted fetch: returns `script[i]` for the i-th call (clamped to the last
 *  entry once exhausted), so a 429 can be scripted first and a normal 200
 *  after it, while every call is recorded for assertions on call COUNT
 *  (whether a later call ever reached fetch at all). */
function fakeStatusFetch(script: { status: number; body: unknown }[]): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const entry = script[Math.min(i, script.length - 1)]!;
    i++;
    return new Response(JSON.stringify(entry.body), { status: entry.status });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

/** Injectable, manually-advanced clock for deterministic cooldown-expiry tests. */
function fakeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("a 429 response arms a bot-wide cooldown from parameters.retry_after that suppresses the NEXT non-polling call without ever reaching fetch", async () => {
  const { calls, fetch } = fakeStatusFetch([
    { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 45 } } },
  ]);
  const clock = fakeClock(0);
  const api = new TelegramApi("TOKEN123", fetch, clock.now);
  const first = await api.sendMessage("999", "hi");
  expect(first.ok).toBe(false);
  expect(calls.length).toBe(1);
  expect(api.isCoolingDown()).toBe(true);

  clock.advance(44_000); // still inside the armed 45s window
  const second = await api.sendMessage("999", "hi again");
  expect(second.ok).toBe(false);
  expect(second.description).toBe(TELEGRAM_COOLDOWN_SUPPRESSED_DESCRIPTION);
  expect(calls.length).toBe(1); // NEVER reached fetch a second time
});

test("retry_after above the 3600s ceiling clamps down instead of arming an unbounded cooldown", async () => {
  const { fetch } = fakeStatusFetch([
    { status: 429, body: { ok: false, parameters: { retry_after: 999_999 } } },
  ]);
  const clock = fakeClock(0);
  const api = new TelegramApi("TOKEN123", fetch, clock.now);
  await api.sendMessage("999", "hi");
  clock.advance(TELEGRAM_COOLDOWN_MAX_SECONDS * 1000 - 1);
  expect(api.isCoolingDown()).toBe(true);
  clock.advance(2);
  expect(api.isCoolingDown()).toBe(false);
});

test("retry_after below the 1s floor clamps up rather than arming a near-0s cooldown", async () => {
  const { fetch } = fakeStatusFetch([
    { status: 429, body: { ok: false, parameters: { retry_after: 0.2 } } },
  ]);
  const clock = fakeClock(0);
  const api = new TelegramApi("TOKEN123", fetch, clock.now);
  await api.sendMessage("999", "hi");
  clock.advance(TELEGRAM_COOLDOWN_MIN_SECONDS * 1000 - 1);
  expect(api.isCoolingDown()).toBe(true);
  clock.advance(2);
  expect(api.isCoolingDown()).toBe(false);
});

test("a malformed retry_after (missing, non-numeric, zero, or negative) falls back to a fixed safe cooldown instead of 0s or unbounded", async () => {
  const malformedParameters = [undefined, { retry_after: "soon" }, { retry_after: -5 }, { retry_after: 0 }, {}];
  for (const parameters of malformedParameters) {
    const { fetch } = fakeStatusFetch([{ status: 429, body: { ok: false, parameters } }]);
    const clock = fakeClock(0);
    const api = new TelegramApi("TOKEN123", fetch, clock.now);
    await api.sendMessage("999", "hi");
    clock.advance(TELEGRAM_COOLDOWN_FALLBACK_SECONDS * 1000 - 1);
    expect(api.isCoolingDown()).toBe(true);
    clock.advance(2);
    expect(api.isCoolingDown()).toBe(false);
  }
});

test("an active cooldown suppresses EVERY non-polling method (getMe, sendPhoto, answerCallbackQuery, getFile, getChat, setMessageReaction, downloadFile) without any of them reaching fetch", async () => {
  const { calls, fetch } = fakeStatusFetch([
    { status: 429, body: { ok: false, parameters: { retry_after: 60 } } },
  ]);
  const api = new TelegramApi("TOKEN123", fetch);
  await api.sendMessage("999", "hi"); // arms the cooldown
  expect(calls.length).toBe(1);

  const me = await api.getMe();
  const photo = await api.sendPhoto("999", "https://example.com/x.png");
  const ack = await api.answerCallbackQuery("cbq-1");
  const file = await api.getFile("file-id-1");
  const chat = await api.getChat("999");
  const reaction = await api.setMessageReaction("999", 1, "👀");
  const downloaded = await api.downloadFile("photos/file.jpg");

  expect(me.ok).toBe(false);
  expect(photo.ok).toBe(false);
  expect(ack.ok).toBe(false);
  expect(file.ok).toBe(false);
  expect(chat.ok).toBe(false);
  expect(reaction.ok).toBe(false);
  expect(downloaded).toBeUndefined();
  expect(calls.length).toBe(1); // still just the original 429 call — nothing else reached fetch
});

test("the cooldown expires after the armed duration elapses (per the injected clock), and the next call reaches fetch again", async () => {
  const { calls, fetch } = fakeStatusFetch([
    { status: 429, body: { ok: false, parameters: { retry_after: 5 } } },
    { status: 200, body: { ok: true } },
  ]);
  const clock = fakeClock(0);
  const api = new TelegramApi("TOKEN123", fetch, clock.now);
  await api.sendMessage("999", "hi");
  expect(api.isCoolingDown()).toBe(true);

  clock.advance(5_000);
  expect(api.isCoolingDown()).toBe(false);

  const res = await api.sendMessage("999", "hi again");
  expect(res.ok).toBe(true);
  expect(calls.length).toBe(2);
});

test("getUpdates is EXEMPT from cooldown suppression and keeps reaching fetch so long-poll recovery still works", async () => {
  const { calls, fetch } = fakeStatusFetch([
    { status: 429, body: { ok: false, parameters: { retry_after: 60 } } },
    { status: 200, body: { ok: true, result: [] } },
  ]);
  const api = new TelegramApi("TOKEN123", fetch);
  await api.sendMessage("999", "hi"); // arms a 60s cooldown
  expect(api.isCoolingDown()).toBe(true);

  const res = await api.getUpdates();
  expect(calls.length).toBe(2); // getUpdates STILL reached fetch despite the active cooldown
  expect(res.result).toEqual([]);
});

test("a non-429 error response never arms a cooldown — non-429 behavior is unchanged", async () => {
  const { calls, fetch } = fakeStatusFetch([
    { status: 400, body: { ok: false, description: "Bad Request" } },
    { status: 200, body: { ok: true } },
  ]);
  const api = new TelegramApi("TOKEN123", fetch);
  const first = await api.sendMessage("999", "hi");
  expect(first.ok).toBe(false);
  expect(first.description).toBe("Bad Request");
  expect(api.isCoolingDown()).toBe(false);

  const second = await api.sendMessage("999", "hi again");
  expect(second.ok).toBe(true);
  expect(calls.length).toBe(2); // second call was NOT suppressed
});
