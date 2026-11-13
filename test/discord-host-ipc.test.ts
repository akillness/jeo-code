import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acceptDiscordHostDecision, closeDiscordHostRuntime, createDiscordHostRuntime, currentDiscordHostExecution, runDiscordHostTurn } from "../src/agent/discord-host";
import { discordHostActionDigest } from "../src/messenger/host-protocol";
import { createMessengerSessionPool } from "../src/messenger/session-pool";
import type { DiscordActionDecision, DiscordActionRequest, DiscordHostBootstrap, DiscordRunRef } from "../src/messenger/types";

const bootstrap: DiscordHostBootstrap = { version: 1, mode: "host", scope: { sessionId: "session-A", generation: 3, epoch: "epoch-A" }, nonce: "parent-nonce", cwd: "/repo/worktree", workspaceRoot: "/repo", sourceRoot: "/source", sessionDir: "/private/sessions", cleanupReceipt: "/private/sessions/receipt.json" };
const allow = (request: DiscordActionRequest): DiscordActionDecision => ({ type: "action_decision", nonce: request.nonce, epoch: request.epoch, runId: request.runId, requestId: request.requestId, actionDigest: discordHostActionDigest(request.action), decision: "allow" });

for (const scenario of [
  { name: "wrong nonce", change: { nonce: "attacker" } },
  { name: "previous worker epoch", change: { epoch: "epoch-old" } },
  { name: "different active run", change: { runId: "run-other" } },
  { name: "unsolicited request ID", change: { requestId: "request-other" } },
  { name: "different exact action digest", change: { actionDigest: "a".repeat(64) } },
  { name: "child-selected actor", change: { actor: "owner" } },
] as const) test(`host child rejects ${scenario.name} before tool effect and consumes the matching decision once`, async () => {
  const requested = Promise.withResolvers<DiscordActionRequest>();
  const runtime = createDiscordHostRuntime(bootstrap, request => requested.resolve(request));
  const stop = new AbortController();
  let effects = 0;
  const turn = runDiscordHostTurn(runtime, "run-A", stop.signal, async () => {
    await currentDiscordHostExecution()!.authorizeTool("/repo/worktree", "bash", { command: "git push origin HEAD" }, stop.signal);
    return ++effects;
  });
  try {
    const request = await requested.promise;
    const decision = allow(request);
    expect(acceptDiscordHostDecision(runtime, { ...decision, ...scenario.change })).toBe(false);
    expect(effects).toBe(0);
    expect(acceptDiscordHostDecision(runtime, decision)).toBe(true);
    expect(await turn).toBe(1);
    expect(acceptDiscordHostDecision(runtime, decision)).toBe(false);
    expect(effects).toBe(1);
  } finally { stop.abort(); await Promise.allSettled([turn]); await closeDiscordHostRuntime(runtime); }
});

test("an approved request cannot authorize the next action even within the same run", async () => {
  let requested = Promise.withResolvers<DiscordActionRequest>();
  const runtime = createDiscordHostRuntime(bootstrap, request => requested.resolve(request));
  const stop = new AbortController();
  let effects = 0;
  const turn = runDiscordHostTurn(runtime, "run-A", stop.signal, async () => {
    for (const command of ["git push origin HEAD", "rm -f retained.txt"]) {
      await currentDiscordHostExecution()!.authorizeTool("/repo/worktree", "bash", { command }, stop.signal);
      effects++;
    }
    return effects;
  });
  try {
    const first = allow(await requested.promise);
    requested = Promise.withResolvers<DiscordActionRequest>();
    expect(acceptDiscordHostDecision(runtime, first)).toBe(true);
    const second = await requested.promise;
    expect(second.requestId).not.toBe(first.requestId);
    expect(acceptDiscordHostDecision(runtime, first)).toBe(false);
    expect(effects).toBe(1);
    expect(acceptDiscordHostDecision(runtime, allow(second))).toBe(true);
    expect(await turn).toBe(2);
  } finally { stop.abort(); await Promise.allSettled([turn]); await closeDiscordHostRuntime(runtime); }
});

for (const outcome of ["deny", "abort", "close"] as const) test(`host ${outcome} invalidates a pending action without executing it`, async () => {
  const requested = Promise.withResolvers<DiscordActionRequest>();
  const runtime = createDiscordHostRuntime(bootstrap, request => requested.resolve(request));
  const stop = new AbortController();
  let effects = 0;
  const turn = runDiscordHostTurn(runtime, "run-A", stop.signal, async () => {
    await currentDiscordHostExecution()!.authorizeTool("/repo/worktree", "bash", { command: "git push" }, stop.signal);
    effects++;
  });
  const rejected = turn.then(() => undefined, error => error);
  try {
    const decision = allow(await requested.promise);
    if (outcome === "deny") expect(acceptDiscordHostDecision(runtime, { ...decision, decision: "deny" })).toBe(true);
    else if (outcome === "abort") stop.abort();
    else await closeDiscordHostRuntime(runtime);
    expect(String(await rejected)).toMatch(/denied|cancelled|closed/);
    expect(acceptDiscordHostDecision(runtime, decision)).toBe(false);
    expect(effects).toBe(0);
  } finally { stop.abort(); await Promise.allSettled([turn]); await closeDiscordHostRuntime(runtime); }
});

interface ControlledHostWorker {
  host: DiscordHostBootstrap; inputs: unknown[]; frames: unknown[]; written: Promise<void>; shutdown: Promise<void>;
  request(frame: unknown): void; nextDecision(): Promise<DiscordActionDecision>; nextInput(): Promise<void>; result(text: string): void;
  receipt(): Promise<void>; ack(nonce?: string, epoch?: string): void; activity(text: string): void; endOutput(): void; finish(): void;
}

// This fake proves IPC ordering/ownership only, not operating-system descendant cleanup.
function controlledWorker(env: Record<string, string>, ipc: (frame: unknown) => void) {
  const host = JSON.parse(env.JEO_MESSENGER_HOST_BOOTSTRAP!) as DiscordHostBootstrap;
  const exited = Promise.withResolvers<number>();
  let written = Promise.withResolvers<void>();
  const shutdown = Promise.withResolvers<void>();
  let decision = Promise.withResolvers<DiscordActionDecision>();
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  const frames: unknown[] = [];
  const inputs: unknown[] = [];
  let alive = true;
  let outputOpen = true;
  const endOutput = () => { if (outputOpen) { outputOpen = false; stdout.close(); } };
  const finish = () => { if (!alive) return; alive = false; endOutput(); stderr.close(); exited.resolve(0); };
  return {
    host, inputs, frames, written: written.promise, shutdown: shutdown.promise,
    request(frame: unknown) { ipc(frame); },
    nextDecision() { return decision.promise; },
    nextInput() { return written.promise; },
    result(text: string) { stdout.enqueue(new TextEncoder().encode(`JEO_MESSENGER_RESULT ${JSON.stringify(text)}\n`)); },
    async receipt() {
      await fs.writeFile(host.cleanupReceipt, JSON.stringify({ version: 1, ...host.scope, pid: process.pid, nonce: host.nonce, gone: true }), { mode: 0o600 });
    },
    ack(nonce = host.nonce, epoch = host.scope.epoch) { if (alive) stderr.enqueue(new TextEncoder().encode(`JEO_MESSENGER_SHUTDOWN_ACK ${JSON.stringify({ nonce, epoch, gone: true })}\n`)); },
    activity(text: string) { stderr.enqueue(new TextEncoder().encode(`JEO_MESSENGER_ACTIVITY ${text}\n`)); },
    endOutput,
    finish,
    child: {
      pid: process.pid,
      stdin: { write(text: string) { inputs.push(JSON.parse(text)); written.resolve(); written = Promise.withResolvers<void>(); return text.length; }, flush() {}, end() {} },
      stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller; } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller; } }),
      exited: exited.promise,
      kill() { throw new Error("Protected host worker must never receive an OS signal"); },
      send(frame: unknown) {
        frames.push(frame);
        if (typeof frame === "object" && frame !== null && "type" in frame) {
          if (frame.type === "action_decision") { decision.resolve(frame as DiscordActionDecision); decision = Promise.withResolvers<DiscordActionDecision>(); }
          if (frame.type === "jeo_messenger_shutdown") shutdown.resolve();
        }
        return true;
      },
    },
  };
}

async function poolLayout() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-host-ipc-"));
  const root = await fs.realpath(temporary);
  const cwd = path.join(root, "workspace");
  const sourceRoot = path.join(root, "source");
  const sessionDir = path.join(root, "sessions");
  await Promise.all([cwd, sourceRoot, sessionDir].map(directory => fs.mkdir(directory)));
  const env = { JEO_SESSION_DIR: sessionDir, JEO_MESSENGER_HOST_BOOTSTRAP: JSON.stringify({ version: 1, mode: "host", cwd, workspaceRoot: cwd, sourceRoot, sessionDir }) };
  return { root, cwd, env };
}

test("parent pool rejects forged, stale, unsolicited and replayed requests before invoking authority", async () => {
  const layout = await poolLayout();
  const created = Promise.withResolvers<void>();
  let worker!: ControlledHostWorker;
  const authorized: Array<{ run: DiscordRunRef; command: unknown }> = [];
  const spawn = ((_command: string[], options: { env: Record<string, string>; ipc: (frame: unknown) => void }) => {
    const fixture = controlledWorker(options.env, options.ipc); worker = fixture; created.resolve(); return fixture.child;
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 2, 300_000, 2_000, {
    onWorkerStarted: async () => {},
    onActionRequest: async (run, action) => { authorized.push({ run, command: action.kind === "tool" ? action.args.command : "upload" }); },
  });
  const run: DiscordRunRef = { conversationKey: "parent-owned-conversation", sessionId: "session-A", generation: 3, runId: "run-A" };
  const signal = new AbortController().signal;
  const turn = pool.turn(run.sessionId, ["fixture"], layout.cwd, layout.env, "literal prompt", signal, undefined, undefined, run);
  const settled = turn.then(value => value, error => String(error));
  try {
    await created.promise; await worker.written;
    const request: DiscordActionRequest = { type: "action_request", nonce: worker.host.nonce, epoch: worker.host.scope.epoch, runId: run.runId, requestId: "request-1", action: { kind: "tool", cwd: layout.cwd, tool: "bash", args: { command: "git push origin HEAD" } } };
    for (const change of [{ nonce: "forged" }, { epoch: "old" }, { runId: "other" }, { requestId: "" }, { actor: "owner" }, { conversationKey: "child-chosen" }, { type: "action_decision" }]) worker.request({ ...request, ...change });
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 64; depth++) nested = { nested };
    worker.request({ ...request, requestId: "overdeep-action", action: { kind: "tool", cwd: layout.cwd, tool: "bash", args: nested } });
    worker.request({ ...request, requestId: "sparse-files", action: { kind: "artifact_upload", channelId: "A", files: new Array(1) } });
    worker.request({ ...request, requestId: "nonfinite-action", action: { kind: "tool", cwd: layout.cwd, tool: "bash", args: { limit: Infinity } } });
    worker.request({ ...request, requestId: "relative-cwd", action: { kind: "tool", cwd: "../escape", tool: "bash", args: {} } });
    const first = worker.nextDecision(); worker.request(request);
    expect(await first).toEqual(allow(request));
    expect(authorized).toEqual([{ run, command: "git push origin HEAD" }]);
    worker.request(request);
    const secondRequest = { ...request, requestId: "request-2" };
    const second = worker.nextDecision(); worker.request(secondRequest);
    expect(await second).toEqual(allow(secondRequest));
    expect(authorized).toHaveLength(2);
    worker.result("complete"); expect(await settled).toBe("complete");
    worker.request({ ...request, requestId: "unsolicited-idle" });
    const nextRun = { ...run, runId: "run-B" };
    const nextInput = worker.nextInput();
    const next = pool.turn(run.sessionId, ["fixture"], layout.cwd, layout.env, "next", signal, undefined, undefined, nextRun);
    // Parent's stdin write is the signal that the next active run exists.
    await nextInput;
    const final = worker.nextDecision();
    worker.request({ ...request, runId: nextRun.runId, requestId: "request-3" });
    await final;
    expect(authorized).toEqual([{ run, command: "git push origin HEAD" }, { run, command: "git push origin HEAD" }, { run: nextRun, command: "git push origin HEAD" }]);
    worker.result("next complete"); expect(await next).toBe("next complete");
  } finally {
    const closing = pool.close();
    if (worker) { await worker.receipt(); worker.ack(); worker.finish(); }
    await closing; await settled; await fs.rm(layout.root, { recursive: true, force: true });
  }
});

for (const state of ["active", "idle"] as const) test(`targeted stop retires A's ${state} worker and queued turns, waits for ACK plus exit, and leaves B usable`, async () => {
  const layout = await poolLayout();
  const createdA = Promise.withResolvers<ControlledHostWorker>();
  const createdB = Promise.withResolvers<ControlledHostWorker>();
  const workers: ControlledHostWorker[] = [];
  const spawn = ((_command: string[], options: { env: Record<string, string>; ipc: (frame: unknown) => void }) => {
    const worker = controlledWorker(options.env, options.ipc); workers.push(worker);
    (worker.host.scope.sessionId === "A" ? createdA : createdB).resolve(worker);
    return worker.child;
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 2, 300_000, 2_000, { onWorkerStarted: async () => {} });
  const signal = new AbortController().signal;
  const turn = (key: string, runId: string) => pool.turn(key, ["fixture"], layout.cwd, layout.env, runId, signal, undefined, undefined, { sessionId: key, generation: 1, conversationKey: key, runId });
  const activeA = turn("A", "A-first").then(value => value, error => String(error));
  const activeB = turn("B", "B-first").then(value => value, error => String(error));
  const [a, b] = await Promise.all([createdA.promise, createdB.promise]);
  try {
    await Promise.all([a.written, b.written]);
    if (state === "idle") { a.result("A completed"); expect(await activeA).toBe("A completed"); }
    const queued = state === "active" ? turn("A", "A-queued").then(value => value, error => String(error)) : undefined;
    let stopped = false;
    const stopping = pool.stop("A").then(() => { stopped = true; });
    await a.shutdown;
    expect(b.frames).toEqual([]);
    await a.receipt(); a.ack();
    b.result("B continues while A exits");
    expect(await activeB).toBe("B continues while A exits");
    expect(stopped).toBe(false);
    if (state === "active") {
      expect(await activeA).toMatch(/stopped|aborted/);
      expect(await queued).toMatch(/stopped|aborted/);
      expect(a.inputs).toEqual([{ type: "host_turn", runId: "A-first", text: "A-first" }]);
    }
    a.finish(); await stopping;
    expect(stopped).toBe(true);
    const written = b.nextInput();
    const nextB = turn("B", "B-second"); await written;
    b.result("same B survives"); expect(await nextB).toBe("same B survives");
    expect(workers).toHaveLength(2);
    expect(b.frames).toEqual([]);
  } finally {
    const closing = pool.close();
    for (const worker of workers) { await worker.receipt(); worker.ack(); worker.finish(); }
    await closing; await Promise.allSettled([activeA, activeB]); await fs.rm(layout.root, { recursive: true, force: true });
  }
});

for (const missing of ["receipt", "authentic ACK"] as const) test(`host exit without ${missing} quarantines only its key instead of claiming successful cleanup`, async () => {
  const layout = await poolLayout();
  const created = Promise.withResolvers<ControlledHostWorker>();
  let spawns = 0;
  const spawn = ((_command: string[], options: { env: Record<string, string>; ipc: (frame: unknown) => void }) => {
    spawns++; const worker = controlledWorker(options.env, options.ipc); created.resolve(worker); return worker.child;
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 2, 300_000, 2_000, { onWorkerStarted: async () => {}, reapOrphans: async () => { throw new Error("Host cleanup must never use the native sandbox reaper"); } });
  const run: DiscordRunRef = { sessionId: "A", conversationKey: "A", generation: 1, runId: "first" };
  const invoke = () => pool.turn("A", ["fixture"], layout.cwd, layout.env, "hello", new AbortController().signal, undefined, undefined, run);
  const active = invoke().then(value => value, error => String(error));
  const worker = await created.promise;
  try {
    await worker.written;
    const stopping = pool.stop("A").then(() => "success", error => String(error));
    await worker.shutdown;
    if (missing === "authentic ACK") await worker.receipt();
    worker.ack(missing === "authentic ACK" ? "forged-nonce" : worker.host.nonce);
    worker.finish();
    expect(await stopping).toContain("REVOKE_INCOMPLETE");
    expect(await invoke().then(() => "success", error => String(error))).toContain("REVOKE_INCOMPLETE");
    expect(spawns).toBe(1);
  } finally {
    worker.finish();
    await pool.close().catch(() => {}); await active; await fs.rm(layout.root, { recursive: true, force: true });
  }
});

for (const boundary of ["ownership publication", "action authorization"] as const) test(`stop fences late ${boundary} completion before any new host effect`, async () => {
  const layout = await poolLayout();
  const created = Promise.withResolvers<ControlledHostWorker>();
  const boundaryEntered = Promise.withResolvers<AbortSignal | undefined>();
  const releaseBoundary = Promise.withResolvers<void>();
  const spawn = ((_command: string[], options: { env: Record<string, string>; ipc: (frame: unknown) => void }) => {
    const worker = controlledWorker(options.env, options.ipc); created.resolve(worker); return worker.child;
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 2, 300_000, 2_000, {
    async onWorkerStarted() { if (boundary === "ownership publication") { boundaryEntered.resolve(undefined); await releaseBoundary.promise; } },
    async onActionRequest(_run, _action, signal) { boundaryEntered.resolve(signal); await releaseBoundary.promise; },
  });
  const run: DiscordRunRef = { sessionId: "A", conversationKey: "A", generation: 1, runId: "run-A" };
  const active = pool.turn("A", ["fixture"], layout.cwd, layout.env, "hello", new AbortController().signal, undefined, undefined, run).then(value => value, error => String(error));
  const worker = await created.promise;
  try {
    if (boundary === "action authorization") {
      await worker.written;
      worker.request({ type: "action_request", nonce: worker.host.nonce, epoch: worker.host.scope.epoch, runId: run.runId, requestId: "pending-request", action: { kind: "tool", tool: "bash", cwd: layout.cwd, args: { command: "git push" } } });
    }
    const authoritySignal = await boundaryEntered.promise;
    const stopping = pool.stop("A");
    await worker.shutdown;
    if (authoritySignal) expect(authoritySignal.aborted).toBe(true);
    releaseBoundary.resolve();
    await worker.receipt(); worker.ack(); worker.finish();
    await stopping;
    expect(await active).toMatch(/stopped|aborted/);
    expect(worker.inputs).toEqual(boundary === "ownership publication" ? [] : [{ type: "host_turn", runId: run.runId, text: "hello" }]);
    expect(worker.frames).toEqual([{ type: "jeo_messenger_shutdown", nonce: worker.host.nonce, epoch: worker.host.scope.epoch }]);
  } finally {
    releaseBoundary.resolve(); const closing = pool.close();
    await worker.receipt(); worker.ack(); worker.finish(); await closing; await active;
    await fs.rm(layout.root, { recursive: true, force: true });
  }
});

test("decision digest accepts reordered JSON keys but never a changed effective argument", async () => {
  const requested = Promise.withResolvers<DiscordActionRequest>();
  const runtime = createDiscordHostRuntime(bootstrap, request => requested.resolve(request));
  const stop = new AbortController();
  let effects = 0;
  const turn = runDiscordHostTurn(runtime, "run-A", stop.signal, async () => {
    await currentDiscordHostExecution()!.authorizeTool("/repo/worktree", "bash", { command: "git push", nested: { b: 2, a: 1 } }, stop.signal);
    return ++effects;
  });
  try {
    const request = await requested.promise;
    const decision = allow(request);
    const changed = discordHostActionDigest({ kind: "tool", tool: "bash", cwd: "/repo/worktree", args: { nested: { a: 1, b: 2 }, command: "git push --force" } });
    expect(acceptDiscordHostDecision(runtime, { ...decision, actionDigest: changed })).toBe(false);
    expect(effects).toBe(0);
    const reordered = discordHostActionDigest({ args: { nested: { a: 1, b: 2 }, command: "git push" }, cwd: "/repo/worktree", tool: "bash", kind: "tool" });
    expect(acceptDiscordHostDecision(runtime, { ...decision, actionDigest: reordered })).toBe(true);
    expect(await turn).toBe(1);
  } finally { stop.abort(); await Promise.allSettled([turn]); await closeDiscordHostRuntime(runtime); }
});

test("authenticated terminal ACK before explicit stop fences the live worker and waits for receipt plus exit before replacement", async () => {
  const layout = await poolLayout();
  const created = [Promise.withResolvers<ControlledHostWorker>(), Promise.withResolvers<ControlledHostWorker>()];
  const workers: ControlledHostWorker[] = [];
  const spawn = ((_command: string[], options: { env: Record<string, string>; ipc: (frame: unknown) => void }) => {
    const worker = controlledWorker(options.env, options.ipc); workers.push(worker); created[workers.length - 1]!.resolve(worker); return worker.child;
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 2, 300_000, 2_000, { onWorkerStarted: async () => {} });
  const invoke = (runId: string) => pool.turn("A", ["fixture"], layout.cwd, layout.env, runId, new AbortController().signal, undefined, undefined, { sessionId: "A", conversationKey: "A", generation: 1, runId });
  const first = invoke("first").then(value => value, error => String(error));
  let replacement: Promise<string> | undefined;
  try {
    const worker = await created[0]!.promise; await worker.written;
    worker.ack();
    worker.endOutput();
    expect(await first).toMatch(/stopped|aborted/);
    replacement = invoke("replacement");
    await worker.receipt();
    expect(workers).toHaveLength(1);
    expect(worker.inputs).toEqual([{ type: "host_turn", runId: "first", text: "first" }]);
    worker.finish();
    const next = await created[1]!.promise; await next.written;
    expect(next.host.scope.epoch).not.toBe(worker.host.scope.epoch);
    next.result("replacement succeeded");
    expect(await replacement).toBe("replacement succeeded");
  } finally {
    const closing = pool.close();
    for (const worker of workers) { await worker.receipt(); worker.ack(); worker.finish(); }
    await closing; await Promise.allSettled([first, ...(replacement ? [replacement] : [])]);
    await fs.rm(layout.root, { recursive: true, force: true });
  }
});

for (const forged of ["nonce", "epoch"] as const) test(`terminal ACK with wrong ${forged} cannot retire a live worker`, async () => {
  const layout = await poolLayout();
  const created = Promise.withResolvers<ControlledHostWorker>();
  const consumed = Promise.withResolvers<void>();
  const spawn = ((_command: string[], options: { env: Record<string, string>; ipc: (frame: unknown) => void }) => {
    const worker = controlledWorker(options.env, options.ipc); created.resolve(worker); return worker.child;
  }) as unknown as typeof Bun.spawn;
  const pool = createMessengerSessionPool(spawn, 2, 300_000, 2_000, { onWorkerStarted: async () => {} });
  const active = pool.turn("A", ["fixture"], layout.cwd, layout.env, "hello", new AbortController().signal, text => { if (text === "ack consumed") consumed.resolve(); }, undefined, { sessionId: "A", conversationKey: "A", generation: 1, runId: "run" }).then(value => value, error => String(error));
  const worker = await created.promise;
  try {
    await worker.written;
    worker.ack(forged === "nonce" ? "attacker" : worker.host.nonce, forged === "epoch" ? "old-epoch" : worker.host.scope.epoch);
    worker.activity("ack consumed"); await consumed.promise;
    expect(worker.frames).toEqual([]);
    worker.result("still serving"); expect(await active).toBe("still serving");
  } finally {
    const closing = pool.close(); await worker.receipt(); worker.ack(); worker.finish();
    await closing; await active; await fs.rm(layout.root, { recursive: true, force: true });
  }
});

test("terminal ACK before buffered stdout result fences actions without dropping the completed answer", async () => {
  const layout = await poolLayout();
  const created = Promise.withResolvers<ControlledHostWorker>();
  const spawn = ((_command: string[], options: { env: Record<string, string>; ipc: (frame: unknown) => void }) => {
    const worker = controlledWorker(options.env, options.ipc); created.resolve(worker); return worker.child;
  }) as unknown as typeof Bun.spawn;
  let actionEffects = 0;
  const pool = createMessengerSessionPool(spawn, 2, 300_000, 2_000, { onWorkerStarted: async () => {}, onActionRequest: async () => { actionEffects++; } });
  const active = pool.turn("A", ["fixture"], layout.cwd, layout.env, "hello", new AbortController().signal, undefined, undefined, { sessionId: "A", conversationKey: "A", generation: 1, runId: "run" }).then(value => value, error => String(error));
  const worker = await created.promise;
  try {
    await worker.written;
    worker.ack(); await worker.shutdown;
    worker.request({ type: "action_request", nonce: worker.host.nonce, epoch: worker.host.scope.epoch, runId: "run", requestId: "after-terminal", action: { kind: "tool", tool: "bash", cwd: layout.cwd, args: { command: "git push" } } });
    worker.result("completed before EOF"); worker.endOutput();
    expect(await active).toBe("completed before EOF");
    expect(actionEffects).toBe(0);
    expect(worker.frames).toEqual([{ type: "jeo_messenger_shutdown", nonce: worker.host.nonce, epoch: worker.host.scope.epoch }]);
  } finally {
    const closing = pool.close(); await worker.receipt(); worker.ack(); worker.finish();
    await closing; await active; await fs.rm(layout.root, { recursive: true, force: true });
  }
});
