import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  SessionNotifyEndpoint,
  startSessionNotifyEndpoint,
  ensureSessionNotifyEndpoint,
  type RemoteUserMessage,
  type RemoteConfigCommand,
} from "../src/agent/notify/session-endpoint";
import { notifySessionEndpointPath } from "../src/agent/notify/paths";
import { SubagentRegistry } from "../src/agent/subagent-registry";

let endpoint: SessionNotifyEndpoint | undefined;
let sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {}
  }
  sockets = [];
  if (endpoint) {
    await endpoint.stop();
    endpoint = undefined;
  }
});

interface Discovery {
  url: string;
  token: string;
  pid: number;
  cwd: string;
}

async function readDiscovery(sessionId: string): Promise<Discovery> {
  const { notifySessionEndpointPath } = await import("../src/agent/notify/paths");
  const raw = await fs.readFile(notifySessionEndpointPath(sessionId), "utf-8");
  return JSON.parse(raw) as Discovery;
}

function connect(discovery: Discovery, token = discovery.token): WebSocket {
  const ws = new WebSocket(`${discovery.url}/?token=${encodeURIComponent(token)}`);
  sockets.push(ws);
  return ws;
}

function waitForMessage(ws: WebSocket, predicate: (msg: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
    const onMessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(msg);
      }
    };
    ws.addEventListener("message", onMessage);
  });
}

function waitForOpenOrClose(ws: WebSocket): Promise<"open" | "close"> {
  return new Promise(resolve => {
    ws.addEventListener("open", () => resolve("open"), { once: true });
    ws.addEventListener("close", () => resolve("close"), { once: true });
  });
}

test("start() publishes a discovery file and an initial snapshot is pushed on connect", async () => {
  const registry = new SubagentRegistry();
  registry.launch("executor", "do a thing", async () => ({ success: true, output: "ok" }));
  endpoint = new SessionNotifyEndpoint("/tmp/some-project");
  endpoint.attachRegistry(registry);
  await endpoint.start();

  const discovery = await readDiscovery(endpoint.sessionId);
  expect(discovery.pid).toBe(process.pid);
  expect(discovery.cwd).toBe("/tmp/some-project");
  expect(discovery.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

  const ws = connect(discovery);
  const snap = await waitForMessage(ws, m => m.type === "snapshot");
  expect(snap.sessionId).toBe(endpoint.sessionId);
  expect(Array.isArray(snap.subagents)).toBe(true);
  expect((snap.subagents as { role: string }[])[0]!.role).toBe("executor");
});

test("a wrong auth token is rejected (connection closes without a snapshot)", async () => {
  const registry = new SubagentRegistry();
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  endpoint.attachRegistry(registry);
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery, "wrong-token");
  const outcome = await waitForOpenOrClose(ws);
  expect(outcome).toBe("close");
});

test("{type:'list'} echoes a fresh snapshot on demand", async () => {
  const registry = new SubagentRegistry();
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  endpoint.attachRegistry(registry);
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot"); // initial push, drain it
  registry.launch("planner", "plan a thing", async () => ({ success: true, output: "ok" }));
  ws.send(JSON.stringify({ type: "list" }));
  const snap = await waitForMessage(ws, m => m.type === "snapshot" && (m.subagents as unknown[]).length === 1);
  expect((snap.subagents as { role: string }[])[0]!.role).toBe("planner");
});

test("steer on a running subagent applies via the real registry and acks ok:true", async () => {
  const registry = new SubagentRegistry();
  let release: (() => void) | undefined;
  const rec = registry.launch("executor", "long task", async (_signal, id) => {
    const drain = registry.steerDrainFor(id);
    await new Promise<void>(resolve => {
      release = resolve;
      const poll = setInterval(() => {
        if (drain().length > 0) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
    });
    return { success: true, output: "ok" };
  });
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  endpoint.attachRegistry(registry);
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot");

  ws.send(JSON.stringify({ type: "steer", reqId: "r1", id: rec.id, message: "please hurry" }));
  const ack = await waitForMessage(ws, m => m.type === "ack" && m.reqId === "r1");
  expect(ack.ok).toBe(true);
  await registry.awaitIds([rec.id], 2000);
  void release;
});

test("steer with an unknown id acks ok:false", async () => {
  const registry = new SubagentRegistry();
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  endpoint.attachRegistry(registry);
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot");
  ws.send(JSON.stringify({ type: "steer", reqId: "r2", id: "no-such-id", message: "hi" }));
  const ack = await waitForMessage(ws, m => m.type === "ack" && m.reqId === "r2");
  expect(ack.ok).toBe(false);
});

test("cancel actually cancels the registry record and pushes an updated snapshot", async () => {
  const registry = new SubagentRegistry();
  const rec = registry.launch("executor", "long task", async signal => {
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    return { success: true, output: "unreachable" };
  });
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  endpoint.attachRegistry(registry);
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot");

  ws.send(JSON.stringify({ type: "cancel", reqId: "r3", ids: [rec.id] }));
  const ack = await waitForMessage(ws, m => m.type === "ack" && m.reqId === "r3");
  expect(ack.ok).toBe(true);
  const snap = await waitForMessage(ws, m => m.type === "snapshot" && (m.subagents as { status: string }[])[0]?.status === "cancelled");
  expect((snap.subagents as { status: string }[])[0]!.status).toBe("cancelled");
});

test("stop() removes the discovery file", async () => {
  const registry = new SubagentRegistry();
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  endpoint.attachRegistry(registry);
  await endpoint.start();
  const sessionId = endpoint.sessionId;
  await readDiscovery(sessionId); // does not throw — file exists
  await endpoint.stop();
  endpoint = undefined;
  const { notifySessionEndpointPath } = await import("../src/agent/notify/paths");
  await expect(fs.readFile(notifySessionEndpointPath(sessionId), "utf-8")).rejects.toThrow();
});

// ── Part B: session-scoped lifecycle additions ──────────────────────────────

test("detachRegistry: list returns an empty subagents array and steer acks ok:false, even after a real running subagent was attached", async () => {
  const registry = new SubagentRegistry();
  const rec = registry.launch("executor", "long task", async signal => {
    const { promise, resolve } = Promise.withResolvers<void>();
    signal.addEventListener("abort", () => resolve());
    await promise;
    return { success: true, output: "ok" };
  });
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  endpoint.attachRegistry(registry);
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  const initial = await waitForMessage(ws, m => m.type === "snapshot");
  expect((initial.subagents as unknown[]).length).toBe(1); // sanity: registry really was live

  endpoint.detachRegistry();
  ws.send(JSON.stringify({ type: "list" }));
  const snap = await waitForMessage(ws, m => m.type === "snapshot");
  expect(snap.subagents).toEqual([]);

  ws.send(JSON.stringify({ type: "steer", reqId: "d1", id: rec.id, message: "hello" }));
  const ack = await waitForMessage(ws, m => m.type === "ack" && m.reqId === "d1");
  expect(ack.ok).toBe(false);

  registry.cancelAll();
});

test("sessionId: an explicit id is used as-is (incl. discovery file path); omitted falls back to a random UUID, different per instance", async () => {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  endpoint = new SessionNotifyEndpoint("/tmp/proj", "explicit-id-123");
  expect(endpoint.sessionId).toBe("explicit-id-123");
  await endpoint.start();
  const discovery = await readDiscovery("explicit-id-123");
  expect(discovery.cwd).toBe("/tmp/proj");
  expect(await fs.readFile(notifySessionEndpointPath("explicit-id-123"), "utf-8")).toBeTruthy();

  const a = new SessionNotifyEndpoint("/tmp/proj");
  const b = new SessionNotifyEndpoint("/tmp/proj");
  expect(a.sessionId).toMatch(uuidRe);
  expect(b.sessionId).toMatch(uuidRe);
  expect(a.sessionId).not.toBe(b.sessionId);
});

test("sendIdentity: a connected client receives an identity_header frame with sessionId + identity fields", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/some-project");
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot"); // initial push, drain it

  endpoint.sendIdentity({ repo: "jeo-code", branch: "main", cwd: "/tmp/some-project" });
  const msg = await waitForMessage(ws, m => m.type === "identity_header");
  expect(msg).toEqual({
    type: "identity_header",
    sessionId: endpoint.sessionId,
    repo: "jeo-code",
    branch: "main",
    cwd: "/tmp/some-project",
  });
});

test("sendContextUpdate: turn_start/turn_end frames carry sessionId+phase+summary, and merge `extra` only when provided", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot");

  endpoint.sendContextUpdate("turn_start", "user asked for X");
  const start = await waitForMessage(ws, m => m.type === "context_update" && m.phase === "turn_start");
  expect(start).toEqual({
    type: "context_update",
    sessionId: endpoint.sessionId,
    phase: "turn_start",
    summary: "user asked for X",
  });
  expect(start.model).toBeUndefined();
  expect(start.usage).toBeUndefined();

  endpoint.sendContextUpdate("turn_end", "replied with Y", { model: "claude-sonnet", usage: "120 tok" });
  const end = await waitForMessage(ws, m => m.type === "context_update" && m.phase === "turn_end");
  expect(end).toEqual({
    type: "context_update",
    sessionId: endpoint.sessionId,
    phase: "turn_end",
    summary: "replied with Y",
    model: "claude-sonnet",
    usage: "120 tok",
  });
});

test("sendTurnStream: a connected client receives the finalized turn_stream frame with the full text", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot");

  endpoint.sendTurnStream("the full final reply text");
  const msg = await waitForMessage(ws, m => m.type === "turn_stream");
  expect(msg).toEqual({
    type: "turn_stream",
    sessionId: endpoint.sessionId,
    phase: "finalized",
    text: "the full final reply text",
  });
});

test("onUserMessage: fires with {text, imagePaths} for a user_message frame sent from the client (callback set BEFORE connect)", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  const { promise, resolve } = Promise.withResolvers<RemoteUserMessage>();
  endpoint.onUserMessage = resolve;
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot");

  ws.send(JSON.stringify({ type: "user_message", text: "hello", imagePaths: ["/tmp/a.png"] }));
  const msg = await promise;
  expect(msg).toEqual({ text: "hello", imagePaths: ["/tmp/a.png"] });
});

test("onUserMessage: fires correctly when registered AFTER connect, and a frame with no imagePaths yields imagePaths: undefined", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot");

  const { promise, resolve } = Promise.withResolvers<RemoteUserMessage>();
  endpoint.onUserMessage = resolve;
  ws.send(JSON.stringify({ type: "user_message", text: "no images here" }));
  const msg = await promise;
  expect(msg.text).toBe("no images here");
  expect(msg.imagePaths).toBeUndefined();
});

test("onConfigCommand: fires with the correct partial RemoteConfigCommand shape for verbosity and for redact separately", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  const received: RemoteConfigCommand[] = [];
  endpoint.onConfigCommand = cmd => received.push(cmd);
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot");

  ws.send(JSON.stringify({ type: "config_command", verbosity: "verbose" }));
  ws.send(JSON.stringify({ type: "list" }));
  await waitForMessage(ws, m => m.type === "snapshot"); // sync point: verbosity frame already handled
  expect(received.length).toBe(1);
  expect(received[0]).toEqual({ verbosity: "verbose", redact: undefined });

  ws.send(JSON.stringify({ type: "config_command", redact: true }));
  ws.send(JSON.stringify({ type: "list" }));
  await waitForMessage(ws, m => m.type === "snapshot"); // sync point: redact frame already handled
  expect(received.length).toBe(2);
  expect(received[1]).toEqual({ verbosity: undefined, redact: true });
});

test("onConfigCommand: does NOT fire for a frame with neither verbosity nor redact set (or an invalid verbosity value)", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/proj");
  const received: RemoteConfigCommand[] = [];
  endpoint.onConfigCommand = cmd => received.push(cmd);
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery);
  await waitForMessage(ws, m => m.type === "snapshot");

  ws.send(JSON.stringify({ type: "config_command" }));
  ws.send(JSON.stringify({ type: "config_command", verbosity: "loud" })); // not a valid enum member
  ws.send(JSON.stringify({ type: "list" }));
  await waitForMessage(ws, m => m.type === "snapshot"); // sync point: both frames already handled
  expect(received.length).toBe(0);
});

test("startSessionNotifyEndpoint: returns undefined and writes no discovery file when notifications.enabled is unset (no config file at all)", async () => {
  const savedCfgDir = process.env.JEO_CONFIG_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-endpoint-"));
  process.env.JEO_CONFIG_DIR = dir;
  try {
    const result = await startSessionNotifyEndpoint("/tmp/proj", "some-session-id");
    expect(result).toBeUndefined();
    const sessionsDir = path.join(dir, "notifications", "sessions");
    await expect(fs.readdir(sessionsDir)).rejects.toThrow(); // directory never created
  } finally {
    if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfgDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("startSessionNotifyEndpoint: returns undefined and writes no discovery file when notifications.enabled is explicitly false", async () => {
  const savedCfgDir = process.env.JEO_CONFIG_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-endpoint-"));
  process.env.JEO_CONFIG_DIR = dir;
  try {
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ providers: {}, defaultModel: "claude-sonnet-4-6", notifications: { enabled: false } }),
    );
    const result = await startSessionNotifyEndpoint("/tmp/proj", "some-session-id");
    expect(result).toBeUndefined();
    const sessionsDir = path.join(dir, "notifications", "sessions");
    await expect(fs.readdir(sessionsDir)).rejects.toThrow();
  } finally {
    if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfgDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("startSessionNotifyEndpoint: positive control — with notifications.enabled true, it starts the endpoint and publishes the discovery file", async () => {
  const savedCfgDir = process.env.JEO_CONFIG_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-endpoint-"));
  process.env.JEO_CONFIG_DIR = dir;
  let started: SessionNotifyEndpoint | undefined;
  try {
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ providers: {}, defaultModel: "claude-sonnet-4-6", notifications: { enabled: true } }),
    );
    started = await startSessionNotifyEndpoint("/tmp/proj", "enabled-session-id");
    expect(started).toBeDefined();
    expect(started!.sessionId).toBe("enabled-session-id");
    const raw = await fs.readFile(path.join(dir, "notifications", "sessions", "enabled-session-id.json"), "utf-8");
    expect(JSON.parse(raw).cwd).toBe("/tmp/proj");
  } finally {
    if (started) await started.stop();
    if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfgDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ensureSessionNotifyEndpoint: when sessionEndpoint is passed, it attachRegistry()s onto THAT instance and creates no second endpoint/discovery file", async () => {
  const savedCfgDir = process.env.JEO_CONFIG_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-ensure-session-endpoint-"));
  process.env.JEO_CONFIG_DIR = dir;
  try {
    endpoint = new SessionNotifyEndpoint("/tmp/proj", "the-only-session");
    await endpoint.start();
    const discovery = await readDiscovery("the-only-session");
    const ws = connect(discovery);
    await waitForMessage(ws, m => m.type === "snapshot"); // initial empty snapshot, drain it

    const registry = new SubagentRegistry();
    registry.launch("executor", "do a thing", async () => ({ success: true, output: "ok" }));
    ensureSessionNotifyEndpoint(registry, "/tmp/proj", endpoint);

    ws.send(JSON.stringify({ type: "list" }));
    const snap = await waitForMessage(ws, m => m.type === "snapshot" && (m.subagents as unknown[]).length === 1);
    expect((snap.subagents as { role: string }[])[0]!.role).toBe("executor");

    const sessionFiles = await fs.readdir(path.join(dir, "notifications", "sessions"));
    expect(sessionFiles).toEqual(["the-only-session.json"]); // no second discovery file
  } finally {
    if (endpoint) {
      await endpoint.stop();
      endpoint = undefined;
    }
    if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfgDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
