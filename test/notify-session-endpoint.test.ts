import { test, expect, beforeEach, afterEach } from "bun:test";
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
import { createDiscordArtifactStage } from "../src/agent/notify/discord-artifacts";

let endpoint: SessionNotifyEndpoint | undefined;
let sockets: WebSocket[] = [];
let endpointDir: string;
let previousConfigDir: string | undefined;

beforeEach(async () => {
  previousConfigDir = process.env.JEO_CONFIG_DIR;
  endpointDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-endpoint-security-"));
  process.env.JEO_CONFIG_DIR = endpointDir;
});

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
  if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = previousConfigDir;
  await fs.rm(endpointDir, { recursive: true, force: true });
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

test("malformed and null frames cannot invoke handlers or prevent a subsequent valid request", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  const received: RemoteUserMessage[] = [];
  const commands: RemoteConfigCommand[] = [];
  endpoint.onUserMessage = message => { received.push(message); };
  endpoint.onConfigCommand = command => commands.push(command);
  await endpoint.start();
  const ws = connect(await readDiscovery(endpoint.sessionId));
  await waitForMessage(ws, message => message.type === "snapshot");
  for (const raw of ["{", "null", "[]", "42", '"user_message"', JSON.stringify({ type: "user_message", text: 42 }), JSON.stringify({ type: "config_command", redact: "true" })]) ws.send(raw);
  const completed = waitForMessage(ws, message => message.type === "ack" && message.reqId === "valid");
  ws.send(JSON.stringify({ type: "user_message", text: "still connected", reqId: "valid" }));
  expect(await completed).toEqual({ type: "ack", reqId: "valid", ok: true });
  expect(received).toEqual([{ text: "still connected", imagePaths: undefined }]);
  expect(commands).toEqual([]);
});

test.each([
  { type: "user_message", text: "hello" },
])("$type is acknowledged as rejected when no consumer exists", async frame => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  await endpoint.start();
  const ws = connect(await readDiscovery(endpoint.sessionId));
  await waitForMessage(ws, message => message.type === "snapshot");
  const rejected = waitForMessage(ws, message => message.type === "ack" && message.reqId === "unhandled");
  ws.send(JSON.stringify({ ...frame, reqId: "unhandled" }));
  expect(await rejected).toEqual({ type: "ack", reqId: "unhandled", ok: false });
});

test("identity published before connection is replayed with latest identity on reconnection", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  endpoint.sendIdentity({ repo: "project", branch: "first", cwd: "/tmp/project" });
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const first = connect(discovery);
  expect(await waitForMessage(first, frame => frame.type === "identity_header")).toEqual({
    type: "identity_header", sessionId: endpoint.sessionId, repo: "project", branch: "first", cwd: "/tmp/project",
  });
  endpoint.sendIdentity({ repo: "project", branch: "second", cwd: "/tmp/project" });
  const second = connect(discovery);
  expect(await waitForMessage(second, frame => frame.type === "identity_header")).toEqual({
    type: "identity_header", sessionId: endpoint.sessionId, repo: "project", branch: "second", cwd: "/tmp/project",
  });
});

test("slash user messages are rejected rather than executing the session command surface", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  const received: RemoteUserMessage[] = [];
  endpoint.onUserMessage = message => { received.push(message); };
  await endpoint.start();
  const ws = connect(await readDiscovery(endpoint.sessionId));
  await waitForMessage(ws, message => message.type === "snapshot");
  for (const text of ["/shell dangerous", "  /model untrusted"]) {
    const rejected = waitForMessage(ws, message => message.type === "ack" && message.reqId === text);
    ws.send(JSON.stringify({ type: "user_message", text, reqId: text }));
    expect(await rejected).toEqual({ type: "ack", reqId: text, ok: false });
  }
  expect(received).toEqual([]);
});

test.each([
  { name: "refused", handler: () => false },
  { name: "asynchronously refused", handler: async () => false },
  { name: "thrown", handler: () => { throw new Error("handler unavailable"); } },
  { name: "rejected promise", handler: async () => { throw new Error("handler unavailable"); } },
])("user message $name by the consumer returns a negative ACK", async ({ handler }) => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  endpoint.onUserMessage = handler;
  await endpoint.start();
  const ws = connect(await readDiscovery(endpoint.sessionId));
  await waitForMessage(ws, message => message.type === "snapshot");
  const rejected = waitForMessage(ws, message => message.type === "ack" && message.reqId === "failed-handler");
  ws.send(JSON.stringify({ type: "user_message", text: "hello", reqId: "failed-handler" }));
  expect(await rejected).toEqual({ type: "ack", reqId: "failed-handler", ok: false });
});

test("a cross-session user frame is ignored without invoking the consumer", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  const received: RemoteUserMessage[] = [];
  endpoint.onUserMessage = message => { received.push(message); };
  await endpoint.start();
  const ws = connect(await readDiscovery(endpoint.sessionId));
  await waitForMessage(ws, message => message.type === "snapshot");
  ws.send(JSON.stringify({ type: "user_message", sessionId: "other-session", text: "wrong target" }));
  const accepted = waitForMessage(ws, message => message.type === "ack" && message.reqId === "right-target");
  ws.send(JSON.stringify({ type: "user_message", sessionId: endpoint.sessionId, text: "right target", reqId: "right-target" }));
  expect(await accepted).toEqual({ type: "ack", reqId: "right-target", ok: true });
  expect(received).toEqual([{ text: "right target", imagePaths: undefined }]);
});

test("local relay only receives finals from turns started within its current opt-in generation", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  await endpoint.start();
  const ws = connect(await readDiscovery(endpoint.sessionId));
  await waitForMessage(ws, message => message.type === "snapshot");
  const finals: string[] = [];
  ws.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.type === "local_final") finals.push(message.text);
  });
  const setRelay = async (enabled: boolean, reqId: string) => {
    const control = waitForMessage(ws, message => message.type === "local_relay_control");
    endpoint!.requestLocalRelay(enabled ? "123456789012345678" : "off");
    const generation = (await control).generation;
    const ack = waitForMessage(ws, message => message.type === "ack" && message.reqId === reqId);
    ws.send(JSON.stringify({ type: "local_relay", sessionId: endpoint!.sessionId, enabled, reqId, generation }));
    expect(await ack).toEqual({ type: "ack", reqId, ok: true });
  };
  await setRelay(true, "enable");
  const oldGeneration = endpoint.localRelayGeneration()!;
  endpoint.sendLocalFinal("first local answer", oldGeneration);
  await setRelay(false, "disable");
  await setRelay(true, "re-enable");
  endpoint.sendLocalFinal("stale answer", oldGeneration);
  const generation = endpoint.localRelayGeneration()!;
  endpoint.sendLocalFinal("new local answer", generation);
  await setRelay(false, "barrier");
  expect(finals).toEqual(["first local answer", "new local answer"]);
});

test("disconnecting the originating socket aborts its accepted remote request, but another socket does not", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  endpoint.setDiscordControlEnabled(true);
  const aborted = Promise.withResolvers<void>();
  let remoteSignal: AbortSignal | undefined;
  endpoint.onRemoteRequest = (_text, _finish, signal: AbortSignal) => {
    remoteSignal = signal;
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return true;
  };
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const origin = connect(discovery);
  await waitForMessage(origin, message => message.type === "snapshot");
  const other = connect(discovery);
  await waitForMessage(other, message => message.type === "snapshot");
  const accepted = waitForMessage(origin, message => message.type === "ack" && message.reqId === "request");
  origin.send(JSON.stringify({ type: "remote_request", sessionId: endpoint.sessionId, reqId: "request", text: "investigate", controlGeneration: 1 }));
  expect(await accepted).toEqual({ type: "ack", reqId: "request", ok: true });
  other.close();
  const barrier = waitForMessage(origin, message => message.type === "snapshot");
  origin.send(JSON.stringify({ type: "list" }));
  await barrier;
  expect(remoteSignal?.aborted).toBe(false);
  origin.close();
  await aborted.promise;
  expect(remoteSignal?.aborted).toBe(true);
});

test("remote cancellation requires the owning socket and matching request ID", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  endpoint.setDiscordControlEnabled(true);
  const aborted = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  endpoint.onRemoteRequest = (_text, _finish, ownerSignal) => {
    signal = ownerSignal;
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return true;
  };
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const owner = connect(discovery);
  await waitForMessage(owner, message => message.type === "snapshot");
  const other = connect(discovery);
  await waitForMessage(other, message => message.type === "snapshot");
  const ack = waitForMessage(owner, message => message.type === "ack" && message.reqId === "owned");
  owner.send(JSON.stringify({ type: "remote_request", sessionId: endpoint.sessionId, reqId: "owned", text: "investigate", controlGeneration: 1 }));
  expect(await ack).toEqual({ type: "ack", reqId: "owned", ok: true });
  const barrier = async (ws: WebSocket) => {
    const snapshot = waitForMessage(ws, message => message.type === "snapshot");
    ws.send(JSON.stringify({ type: "list" }));
    await snapshot;
  };
  owner.send(JSON.stringify({ type: "remote_cancel", sessionId: endpoint.sessionId, reqId: "wrong" }));
  other.send(JSON.stringify({ type: "remote_cancel", sessionId: endpoint.sessionId, reqId: "owned" }));
  await Promise.all([barrier(owner), barrier(other)]);
  expect(signal?.aborted).toBe(false);
  owner.send(JSON.stringify({ type: "remote_cancel", sessionId: endpoint.sessionId, reqId: "owned" }));
  await aborted.promise;
  expect(signal?.aborted).toBe(true);
});

test("remote control requires local consent and revocation aborts the active request", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  const received: string[] = [];
  const aborted = Promise.withResolvers<void>();
  endpoint.onRemoteRequest = (text, _finish, signal) => {
    received.push(text);
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return true;
  };
  await endpoint.start();
  const ws = connect(await readDiscovery(endpoint.sessionId));
  await waitForMessage(ws, message => message.type === "snapshot");
  const request = async (reqId: string, text: string) => {
    const ack = waitForMessage(ws, message => message.type === "ack" && message.reqId === reqId);
    ws.send(JSON.stringify({ type: "remote_request", sessionId: endpoint!.sessionId, reqId, text, controlGeneration: 1 }));
    return ack;
  };
  expect(await request("before", "before consent")).toEqual({ type: "ack", reqId: "before", ok: false });
  endpoint.setDiscordControlEnabled(true);
  expect(await request("active", "after consent")).toEqual({ type: "ack", reqId: "active", ok: true });
  endpoint.setDiscordControlEnabled(false);
  await aborted.promise;
  expect(await request("after", "after revocation")).toEqual({ type: "ack", reqId: "after", ok: false });
  expect(received).toEqual(["after consent"]);
});

test("Discord subagent cancellation cannot run before local control consent", async () => {
  const registry = new SubagentRegistry();
  const aborted = Promise.withResolvers<void>();
  const record = registry.launch("executor", "work", async signal => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    await aborted.promise;
    return { success: false, output: "cancelled" };
  });
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  endpoint.attachRegistry(registry);
  await endpoint.start();
  const ws = connect(await readDiscovery(endpoint.sessionId));
  await waitForMessage(ws, message => message.type === "snapshot");
  const cancel = async (reqId: string, generation: number) => {
    const ack = waitForMessage(ws, message => message.type === "ack" && message.reqId === reqId);
    ws.send(JSON.stringify({ type: "discord_cancel", sessionId: endpoint!.sessionId, reqId, ids: [record.id], controlGeneration: generation }));
    return ack;
  };
  expect(await cancel("denied", 0)).toEqual({ type: "ack", reqId: "denied", ok: false });
  const control = waitForMessage(ws, message => message.type === "discord_control" && message.enabled === true);
  endpoint.setDiscordControlEnabled(true);
  const generation = (await control).generation as number;
  expect(await cancel("stale", generation - 1)).toEqual({ type: "ack", reqId: "stale", ok: false });
  const steer = async (reqId: string, generation: number) => {
    const ack = waitForMessage(ws, message => message.type === "ack" && message.reqId === reqId);
    ws.send(JSON.stringify({ type: "discord_steer", sessionId: endpoint!.sessionId, reqId, id: record.id, message: "focus", controlGeneration: generation }));
    return ack;
  };
  expect(await steer("stale-steer", generation - 1)).toEqual({ type: "ack", reqId: "stale-steer", ok: false });
  expect(await steer("valid-steer", generation)).toEqual({ type: "ack", reqId: "valid-steer", ok: true });
  expect(registry.steerDrainFor(record.id)()).toEqual(["focus"]);
  expect(await cancel("allowed", generation)).toEqual({ type: "ack", reqId: "allowed", ok: true });
  await aborted.promise;
});

test("staged remote requests use only the private resolved directory and require explicit artifact approval", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  endpoint.setDiscordControlEnabled(true);
  const calls: { text: string; output?: string; finish: (text?: string, allowed?: boolean) => void }[] = [];
  endpoint.onRemoteRequest = (text, finish, _signal, stage) => { calls.push({ text, output: stage?.output, finish }); return true; };
  await endpoint.start();
  const ws = connect(await readDiscovery(endpoint.sessionId));
  await waitForMessage(ws, message => message.type === "snapshot");
  const stageId = crypto.randomUUID();
  const stage = await createDiscordArtifactStage(endpoint.sessionId, stageId);
  const send = async (reqId: string, extra: Record<string, unknown> = {}) => {
    const ack = waitForMessage(ws, message => message.type === "ack" && message.reqId === reqId);
    ws.send(JSON.stringify({ type: "remote_request", sessionId: endpoint!.sessionId, reqId, text: "  unchanged prompt 🙂  ", controlGeneration: 1, ...extra }));
    return ack;
  };
  try {
    const forged = crypto.randomUUID();
    expect((await send(forged, { staged: true, output: stage.directory })).ok).toBe(false);
    expect((await send(crypto.randomUUID(), { staged: true })).ok).toBe(false);
    expect(calls).toEqual([]);
    expect((await send(stageId, { staged: true })).ok).toBe(true);
    expect({ text: calls[0]!.text, output: calls[0]!.output }).toEqual({ text: "  unchanged prompt 🙂  ", output: stage.directory });
    const stagedFinal = waitForMessage(ws, message => message.type === "remote_final" && message.reqId === stageId);
    calls[0]!.finish("redacted answer", false);
    expect((await stagedFinal).artifactsAllowed).toBe(false);
    const plainId = crypto.randomUUID();
    expect((await send(plainId)).ok).toBe(true);
    const plainFinal = waitForMessage(ws, message => message.type === "remote_final" && message.reqId === plainId);
    calls[1]!.finish("answer", true);
    expect((await plainFinal).artifactsAllowed).toBe(false);
    expect((await send(stageId, { staged: true })).ok).toBe(true);
    const allowedFinal = waitForMessage(ws, message => message.type === "remote_final" && message.reqId === stageId);
    calls[2]!.finish("approved", true);
    expect((await allowedFinal).artifactsAllowed).toBe(true);
    expect((await send(stageId, { staged: true })).ok).toBe(true);
    const revokedFinal = waitForMessage(ws, message => message.type === "remote_final" && message.reqId === stageId);
    endpoint.setDiscordControlEnabled(false);
    calls[3]!.finish("must not deliver", true);
    const revoked = await revokedFinal;
    expect(revoked.ok).toBe(false);
    expect(revoked.artifactsAllowed).toBe(false);
    expect(revoked.text).toBeUndefined();
  } finally { await stage.cleanup(); }
});

test("staged requests from a revoked control generation cannot execute after re-enabling", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  const received: string[] = [];
  let finish: ((text?: string) => void) | undefined;
  endpoint.onRemoteRequest = (text, complete) => { received.push(text); finish = complete; return true; };
  await endpoint.start();
  const ws = connect(await readDiscovery(endpoint.sessionId));
  await waitForMessage(ws, message => message.type === "snapshot");
  const control = waitForMessage(ws, message => message.type === "discord_control" && message.enabled === true);
  endpoint.setDiscordControlEnabled(true);
  const original = (await control).generation as number;
  endpoint.setDiscordControlEnabled(true);
  const id = crypto.randomUUID();
  const stage = await createDiscordArtifactStage(endpoint.sessionId, id);
  const request = async (reqId: string, generation: number, text: string) => {
    const ack = waitForMessage(ws, message => message.type === "ack" && message.reqId === reqId);
    ws.send(JSON.stringify({ type: "remote_request", sessionId: endpoint!.sessionId, reqId, text, staged: true, controlGeneration: generation }));
    return ack;
  };
  try {
    expect((await request(id, original, "current request")).ok).toBe(true);
    const final = waitForMessage(ws, message => message.type === "remote_final" && message.reqId === id);
    finish!("done");
    await final;
    endpoint.setDiscordControlEnabled(false);
    const enabledAgain = waitForMessage(ws, message => message.type === "discord_control" && message.enabled === true);
    endpoint.setDiscordControlEnabled(true);
    const fresh = (await enabledAgain).generation as number;
    expect(fresh).not.toBe(original);
    expect((await request(id, original, "staged before revoke")).ok).toBe(false);
    expect((await request(id, fresh, "fresh request")).ok).toBe(true);
    expect(received).toEqual(["current request", "fresh request"]);
  } finally { await stage.cleanup(); }
});

test("relay subscription requires a fresh local grant for the same socket and generation", async () => {
  endpoint = new SessionNotifyEndpoint("/tmp/project");
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const owner = connect(discovery);
  await waitForMessage(owner, message => message.type === "snapshot");
  const subscribe = async (ws: WebSocket, reqId: string, generation: number) => {
    const ack = waitForMessage(ws, message => message.type === "ack" && message.reqId === reqId);
    ws.send(JSON.stringify({ type: "local_relay", sessionId: endpoint!.sessionId, reqId, enabled: true, generation }));
    return ack;
  };
  expect((await subscribe(owner, "unsolicited", 0)).ok).toBe(false);
  const control = waitForMessage(owner, message => message.type === "local_relay_control");
  expect(endpoint.requestLocalRelay("123456789012345678")).toBe(1);
  const generation = (await control).generation as number;
  const newcomer = connect(discovery);
  await waitForMessage(newcomer, message => message.type === "snapshot");
  expect((await subscribe(newcomer, "wrong-socket", generation)).ok).toBe(false);
  expect((await subscribe(owner, "accepted", generation)).ok).toBe(true);
  const final = waitForMessage(owner, message => message.type === "local_final");
  endpoint.sendLocalFinal("allowed answer", endpoint.localRelayGeneration()!);
  expect((await final).text).toBe("allowed answer");
  endpoint.requestLocalRelay("off");
  expect((await subscribe(owner, "stale", generation)).ok).toBe(false);
});
