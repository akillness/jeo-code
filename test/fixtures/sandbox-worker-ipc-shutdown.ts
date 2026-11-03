import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMessengerCliReply } from "../../src/commands/messenger";
import { parseMessengerConfig } from "../../src/messenger/config";

const [root, modeArg = "active"] = process.argv.slice(2);
if (!root) throw new Error("Fixture root required");
// active: shutdown frame during a running guest tool. natural: one plain answer, then natural exit 0 (no frame/signal).
// early: exact shutdown frame sent synchronously right after spawn, before any model/tool work.
if (modeArg !== "active" && modeArg !== "natural" && modeArg !== "early") throw new Error(`Unknown mode ${modeArg}`);
const mode: "active" | "natural" | "early" = modeArg;
const binary = process.env.JEO_TEST_CLI_BINARY;
if (binary !== undefined) {
  if (!path.isAbsolute(binary)) throw new Error("JEO_TEST_CLI_BINARY must be an absolute executable path");
  await fs.access(binary, constants.X_OK);
}
const cwd = path.join(root, "workspace");
const configDir = path.join(root, "config");
await Promise.all([fs.mkdir(cwd), fs.mkdir(configDir)]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Deadline race whose timer is always cleared once the promise settles, so a losing timer never keeps the process alive.
async function bounded<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<F>(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function docker(args: string[]) {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`docker ${args[0]} failed`);
  return out.trim().split(/\s+/).filter(Boolean);
}
async function exists(file: string) { return fs.access(file).then(() => true, () => false); }

// The guest tool writes a barrier file, then blocks. The model turn is only complete if the container dies.
const command = "echo $$ > /workspace/tool.pid; touch /workspace/tool.started; while true; do sleep 1; done";
let requestCount = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST") return Response.json({ data: [{ id: "ipc-fixture" }] });
  const body = await request.json() as { stream?: boolean };
  requestCount++;
  if (mode !== "active") {
    // Non-mutating plain answer: no tool calls, so nothing in the workspace or container is touched.
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "natural exit answer" }, finish_reason: "stop" }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "natural exit answer" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  const call = { id: `fixture-${requestCount}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } };
  if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] });
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
} });
await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
  providers: {}, defaultModel: "openai/ipc-fixture", openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
  routing: { enabled: false }, computer: { enabled: false }, gitAutoCommit: false,
}));
const config = parseMessengerConfig({
  cwd, sessionDir: path.join(root, "sessions"),
  sandbox: { image: "oven/bun:1.3.14", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } },
  platforms: { discord: { allowedUserIds: ["operator"], model: "openai/ipc-fixture" } },
}, root);

let sessionKey = "";
let nonce = "";
let diagnostics = "";
let send: ((message: unknown) => void) | undefined;
let workerExited: Promise<number> | undefined;
let workerExitedEarly = false;
const killCalls: unknown[] = [];
let ipcJson = false;
let earlySent = false;
let endStdin: (() => unknown) | undefined;
const spawn = ((cmd: string[], options: Parameters<typeof Bun.spawn>[1]) => {
  ipcJson = typeof options?.ipc === "function" && options?.serialization === "json";
  const key = options?.env?.JEO_MESSENGER_SESSION_KEY;
  const captured = options?.env?.JEO_MESSENGER_SHUTDOWN_NONCE;
  if (typeof key !== "string" || typeof captured !== "string" || !captured) throw new Error("Worker identity/nonce missing");
  sessionKey = key; nonce = captured;
  const argv = binary ? [binary, ...cmd.slice(3)] : [...cmd];
  if (!binary) argv[2] = path.resolve(import.meta.dir, "../../src/cli.ts");
  // Real Bun IPC: the production options (ipc handler, serialization) are forwarded unchanged.
  const child = Bun.spawn(argv, { ...options, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  send = message => (child as unknown as { send(m: unknown): void }).send(message);
  // Actual stdin EOF closure of the real child; production reuses open stdin, so natural mode closes it explicitly after the turn.
  endStdin = () => (child.stdin as unknown as { end(): unknown }).end();
  workerExited = child.exited.then(code => { workerExitedEarly = true; return code; });
  if (mode === "early") { send({ type: "jeo_messenger_shutdown", nonce }); earlySent = true; }
  const stderr = child.stderr.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    diagnostics += new TextDecoder().decode(chunk);
    controller.enqueue(chunk);
  } }));
  return new Proxy(child, { get(target, prop) {
    if (prop === "stderr") return stderr;
    if (prop === "kill") return (...args: unknown[]) => { killCalls.push(args); return (target.kill as (...a: unknown[]) => unknown)(...args); };
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}) as typeof Bun.spawn;

const reply = createMessengerCliReply(config, spawn, async model => model!);
const controller = new AbortController();
const watchdog = setTimeout(() => controller.abort(), 90_000);
const turn = reply({ platform: "discord", accountId: "offline-bot", channelId: "offline-thread", senderId: "operator", messageId: "1", text: "Run the long tool.", direct: true, mentioned: false }, controller.signal).then(() => "resolved", () => "rejected");
let result: Record<string, unknown> = {};
const ackPrefix = "JEO_MESSENGER_SHUTDOWN_ACK ";
const readAcks = () => diagnostics.split(/\r?\n/).filter(l => l.startsWith(ackPrefix)).map(l => JSON.parse(l.slice(ackPrefix.length)));
const ownedContainers = () => docker(["container", "ls", "--all", "--filter", `label=dev.jeo.sandbox.session=${sessionKey}`, "--format", "{{.ID}}"]);
let leaked: string[] = [];
try {
  if (mode !== "active") {
    for (let i = 0; i < 300 && !workerExited; i++) await sleep(100);
    if (!workerExited) throw new Error(`Worker never spawned\n${diagnostics}`);
    // Neither mode kills the worker handle; natural exit relies on stdin EOF + normal completion only.
    let turnResult: string;
    if (mode === "natural") {
      // The turn must settle first (stdin stays open during it), then stdin EOF, then the worker exits normally.
      turnResult = await bounded(turn, 60_000, "pending");
      if (!endStdin) throw new Error("Worker stdin closure missing");
      await endStdin();
    } else turnResult = "pending";
    const workerExit = await bounded(workerExited, 60_000, -1);
    if (mode !== "natural") turnResult = await bounded(turn, 10_000, "pending");
    await sleep(500);
    const containersAfter = sessionKey ? await ownedContainers() : ["no-session-key"];
    result = {
      mode, ipcJson, earlySent, workerExit, turn: turnResult, requests: requestCount, killCalls: killCalls.length, nonce,
      toolStarted: await exists(path.join(cwd, "tool.started")), containersAfter, acknowledgements: readAcks(),
    };
  } else {
  // Barrier: the model asked for the tool and the guest process is really running inside the container.
  for (let i = 0; i < 600 && !(await exists(path.join(cwd, "tool.started"))); i++) await sleep(100);
  if (!(await exists(path.join(cwd, "tool.started")))) throw new Error(`Guest tool never started\n${diagnostics}`);
  if (!send || !workerExited) throw new Error("IPC channel missing");
  const guestPid = (await fs.readFile(path.join(cwd, "tool.pid"), "utf8")).trim();
  const [containerId] = await docker(["container", "ls", "--filter", `label=dev.jeo.sandbox.session=${sessionKey}`, "--format", "{{.ID}}"]);
  if (!containerId) throw new Error("Owned container missing before shutdown");
  const badFrames = [
    { type: "jeo_messenger_shutdown", nonce: `${nonce}-wrong` },
    { type: "jeo_messenger_shutdown" },
    { type: "jeo_messenger_shutdown", nonce, extra: true },
    { type: "other", nonce },
    "jeo_messenger_shutdown",
  ];
  for (const frame of badFrames) send(frame);
  await sleep(3000);
  const aliveAfterBad = !workerExitedEarly && (await docker(["container", "ls", "--filter", `id=${containerId}`, "--format", "{{.ID}}"])).length === 1
    && (await docker(["exec", containerId, "sh", "-c", `kill -0 ${guestPid}`]).then(() => true, () => false));
  const ackBefore = diagnostics.includes("JEO_MESSENGER_SHUTDOWN_ACK ");
  const killsBefore = killCalls.length;
  send({ type: "jeo_messenger_shutdown", nonce });
  const workerExit = await bounded(workerExited, 60_000, -1);
  const containersAfter = await docker(["container", "ls", "--all", "--filter", `label=dev.jeo.sandbox.session=${sessionKey}`, "--format", "{{.ID}}"]);
  const acknowledgements = diagnostics.split(/\r?\n/).filter(l => l.startsWith("JEO_MESSENGER_SHUTDOWN_ACK ")).map(l => JSON.parse(l.slice("JEO_MESSENGER_SHUTDOWN_ACK ".length)));
  result = { aliveAfterBad, ackBefore, killsBefore, killsAfter: killCalls.length, workerExit, containersAfter, containerId, acknowledgements, nonce, turn: await bounded(turn, 5000, "pending") };
  }
} finally {
  clearTimeout(watchdog);
  // Cleanup order: authenticated IPC shutdown first (never a blind kill), confirm container absence, then close the owner.
  try {
    if (send && workerExited && !workerExitedEarly) {
      send({ type: "jeo_messenger_shutdown", nonce });
      await bounded(workerExited, 60_000, -1);
    }
  } catch {}
  controller.abort();
  try { await reply.close(); } finally { server.stop(true); }
  if (sessionKey) {
    leaked = await ownedContainers().catch(() => []);
    if (leaked.length > 0) {
      // Last resort only after IPC cleanup and owner close failed to remove the labeled containers.
      await docker(["rm", "-f", ...leaked]).catch(() => []);
      throw new Error(`Owned containers survived authenticated cleanup: ${leaked.join(",")}`);
    }
  }
}
process.stdout.write(JSON.stringify(result) + "\n");
