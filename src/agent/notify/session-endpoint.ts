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
 *   - main-session mirroring: `identity_header` (cached and replayed on connect),
 *     `context_update` (turn start/end), `turn_stream` (finalized reply) sent
 *     OUT, and `user_message`/`config_command` received IN via callbacks the
 *     caller registers. `user_message` ACKs report callback acceptance.
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
import { resolveDiscordArtifactStage, type DiscordArtifactPaths } from "./discord-artifacts";
import type { SubagentRecord, SubagentRegistry } from "../subagent-registry";

const SNAPSHOT_POLL_MS = 1_200;
const MAX_INBOUND_BYTES = 64 * 1024;

/** Session identity, cached and replayed as an `identity_header` on connection
 *  so a late or reconnecting daemon can name the session's forum topic. */
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
  private readonly relaySockets = new Set<ServerWebSocket<undefined>>();
  private readonly pendingRelay = new Map<ServerWebSocket<undefined>, number>();
  private relayRequestGeneration = 0;
  private readonly remoteControllers = new Map<ServerWebSocket<undefined>, { reqId: string; controller: AbortController }>();
  private relayGeneration = 0;
  private discordControlEnabled = false;
  private discordControlGeneration = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastSnapshotJson = "";
  /** `undefined` between turns — subagent requests report an empty registry. */
  private registry: SubagentRegistry | undefined;
  readonly sessionId: string;
  private readonly token: string;
  private identityFrame: string | undefined;

  /** Registered by launch.ts; absent or rejected handlers return a failed ACK. */
  onUserMessage: ((msg: RemoteUserMessage) => void | boolean | Promise<void | boolean>) | undefined;
  onRemoteRequest: ((text: string, finish: (text?: string, artifactsAllowed?: boolean) => void, signal: AbortSignal, stage?: DiscordArtifactPaths) => boolean) | undefined;
  onRegistryMutation: (() => void) | undefined;
  onConfigCommand: ((cmd: RemoteConfigCommand) => void) | undefined;

  constructor(
    private readonly cwd: string,
    /** jeo's real, persistent session id when one exists (so a resumed
     *  session reconnects to the SAME discovery file / Telegram topic);
     *  falls back to a random id for session-less contexts. */
    sessionId: string = crypto.randomUUID(),
  ) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid notification session ID");
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

  /** Cache identity so a late or reconnecting daemon receives it as well. */
  sendIdentity(identity: SessionIdentity): void {
    this.identityFrame = JSON.stringify({ type: "identity_header", sessionId: this.sessionId, ...identity });
    this.broadcast(this.identityFrame);
  }

  /** Push a turn-boundary summary (`phase: "turn_start" | "turn_end"`). */
  sendContextUpdate(phase: "turn_start" | "turn_end", summary: string, extra?: { model?: string; usage?: string }): void {
    this.broadcast(JSON.stringify({ type: "context_update", sessionId: this.sessionId, phase, summary, ...extra }));
  }

  /** Push the finalized reply text for a completed turn. */
  sendTurnStream(text: string): void {
    this.broadcast(JSON.stringify({ type: "turn_stream", sessionId: this.sessionId, phase: "finalized", text }));
  }

  /** Revoke current subscriptions before asking a daemon to change destination. */
  requestLocalRelay(destination: string): number {
    this.relaySockets.clear();
    this.relayGeneration++;
    this.pendingRelay.clear();
    const generation = ++this.relayRequestGeneration;
    const json = JSON.stringify({ type: "local_relay_control", sessionId: this.sessionId, destination, generation });
    let sent = 0;
    for (const ws of this.sockets) {
      try { if (ws.send(json) > 0) { if (destination !== "off") this.pendingRelay.set(ws, generation); sent++; continue; } } catch {}
      this.sockets.delete(ws);
      this.remoteControllers.get(ws)?.controller.abort();
      this.remoteControllers.delete(ws);
      try { ws.terminate(); } catch { try { ws.close(); } catch {} }
    }
    return sent;
  }

  /** Snapshot eligibility before a turn; changes invalidate its relay. */
  localRelayGeneration(): number | undefined {
    return this.relaySockets.size ? this.relayGeneration : undefined;
  }

  sendLocalFinal(text: string, generation: number): void {
    if (generation !== this.relayGeneration) return;
    const json = JSON.stringify({ type: "local_final", sessionId: this.sessionId, text });
    for (const ws of this.relaySockets) {
      try { ws.send(json); } catch {}
    }
  }

  private sendDiscordControl(ws: ServerWebSocket<undefined>): void {
    try {
      const frame = JSON.stringify({ type: "discord_control", sessionId: this.sessionId, enabled: this.discordControlEnabled, generation: this.discordControlGeneration });
      if (ws.send(frame) > 0) return;
    } catch {}
    this.sockets.delete(ws);
    this.pendingRelay.delete(ws);
    if (this.relaySockets.delete(ws)) this.relayGeneration++;
    this.remoteControllers.get(ws)?.controller.abort();
    this.remoteControllers.delete(ws);
    try { ws.terminate(); } catch { try { ws.close(); } catch {} }
  }

  setDiscordControlEnabled(enabled: boolean): void {
    if (enabled === this.discordControlEnabled) return;
    this.discordControlEnabled = enabled;
    this.discordControlGeneration++;
    for (const ws of this.sockets) this.sendDiscordControl(ws);
    if (!enabled) {
      for (const remote of this.remoteControllers.values()) remote.controller.abort();
      this.remoteControllers.clear();
    }
  }

  private async handleMessage(ws: ServerWebSocket<undefined>, raw: string | Buffer): Promise<void> {
    if (Buffer.byteLength(raw) > MAX_INBOUND_BYTES) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    if (msg.type !== "remote_request" && msg.sessionId !== undefined && msg.sessionId !== this.sessionId) return;
    if (msg.type === "remote_request") {
      const reqId = msg.reqId;
      let ok = false;
      const onlyExpectedFields = Object.keys(msg).every(key => ["type", "sessionId", "reqId", "text", "staged", "controlGeneration"].includes(key));
      if (onlyExpectedFields && this.discordControlEnabled && msg.controlGeneration === this.discordControlGeneration && msg.sessionId === this.sessionId && typeof reqId === "string" && reqId.length > 0 && reqId.length <= 256 &&
          typeof msg.text === "string" && !!msg.text.trim() && !msg.text.includes("\u0003") && !/^[\/!$]/.test(msg.text.trimStart()) && (msg.staged === undefined || msg.staged === true) && this.onRemoteRequest && !this.remoteControllers.has(ws)) {
        let finished = false;
        const controlGeneration = this.discordControlGeneration;
        const controller = new AbortController();
        this.remoteControllers.set(ws, { reqId, controller });
        let stage: DiscordArtifactPaths | undefined;
        const finish = (text?: string, artifactsAllowed = false): void => {
          if (finished) return;
          finished = true;
          if (this.remoteControllers.get(ws)?.controller === controller) this.remoteControllers.delete(ws);
          if (!this.sockets.has(ws)) return;
          if (!this.discordControlEnabled || controller.signal.aborted || controlGeneration !== this.discordControlGeneration) text = undefined;
          if (!stage) artifactsAllowed = false;
          try { ws.send(JSON.stringify({ type: "remote_final", sessionId: this.sessionId, reqId, controlGeneration, ok: text !== undefined, artifactsAllowed: text !== undefined && artifactsAllowed, ...(text !== undefined ? { text } : {}) })); } catch {}
        };
        try {
          if (msg.staged === true) stage = await resolveDiscordArtifactStage(this.sessionId, reqId);
          if (this.discordControlEnabled && controlGeneration === this.discordControlGeneration && !controller.signal.aborted && this.sockets.has(ws)) {
            ok = this.onRemoteRequest(msg.text, finish, controller.signal, stage);
          }
        } catch {}
        if (!ok && this.remoteControllers.get(ws)?.controller === controller) this.remoteControllers.delete(ws);
      }
      try { ws.send(JSON.stringify({ type: "ack", reqId, ok })); } catch {}
      return;
    }
    if (msg.type === "remote_cancel" && msg.sessionId === this.sessionId && typeof msg.reqId === "string") {
      const remote = this.remoteControllers.get(ws);
      if (remote?.reqId === msg.reqId) remote.controller.abort();
      return;
    }
    if (msg.type === "local_relay" && msg.sessionId === this.sessionId && typeof msg.enabled === "boolean") {
      const allowed = !msg.enabled || (typeof msg.generation === "number" && this.pendingRelay.get(ws) === msg.generation && msg.generation === this.relayRequestGeneration);
      if (allowed && msg.enabled) this.relaySockets.add(ws);
      else if (!msg.enabled) this.relaySockets.delete(ws);
      if (allowed) { this.pendingRelay.delete(ws); this.relayGeneration++; }
      try { ws.send(JSON.stringify({ type: "ack", reqId: msg.reqId, ok: allowed })); } catch {}
      return;
    }
    if (msg.type === "list") {
      try {
        ws.send(JSON.stringify(this.snapshot()));
      } catch {}
      return;
    }
    if (msg.type === "steer" || msg.type === "discord_steer") {
      const id = typeof msg.id === "string" ? msg.id : "";
      const message = typeof msg.message === "string" ? msg.message : "";
      const ok = !!((msg.type === "steer" || (this.discordControlEnabled && msg.sessionId === this.sessionId && msg.controlGeneration === this.discordControlGeneration)) && id && message && this.registry?.steer(id, message));
      if (ok) this.onRegistryMutation?.();
      try {
        ws.send(JSON.stringify({ type: "ack", reqId: msg.reqId, ok }));
      } catch {}
      return;
    }
    if (msg.type === "cancel" || msg.type === "discord_cancel") {
      const ids = Array.isArray(msg.ids) ? msg.ids.filter((x): x is string => typeof x === "string") : [];
      const cancelled = (msg.type === "cancel" || (this.discordControlEnabled && msg.sessionId === this.sessionId && msg.controlGeneration === this.discordControlGeneration)) && ids.length > 0 ? (this.registry?.cancel(ids) ?? []) : [];
      if (cancelled.length) this.onRegistryMutation?.();
      try {
        ws.send(JSON.stringify({ type: "ack", reqId: msg.reqId, ok: cancelled.length > 0 }));
        ws.send(JSON.stringify(this.snapshot()));
      } catch {}
      return;
    }
    if (msg.type === "user_message") {
      let ok = false;
      const validPaths = msg.imagePaths === undefined || (Array.isArray(msg.imagePaths) && msg.imagePaths.every(x => typeof x === "string"));
      if (typeof msg.text === "string" && !msg.text.trimStart().startsWith("/") && validPaths &&
          (msg.text.trim() || (msg.imagePaths as string[] | undefined)?.length) && this.onUserMessage) {
        try {
          ok = (await this.onUserMessage({ text: msg.text, imagePaths: msg.imagePaths as string[] | undefined })) !== false;
        } catch {}
      }
      try {
        ws.send(JSON.stringify({ type: "ack", reqId: msg.reqId, ok }));
      } catch {}
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
        maxPayloadLength: MAX_INBOUND_BYTES,
        open: ws => {
          this.sockets.add(ws);
          try {
            ws.send(JSON.stringify(this.snapshot()));
            if (this.identityFrame) ws.send(this.identityFrame);
          } catch {}
          this.sendDiscordControl(ws);
        },
        message: (ws, raw) => { void this.handleMessage(ws, raw); },
        close: ws => {
          this.sockets.delete(ws);
          this.pendingRelay.delete(ws);
          this.remoteControllers.get(ws)?.controller.abort();
          this.remoteControllers.delete(ws);
          if (this.relaySockets.delete(ws)) this.relayGeneration++;
        },
      },
    });
    // Same reasoning as the poll timer below: a listening socket also keeps the Bun
    // event loop alive. This server exists to MIRROR a session, never to outlive it,
    // so it must not be able to decide the process stays up. `stop()` still tears it
    // down explicitly on the paths that have one — this only removes its veto over exit.
    (this.server as { unref?: () => void }).unref?.();
    this.pollTimer = setInterval(() => this.broadcastIfChanged(), SNAPSHOT_POLL_MS);
    // Unref the poll timer so it can NEVER be the reason the process stays alive.
    // This endpoint mirrors an already-running session; it has no work of its own
    // worth holding the event loop open for. Left ref'd, any code path that starts
    // the endpoint but does not reach an explicit `stop()` hangs the process
    // forever — which is exactly what happened to every non-interactive invocation
    // (`echo "…" | jeo`, `jeo -p "…"` in CI): the one-shot branch returns long
    // before the interactive REPL's exit teardown runs. Bun timers do not appear in
    // `process._getActiveHandles()`, so that hang presented as a process with zero
    // active handles refusing to exit.
    (this.pollTimer as { unref?: () => void }).unref?.();
    await fs.mkdir(notifySessionsDir(), { recursive: true, mode: 0o700 });
    await fs.chmod(notifySessionsDir(), 0o700);
    const payload = {
      url: `ws://127.0.0.1:${this.server.port}`,
      token: this.token,
      pid: process.pid,
      cwd: this.cwd,
      startedAt: Date.now(),
    };
    const discoveryPath = notifySessionEndpointPath(this.sessionId);
    const temporaryPath = `${discoveryPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
      await fs.rename(temporaryPath, discoveryPath);
    } finally {
      await fs.unlink(temporaryPath).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.setDiscordControlEnabled(false);
    this.relaySockets.clear();
    this.pendingRelay.clear();
    this.relayGeneration++;
    for (const remote of this.remoteControllers.values()) remote.controller.abort();
    this.remoteControllers.clear();
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

