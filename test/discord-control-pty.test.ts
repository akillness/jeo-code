import { expect, test } from "bun:test";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");
const AGY = path.resolve(import.meta.dir, "fixtures/agy-fake-cli.ts");

for (const [noTui, priorPaste, localTurn, relayTurn, cancelFirst, pasteAbort] of [[false, false, false, false, false, false], [true, false, false, false, false, false], [false, true, false, false, false, false], [false, false, true, false, false, false], [true, false, true, false, false, false], [false, false, false, true, false, false], [false, false, false, false, true, false], [false, false, false, false, true, true]] as const) test(`Discord terminal control and relay (no-tui=${noTui}, prior-paste=${priorPaste}, local-turn=${localTurn}, relay-turn=${relayTurn}, cancel-first=${cancelFirst}, paste-abort=${pasteAbort})`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-discord-pty-"));
  const config = path.join(root, "config");
  const sessions = path.join(config, "notifications", "sessions");
  const bin = path.join(root, "bin");
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(bin);
  await fs.symlink(AGY, path.join(bin, "agy"));
  await fs.writeFile(path.join(config, "config.json"), JSON.stringify({ providers: {}, defaultModel: "agy/gemini-4-argon-low", notifications: { enabled: true } }));
  const agyFixture = relayTurn ? { stdout: [
    JSON.stringify({ event: "init", conversation_id: "fixture", init: { model: "gemini-4-argon-low", cwd: root, tools: [], permission_mode: "request-review" } }) + "\n",
    JSON.stringify({ event: "result", result: { conversation_id: "fixture", status: "SUCCESS", response: "local relay answer", model: "gemini-4-argon-low", num_turns: 1 } }) + "\n",
  ] } : { readyThenHang: true };
  await fs.writeFile(path.join(root, "agy-fixture.json"), JSON.stringify(agyFixture));

  let output = "";
  let outputWaiters: (() => void)[] = [];
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
  const waitOutput = async (needle: string, from = 0) => {
    while (!output.slice(from).includes(needle)) await nextOutput();
  };
  const typed = async (text: string) => {
    for (const character of text) {
      const echoed = nextOutput();
      terminal.write(character);
      await echoed;
    }
    terminal.write("\r");
  };
  const discoveryReady = Promise.withResolvers<{ url: string; token: string; id: string }>();
  const watcher = watch(sessions, async () => {
    const names = await fs.readdir(sessions).catch(() => []);
    for (const name of names) if (name.endsWith(".json")) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(sessions, name), "utf8"));
        discoveryReady.resolve({ ...data, id: name.slice(0, -5) });
      } catch {}
    }
  });
  const env = { HOME: root, PATH: `${bin}:${process.env.PATH ?? ""}`, JEO_CONFIG_DIR: config, JEO_STATIC_MEMORY: "1", NO_COLOR: "1", TERM: "xterm-256color" };
  const command = process.env.JEO_TEST_BINARY ? [path.resolve(process.env.JEO_TEST_BINARY)] : [process.execPath, CLI];
  const proc = Bun.spawn([...command, "launch", "--no-skills", "--model", "agy/gemini-4-argon-low", ...(noTui ? ["--no-tui"] : [])], { cwd: root, env, terminal });
  let ws: WebSocket | undefined;
  let childPid: number | undefined;
  try {
    await waitOutput("Type your message");
    const discovery = await discoveryReady.promise;
    ws = new WebSocket(`${discovery.url}/?token=${encodeURIComponent(discovery.token)}`);
    const frames: Record<string, unknown>[] = [];
    const listeners: (() => void)[] = [];
    ws.addEventListener("message", event => {
      frames.push(JSON.parse(String(event.data)));
      for (const resolve of listeners.splice(0)) resolve();
    });
    const waitFrame = async (predicate: (frame: Record<string, unknown>) => boolean, from = 0) => {
      for (;;) {
        const found = frames.slice(from).find(predicate);
        if (found) return found;
        const { promise, resolve } = Promise.withResolvers<void>();
        listeners.push(resolve);
        await promise;
      }
    };
    await waitFrame(frame => frame.type === "snapshot");
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
      ws.send(JSON.stringify({ type: "remote_request", sessionId: discovery.id, reqId, controlGeneration: enabled.generation, text: "long remote task" }));
      const accepted = await waitFrame(frame => frame.type === "ack" && frame.reqId === reqId);
      expect(accepted.ok).toBe(true);
    }
    const ready = Promise.withResolvers<void>();
    const readyWatch = watch(root, async () => {
      if (await fs.stat(path.join(root, "agy-ready")).then(() => true, () => false)) ready.resolve();
    });
    try {
      if (await fs.stat(path.join(root, "agy-ready")).then(() => true, () => false)) ready.resolve();
      await ready.promise;
    } finally { readyWatch.close(); }
    if (pasteAbort) {
      const beforePaste = output.length;
      terminal.write("\u001b[200~paste before abort");
      await waitOutput("paste before abort", beforePaste);
    }
    if (cancelFirst) {
      const terminated = Promise.withResolvers<void>();
      const signalWatch = watch(root, async () => {
        if (await fs.stat(path.join(root, "agy-sigterm")).then(() => true, () => false)) terminated.resolve();
      });
      try {
        ws.send(JSON.stringify({ type: "remote_cancel", sessionId: discovery.id, reqId }));
        if (await fs.stat(path.join(root, "agy-sigterm")).then(() => true, () => false)) terminated.resolve();
        await terminated.promise;
      } finally { signalWatch.close(); }
    }
    if (pasteAbort) terminal.write("\u0003\u001b[201~");
    const beforeOff = output.length;
    if (noTui || cancelFirst) terminal.write("/discord  control   off\r");
    else await typed("/discord  control   off");
    const disabled = await waitFrame(frame => frame.type === "discord_control" && frame.enabled === false && (frame.generation as number) > (enabled.generation as number));
    expect(disabled.enabled).toBe(false);
    if (pasteAbort) {
      terminal.write("\u0003");
      expect(await proc.exited).not.toBe(0);
      return;
    }
    if (cancelFirst) {
      childPid = Number(await fs.readFile(path.join(root, "agy-pid"), "utf8"));
      expect(childPid).toBeGreaterThan(0);
      expect(process.kill(childPid, 0)).toBe(true);
    }
    if (localTurn) {
      ws.send(JSON.stringify({ type: "remote_request", sessionId: discovery.id, reqId, controlGeneration: enabled.generation, text: "must be denied" }));
      const rejected = await waitFrame(frame => frame.type === "ack" && frame.reqId === reqId);
      expect(rejected.ok).toBe(false);
      childPid = Number(await fs.readFile(path.join(root, "agy-pid"), "utf8"));
      expect(childPid).toBeGreaterThan(0);
      expect(process.kill(childPid, 0)).toBe(true);
    } else {
      const final = await waitFrame(frame => frame.type === "remote_final" && frame.reqId === reqId);
      expect(final.ok).toBe(false);
      expect(final.text).toBeUndefined();
      await waitOutput("Type your message", beforeOff);
      const beforeHelp = output.length;
      await typed("/help");
      await waitOutput("Tools: read / write / edit / bash / find / search.", beforeHelp);
    }
  } finally {
    watcher.close();
    ws?.close();
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    proc.kill();
    await proc.exited.catch(() => {});
    terminal.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30000);
