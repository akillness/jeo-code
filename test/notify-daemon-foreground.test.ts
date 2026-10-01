import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNotifyDaemonForeground, type NotifyForegroundOptions } from "../src/agent/notify/telegram-daemon";
import { acquireDaemonLock, daemonStatus, readDaemonLock, startDaemon } from "../src/agent/notify/daemon-control";
import { saveConfigPatch } from "../src/agent/state";

type Signal = "SIGTERM" | "SIGINT";
class FakeSignals {
  private listeners: Record<Signal, Set<() => void>> = { SIGTERM: new Set(), SIGINT: new Set() };
  on(signal: Signal, listener: () => void) { this.listeners[signal].add(listener); }
  off(signal: Signal, listener: () => void) { this.listeners[signal].delete(listener); }
  emit(signal: Signal) { for (const listener of this.listeners[signal]) listener(); }
  get count() { return this.listeners.SIGTERM.size + this.listeners.SIGINT.size; }
}

let directory: string;
let priorConfig: string | undefined;
let priorExitCode: typeof process.exitCode;
beforeEach(async () => {
  priorConfig = process.env.JEO_CONFIG_DIR;
  priorExitCode = process.exitCode;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-foreground-test-"));
  process.env.JEO_CONFIG_DIR = directory;
  process.exitCode = 0;
});
afterEach(async () => {
  if (priorConfig === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = priorConfig;
  process.exitCode = priorExitCode ?? 0;
  await fs.rm(directory, { recursive: true, force: true });
});

const discordConfig = { botToken: "fake-discord-token", channelId: "123456789012345678", allowedUserIds: ["234567890123456789"] };
const telegramConfig = { botToken: "fake-telegram-token", chatId: "999", allowedUserIds: ["999"] };

function telegramFetch(reply: (method: string) => unknown | Promise<unknown>) {
  const implementation = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Response.json(await reply(url.pathname.split("/").at(-1)!));
  };
  // Foreground uses only the standard fetch call, not Bun's preconnect extension.
  return implementation as typeof fetch;
}

test.each([
  { mode: "Discord only", telegram: false, signal: "SIGTERM" as const },
  { mode: "both providers", telegram: true, signal: "SIGINT" as const },
])("foreground $mode becomes ready only after startup and releases all ownership on $signal", async ({ telegram, signal }) => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, discord: discordConfig, ...(telegram ? { telegram: telegramConfig } : {}) } }));
  const signals = new FakeSignals();
  const discordEntered = Promise.withResolvers<void>();
  const finishDiscordStartup = Promise.withResolvers<void>();
  const stopTelegram = Promise.withResolvers<void>();
  const active = new Set<string>();
  const checks: string[] = [];
  let foreground: Promise<void> | undefined;
  const start = startDaemon(() => {
    foreground = runNotifyDaemonForeground({
      signals,
      createDiscord: () => ({
        async start() { discordEntered.resolve(); await finishDiscordStartup.promise; active.add("discord"); },
        stop() { active.delete("discord"); },
      }),
      createTelegram: () => ({
        async start() { active.add("telegram"); await stopTelegram.promise; },
        stop() { active.delete("telegram"); stopTelegram.resolve(); },
      }),
      fetchImpl: telegramFetch(method => {
        checks.push(method);
        if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true } };
        if (method === "getChat") return { ok: true, result: { id: 999, type: "private" } };
        throw new Error("Unexpected foreground platform operation");
      }),
    });
    return { unref() {} };
  });
  try {
    await discordEntered.promise;
    expect((await daemonStatus()).ready).toBe(false);
    expect(await acquireDaemonLock()).toBeUndefined();
    finishDiscordStartup.resolve();
    const result = await start;
    expect(result.ok).toBe(true);
    expect((await daemonStatus()).ready).toBe(true);
    expect([...active].sort()).toEqual(telegram ? ["discord", "telegram"] : ["discord"]);
    expect(checks).toEqual(telegram ? ["getMe", "getChat"] : []);
    signals.emit(signal);
    await foreground;
    expect([...active]).toEqual([]);
    expect(signals.count).toBe(0);
    expect(await readDaemonLock()).toBeUndefined();
    expect(process.exitCode).toBe(0);
  } finally {
    finishDiscordStartup.resolve();
    signals.emit(signal);
    stopTelegram.resolve();
    await foreground;
    await start;
  }
});

test("failed Telegram API preflight never publishes readiness and stops an already-started Discord transport", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, discord: discordConfig, telegram: telegramConfig } }));
  const signals = new FakeSignals();
  const preflightEntered = Promise.withResolvers<void>();
  const releasePreflight = Promise.withResolvers<void>();
  let discordActive = false;
  let telegramStarted = false;
  const foreground = runNotifyDaemonForeground({
    signals,
    createDiscord: () => ({ async start() { discordActive = true; }, stop() { discordActive = false; } }),
    createTelegram: () => ({ async start() { telegramStarted = true; }, stop() {} }),
    fetchImpl: telegramFetch(async method => {
      if (method === "getMe") {
        preflightEntered.resolve();
        await releasePreflight.promise;
        return { ok: false, description: "Unauthorized" };
      }
      if (method === "getChat") return { ok: true, result: { id: 999, type: "private" } };
      throw new Error("Unexpected foreground platform operation");
    }),
  });
  try {
    await preflightEntered.promise;
    expect(discordActive).toBe(true);
    expect((await daemonStatus()).ready).toBe(false);
    releasePreflight.resolve();
    await foreground;
    expect(process.exitCode).toBe(1);
    expect(discordActive).toBe(false);
    expect(telegramStarted).toBe(false);
    expect(signals.count).toBe(0);
    expect(await readDaemonLock()).toBeUndefined();
    const next = await acquireDaemonLock();
    expect(next).toBeDefined();
    await next?.release();
  } finally {
    releasePreflight.resolve();
    signals.emit("SIGTERM");
    await foreground;
  }
});

test("a signal during Discord startup prevents readiness and cleans resources created by late startup completion", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, discord: discordConfig } }));
  const signals = new FakeSignals();
  const startupEntered = Promise.withResolvers<void>();
  const finishStartup = Promise.withResolvers<void>();
  let resourceActive = false;
  const foreground = runNotifyDaemonForeground({
    signals,
    createDiscord: () => ({
      async start() { startupEntered.resolve(); await finishStartup.promise; resourceActive = true; },
      stop() { resourceActive = false; },
    }),
    fetchImpl: telegramFetch(() => { throw new Error("Discord-only startup must not call Telegram"); }),
  });
  try {
    await startupEntered.promise;
    signals.emit("SIGTERM");
    expect((await daemonStatus()).ready).toBe(false);
    finishStartup.resolve();
    await foreground;
    expect(resourceActive).toBe(false);
    expect(signals.count).toBe(0);
    expect(await readDaemonLock()).toBeUndefined();
  } finally {
    finishStartup.resolve();
    signals.emit("SIGTERM");
    await foreground;
  }
});

test("transient Discord errors preserve service but fatal errors stop both providers and release ownership", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, discord: discordConfig, telegram: telegramConfig } }));
  const signals = new FakeSignals();
  const stopTelegram = Promise.withResolvers<void>();
  const active = new Set<string>();
  let discordEvents: Parameters<NonNullable<NotifyForegroundOptions["createDiscord"]>>[1] | undefined;
  let foreground: Promise<void> | undefined;
  const started = startDaemon(() => {
    foreground = runNotifyDaemonForeground({
      signals,
      createDiscord: (_config, dependencies) => {
        discordEvents = dependencies;
        return {
          async start() { active.add("discord"); },
          stop() { active.delete("discord"); },
        };
      },
      createTelegram: () => ({
        async start() { active.add("telegram"); await stopTelegram.promise; },
        stop() { active.delete("telegram"); stopTelegram.resolve(); },
      }),
      fetchImpl: telegramFetch(method => {
        if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true } };
        if (method === "getChat") return { ok: true, result: { id: 999, type: "private" } };
        throw new Error("Unexpected foreground platform operation");
      }),
    });
    return { unref() {} };
  });
  try {
    expect((await started).ok).toBe(true);
    discordEvents!.onError?.("temporary notification delivery failure");
    expect((await daemonStatus()).ready).toBe(true);
    expect([...active].sort()).toEqual(["discord", "telegram"]);
    expect(process.exitCode).toBe(0);
    expect(await acquireDaemonLock()).toBeUndefined();

    discordEvents!.onFatal?.("gateway authentication rejected");
    expect(process.exitCode).toBe(1);
    expect([...active]).toEqual([]);
    await foreground;
    expect(signals.count).toBe(0);
    expect(await readDaemonLock()).toBeUndefined();
    const replacement = await acquireDaemonLock();
    expect(replacement).toBeDefined();
    await replacement?.release();
  } finally {
    signals.emit("SIGTERM");
    stopTelegram.resolve();
    await foreground;
    await started;
  }
});

const slackConfig = { botToken: "xoxb-test", appToken: "xapp-test", channelId: "CTARGET", allowedUserIds: ["UOWNER"] };

test.each([
  { mode: "Slack only", siblings: false, signal: "SIGTERM" as const },
  { mode: "all three providers", siblings: true, signal: "SIGINT" as const },
])("foreground $mode cleans every transport and releases lock ownership on $signal", async ({ siblings, signal }) => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, slack: slackConfig,
    ...(siblings ? { telegram: telegramConfig, discord: discordConfig } : {}),
  } }));
  const signals = new FakeSignals();
  const stopTelegram = Promise.withResolvers<void>();
  const active = new Set<string>();
  let foreground: Promise<void> | undefined;
  const started = startDaemon(() => {
    foreground = runNotifyDaemonForeground({
      signals,
      createSlack: () => ({ async start() { active.add("slack"); }, stop() { active.delete("slack"); } }),
      createDiscord: () => ({ async start() { active.add("discord"); }, stop() { active.delete("discord"); } }),
      createTelegram: () => ({ async start() { active.add("telegram"); await stopTelegram.promise; }, stop() { active.delete("telegram"); stopTelegram.resolve(); } }),
      fetchImpl: telegramFetch(method => {
        if (!siblings) throw new Error("Slack-only lifecycle must not contact Telegram");
        if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true } };
        if (method === "getChat") return { ok: true, result: { id: 999, type: "private" } };
        throw new Error("Unexpected foreground platform operation");
      }),
    });
    return { unref() {} };
  });
  try {
    expect((await started).ok).toBe(true);
    expect([...active].sort()).toEqual(siblings ? ["discord", "slack", "telegram"] : ["slack"]);
    expect(await acquireDaemonLock()).toBeUndefined();
    signals.emit(signal);
    await foreground;
    expect([...active]).toEqual([]);
    expect(signals.count).toBe(0);
    expect(await readDaemonLock()).toBeUndefined();
    expect(process.exitCode).toBe(0);
  } finally {
    signals.emit(signal);
    stopTelegram.resolve();
    await foreground;
    await started;
  }
}, 20_000);

test("Slack transient errors retain siblings but fatal Socket Mode failure shuts down every provider and frees the lock", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, slack: slackConfig, discord: discordConfig, telegram: telegramConfig } }));
  const signals = new FakeSignals();
  const stopTelegram = Promise.withResolvers<void>();
  const active = new Set<string>();
  let events: Parameters<NonNullable<NotifyForegroundOptions["createSlack"]>>[1] | undefined;
  let foreground: Promise<void> | undefined;
  const started = startDaemon(() => {
    foreground = runNotifyDaemonForeground({
      signals,
      createSlack: (_config, dependencies) => {
        events = dependencies;
        return { async start() { active.add("slack"); }, stop() { active.delete("slack"); } };
      },
      createDiscord: () => ({ async start() { active.add("discord"); }, stop() { active.delete("discord"); } }),
      createTelegram: () => ({ async start() { active.add("telegram"); await stopTelegram.promise; }, stop() { active.delete("telegram"); stopTelegram.resolve(); } }),
      fetchImpl: telegramFetch(method => {
        if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true } };
        if (method === "getChat") return { ok: true, result: { id: 999, type: "private" } };
        throw new Error("Unexpected foreground platform operation");
      }),
    });
    return { unref() {} };
  });
  try {
    expect((await started).ok).toBe(true);
    expect([...active].sort()).toEqual(["discord", "slack", "telegram"]);
    events!.onError?.("transient delivery error");
    expect((await daemonStatus()).ready).toBe(true);
    expect([...active].sort()).toEqual(["discord", "slack", "telegram"]);
    events!.onFatal?.("invalid app credentials");
    await foreground;
    expect(process.exitCode).toBe(1);
    expect([...active]).toEqual([]);
    expect(signals.count).toBe(0);
    expect(await readDaemonLock()).toBeUndefined();
    const replacement = await acquireDaemonLock();
    expect(replacement).toBeDefined();
    await replacement?.release();
  } finally {
    signals.emit("SIGTERM");
    stopTelegram.resolve();
    await foreground;
    await started;
  }
});

test("Slack startup interrupted by a signal never publishes readiness or leaks late-created resources", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, slack: slackConfig } }));
  const signals = new FakeSignals();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let active = false;
  const foreground = runNotifyDaemonForeground({
    signals,
    createSlack: () => ({
      async start() { entered.resolve(); await finish.promise; active = true; },
      stop() { active = false; },
    }),
    fetchImpl: telegramFetch(() => { throw new Error("Slack-only startup must not contact Telegram"); }),
  });
  try {
    await Promise.race([entered.promise, foreground]);
    expect(await readDaemonLock()).toBeDefined();
    expect((await daemonStatus()).ready).toBe(false);
    signals.emit("SIGTERM");
    finish.resolve();
    await foreground;
    expect(active).toBe(false);
    expect(signals.count).toBe(0);
    expect(await readDaemonLock()).toBeUndefined();
    expect(process.exitCode).toBe(0);
  } finally {
    finish.resolve();
    signals.emit("SIGTERM");
    await foreground;
  }
});

test.each(["auth.test", "conversations.info"])("SIGTERM aborting Slack %s startup is a clean shutdown, not a startup failure", async pendingMethod => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, slack: slackConfig, discord: discordConfig } }));
  const signals = new FakeSignals();
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  let discordActive = false;
  const diagnostics: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation(chunk => { diagnostics.push(String(chunk)); return true; });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = new URL(input instanceof Request ? input.url : String(input)).pathname.split("/").at(-1);
    if (method === pendingMethod) {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) { reject(new Error("Startup request must carry a cancellation signal")); return; }
        const abort = () => { aborted = true; reject(signal.reason); };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        entered.resolve();
      });
    }
    if (method === "auth.test") return Response.json({ ok: true, user_id: "UJEOBOT", bot_id: "BJEOBOT", team_id: "TWORK" });
    if (method === "bots.info") return Response.json({ ok: true, bot: { id: "BJEOBOT", user_id: "UJEOBOT", app_id: "AAPP" } });
    throw new Error(`Unexpected request during held startup: ${method}`);
  }) as typeof fetch;
  const foreground = runNotifyDaemonForeground({
    signals, fetchImpl,
    createDiscord: () => ({ async start() { discordActive = true; }, stop() { discordActive = false; } }),
  });
  try {
    await Promise.race([entered.promise, foreground]);
    expect(discordActive).toBe(true);
    expect((await daemonStatus()).ready).toBe(false);
    signals.emit("SIGTERM");
    await foreground;
    expect(aborted).toBe(true);
    expect(process.exitCode).toBe(0);
    expect(diagnostics.join("\n")).not.toContain("startup failed");
    expect(discordActive).toBe(false);
    expect(signals.count).toBe(0);
    expect(await readDaemonLock()).toBeUndefined();
  } finally {
    signals.emit("SIGTERM");
    await foreground;
    stderr.mockRestore();
  }
});

test("Slack credential failure during startup remains an error and stops initialized siblings", async () => {
  await saveConfigPatch(() => ({ notifications: { enabled: true, slack: slackConfig, discord: discordConfig } }));
  const signals = new FakeSignals();
  const entered = Promise.withResolvers<void>();
  const rejectCredentials = Promise.withResolvers<void>();
  let discordActive = false;
  const diagnostics: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation(chunk => { diagnostics.push(String(chunk)); return true; });
  const fetchImpl = (async () => {
    entered.resolve();
    await rejectCredentials.promise;
    return Response.json({ ok: false, error: "invalid_auth" });
  }) as typeof fetch;
  const foreground = runNotifyDaemonForeground({
    signals, fetchImpl,
    createDiscord: () => ({ async start() { discordActive = true; }, stop() { discordActive = false; } }),
  });
  try {
    await Promise.race([entered.promise, foreground]);
    expect(discordActive).toBe(true);
    expect((await daemonStatus()).ready).toBe(false);
    rejectCredentials.resolve();
    await foreground;
    expect(process.exitCode).toBe(1);
    expect(diagnostics.join("\n")).toContain("startup failed");
    expect(discordActive).toBe(false);
    expect(signals.count).toBe(0);
    expect(await readDaemonLock()).toBeUndefined();
  } finally {
    rejectCredentials.resolve();
    signals.emit("SIGTERM");
    await foreground;
    stderr.mockRestore();
  }
});
