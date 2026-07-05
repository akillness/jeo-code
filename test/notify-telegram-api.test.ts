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
