/**
 * Per-SESSION loopback WebSocket endpoint (gjc per-session-thread parity —
 * see the Tier 2 contract in CHANGELOG history). One endpoint lives for the
 * whole interactive REPL lifetime (created once `sessionId` is established,
 * stopped at process exit), multiplexing TWO frame families over the SAME
 * connection:
 *
 *   - subagent visibility/control (unchanged since 0.7.34): `snapshot` on
 *     connect + on change, `steer`/`cancel`/`list` requests — applied to
 *     whichever `SubagentRegistry` is currently ATTACHED (see below);
 *   - main-session mirroring (new): `identity_header` (once, at start),
 *     `context_update` (turn start/end), `turn_stream` (finalized reply) sent
 *     OUT, and `user_message`/`config_command` received IN via callbacks the
 *     caller registers.
 *
 * `SubagentRegistry` instances are themselves per-turn (a fresh one every
 * `runTurn` call, see launch.ts), so this endpoint does NOT own one at
 * construction — `attachRegistry`/`detachRegistry` swap the live registry in
 * and out at turn boundaries. Between turns (or before the first turn),
 * `snapshot`/`list` report an empty subagent list and `steer`/`cancel` ack
 * `ok:false` — there is no registry to apply them to, not an error.
 *
 * The endpoint:
 *   - binds a random free port on 127.0.0.1 only (never exposed off-box; the
 *     ONLY internet-facing hop is the separate `notify-daemon-run` process
 *     relaying through Telegram — see `telegram-daemon.ts`);
 *   - publishes a discovery file (`notifySessionEndpointPath`) keyed by jeo's
 *     REAL session id (not a random one) so a Telegram forum topic, once
 *     created for a session, is found and reused across `--resume` instead of
 *     minting a duplicate topic every relaunch;
 *   - pushes a `snapshot` frame on connect and whenever the attached
 *     registry's subagent list changes (cheap poll — bounded by the small
 *     list size, only runs while a client is connected).
 *
 * Lifecycle: `startSessionNotifyEndpoint` is a no-op unless
 * `notifications.enabled` is set in the global config. A context lacking a
 * real jeo session (e.g. a bare `task-tool.ts` detached run outside any
 * interactive REPL) falls back to the OLD lazy, per-registry, random-id
 * behavior via `ensureSessionNotifyEndpoint` — but when an interactive
 * session's endpoint is already running in this process, that same path
 * ATTACHES to it instead of creating a second, competing endpoint.
 */
import * as fs from "node:fs/promises";
import type { Server, ServerWebSocket } from "bun";
import { readGlobalConfig } from "../state";
import { notifySessionEndpointPath, notifySessionsDir } from "./paths";
import type { SubagentRecord, SubagentRegistry } from "../subagent-registry";

const SNAPSHOT_POLL_MS = 1_200;

/** Session identity, pushed once as an `identity_header` frame right after
 *  `start()` — lets the daemon name/rename the session's forum topic. */
export interface SessionIdentity {
  repo: string;
  branch?: string;
  cwd: string;
}

/** A free-text reply arriving in the session's topic, already resolved to
 *  local temp-file paths for any attached photos/documents (the daemon owns
 *  the download; this endpoint only relays paths onward). */
export interface RemoteUserMessage {
  text: string;
  imagePaths?: string[];
}

/** A parsed `/verbose`, `/lean`, `/verbosity`, or `/redact` in-thread command. */
export interface RemoteConfigCommand {
  verbosity?: "lean" | "verbose";
  redact?: boolean;
}

export class SessionNotifyEndpoint {
  private server: Server<undefined> | undefined;

  private readonly sockets = new Set<ServerWebSocket<undefined>>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastSnapshotJson = "";
  /** `undefined` between turns — subagent requests report an empty registry. */
  private registry: SubagentRegistry | undefined;
  readonly sessionId: string;
  private readonly token: string;

  /** Registered by the caller (launch.ts) to route inbound frames; both are
   *  no-ops (frame silently dropped) until wired — matches the existing
   *  best-effort posture of this whole module. */
  onUserMessage: ((msg: RemoteUserMessage) => void) | undefined;
  onConfigCommand: ((cmd: RemoteConfigCommand) => void) | undefined;

  constructor(
    private readonly cwd: string,
    /** jeo's real, persistent session id when one exists (so a resumed
     *  session reconnects to the SAME discovery file / Telegram topic);
     *  falls back to a random id for session-less contexts. */
    sessionId: string = crypto.randomUUID(),
  ) {
    this.sessionId = sessionId;
    this.token = crypto.randomUUID();
  }

  /** Attach the registry backing THIS turn's subagents; `list`/`snapshot`
   *  immediately reflect it. Call once per `runTurn`. */
  attachRegistry(registry: SubagentRegistry): void {
    this.registry = registry;
    this.lastSnapshotJson = ""; // force a fresh push even if shapes coincide
    this.broadcastIfChanged();
  }

  /** Detach at turn end — a completed turn's registry must never keep
   *  receiving `steer`/`cancel` after `cancelAll()` already ran on it. */
  detachRegistry(): void {
    this.registry = undefined;
    this.lastSnapshotJson = "";
    this.broadcastIfChanged();
  }

  private snapshot(): { type: "snapshot"; sessionId: string; cwd: string; pid: number; subagents: SubagentRecord[] } {
    return { type: "snapshot", sessionId: this.sessionId, cwd: this.cwd, pid: process.pid, subagents: this.registry?.list() ?? [] };
  }

  private broadcastIfChanged(): void {
    if (this.sockets.size === 0) return;
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    if (json === this.lastSnapshotJson) return;
    this.lastSnapshotJson = json;
    this.broadcast(json);
  }

  /** Send a pre-serialized frame to every connected socket, best-effort. */
  private broadcast(json: string): void {
    for (const ws of this.sockets) {
      try {
        ws.send(json);
      } catch {}
    }
  }

  /** Push the one-time identity header. Safe to call even with no socket
   *  connected yet — silently dropped, matching every other push here (the
   *  daemon reconnects and gets a fresh `snapshot`, but identity is a single
   *  point-in-time fact with no polling fallback, so a session started before
   *  the daemon connects will not retroactively announce itself; acceptable
   *  since the common case is the daemon already scanning when a session
   *  starts). */
  sendIdentity(identity: SessionIdentity): void {
    this.broadcast(JSON.stringify({ type: "identity_header", sessionId: this.sessionId, ...identity }));
  }

  /** Push a turn-boundary summary (`phase: "turn_start" | "turn_end"`). */
  sendContextUpdate(phase: "turn_start" | "turn_end", summary: string, extra?: { model?: string; usage?: string }): void {
    this.broadcast(JSON.stringify({ type: "context_update", sessionId: this.sessionId, phase, summary, ...extra }));
  }

  /** Push the finalized reply text for a completed turn. */
  sendTurnStream(text: string): void {
    this.broadcast(JSON.stringify({ type: "turn_stream", sessionId: this.sessionId, phase: "finalized", text }));
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
      const ok = id && message ? (this.registry?.steer(id, message) ?? false) : false;
      try {
        ws.send(JSON.stringify({ type: "ack", reqId: msg.reqId, ok }));
      } catch {}
      return;
    }
    if (msg.type === "cancel") {
      const ids = Array.isArray(msg.ids) ? msg.ids.filter((x): x is string => typeof x === "string") : [];
      const cancelled = ids.length > 0 ? (this.registry?.cancel(ids) ?? []) : [];
      try {
        ws.send(JSON.stringify({ type: "ack", reqId: msg.reqId, ok: cancelled.length > 0 }));
        ws.send(JSON.stringify(this.snapshot()));
      } catch {}
      return;
    }
    if (msg.type === "user_message" && typeof msg.text === "string") {
      const imagePaths = Array.isArray(msg.imagePaths) ? msg.imagePaths.filter((x): x is string => typeof x === "string") : undefined;
      this.onUserMessage?.({ text: msg.text, imagePaths });
      return;
    }
    if (msg.type === "config_command") {
      const verbosity = msg.verbosity === "lean" || msg.verbosity === "verbose" ? msg.verbosity : undefined;
      const redact = typeof msg.redact === "boolean" ? msg.redact : undefined;
      if (verbosity !== undefined || redact !== undefined) this.onConfigCommand?.({ verbosity, redact });
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

// ── Session-scoped lifecycle (launch.ts's interactive REPL) ─────────────────

/** Best-effort, fire-and-forget: creates + starts a session-scoped endpoint IF
 *  `notifications.enabled`, otherwise returns `undefined` (cheap no-op — the
 *  common case). Never throws. Call once, right after `sessionId` is
 *  established; keep the result for the REPL's lifetime (`attachRegistry`
 *  per turn, `stop()` at exit). */
export async function startSessionNotifyEndpoint(cwd: string, sessionId: string | undefined): Promise<SessionNotifyEndpoint | undefined> {
  try {
    const config = await readGlobalConfig();
    if (!config.notifications?.enabled) return undefined;
    const endpoint = new SessionNotifyEndpoint(cwd, sessionId);
    await endpoint.start();
    return endpoint;
  } catch {
    return undefined; // best-effort: a bind/config failure must never break the session
  }
}

// ── Lazy per-registry fallback (task-tool.ts's detached path OUTSIDE any
//    interactive session — e.g. a bare `jeo run`/non-REPL invocation with no
//    session-scoped endpoint to attach to) ───────────────────────────────────
const endpointsByRegistry = new WeakMap<SubagentRegistry, SessionNotifyEndpoint>();
const startingRegistries = new WeakSet<SubagentRegistry>();

/** Best-effort, fire-and-forget: attaches `registry` to `sessionEndpoint` when
 *  given (the common interactive-session case — no new endpoint, no discovery
 *  file, just a registry swap), otherwise falls back to the OLD lazy
 *  per-registry endpoint (own random session id, own discovery file) IF
 *  `notifications.enabled`. Never throws and never blocks the caller. */
export function ensureSessionNotifyEndpoint(registry: SubagentRegistry, cwd: string, sessionEndpoint?: SessionNotifyEndpoint): void {
  if (sessionEndpoint) {
    sessionEndpoint.attachRegistry(registry);
    return;
  }
  if (endpointsByRegistry.has(registry) || startingRegistries.has(registry)) return;
  startingRegistries.add(registry);
  void (async () => {
    try {
      const config = await readGlobalConfig();
      if (!config.notifications?.enabled) return;
      const endpoint = new SessionNotifyEndpoint(cwd);
      await endpoint.start();
      endpoint.attachRegistry(registry);
      endpointsByRegistry.set(registry, endpoint);
    } catch {
      // best-effort: a bind/config failure must never break the parent turn.
    } finally {
      startingRegistries.delete(registry);
    }
  })();
}

/** Turn-boundary teardown for the FALLBACK path only: detaches + stops the
 *  lazily-created endpoint, if one was ever started for this registry (the
 *  common case — either notifications are off, or an interactive session's
 *  endpoint was attached instead and owns its own `stop()` at process exit).
 *  A no-op when `registry` was attached to a `sessionEndpoint` above — that
 *  endpoint outlives the turn and the caller detaches it separately. */
export async function stopSessionNotifyEndpoint(registry: SubagentRegistry): Promise<void> {
  const endpoint = endpointsByRegistry.get(registry);
  if (!endpoint) return;
  endpointsByRegistry.delete(registry);
  await endpoint.stop();
}

