import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/launch-async-attachments.ts");
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
type Part = { type: string; text?: string; image_url?: { url: string } };
type RequestBody = { messages: { role: string; content: string | Part[] }[]; stream?: boolean };
type ReadEvent = { type: "read-started" | "read-settled"; kind: string; id: number };

test("launch PTY: deferred clipboard and file reads cannot resurrect cleared drafts or overwrite later input", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-async-attachments-pty-")));
  const config = path.join(root, "config");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(config, { mode: 0o700 });
  await fs.mkdir(workspace);
  const dropPath = path.join(workspace, "dropped.png");
  await fs.writeFile(dropPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]));
  const requests: RequestBody[] = [];
  const providerReleases: (() => void)[] = [];
  const events: ReadEvent[] = [];
  const attachmentResults: { input: string; output: string; images: number }[] = [];
  const usedReads = new Set<number>();
  let output = "";
  let consumedInput = "";
  let changed = Promise.withResolvers<void>();
  const signal = () => { const previous = changed; changed = Promise.withResolvers<void>(); previous.resolve(); };
  const deadline = Promise.withResolvers<never>();
  deadline.promise.catch(() => {});
  let phase = "startup";
  // Real-process IO is event-driven; this watchdog only bounds a stalled child and cannot use fake time across processes.
  const watchdog = setTimeout(() => deadline.reject(new Error(`Async PTY stalled at ${phase}: ${JSON.stringify(output.slice(-2500))}`)), 65_000);
  const until = async (label: string, predicate: () => boolean) => {
    phase = label;
    while (!predicate()) await Promise.race([changed.promise, deadline.promise]);
  };
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [{ id: "async-fixture-model" }] });
    const body = await request.json() as RequestBody;
    const release = Promise.withResolvers<void>();
    requests.push(body);
    providerReleases.push(release.resolve);
    signal();
    await release.promise;
    const text = "async attachment regression complete";
    return body.stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] });
  } });
  await fs.writeFile(path.join(config, "config.json"), JSON.stringify({
    providers: {}, defaultModel: "openai/async-fixture-model", openaiBaseUrl: `http://127.0.0.1:${provider.port}/v1`,
    sandbox: process.platform === "linux"
      ? { backend: "docker", image: "oven/bun:1.3.14", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } }
      : { backend: "native" },
    routing: { enabled: false }, computer: { enabled: false }, gitAutoCommit: false,
  }));
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 160, rows: 40, data(_terminal, bytes) {
    output += decoder.decode(bytes, { stream: true });
    signal();
  } });
  const proc = Bun.spawn([process.execPath, FIXTURE], {
    cwd: workspace, terminal, detached: true,
    env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", JEO_CONFIG_DIR: config, OPENAI_API_KEY: "sk-test-local-only", JEO_STATIC_MEMORY: "1", NO_COLOR: "1", TERM: "xterm-256color", JEO_IMAGE_PROTOCOL: "kitty" },
    ipc(message: ReadEvent | { type: "exit"; exitCode: number } | { type: "stdin-consumed"; data: string } | { type: "attachment-result"; input: string; output: string; images: number }) {
      if (message.type === "exit") deadline.reject(new Error(`CLI exited at ${phase}: ${message.exitCode}; ${JSON.stringify(output.slice(-2500))}`));
      else if (message.type === "stdin-consumed") consumedInput += message.data;
      else if (message.type === "attachment-result") attachmentResults.push(message);
      else events.push(message);
      signal();
    },
  });
  const waitOutput = (needle: string, from: number) => until(`output ${needle}`, () => plain(output.slice(from)).includes(needle));
  const key = async (sequence: string) => {
    const from = consumedInput.length;
    terminal.write(sequence);
    await until(`key ${JSON.stringify(sequence)}`, () => consumedInput.slice(from).includes(sequence));
  };
  const type = async (text: string) => { for (const character of text) await key(character); };
  const takeRead = async (kind: string): Promise<ReadEvent> => {
    await until(`read ${kind}`, () => events.some(event => event.type === "read-started" && event.kind === kind && !usedReads.has(event.id)));
    const event = events.find(event => event.type === "read-started" && event.kind === kind && !usedReads.has(event.id))!;
    usedReads.add(event.id);
    return event;
  };
  const releaseRead = async (event: ReadEvent, value: "image" | "text" | "none", text?: string) => {
    proc.send({ type: "release", id: event.id, value, text });
    await until(`settled ${event.kind} ${event.id}`, () => events.some(item => item.type === "read-settled" && item.id === event.id));
  };
  const userContent = (index: number) => requests[index]!.messages.filter(message => message.role === "user").at(-1)!.content;
  const submitText = async (text: string) => {
    const index = requests.length;
    await type(text);
    terminal.write("\r");
    await until(`provider request ${index}`, () => requests.length > index);
    expect(userContent(index)).toBe(text);
    return index;
  };
  const finishTurn = async (index: number) => {
    const from = output.length;
    providerReleases[index]!();
    await waitOutput("[DONE]", from);
    await waitOutput("Type your message", output.indexOf("[DONE]", from));
  };
  try {
    await waitOutput("Type your message", 0);

    terminal.write("\x16");
    const ctrlCRead = await takeRead("clipboard-image");
    await key("\x03");
    await releaseRead(ctrlCRead, "image");
    await finishTurn(await submitText("after Ctrl+C clear"));

    terminal.write("\x16");
    const imageRead = await takeRead("clipboard-image");
    await releaseRead(imageRead, "none");
    const textRead = await takeRead("clipboard-text");
    await key("\x15");
    await releaseRead(textRead, "text", "stale clipboard text must not return");
    await finishTurn(await submitText("after Ctrl+U clear"));

    terminal.write("\x16");
    const pendingAtSubmit = await takeRead("clipboard-image");
    const submittedIndex = await submitText("submitted before clipboard completes");
    await finishTurn(submittedIndex);
    await releaseRead(pendingAtSubmit, "image");
    await finishTurn(await submitText("new prompt stays independent"));

    terminal.write(`${PASTE_START}${dropPath}${PASTE_END}`);
    const pendingDrop = await takeRead("drop-file");
    await type(" appended suffix");
    await releaseRead(pendingDrop, "image");
    const dropIndex = requests.length;
    terminal.write("\r");
    while (requests.length <= dropIndex) {
      await until("edited drop read or provider request", () => requests.length > dropIndex || events.some(event => event.type === "read-started" && event.kind === "drop-file" && !usedReads.has(event.id)));
      if (requests.length > dropIndex) break;
      await releaseRead(await takeRead("drop-file"), "image");
    }
    const content = userContent(dropIndex);
    await finishTurn(dropIndex);

    terminal.write(`${PASTE_START}${dropPath}${PASTE_END}`);
    const clearedDrop = await takeRead("drop-file");
    await key("\x15");
    await releaseRead(clearedDrop, "image");
    await finishTurn(await submitText("after dropped path clear"));

    terminal.write("\x16");
    const escapeRead = await takeRead("clipboard-image");
    await key("\x1b[27u");
    await releaseRead(escapeRead, "image");
    await finishTurn(await submitText("after Escape clear"));

    if (typeof content === "string") throw new Error(`Edited drop lost its image attachment: ${JSON.stringify({ content, attachmentResults, events })}`);
    expect(content.filter(part => part.type === "text").map(part => part.text).join("\n")).toBe("#image01 appended suffix");
    expect(content.filter(part => part.type === "image_url").map(part => part.image_url?.url)).toEqual([
      `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]).toString("base64")}`,
    ]);
  } finally {
    clearTimeout(watchdog);
    for (const release of providerReleases) release();
    const cleanup = Promise.withResolvers<never>();
    // Bound process cleanup, not test progress: the child must revoke its real sandbox before removal.
    const timer = setTimeout(() => cleanup.reject(new Error("Async attachment PTY cleanup timed out")), 10_000);
    try {
      if (proc.exitCode === null) proc.send("stop");
      await Promise.race([proc.exited, cleanup.promise]);
    } finally {
      clearTimeout(timer);
      terminal.close();
      provider.stop(true);
      if (proc.exitCode !== null) await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 85_000);
