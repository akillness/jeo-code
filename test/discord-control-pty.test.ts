import { expect, test } from "bun:test";
import { constants as fsConstants, watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");
const GUARDIAN = path.resolve(import.meta.dir, "fixtures/sandbox-terminal-guardian.ts");
const USER = "222222222222222222";

function sse(text: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

for (const [noTui, priorPaste, localTurn, relayTurn, cancelFirst, pasteAbort, dropWatchEvents = false] of [[false, false, false, false, false, false], [true, false, false, false, false, false], [false, true, false, false, false, false], [false, false, true, false, false, false], [true, false, true, false, false, false], [false, false, false, true, false, false], [false, false, false, false, true, false], [false, false, false, false, true, true], [false, false, false, false, false, false, true]] as const) test(`Discord terminal control and relay (no-tui=${noTui}, prior-paste=${priorPaste}, local-turn=${localTurn}, relay-turn=${relayTurn}, cancel-first=${cancelFirst}, paste-abort=${pasteAbort}, drop-watch-events=${dropWatchEvents})`, async () => {
  // Sibling workspace/config under one temp root; HOME stays the real one so Docker remains reachable.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-pty-")));
  const config = path.join(root, "config");
  const workspace = path.join(root, "workspace");
  const sessions = path.join(config, "notifications", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(workspace);
  await fs.chmod(config, 0o700);
  let binary: string | undefined;
  if (process.env.JEO_TEST_BINARY) {
    const source = path.resolve(process.env.JEO_TEST_BINARY);
    await fs.access(source, fsConstants.X_OK);
    const binaryDir = path.join(root, "isolated-binary");
    await fs.mkdir(binaryDir);
    binary = path.join(binaryDir, "jeo");
    await fs.copyFile(source, binary);
    await fs.chmod(binary, 0o700);
  }
  // Local fake OpenAI-compatible model. Non-relay turns stay busy until the client aborts or cleanup releases them.
  const providerReady = Promise.withResolvers<void>();
  const providerAborted = Promise.withResolvers<void>();
  const providerRequests: { aborted: boolean; release: () => void }[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [{ id: "pty-model" }] });
    const body = await request.json() as { stream?: boolean };
    const entry = { aborted: false, release: () => {} };
    const released = Promise.withResolvers<void>();
    entry.release = released.resolve;
    providerRequests.push(entry);
    request.signal.addEventListener("abort", () => { entry.aborted = true; providerAborted.resolve(); released.resolve(); });
    providerReady.resolve();
    if (!relayTurn) await released.promise;
    const text = relayTurn ? "local relay answer" : "released";
    return body.stream ? sse(text) : Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] });
  } });
  await fs.writeFile(path.join(config, "config.json"), JSON.stringify({
    providers: {}, defaultModel: "openai/pty-model", openaiBaseUrl: `http://127.0.0.1:${provider.port}/v1`,
    sandbox: { image: "oven/bun:1.3.14", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } },
    notifications: { enabled: true, discord: { allowedUserIds: [USER] } },
    routing: { enabled: false }, computer: { enabled: false }, gitAutoCommit: false,
  }));

  let output = "";
  let outputWaiters: (() => void)[] = [];
  const pending = new Set<string>();
  let typedCharacter = "";
  let discoveryEvents = 0;
  let discoveryScans = 0;
  let discoveryError = "";
  const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<never>();
  deadline.catch(() => {});
  const phase = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
    pending.add(label);
    try { return await Promise.race([action(), deadline]); } finally { pending.delete(label); }
  };
  const terminal = new Bun.Terminal({ cols: 120, rows: 36, data(_terminal, bytes) {
    output += new TextDecoder().decode(bytes);
    const waiters = outputWaiters;
    outputWaiters = [];
    for (const resolve of waiters) resolve();
  } });
  const nextOutput = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    outputWaiters.push(resolve);
    return promise;
  };
  const waitOutput = (needle: string, from = 0) => phase(`output ${JSON.stringify(needle)} from ${from}`, async () => {
    while (!output.slice(from).includes(needle)) await nextOutput();
  });
  const typed = (text: string) => phase(`typing ${JSON.stringify(text)}`, async () => {
    let index = 0;
    for (const character of text) {
      typedCharacter = `${index++}:${JSON.stringify(character)}`;
      const echoed = nextOutput();
      terminal.write(character);
      await echoed;
    }
    terminal.write("\r");
  });
  const discoveryReady = Promise.withResolvers<{ url: string; token: string; id: string }>();
  const scanDiscovery = async () => {
    discoveryScans++;
    const names = await fs.readdir(sessions).catch(() => []);
    for (const name of names) if (name.endsWith(".json")) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(sessions, name), "utf8"));
        discoveryReady.resolve({ ...data, id: name.slice(0, -5) });
      } catch (error) { discoveryError = String(error); }
    }
  };
  const watcher = watch(sessions, () => {
    discoveryEvents++;
    if (!dropWatchEvents) void scanDiscovery();
  });
  // Real HOME is preserved for Docker; only a dummy key for the local fake OpenAI endpoint is passed (no real provider/bot credentials).
  const env = { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", JEO_CONFIG_DIR: config, OPENAI_API_KEY: "sk-test-fake-local-openai-key",JEO_STATIC_MEMORY: "1", NO_COLOR: "1", TERM: "xterm-256color", ...(binary ? { JEO_TEST_CLI_BINARY: binary } : {}) };
  const cliExited = Promise.withResolvers<number>();
  let cliExitCode: number | undefined;
  const proc = Bun.spawn([process.execPath, GUARDIAN, process.execPath, CLI, "launch", "--no-skills", "--model", "openai/pty-model", ...(noTui ? ["--no-tui"] : [])], {
    cwd: workspace, env, terminal, detached: true,
    ipc(message) {
      if (message.type === "exit") { cliExitCode = message.exitCode; cliExited.resolve(message.exitCode); }
    },
  });
  void proc.exited.then(code => rejectDeadline(new Error(`PTY guardian exited unexpectedly: ${code}`)));
  let ws: WebSocket | undefined;
  let testFailure: unknown;
  try {
    // Real PTY processes cannot use fake time; fail before Bun's timeout so cleanup can run.
    const diagnostic = setTimeout(() => {
      void fs.readdir(sessions).then(
        names => rejectDeadline(new Error(`Discord PTY stalled; pending: ${[...pending].join("; ")}; character: ${typedCharacter}; child exit: ${cliExitCode}; discovery events: ${discoveryEvents}; discovery scans: ${discoveryScans}; discovery entries: ${JSON.stringify(names)}; discovery error: ${discoveryError}; output tail: ${JSON.stringify(output.slice(-1000))}`)),
        error => rejectDeadline(new Error(`Discord PTY stalled; pending: ${[...pending].join("; ")}; discovery readdir error: ${String(error)}`)),
      );
    }, 55_000);
    try {
    await waitOutput("Type your message");
    // Filesystem watch events can be coalesced or lost; rescan until publication or the test deadline.
    const discoveryPoll = setInterval(() => { void scanDiscovery(); }, 100);
    let discovery: { url: string; token: string; id: string };
    try {
      if (!dropWatchEvents) await scanDiscovery();
      discovery = await phase("session discovery", () => discoveryReady.promise);
    } finally { clearInterval(discoveryPoll); }
    ws = new WebSocket(`${discovery.url}/?token=${encodeURIComponent(discovery.token)}`);
    const frames: Record<string, unknown>[] = [];
    const listeners: (() => void)[] = [];
    ws.addEventListener("message", event => {
      frames.push(JSON.parse(String(event.data)));
      for (const resolve of listeners.splice(0)) resolve();
    });
    const waitFrame = (predicate: (frame: Record<string, unknown>) => boolean, from = 0) => phase(`frame ${predicate.toString()} from ${from}`, async () => {
      for (;;) {
        const found = frames.slice(from).find(predicate);
        if (found) return found;
        const { promise, resolve } = Promise.withResolvers<void>();
        listeners.push(resolve);
        await promise;
      }
    });
    await waitFrame(frame => frame.type === "snapshot");
    // Process-liveness invariant: CLI has not exited and the authenticated session endpoint still answers.
    const expectAlive = async () => {
      expect(cliExitCode).toBeUndefined();
      expect(proc.exitCode).toBeNull();
      expect(ws!.readyState).toBe(WebSocket.OPEN);
      const index = frames.length;
      ws!.send(JSON.stringify({ type: "list" }));
      await waitFrame(frame => frame.type === "snapshot", index);
      expect(cliExitCode).toBeUndefined();
    };
    if (priorPaste) {
      const beforePaste = output.length;
      terminal.write("\u001b[200~/discord control on --allow-full-control\u001b[201~\r");
      await waitOutput("Discord control requires a directly submitted local prompt.", beforePaste);
      await waitOutput("Type your message", beforePaste);
      const barrier = frames.length;
      ws.send(JSON.stringify({ type: "list" }));
      await waitFrame(frame => frame.type === "snapshot", barrier);
      expect(frames.some(frame => frame.type === "discord_control" && frame.enabled === true)).toBe(false);
    }
    const beforeTyped = output.length;
    await typed("/discord control on --allow-full-control");
    const outcome = await Promise.race([
      waitFrame(frame => frame.type === "discord_control" && frame.enabled === true).then(frame => ({ frame })),
      waitOutput("Confirm Discord control: press y to allow, any other key to cancel.", beforeTyped).then(() => ({ frame: undefined })),
      waitOutput("Discord control requires a directly submitted local prompt.", beforeTyped).then(() => { throw new Error("Directly typed consent was rejected"); }),
    ]);
    let enabled = outcome.frame;
    if (!enabled) {
      const index = frames.length;
      ws.send(JSON.stringify({ type: "list" }));
      await waitFrame(frame => frame.type === "snapshot", index);
      expect(frames.some(frame => frame.type === "discord_control" && frame.enabled === true)).toBe(false);
      terminal.write("y");
      enabled = await waitFrame(frame => frame.type === "discord_control" && frame.enabled === true);
    }
    if (relayTurn) {
      await waitOutput("Type your message", beforeTyped);
      const beforeRelay = output.length;
      await typed("/discord relay 123456789012345678");
      const relayOutcome = await Promise.race([
        waitFrame(frame => frame.type === "local_relay_control" && frame.destination === "123456789012345678").then(frame => ({ frame })),
        waitOutput("Confirm Discord relay: press y to allow, any other key to cancel.", beforeRelay).then(() => ({ frame: undefined })),
      ]);
      let relay = relayOutcome.frame;
      if (!relay) {
        const index = frames.length;
        ws.send(JSON.stringify({ type: "list" }));
        await waitFrame(frame => frame.type === "snapshot", index);
        expect(frames.some(frame => frame.type === "local_relay_control")).toBe(false);
        terminal.write("y");
        relay = await waitFrame(frame => frame.type === "local_relay_control" && frame.destination === "123456789012345678");
      }
      expect(relay.destination).toBe("123456789012345678");
      ws.send(JSON.stringify({ type: "local_relay", sessionId: discovery.id, reqId: "relay-ack", enabled: true, generation: relay.generation }));
      expect((await waitFrame(frame => frame.type === "ack" && frame.reqId === "relay-ack")).ok).toBe(true);
      await waitOutput("Discord relay request sent", beforeRelay);
      const localPromptStart = output.length;
      await waitOutput("Type your message", beforeRelay);
      terminal.write("coalesced local request\r");
      const final = await waitFrame(frame => frame.type === "local_final");
      expect(final.text).toBe("local relay answer");
      expect(output.slice(localPromptStart)).not.toContain("Confirm Discord relay:");
      const barrier = frames.length;
      ws.send(JSON.stringify({ type: "list" }));
      await waitFrame(frame => frame.type === "snapshot", barrier);
      expect(frames.filter(frame => frame.type === "local_final").map(frame => frame.text)).toEqual(["local relay answer"]);
      return;
    }
    const reqId = crypto.randomUUID();
    if (localTurn) {
      await waitOutput("Type your message", beforeTyped);
      await typed("independent local task");
    } else {
      ws.send(JSON.stringify({ type: "remote_request", sessionId: discovery.id, reqId, controlGeneration: enabled.generation, actor: { origin: "discord", sessionKey: discovery.id, userId: USER }, text: "long remote task" }));
      const accepted = await waitFrame(frame => frame.type === "ack" && frame.reqId === reqId);
      expect(accepted.ok).toBe(true);
    }
    await phase("provider ready", () => providerReady.promise);
    if (pasteAbort) {
      const beforePaste = output.length;
      terminal.write("\u001b[200~paste before abort");
      await waitOutput("paste before abort", beforePaste);
    }
    if (cancelFirst) {
      ws.send(JSON.stringify({ type: "remote_cancel", sessionId: discovery.id, reqId }));
      await phase("provider request abort", () => providerAborted.promise);
    }
    if (pasteAbort) terminal.write("\u0003\u001b[201~");
    const beforeOff = output.length;
    if (noTui || cancelFirst) terminal.write("/discord  control   off\r");
    else await typed("/discord  control   off");
    const disabled = await waitFrame(frame => frame.type === "discord_control" && frame.enabled === false && (frame.generation as number) > (enabled.generation as number));
    expect(disabled.enabled).toBe(false);
    if (pasteAbort) {
      terminal.write("\u0003");
      expect(await phase("terminal exit", () => cliExited.promise)).not.toBe(0);
      return;
    }
    if (cancelFirst) {
      // The local fake provider replaces the external companion process: the cancelled request was observed and the fixture is still serving.
      expect(providerRequests.length).toBeGreaterThan(0);
      expect(providerRequests.some(request => request.aborted)).toBe(true);
      await expectAlive();
    }
    if (localTurn) {
      ws.send(JSON.stringify({ type: "remote_request", sessionId: discovery.id, reqId, controlGeneration: enabled.generation, actor: { origin: "discord", sessionKey: discovery.id, userId: USER }, text: "must be denied" }));
      const rejected = await waitFrame(frame => frame.type === "ack" && frame.reqId === reqId);
      expect(rejected.ok).toBe(false);
      // The independent local turn must still be busy: its provider request is in flight and was not aborted.
      expect(providerRequests.length).toBeGreaterThan(0);
      expect(providerRequests.every(request => !request.aborted)).toBe(true);
      await expectAlive();
    } else {
      const final = await waitFrame(frame => frame.type === "remote_final" && frame.reqId === reqId);
      expect(final.ok).toBe(false);
      expect(final.text).toBeUndefined();
      await waitOutput("Type your message", beforeOff);
      const beforeHelp = output.length;
      await typed("/help");
      await waitOutput("Tools: read / write / edit / bash / find / search.", beforeHelp);
    }
    } finally { clearTimeout(diagnostic); }
  } catch (error) {
    testFailure = error;
    throw error;
  } finally {
    watcher.close();
    ws?.close();
    for (const request of providerRequests) request.release();
    let cleanupFailure: unknown;
    const { promise: cleanupDeadline, reject: rejectCleanup } = Promise.withResolvers<never>();
    // This watchdog bounds a real subprocess; fake time cannot stop an OS process.
    const cleanupTimer = setTimeout(() => rejectCleanup(new Error("PTY guardian did not stop within 10 seconds")), 10_000);
    try {
      // IPC queues the stop even if the guardian has not yet begun executing.
      if (proc.exitCode === null) proc.send("stop");
      await Promise.race([proc.exited, cleanupDeadline]);
    } catch (error) {
      cleanupFailure = error;
      // Disconnect requests the same self-termination without signaling a PID.
      try { proc.disconnect(); } catch {}
    } finally {
      clearTimeout(cleanupTimer);
      terminal.close();
      provider.stop(true);
    }
    if (cleanupFailure) {
      if (testFailure) throw new AggregateError([testFailure, cleanupFailure], "PTY test and cleanup failed");
      throw cleanupFailure;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 90_000);
