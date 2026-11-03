import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMessengerCliReply } from "../../src/commands/messenger";
import { parseMessengerConfig } from "../../src/messenger/config";

const [mode, root] = process.argv.slice(2);
if (!root) throw new Error("Fixture root required");
const binary = process.env.JEO_TEST_CLI_BINARY;
if (binary !== undefined) {
  if (!path.isAbsolute(binary)) throw new Error("JEO_TEST_CLI_BINARY must be an absolute executable path");
  await fs.access(binary, constants.X_OK);
}
const cwd = path.join(root, "workspace");
const resource = path.join(root, "requested-resource");
const configDir = path.join(root, "config");
await Promise.all([fs.mkdir(cwd), fs.mkdir(resource), fs.mkdir(configDir)]);
await fs.writeFile(path.join(resource, "private.txt"), "not approved for the worker");
await fs.writeFile(path.join(cwd, "public.txt"), "ISOLATED_WORKSPACE_READ-7c19\n");
const requests: Array<{ tools?: Array<{ function: { name: string; parameters: unknown } }>; messages: Array<{ role: string; content: unknown }>; stream?: boolean }> = [];
let sessionKey = "";
let mounts: Array<{ Source: string; Destination: string; RW: boolean }> = [];
async function inspectMounts() {
  const list = Bun.spawn(["docker", "container", "ls", "--filter", `label=dev.jeo.sandbox.session=${sessionKey}`, "--format", "{{.ID}}"], { stdout: "pipe", stderr: "pipe" });
  const ids = (await new Response(list.stdout).text()).trim().split(/\s+/).filter(Boolean);
  if (await list.exited !== 0 || ids.length !== 1) throw new Error(`Expected one session container, got ${JSON.stringify(ids)}`);
  const inspect = Bun.spawn(["docker", "inspect", "--format", "{{json .Mounts}}", ids[0]!], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(inspect.stdout).text();
  if (await inspect.exited !== 0) throw new Error("Could not inspect session mounts");
  mounts = JSON.parse(text);
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST") return Response.json({ data: [{ id: "requester-fixture" }] });
  const body = await request.json() as (typeof requests)[number];
  requests.push(body);
  const step = requests.length;
  const name = step === 1 || (step === 2 && mode !== "disabled") ? "sandbox_request"
    : step === 3 && mode === "restricted" ? "read" : "done";
  const args = step === 1 ? { action: "request", host: resource, mode: "ro" }
    : name === "sandbox_request" ? { action: "status" }
    : name === "read" ? { filePath: "/workspace/public.txt" } : { reason: "REQUESTER_SCENARIO_FINISHED" };
  if (name === "done") await inspectMounts();
  const call = { id: `fixture-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
  if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] });
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
} });
await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
  providers: {}, defaultModel: "openai/requester-fixture", openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
  routing: { enabled: false }, computer: { enabled: false }, gitAutoCommit: false,
}));
const config = parseMessengerConfig({
  cwd, sessionDir: path.join(root, "sessions"),
  sandbox: { image: "oven/bun:1.3.14", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } },
  ...(mode === "restricted" ? { toolNames: ["read"] } : mode === "explicit" ? { toolNames: ["sandbox_request"] } : mode === "disabled" ? { toolNames: [] } : {}),
  platforms: { discord: { allowedUserIds: ["operator"], model: "openai/requester-fixture" } },
}, root);
// Only the subprocess entry is adapted: all worker flags, environment, pooling, CLI launch,
// native schemas, tool dispatch, authority, and container execution are the real implementations.
let diagnostics = "";
let shutdownNonce = "";
let workerExited: Promise<number> | undefined;
const spawn = ((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
  const key = options?.env?.JEO_MESSENGER_SESSION_KEY;
  if (typeof key !== "string") throw new Error("Worker session identity missing");
  sessionKey = key;
  const nonce = options?.env?.JEO_MESSENGER_SHUTDOWN_NONCE;
  if (typeof nonce !== "string" || !nonce) throw new Error("Parent-generated cleanup nonce missing");
  shutdownNonce = nonce;
  const argv = binary ? [binary, ...command.slice(3)] : [...command];
  if (!binary) argv[2] = path.resolve(import.meta.dir, "../../src/cli.ts");
  const child = Bun.spawn(argv, { ...options, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  workerExited = child.exited;
  const stderr = child.stderr.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    diagnostics += new TextDecoder().decode(chunk);
    controller.enqueue(chunk);
  } }));
  return { pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr, exited: child.exited, kill: child.kill.bind(child), send: child.send.bind(child) };
}) as typeof Bun.spawn;
const reply = createMessengerCliReply(config, spawn, async model => model!);
const controller = new AbortController();
const watchdog = setTimeout(() => controller.abort(), 60_000);
let answer = "";
try {
  answer = await reply({ platform: "discord", accountId: "offline-bot", channelId: "offline-thread", senderId: "operator", messageId: "1", text: "Request the additional read-only resource, then report authority status.", direct: true, mentioned: false }, controller.signal);
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nWorker diagnostics: ${diagnostics}`);
} finally {
  clearTimeout(watchdog);
  controller.abort();
  try { await reply.close(); } finally { server.stop(true); }
}
const remaining = Bun.spawn(["docker", "container", "ls", "--all", "--filter", `label=dev.jeo.sandbox.session=${sessionKey}`, "--format", "{{.ID}}"], { stdout: "pipe", stderr: "pipe" });
const remainingText = await new Response(remaining.stdout).text();
if (await remaining.exited !== 0) throw new Error("Could not verify session container removal");
if (!workerExited) throw new Error("Expected real worker startup");
const workerExit = await workerExited;
const acknowledgements = diagnostics.split(/\r?\n/).filter(line => line.startsWith("JEO_MESSENGER_SHUTDOWN_ACK ")).map(line => JSON.parse(line.slice("JEO_MESSENGER_SHUTDOWN_ACK ".length)));
process.stdout.write(JSON.stringify({ answer, requests, mounts, cwd, resource, sessionKey, shutdownNonce, acknowledgements, remainingContainers: remainingText.trim().split(/\s+/).filter(Boolean), workerExit }) + "\n");
