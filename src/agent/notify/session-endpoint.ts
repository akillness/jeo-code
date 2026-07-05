/**
 * Per-process loopback WebSocket endpoint exposing ONE `SubagentRegistry` for
 * remote monitoring/control (gjc "loopback WebSocket SDK" parity, scoped to
 * subagents — jeo does not replicate gjc's full session-lifecycle/ask-prompt
 * notification surface, see CHANGELOG 0.7.34). The endpoint:
 *
 *   - binds a random free port on 127.0.0.1 only (never exposed off-box; the
 *     ONLY internet-facing hop is the separate `notify-daemon-run` process
 *     relaying through Telegram — see `telegram-daemon.ts`);
 *   - publishes a discovery file (`notifySessionEndpointPath`) with the ws url,
 *     a random auth token, and `pid`/`cwd` so the daemon can find and connect;
 *   - pushes a `snapshot` frame on connect and whenever the registry's subagent
 *     list changes (cheap poll — bounded by the small list size, only runs
 *     while a client is connected);
 *   - accepts `steer`/`cancel`/`list` requests and applies them to the SAME
 *     registry instance the interactive turn's `task`/`subagent` tools use.
 *
 * Lifecycle is opt-in and lazy: `ensureSessionNotifyEndpoint` is a no-op unless
 * `notifications.enabled` is set in the global config, and only actually binds
 * once a detached subagent is launched (never pays a port/socket cost for a
 * plain turn). `stopSessionNotifyEndpoint` tears it down (turn boundary).
 */
import * as fs from "node:fs/promises";
import type { Server, ServerWebSocket } from "bun";
import { readGlobalConfig } from "../state";
import { notifySessionEndpointPath, notifySessionsDir } from "./paths";
import type { SubagentRecord, SubagentRegistry } from "../subagent-registry";

const SNAPSHOT_POLL_MS = 1_200;

export class SessionNotifyEndpoint {
  private server: Server<undefined> | undefined;

  private readonly sockets = new Set<ServerWebSocket<undefined>>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastSnapshotJson = "";
  readonly sessionId: string;
  private readonly token: string;

  constructor(
    private readonly registry: SubagentRegistry,
    private readonly cwd: string,
  ) {
    this.sessionId = crypto.randomUUID();
    this.token = crypto.randomUUID();
  }

  private snapshot(): { type: "snapshot"; sessionId: string; cwd: string; pid: number; subagents: SubagentRecord[] } {
    return { type: "snapshot", sessionId: this.sessionId, cwd: this.cwd, pid: process.pid, subagents: this.registry.list() };
  }

  private broadcastIfChanged(): void {
    if (this.sockets.size === 0) return;
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    if (json === this.lastSnapshotJson) return;
    this.lastSnapshotJson = json;
    for (const ws of this.sockets) {
      try {
        ws.send(json);
      } catch {}
    }
  }

  private handleMessage(ws: ServerWebSocket<undefined>, raw: string | Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "list") {
      try {
        ws.send(JSON.stringify(this.snapshot()));
      } catch {}
      return;
    }
    if (msg.type === "steer") {
      const id = String(msg.id ?? "");
      const message = String(msg.message ?? "");
      const ok = id && message ? this.registry.steer(id, message) : false;
      try {
        ws.send(JSON.stringify({ type: "ack", reqId: msg.reqId, ok }));
      } catch {}
      return;
    }
    if (msg.type === "cancel") {
      const ids = Array.isArray(msg.ids) ? msg.ids.filter((x): x is string => typeof x === "string") : [];
      const cancelled = ids.length > 0 ? this.registry.cancel(ids) : [];
      try {
        ws.send(JSON.stringify({ type: "ack", reqId: msg.reqId, ok: cancelled.length > 0 }));
        ws.send(JSON.stringify(this.snapshot()));
      } catch {}
      return;
    }
  }

  /** Bind the server, start the change-poll, and publish the discovery file.
   *  Idempotent no-op if already started. */
  async start(): Promise<void> {
    if (this.server) return;
    this.server = Bun.serve<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.searchParams.get("token") !== this.token) {
          return new Response("unauthorized", { status: 401 });
        }
        if (server.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 500 });
      },
      websocket: {
        open: ws => {
          this.sockets.add(ws);
          try {
            ws.send(JSON.stringify(this.snapshot()));
          } catch {}
        },
        message: (ws, raw) => this.handleMessage(ws, raw),
        close: ws => {
          this.sockets.delete(ws);
        },
      },
    });
    this.pollTimer = setInterval(() => this.broadcastIfChanged(), SNAPSHOT_POLL_MS);
    await fs.mkdir(notifySessionsDir(), { recursive: true, mode: 0o700 });
    const payload = {
      url: `ws://127.0.0.1:${this.server.port}`,
      token: this.token,
      pid: process.pid,
      cwd: this.cwd,
      startedAt: Date.now(),
    };
    await fs.writeFile(notifySessionEndpointPath(this.sessionId), JSON.stringify(payload), { mode: 0o600 });
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {}
    }
    this.sockets.clear();
    if (this.server) {
      this.server.stop(true);
      this.server = undefined;
    }
    await fs.unlink(notifySessionEndpointPath(this.sessionId)).catch(() => {});
  }
}

// ── Lazy per-registry singleton wiring (task-tool.ts detached path) ────────────
const endpointsByRegistry = new WeakMap<SubagentRegistry, SessionNotifyEndpoint>();
const startingRegistries = new WeakSet<SubagentRegistry>();

/** Best-effort, fire-and-forget: starts (once) a `SessionNotifyEndpoint` bound to
 *  `registry` IF `notifications.enabled` is set, otherwise a cheap no-op. Never
 *  throws and never blocks the caller — matches the `spawnDetachedDistill`
 *  "background best-effort, never slows the turn" convention. */
export function ensureSessionNotifyEndpoint(registry: SubagentRegistry, cwd: string): void {
  if (endpointsByRegistry.has(registry) || startingRegistries.has(registry)) return;
  startingRegistries.add(registry);
  void (async () => {
    try {
      const config = await readGlobalConfig();
      if (!config.notifications?.enabled) return;
      const endpoint = new SessionNotifyEndpoint(registry, cwd);
      await endpoint.start();
      endpointsByRegistry.set(registry, endpoint);
    } catch {
      // best-effort: a bind/config failure must never break the parent turn.
    } finally {
      startingRegistries.delete(registry);
    }
  })();
}

/** Turn-boundary teardown (mirrors `registry.cancelAll()`); a no-op if no endpoint
 *  was ever started for this registry (the common case — notifications off). */
export async function stopSessionNotifyEndpoint(registry: SubagentRegistry): Promise<void> {
  const endpoint = endpointsByRegistry.get(registry);
  if (!endpoint) return;
  endpointsByRegistry.delete(registry);
  await endpoint.stop();
}
