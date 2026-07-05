import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { SessionNotifyEndpoint } from "../src/agent/notify/session-endpoint";
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
  endpoint = new SessionNotifyEndpoint(registry, "/tmp/some-project");
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
  endpoint = new SessionNotifyEndpoint(registry, "/tmp/proj");
  await endpoint.start();
  const discovery = await readDiscovery(endpoint.sessionId);
  const ws = connect(discovery, "wrong-token");
  const outcome = await waitForOpenOrClose(ws);
  expect(outcome).toBe("close");
});

test("{type:'list'} echoes a fresh snapshot on demand", async () => {
  const registry = new SubagentRegistry();
  endpoint = new SessionNotifyEndpoint(registry, "/tmp/proj");
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
  endpoint = new SessionNotifyEndpoint(registry, "/tmp/proj");
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
  endpoint = new SessionNotifyEndpoint(registry, "/tmp/proj");
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
  endpoint = new SessionNotifyEndpoint(registry, "/tmp/proj");
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
  endpoint = new SessionNotifyEndpoint(registry, "/tmp/proj");
  await endpoint.start();
  const sessionId = endpoint.sessionId;
  await readDiscovery(sessionId); // does not throw — file exists
  await endpoint.stop();
  endpoint = undefined;
  const { notifySessionEndpointPath } = await import("../src/agent/notify/paths");
  await expect(fs.readFile(notifySessionEndpointPath(sessionId), "utf-8")).rejects.toThrow();
});
