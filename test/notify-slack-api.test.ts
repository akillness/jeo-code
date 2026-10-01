import { test, expect } from "bun:test";
import { SlackApi } from "../src/agent/notify/slack-api";

const BOT_TOKEN = "xoxb-offline-contract-token";
const APP_TOKEN = "xapp-offline-connection-token";
const CHANNEL = "C111";
const identity = { team_id: "T111", user_id: "U999", bot_id: "B999", app_id: "A111" };

function transport(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)), init ?? {})) as typeof fetch;
}
function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

test("bot Web API and app Socket Mode credentials are never interchangeable or exposed in URLs", async () => {
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, { fetchImpl: transport((url, init) => {
    const method = url.pathname.split("/").at(-1);
    const expected = method === "apps.connections.open" ? APP_TOKEN : BOT_TOKEN;
    if (url.origin !== "https://slack.com" || new Headers(init.headers).get("Authorization") !== `Bearer ${expected}` ||
        url.href.includes(BOT_TOKEN) || url.href.includes(APP_TOKEN) || String(init.body).includes(BOT_TOKEN) || String(init.body).includes(APP_TOKEN) || init.redirect !== "error") {
      return json({ ok: false, error: "invalid_auth" });
    }
    if (method === "auth.test") return json({ ok: true, ...identity });
    if (method === "conversations.info") return json({ ok: true, channel: { id: CHANNEL, is_member: true, context_team_id: "T111" } });
    if (method === "bots.info") return json({ ok: true, bot: { id: "B999", user_id: "U999", app_id: "A111" } });
    if (method === "apps.connections.open") return json({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=offline" });
    return json({ ok: true, channel: CHANNEL, ts: "1000.000001" });
  }) });
  try {
    expect(await api.getMe()).toMatchObject(identity);
    expect(await api.getChannel(CHANNEL)).toMatchObject({ id: CHANNEL, is_member: true });
    expect(await api.openConnection()).toEqual({ url: "wss://wss-primary.slack.com/link/?ticket=offline" });
    expect(await api.sendMessage(CHANNEL, "hello")).toEqual([{ ts: "1000.000001" }]);
  } finally { api.stop(); }
});

test.each([
  { name: "human token", body: { ok: true, team_id: "T111", user_id: "U111" } },
  { name: "missing workspace", body: { ok: true, user_id: "U999", bot_id: "B999" } },
  { name: "numeric user", body: { ok: true, team_id: "T111", user_id: 999, bot_id: "B999" } },
  { name: "malformed JSON shape", body: [] },
])("authentication rejects $name before trusting a relay", async ({ body }) => {
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, { fetchImpl: transport(() => json(body)) });
  try { await expect(api.getMe()).rejects.toThrow(); } finally { api.stop(); }
});

test.each([
  "ws://wss-primary.slack.com/link", "wss://slack.com.attacker.test/link", "wss://evil.slack.com/link",
  "wss://user:password@wss-primary.slack.com/link", "wss://wss-primary.slack.com:8443/link", "wss://127.0.0.1/link",
])("Socket Mode refuses unsafe URL %s", async url => {
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, { fetchImpl: transport(() => json({ ok: true, url })) });
  try { await expect(api.openConnection()).rejects.toThrow(); } finally { api.stop(); }
});

test.each([
  { name: "not joined", channel: { id: CHANNEL, is_member: false } },
  { name: "archived", channel: { id: CHANNEL, is_member: true, is_archived: true } },
  { name: "different ID", channel: { id: "C222", is_member: true } },
])("channel validation rejects $name", async ({ channel }) => {
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, { fetchImpl: transport(() => json({ ok: true, channel })) });
  try { await expect(api.getChannel(CHANNEL)).rejects.toThrow(); } finally { api.stop(); }
});

test("model output cannot activate Slack mentions, links, or markdown and preserves Unicode across bounded chunks", async () => {
  const content = "<&> <!channel> <!here> <@U111> <https://attacker.test|click> @everyone 🚀 ".repeat(160);
  const chunks: string[] = [];
  const pings: string[] = [];
  let now = 0;
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, { now: () => now, sleep: async ms => { now += ms; }, fetchImpl: transport((_url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.mrkdwn !== false || body.parse !== "none" || body.link_names || body.unfurl_links !== false || body.unfurl_media !== false || /<[@!]|<https?:/.test(body.text)) pings.push(body.text);
    if (body.text.length > 40000 || !body.text.isWellFormed() || body.thread_ts !== "1000.000001") return json({ ok: false, error: "invalid_arguments" });
    chunks.push(body.text);
    return json({ ok: true, channel: CHANNEL, ts: `1001.${String(chunks.length).padStart(6, "0")}` });
  }) });
  try {
    const result = await api.sendMessage(CHANNEL, content, "1000.000001");
    expect(chunks.join("")).toBe(content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    expect(pings).toEqual([]);
    expect(result).toEqual(chunks.map((_, index) => ({ ts: `1001.${String(index + 1).padStart(6, "0")}` })));
  } finally { api.stop(); }
});

test("Retry-After seconds serialize requests without dropping or reordering accepted messages", async () => {
  let now = 0;
  const attempts: { at: number; text: string }[] = [];
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, {
    now: () => now, maxRetries: 1, sleep: async ms => { now += ms; },
    fetchImpl: transport((_url, init) => {
      attempts.push({ at: now, text: JSON.parse(String(init.body)).text });
      if (attempts.length === 1) return new Response("limited", { status: 429, headers: { "Retry-After": "1.25" } });
      return json({ ok: true, channel: JSON.parse(String(init.body)).channel, ts: `1000.00000${attempts.length}` });
    }),
  });
  try {
    expect(await Promise.all([api.sendMessage(CHANNEL, "first"), api.sendMessage("C222", "second")])).toEqual([[{ ts: "1000.000002" }], [{ ts: "1000.000003" }]]);
    expect(attempts).toEqual([{ at: 0, text: "first" }, { at: 1250, text: "first" }, { at: 2250, text: "second" }]);
  } finally { api.stop(); }
});

test("retry exhaustion rejects delivery while a long cooldown blocks further network work", async () => {
  let now = 0;
  let attempts = 0;
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, {
    now: () => now, maxRetries: 2, sleep: async ms => { now += ms; },
    fetchImpl: transport(() => { attempts++; return json({ ok: false }, 429, { "Retry-After": attempts <= 3 ? "0.5" : "3600" }); }),
  });
  try {
    await expect(api.sendMessage(CHANNEL, "exhaust retries")).rejects.toThrow();
    expect(attempts).toBe(3);
    expect(now).toBe(1000);
    await expect(api.sendMessage(CHANNEL, "long cooldown")).rejects.toThrow(/cooldown/i);
    await expect(api.getMe()).rejects.toThrow(/cooldown/i);
    expect(attempts).toBe(4);
  } finally { api.stop(); }
});

test.each(["invalid_auth", "token_revoked", "missing_scope"])("%s halts queued requests without leaking credentials", async error => {
  let attempts = 0;
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, { fetchImpl: transport(() => {
    attempts++;
    return json({ ok: false, error, detail: `${BOT_TOKEN} ${APP_TOKEN}` });
  }) });
  try {
    const results = await Promise.allSettled([api.getMe(), api.sendMessage(CHANNEL, "denied")]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of results) if (result.status === "rejected") {
      expect(String(result.reason)).not.toContain(BOT_TOKEN);
      expect(String(result.reason)).not.toContain(APP_TOKEN);
    }
    expect(attempts).toBe(1);
  } finally { api.stop(); }
});

test("uncertain network failure is never retried as a duplicate post", async () => {
  let attempts = 0;
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, { maxRetries: 3, fetchImpl: transport(() => { attempts++; throw new Error(`${BOT_TOKEN} ${APP_TOKEN}`); }) });
  try {
    await expect(api.sendMessage(CHANNEL, "once only")).rejects.toThrow(/Slack.*failed/i);
    expect(attempts).toBe(1);
  } finally { api.stop(); }
});

test("stop interrupts rate-limit sleep and rejects queued messages without further requests", async () => {
  const sleeping = Promise.withResolvers<void>();
  let attempts = 0;
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, {
    now: () => 0, maxRetries: 2,
    fetchImpl: transport(() => { attempts++; return json({ ok: false }, 429, { "Retry-After": "2" }); }),
    sleep: (_ms, signal) => {
      const { promise, reject } = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
      sleeping.resolve();
      return promise;
    },
  });
  const result = Promise.allSettled([api.sendMessage(CHANNEL, "first"), api.sendMessage(CHANNEL, "second")]);
  try {
    await sleeping.promise;
    api.stop();
    expect((await result).map(item => item.status)).toEqual(["rejected", "rejected"]);
    expect(attempts).toBe(1);
  } finally { api.stop(); }
});

test("configured request deadline aborts a hung HTTP request without retrying it", async () => {
  const entered = Promise.withResolvers<void>();
  const deadlines: { ms: number; fire: () => void }[] = [];
  let aborted = false;
  let attempts = 0;
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, {
    requestTimeoutMs: 75, maxRetries: 3,
    setTimeout: (fire, ms) => { deadlines.push({ ms, fire }); return deadlines.length as unknown as Timer; },
    clearTimeout: () => {},
    fetchImpl: transport((_url, init) => {
      attempts++;
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
      entered.resolve();
      return promise;
    }),
  });
  try {
    const response = api.sendMessage(CHANNEL, "bounded request");
    await entered.promise;
    expect(deadlines.map(deadline => deadline.ms)).toEqual([75]);
    deadlines[0]!.fire();
    await expect(response).rejects.toThrow(/timed out/i);
    expect(aborted).toBe(true);
    expect(attempts).toBe(1);
  } finally { api.stop(); }
});

test("request backlog is bounded and shutdown drains every accepted and rejected waiter", async () => {
  const entered = Promise.withResolvers<void>();
  const overflow = Promise.withResolvers<void>();
  let attempts = 0;
  const failures: string[] = [];
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, { fetchImpl: transport((_url, init) => {
    attempts++;
    const { promise, reject } = Promise.withResolvers<Response>();
    init.signal!.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    entered.resolve();
    return promise;
  }) });
  const requests = Array.from({ length: 512 }, (_, index) => api.sendMessage(CHANNEL, `queued ${index}`).catch(error => {
    failures.push(String(error));
    if (/queue full/i.test(String(error))) overflow.resolve();
  }));
  try {
    await entered.promise;
    await overflow.promise;
    api.stop();
    await Promise.all(requests);
    expect(failures).toHaveLength(512);
    expect(attempts).toBe(1);
  } finally { api.stop(); }
});

test.each([
  { id: "B222", user_id: "U999", app_id: "A111" },
  { id: "B999", user_id: "U222", app_id: "A111" },
  { id: "B999", user_id: "U999", app_id: "not-an-app" },
])("bot metadata cannot substitute another identity: %j", async bot => {
  const api = new SlackApi(BOT_TOKEN, APP_TOKEN, { fetchImpl: transport(url =>
    json(url.pathname.endsWith("auth.test") ? { ok: true, ...identity } : { ok: true, bot })) });
  try { await expect(api.getMe()).rejects.toThrow(); } finally { api.stop(); }
});
