import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

// Real PTY and filesystem events cross process boundaries; fake time cannot drive them.
async function waitFor<T>(check: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for session switch");
    await Bun.sleep(25);
  }
}

test("switching sessions closes the old notification endpoint for all connected clients", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-notify-switch-"));
  const cwd = path.join(root, "workspace");
  const config = path.join(root, "config");
  await fs.mkdir(cwd);
  await fs.mkdir(config);
  const requests: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [{ id: "pty-model" }] });
    requests.push(await request.text());
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "local answer marker" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  await fs.writeFile(path.join(config, "config.json"), JSON.stringify({ defaultModel: "openai/pty-model", providers: { openai: "local-test-key" }, openaiBaseUrl: `http://127.0.0.1:${provider.port}/v1`, notifications: { enabled: true }, hooks: { enabled: false }, routing: { enabled: false } }));
  let output = "";
  const terminal = new Bun.Terminal({ cols: 120, rows: 36, data(_terminal, bytes) { output += new TextDecoder().decode(bytes); } });
  const env = { HOME: root, PATH: process.env.PATH ?? "", JEO_CONFIG_DIR: config, JEO_STATIC_MEMORY: "1", NO_COLOR: "1", TERM: "xterm-256color" };
  const proc = Bun.spawn([process.execPath, cli, "launch", "--no-tui", "--no-skills"], { cwd, env, terminal });
  const sockets: WebSocket[] = [];
  try {
    const discoveryDir = path.join(config, "notifications", "sessions");
    const file = await waitFor(async () => (await fs.readdir(discoveryDir).catch(() => [] as string[])).find(name => name.endsWith(".json")));
    const discoveryPath = path.join(discoveryDir, file);
    const discovery = JSON.parse(await fs.readFile(discoveryPath, "utf8")) as { url: string; token: string };
    const frames: unknown[][] = [[], []];
    for (let i = 0; i < 2; i++) {
      const socket = new WebSocket(`${discovery.url}/?token=${encodeURIComponent(discovery.token)}`);
      sockets.push(socket);
      socket.addEventListener("message", event => frames[i]!.push(JSON.parse(String(event.data))));
    }
    await waitFor(async () => sockets.every(ws => ws.readyState === WebSocket.OPEN) && frames.every(f => f.length > 0) ? true : undefined);
    await waitFor(async () => output.includes("Type your message") ? true : undefined);
    const beforeSwitch = output.length;
    terminal.write("/session new\r");
    await waitFor(async () => output.includes("new session ") ? true : undefined);
    await waitFor(async () => sockets.every(ws => ws.readyState === WebSocket.CLOSED) ? true : undefined);
    await waitFor(async () => await fs.access(discoveryPath).then(() => undefined, () => true));
    await waitFor(async () => output.slice(beforeSwitch).includes("Type your message") ? true : undefined);
    const before = frames.map(f => f.length);
    terminal.write("new session private prompt\r");
    await waitFor(async () => requests.some(body => body.includes("new session private prompt")) ? true : undefined);
    await waitFor(async () => output.slice(beforeSwitch).includes("agent did not converge") ? true : undefined);
    expect(sockets.every(ws => ws.readyState === WebSocket.CLOSED)).toBe(true);
    expect(frames.map(f => f.length)).toEqual(before);
  } finally {
    for (const socket of sockets) socket.close();
    proc.kill();
    await proc.exited;
    terminal.close();
    provider.stop(true);
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("busy Telegram image reaches its own provider turn, not the next local prompt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-remote-provider-"));
  const imageDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-telegram-"));
  const imagePath = path.join(imageDir, "image.png");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXkAAAAASUVORK5CYII=", "base64");
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-outside-"));
  const outsidePath = path.join(outsideDir, "secret.png");
  const linkedFile = path.join(imageDir, "linked.png");
  const linkedDir = path.join(os.tmpdir(), `jeo-telegram-link-${crypto.randomUUID()}`);
  const hardLink = path.join(imageDir, "hardlink.png");
  const publicFile = path.join(imageDir, "public.png");
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-telegram-public-"));
  const publicDirFile = path.join(publicDir, "image.png");
  await fs.writeFile(imagePath, image, { mode: 0o600 });
  await fs.writeFile(outsidePath, image);
  await fs.symlink(outsidePath, linkedFile);
  await fs.symlink(imageDir, linkedDir);
  await fs.chmod(outsidePath, 0o600);
  await fs.link(outsidePath, hardLink);
  await fs.writeFile(publicFile, image, { mode: 0o644 });
  await fs.chmod(publicFile, 0o644);
  await fs.writeFile(publicDirFile, image, { mode: 0o600 });
  await fs.chmod(publicDir, 0o755);
  const cwd = path.join(root, "workspace");
  const config = path.join(root, "config");
  await fs.mkdir(cwd);
  await fs.mkdir(config);
  const requests: string[] = [];
  const release = Promise.withResolvers<void>();
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [{ id: "pty-model" }] });
    requests.push(await request.text());
    if (requests.length === 1) await release.promise;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  await fs.writeFile(path.join(config, "config.json"), JSON.stringify({ defaultModel: "openai/pty-model", providers: { openai: "local-test-key" }, openaiBaseUrl: `http://127.0.0.1:${provider.port}/v1`, notifications: { enabled: true }, hooks: { enabled: false }, routing: { enabled: false }, sandbox: { image: "oven/bun:1.3.14", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } } }));
  let output = "";
  const terminal = new Bun.Terminal({ cols: 120, rows: 36, data(_terminal, bytes) { output += new TextDecoder().decode(bytes); } });
  const env = { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", TMPDIR: os.tmpdir(), JEO_CONFIG_DIR: config, JEO_STATIC_MEMORY: "1", NO_COLOR: "1", TERM: "xterm-256color" };
  const proc = Bun.spawn([process.execPath, cli, "launch", "--no-tui", "--no-skills"], { cwd, env, terminal });
  let ws: WebSocket | undefined;
  try {
    const dir = path.join(config, "notifications", "sessions");
    const file = await waitFor(async () => (await fs.readdir(dir).catch(() => [] as string[])).find(name => name.endsWith(".json")));
    const discovery = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as { url: string; token: string };
    const frames: Record<string, unknown>[] = [];
    ws = new WebSocket(`${discovery.url}/?token=${encodeURIComponent(discovery.token)}`);
    ws.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
    await waitFor(async () => frames.some(m => m.type === "snapshot") && output.includes("Type your message") ? true : undefined);
    terminal.write("first local prompt\r");
    await waitFor(async () => requests.length === 1 ? true : undefined);
    for (const [reqId, filePath] of [["linked-file", linkedFile], ["linked-dir", path.join(linkedDir, "image.png")], ["hard-link", hardLink], ["public-file", publicFile], ["public-dir", publicDirFile]]) {
      ws.send(JSON.stringify({ type: "user_message", text: `blocked ${reqId}`, imagePaths: [filePath], reqId }));
      await waitFor(async () => frames.some(m => m.type === "ack" && m.reqId === reqId) ? true : undefined);
      expect(frames.find(m => m.type === "ack" && m.reqId === reqId)).toEqual({ type: "ack", reqId, ok: false });
    }
    const validImage = { mediaType: "image/png", data: image.toString("base64") };
    const invalidImages = [
      ["invalid-base64", [{ mediaType: "image/png", data: "not!base64" }]],
      ["truncated", [{ mediaType: "image/png", data: "iVBORw==" }]],
      ["wrong-mime", [{ ...validImage, mediaType: "image/jpeg" }]],
      ["multiple", [validImage, validImage]],
    ] as const;
    for (const [reqId, images] of invalidImages) {
      ws.send(JSON.stringify({ type: "user_message", text: `blocked ${reqId}`, images, reqId }));
      await waitFor(async () => frames.some(m => m.type === "ack" && m.reqId === reqId) ? true : undefined);
      expect(frames.find(m => m.type === "ack" && m.reqId === reqId)).toEqual({ type: "ack", reqId, ok: false });
    }
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1);
    image.copy(oversized);
    ws.send(JSON.stringify({ type: "user_message", text: "oversized", images: [{ mediaType: "image/png", data: oversized.toString("base64") }], reqId: "oversized" }));
    await waitFor(async () => frames.some(m => m.type === "ack" && m.reqId === "oversized") ? true : undefined);
    expect(frames.find(m => m.type === "ack" && m.reqId === "oversized")).toEqual({ type: "ack", reqId: "oversized", ok: false });
    ws.send(JSON.stringify({ type: "user_message", text: "remote photo request", images: [{ mediaType: "image/png", data: image.toString("base64") }], reqId: "photo" }));
    await waitFor(async () => frames.some(m => m.type === "ack" && m.reqId === "photo") ? true : undefined);
    expect(frames.find(m => m.type === "ack" && m.reqId === "photo")).toEqual({ type: "ack", reqId: "photo", ok: true });
    release.resolve();
    await waitFor(async () => requests.some(body => body.includes("remote photo request")) ? true : undefined);
    const remoteBody = requests.find(body => body.includes("remote photo request"))!;
    expect(remoteBody).toContain(image.toString("base64"));
    expect(requests[0]).not.toContain("remote photo request");
    expect(requests[0]).not.toContain(image.toString("base64"));
    await waitFor(async () => output.split("agent did not converge").length >= 3 ? true : undefined);
    const afterRemote = output.lastIndexOf("agent did not converge");
    await waitFor(async () => output.slice(afterRemote).includes("Type your message") ? true : undefined);
    terminal.write("unrelated local prompt\r");
    const localBody = await waitFor(async () => requests.find(body => body.includes("unrelated local prompt")));
    const payload = JSON.parse(localBody);
    const localMessage = payload.messages.find((message: { role: string; content: unknown }) => message.role === "user" && JSON.stringify(message.content).includes("unrelated local prompt"));
    expect(localMessage).toBeDefined();
    expect(JSON.stringify(localMessage)).not.toContain(image.toString("base64"));
    expect(JSON.stringify(payload.messages).split("remote photo request")).toHaveLength(2);
  } finally {
    release.resolve();
    ws?.close();
    proc.kill();
    await proc.exited;
    terminal.close();
    provider.stop(true);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(imageDir, { recursive: true, force: true });
    await fs.rm(linkedDir, { force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
    await fs.rm(publicDir, { recursive: true, force: true });
  }
}, 30_000);
