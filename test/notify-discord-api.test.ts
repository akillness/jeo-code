import { test, expect } from "bun:test";
import { DiscordApi } from "../src/agent/notify/discord-api";

const CHANNEL = "123456789012345678";
const TOKEN = "offline-discord-bot-token";

function transport(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)), init ?? {})) as typeof fetch;
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

test("getMe authenticates a bot with a header and preserves snowflake precision", async () => {
  const identity = { id: "999999999999999999", username: "offline-bot", bot: true };
  const api = new DiscordApi(TOKEN, { fetchImpl: transport((url, init) => {
    if (url.href !== "https://discord.com/api/v10/users/@me" || new Headers(init.headers).get("Authorization") !== `Bot ${TOKEN}`) {
      return json({ message: "unauthorized" }, 401);
    }
    return json(identity);
  }) });
  try { expect(await api.getMe()).toEqual(identity); } finally { api.stop(); }
});

for (const [name, identity] of Object.entries({
  "human account": { id: "12", username: "human", bot: false },
  "numeric snowflake": { id: 12, username: "bot", bot: true },
  "missing username": { id: "12", bot: true },
  "null response": null,
})) {
  test(`getMe rejects ${name} instead of authorizing the relay`, async () => {
    const api = new DiscordApi(TOKEN, { fetchImpl: transport(() => json(identity)) });
    try { await expect(api.getMe()).rejects.toThrow(); } finally { api.stop(); }
  });
}

for (const [name, content, lengths] of [
  ["exact boundary", "x".repeat(2000), [2000]],
  ["one character overflow", "x".repeat(2001), [2000, 1]],
  ["astral character at split", "x".repeat(1999) + "\u{1F680}" + "z".repeat(2000), [1999, 2000, 2]],
] as const) {
  test(`sendMessage preserves content and Unicode across ${name}`, async () => {
    const chunks: string[] = [];
    const api = new DiscordApi(TOKEN, { fetchImpl: transport((url, init) => {
      if (url.pathname !== `/api/v10/channels/${CHANNEL}/messages`) return json({}, 404);
      const body = JSON.parse(String(init.body));
      if (body.content.length > 2000 || !body.content.isWellFormed()) return json({}, 400);
      chunks.push(body.content);
      return json({ id: String(100 + chunks.length) });
    }) });
    try {
      const messages = await api.sendMessage(CHANNEL, content);
      expect(chunks.join("")).toBe(content);
      expect(chunks.map(chunk => chunk.length)).toEqual([...lengths]);
      expect(messages.map(message => message.id)).toEqual(chunks.map((_, index) => String(101 + index)));
    } finally { api.stop(); }
  });
}

test("model-authored everyone, role and user mentions cannot ping on any chunk", async () => {
  const content = "@everyone<@123><@&456>x".repeat(130);
  const delivered: string[] = [];
  let pinged = false;
  const api = new DiscordApi(TOKEN, { fetchImpl: transport((_url, init) => {
    const body = JSON.parse(String(init.body));
    const mentions = body.allowed_mentions;
    pinged ||= !mentions || mentions.parse.length !== 0 || mentions.replied_user !== false;
    delivered.push(body.content);
    return json({ id: String(delivered.length) });
  }) });
  try {
    await api.sendMessage(CHANNEL, content);
    expect(delivered.join("")).toBe(content);
    expect(pinged).toBe(false);
  } finally { api.stop(); }
});

test("429 seconds impose a bot-wide cooldown and preserve queued messages in order", async () => {
  let now = 1000;
  let limited = false;
  const attempts: { at: number; content: string }[] = [];
  const waits: number[] = [];
  const api = new DiscordApi(TOKEN, {
    now: () => now,
    maxRetries: 1,
    sleep: async ms => { waits.push(ms); now += ms; },
    fetchImpl: transport((_url, init) => {
      const content = JSON.parse(String(init.body)).content;
      attempts.push({ at: now, content });
      if (!limited) { limited = true; return json({ retry_after: 1.25, global: true }, 429); }
      return json({ id: String(attempts.length) });
    }),
  });
  try {
    const first = api.sendMessage(CHANNEL, "first");
    const second = api.sendMessage("222", "second");
    expect(await Promise.all([first, second])).toEqual([[{ id: "2" }], [{ id: "3" }]]);
    expect(waits).toEqual([1250]);
    expect(attempts).toEqual([{ at: 1000, content: "first" }, { at: 2250, content: "first" }, { at: 2250, content: "second" }]);
  } finally { api.stop(); }
});

test("successful bucket exhaustion delays the next request until Reset-After", async () => {
  let now = 0;
  const times: number[] = [];
  const api = new DiscordApi(TOKEN, {
    now: () => now,
    sleep: async ms => { now += ms; },
    fetchImpl: transport(() => {
      times.push(now);
      return json({ id: String(times.length) }, 200, times.length === 1 ? { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "0.75" } : {});
    }),
  });
  try {
    await api.sendMessage(CHANNEL, "first");
    await api.sendMessage(CHANNEL, "second");
    expect(times).toEqual([0, 750]);
  } finally { api.stop(); }
});

for (const [status, bodyKind] of [[401, "json"], [403, "json"], [401, "html"], [403, "html"]] as const) {
  test(`HTTP ${status} with ${bodyKind} body does not leak credentials and applies the correct failure scope`, async () => {
    let attempts = 0;
    const api = new DiscordApi(TOKEN, { fetchImpl: transport(() => {
      attempts++;
      return bodyKind === "json" ? json({ message: TOKEN }, status) : new Response(`<html>${TOKEN}</html>`, { status });
    }) });
    try {
      const errors = await Promise.allSettled([api.getMe(), api.sendMessage(CHANNEL, "must not send")]);
      expect(errors.map(result => result.status)).toEqual(["rejected", "rejected"]);
      for (const result of errors) {
        if (result.status === "rejected") expect(String(result.reason)).not.toContain(TOKEN);
      }
      expect(attempts).toBe(status === 401 ? 1 : 2);
    } finally { api.stop(); }
  });
}

test("an uncertain POST failure is surfaced without resending a possible duplicate", async () => {
  let attempts = 0;
  const api = new DiscordApi(TOKEN, { maxRetries: 3, fetchImpl: transport(() => { attempts++; throw new Error(TOKEN); }) });
  try {
    await expect(api.sendMessage(CHANNEL, "exactly once")).rejects.toThrow("Discord request failed");
    expect(attempts).toBe(1);
  } finally { api.stop(); }
});

test("stop aborts cooldown and prevents queued messages from reaching Discord", async () => {
  const sleeping = Promise.withResolvers<void>();
  let attempts = 0;
  const api = new DiscordApi(TOKEN, {
    now: () => 0,
    maxRetries: 1,
    fetchImpl: transport(() => { attempts++; return json({ retry_after: 2 }, 429); }),
    sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
      sleeping.resolve();
    }),
  });
  const sends = Promise.allSettled([api.sendMessage(CHANNEL, "first"), api.sendMessage(CHANNEL, "second")]);
  try {
    await sleeping.promise;
    api.stop();
    expect((await sends).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(attempts).toBe(1);
  } finally { api.stop(); }
});

test("exhausted 429 retries surface failure instead of reporting a lost message as delivered", async () => {
  let now = 0;
  let attempts = 0;
  const api = new DiscordApi(TOKEN, {
    now: () => now,
    maxRetries: 2,
    sleep: async ms => { now += ms; },
    fetchImpl: transport(() => { attempts++; return json({ retry_after: 0.5 }, 429); }),
  });
  try {
    await expect(api.sendMessage(CHANNEL, "must be delivered or fail")).rejects.toThrow("Discord HTTP 429");
    expect(attempts).toBe(3);
    expect(now).toBe(1000);
  } finally { api.stop(); }
});

test("long 429 cooldown rejects further requests without an unbounded wait or extra I/O", async () => {
  let attempts = 0;
  let waits = 0;
  const api = new DiscordApi(TOKEN, {
    now: () => 0,
    maxRetries: 2,
    sleep: async () => { waits++; },
    fetchImpl: transport(() => { attempts++; return json({ retry_after: 3600, global: true }, 429); }),
  });
  try {
    await expect(api.sendMessage(CHANNEL, "first")).rejects.toThrow("cooldown");
    await expect(api.getMe()).rejects.toThrow("cooldown");
    expect(attempts).toBe(1);
    expect(waits).toBe(0);
  } finally { api.stop(); }
});

test("REST identifies its bot client to Discord with a valid User-Agent", async () => {
  const api = new DiscordApi(TOKEN, { fetchImpl: transport((_url, init) => {
    const agent = new Headers(init.headers).get("User-Agent") ?? "";
    if (!/^DiscordBot \(https:\/\/[^,\s]+, [^)\s]+\)$/.test(agent)) return json({ message: "bot user agent required" }, 403);
    return json({ id: "123", username: "identified-bot", bot: true });
  }) });
  try { expect((await api.getMe()).id).toBe("123"); } finally { api.stop(); }
});

test("non-JSON 429 honors Retry-After seconds before retrying the original message", async () => {
  let now = 1000;
  const attempts: number[] = [];
  const delivered: string[] = [];
  const api = new DiscordApi(TOKEN, {
    now: () => now,
    maxRetries: 1,
    sleep: async ms => { now += ms; },
    fetchImpl: transport((_url, init) => {
      attempts.push(now);
      if (attempts.length === 1) return new Response("<html>rate limited</html>", { status: 429, headers: { "Retry-After": "1.5" } });
      delivered.push(JSON.parse(String(init.body)).content);
      return json({ id: "9000" });
    }),
  });
  try {
    expect(await api.sendMessage(CHANNEL, "preserve this message")).toEqual([{ id: "9000" }]);
    expect(attempts).toEqual([1000, 2500]);
    expect(delivered).toEqual(["preserve this message"]);
  } finally { api.stop(); }
});

test("whitespace-sensitive long Unicode output includes an exact UTF-8 attachment and retries it after 429", async () => {
  const content = ` \n${JSON.stringify({ text: `가🙂\u200b${"x".repeat(2005)}\u200b` })}\t `;
  const visible: string[] = [];
  const attachments: Uint8Array[] = [];
  let now = 0;
  const api = new DiscordApi(TOKEN, {
    now: () => now,
    maxRetries: 1,
    sleep: async ms => { now += ms; },
    fetchImpl: transport(async (url, init) => {
      if (url.pathname !== `/api/v10/channels/${CHANNEL}/messages`) return json({}, 404);
      if (init.body instanceof FormData) {
        const file = init.body.get("files[0]");
        if (!(file instanceof Blob)) return json({}, 400);
        attachments.push(new Uint8Array(await file.arrayBuffer()));
        return attachments.length === 1 ? json({ retry_after: 1 }, 429) : json({ id: "900" });
      }
      const body = JSON.parse(String(init.body));
      if (!body.content.trim()) return json({}, 400);
      visible.push(body.content);
      return json({ id: String(100 + visible.length) });
    }),
  });
  try {
    await api.sendMessage(CHANNEL, content);
    expect(attachments).toEqual([new TextEncoder().encode(content), new TextEncoder().encode(content)]);
    expect(now).toBe(1000);
    expect(visible.length).toBeGreaterThan(0);
  } finally { api.stop(); }
});

test("a rate-limited middle chunk is retried without losing or reordering a long Unicode answer", async () => {
  const content = Array.from({ length: 10 }, (_, i) => `${i}:${"한".repeat(1996)}😀`).join("");
  const attempted: string[] = [];
  const delivered: string[] = [];
  let now = 0;
  const api = new DiscordApi(TOKEN, {
    now: () => now, maxRetries: 1,
    sleep: async ms => { now += ms; },
    fetchImpl: transport((_url, init) => {
      const chunk = JSON.parse(String(init.body)).content as string;
      if (chunk.length > 2000 || !chunk.isWellFormed()) return json({}, 400);
      attempted.push(chunk);
      if (attempted.length === 4) return json({ retry_after: 2 }, 429);
      delivered.push(chunk);
      return json({ id: String(delivered.length) });
    }),
  });
  try {
    await api.sendMessage(CHANNEL, content);
    expect(delivered.length).toBeGreaterThan(8);
    expect(delivered.join("")).toBe(content);
    expect(attempted).toEqual([...delivered.slice(0, 3), delivered[3], ...delivered.slice(3)]);
    expect(now).toBe(2000);
  } finally { api.stop(); }
});

test("progress reactions accept empty 204 responses and preserve the target message", async () => {
  const operations: string[] = [];
  const api = new DiscordApi(TOKEN, { fetchImpl: transport((url, init) => {
    operations.push(`${init.method} ${decodeURIComponent(url.pathname)}`);
    return new Response(null, { status: 204 });
  }) });
  try {
    await api.addReaction(CHANNEL, "456", "👀");
    await api.removeReaction(CHANNEL, "456", "👀");
    await api.addReaction(CHANNEL, "456", "✅");
    expect(operations).toEqual([
      `PUT /api/v10/channels/${CHANNEL}/messages/456/reactions/👀/@me`,
      `DELETE /api/v10/channels/${CHANNEL}/messages/456/reactions/👀/@me`,
      `PUT /api/v10/channels/${CHANNEL}/messages/456/reactions/✅/@me`,
    ]);
  } finally { api.stop(); }
});

test("concurrent long replies remain contiguous instead of interleaving chunks", async () => {
  const firstEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered: { channel: string; content: string }[] = [];
  const api = new DiscordApi(TOKEN, { fetchImpl: transport(async (url, init) => {
    const content = JSON.parse(String(init.body)).content as string;
    delivered.push({ channel: url.pathname.split("/")[4]!, content });
    if (delivered.length === 1) { firstEntered.resolve(); await release.promise; }
    return json({ id: String(delivered.length) });
  }) });
  try {
    const first = api.sendMessage(CHANNEL, "a".repeat(4001));
    await firstEntered.promise;
    const second = api.sendMessage("222", "b".repeat(2001));
    release.resolve();
    await Promise.all([first, second]);
    expect(delivered.map(item => item.channel)).toEqual([CHANNEL, CHANNEL, CHANNEL, "222", "222"]);
    expect(delivered.filter(item => item.channel === CHANNEL).map(item => item.content).join("")).toBe("a".repeat(4001));
    expect(delivered.filter(item => item.channel === "222").map(item => item.content).join("")).toBe("b".repeat(2001));
  } finally { release.resolve(); api.stop(); }
});

test("failure to deliver the exact-copy attachment is surfaced after visible chunks", async () => {
  const delivered: string[] = [];
  const api = new DiscordApi(TOKEN, { fetchImpl: transport((_url, init) => {
    if (init.body instanceof FormData) return json({ message: "unavailable" }, 500);
    delivered.push(JSON.parse(String(init.body)).content);
    return json({ id: String(delivered.length) });
  }) });
  try {
    await expect(api.sendMessage(CHANNEL, ` ${"x".repeat(2001)} `)).rejects.toThrow("Discord HTTP 500");
    expect(delivered.join("")).toContain("x".repeat(2001));
  } finally { api.stop(); }
});

test("a forbidden progress reaction does not block delivery of the answer", async () => {
  const delivered: string[] = [];
  const api = new DiscordApi(TOKEN, { fetchImpl: transport((url, init) => {
    if (url.pathname.includes("/reactions/")) return json({ message: "missing permission" }, 403);
    delivered.push(JSON.parse(String(init.body)).content);
    return json({ id: "789" });
  }) });
  try {
    await expect(api.addReaction(CHANNEL, "456", "👀")).rejects.toThrow("Discord HTTP 403");
    expect(await api.sendMessage(CHANNEL, "answer after denied reaction")).toEqual([{ id: "789" }]);
    expect(delivered).toEqual(["answer after denied reaction"]);
  } finally { api.stop(); }
});

test("invalid bot authentication on a reaction prevents subsequent delivery", async () => {
  let requests = 0;
  const api = new DiscordApi(TOKEN, { fetchImpl: transport(() => { requests++; return json({}, 401); }) });
  try {
    await expect(api.addReaction(CHANNEL, "456", "👀")).rejects.toThrow("Discord HTTP 401");
    await expect(api.sendMessage(CHANNEL, "must not be delivered")).rejects.toThrow();
    expect(requests).toBe(1);
  } finally { api.stop(); }
});
