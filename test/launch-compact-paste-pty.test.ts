import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");
const GUARDIAN = path.resolve(import.meta.dir, "fixtures/sandbox-terminal-guardian.ts");
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
type RequestBody = { messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[]; stream?: boolean };

test("launch PTY: compact paste survives editing, submit, recall, reset and mixed image attachments without leaking bodies", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-compact-paste-pty-")));
  const config = path.join(root, "config");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(config, { mode: 0o700 });
  await fs.mkdir(workspace);
  let binary: string | undefined;
  if (process.env.JEO_TEST_BINARY) {
    const binaryDir = path.join(root, "isolated-binary");
    await fs.mkdir(binaryDir);
    binary = path.join(binaryDir, "jeo");
    await fs.copyFile(path.resolve(process.env.JEO_TEST_BINARY), binary);
    await fs.chmod(binary, 0o700);
  }
  const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
  const jpeg = Buffer.from([255,216,255,224,0,16,74,70]);
  const a = path.join(workspace, "first.png");
  const b = path.join(workspace, "second.jpg");
  await fs.writeFile(a, png);
  await fs.writeFile(b, jpeg);
  const requests: RequestBody[] = [];
  const releases: (() => void)[] = [];
  let output = "";
  let changed = Promise.withResolvers<void>();
  const signal = () => { const previous = changed; changed = Promise.withResolvers<void>(); previous.resolve(); };
  const deadline = Promise.withResolvers<never>();
  deadline.promise.catch(() => {});
  let phase = "startup";
  // A watchdog bounds real child-process IO; progress always waits for an observed event, never a sleep.
  const watchdog = setTimeout(() => deadline.reject(new Error(`PTY stalled at ${phase}: ${JSON.stringify(output.slice(-2000))}`)), 55_000);
  const until = async (label: string, predicate: () => boolean) => {
    phase = label;
    while (!predicate()) await Promise.race([changed.promise, deadline.promise]);
  };
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [{ id: "pty-model" }] });
    const body = await request.json() as RequestBody;
    const released = Promise.withResolvers<void>();
    releases.push(released.resolve);
    requests.push(body);
    signal();
    await released.promise;
    const text = "terminal regression complete";
    return body.stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] });
  } });
  await fs.writeFile(path.join(config, "config.json"), JSON.stringify({
    providers: {}, defaultModel: "openai/pty-model", openaiBaseUrl: `http://127.0.0.1:${provider.port}/v1`,
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
  const proc = Bun.spawn([process.execPath, GUARDIAN, process.execPath, CLI, "launch", "--no-skills", "--no-session", "--model", "openai/pty-model"], {
    cwd: workspace, terminal, detached: true,
    env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", JEO_CONFIG_DIR: config, OPENAI_API_KEY: "sk-test-local-only", JEO_STATIC_MEMORY: "1", NO_COLOR: "1", TERM: "xterm-256color", JEO_IMAGE_PROTOCOL: "kitty", ...(binary ? { JEO_TEST_CLI_BINARY: binary } : {}) },
    ipc(message) { if (message.type === "exit") deadline.reject(new Error(`CLI exited before completion: ${message.exitCode}; ${JSON.stringify(output.slice(-3000))}`)); },
  });
  const waitOutput = (needle: string, from: number) => until(`output ${needle}`, () => plain(output.slice(from)).includes(needle));
  const key = async (sequence: string) => {
    const from = output.length;
    terminal.write(sequence);
    await until(`key ${JSON.stringify(sequence)}`, () => output.length > from);
  };
  const waitCompact = async (marker: string, secret: string, from: number) => {
    await until(`compact draft ${marker}`, () => {
      const rendered = plain(output.slice(from));
      return rendered.includes(marker) || rendered.includes(secret);
    });
    const rendered = plain(output.slice(from));
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain(marker);
  };
  const type = async (text: string) => {
    for (const character of text) {
      const from = output.length;
      terminal.write(character);
      await until(`echo ${JSON.stringify(character)}`, () => output.length > from);
    }
  };
  const finishTurn = async (index: number, readyText = "Type your message") => {
    const from = output.length;
    releases[index]!();
    await waitOutput("[DONE]", from);
    await waitOutput(readyText, output.indexOf("[DONE]", from));
  };
  const userContent = (index: number) => requests[index]!.messages.filter(message => message.role === "user").at(-1)!.content;
  const paste = (text: string) => terminal.write(`${PASTE_START}${text}${PASTE_END}`);
  try {
    await waitOutput("Type your message", 0);
    await type("before ");
    const draftStart = output.length;
    const first = "private-A\r\n한🙂\t$&";
    paste(`\x1b[31mprivate-A\x1b[0m\r\n한🙂\t$&`);
    await waitCompact("[Paste #1, 2 lines,", "private-A", draftStart);
    await type(" between ");
    const second = "private-B\nlast";
    paste(second);
    await waitCompact("[Paste #2, 2 lines,", "private-B", draftStart);
    await type(" after");
    expect(plain(output.slice(draftStart))).not.toContain("private-A");
    expect(plain(output.slice(draftStart))).not.toContain("private-B");
    terminal.write("\r");
    await until("first exact provider request", () => requests.length === 1);
    const full = `before ${first} between ${second} after`;
    expect(userContent(0)).toBe(full);
    expect(plain(output.slice(draftStart))).not.toContain("private-A");
    expect(plain(output.slice(draftStart))).not.toContain("private-B");
    await finishTurn(0);

    // Recall the actual submitted draft and resubmit, not the literal placeholder text.
    const recallStart = output.length;
    terminal.write("\x1b[A");
    await waitCompact("[Paste #1, 2 lines,", "private-A", recallStart);
    expect(plain(output.slice(recallStart))).not.toContain("private-A");
    terminal.write("\r");
    await until("recalled exact provider request", () => requests.length === 2);
    expect(userContent(1)).toBe(full);
    expect(requests[1]!.messages.filter(message => message.role === "user").map(message => message.content)).toEqual([full, full]);
    await finishTurn(1);

    // Ctrl+U removes all marker references; reset must not retain hidden payloads.
    const resetStart = output.length;
    paste("discarded-private");
    await waitCompact("[Paste #3,", "discarded-private", resetStart);
    terminal.write("\x15");
    await type("fresh-only");
    terminal.write("\r");
    await until("reset provider request", () => requests.length === 3);
    expect(userContent(2)).toBe("fresh-only");
    const persisted = await fs.readFile(path.join(workspace, ".jeo", "input-history"), "utf8");
    expect(persisted).toContain("fresh-only");
    expect(persisted).not.toContain("[Paste #");
    await finishTurn(2);

    // Filesystem drops and text pastes share the real launch input and provider path.
    const imagesStart = output.length;
    paste(a);
    await waitOutput("#image01", imagesStart);
    paste(b);
    await waitOutput("#image02", imagesStart);
    await type("compare ");
    paste("hidden-caption\r\n한🙂");
    await until("mixed compact text marker", () => /\[Paste #\d+, 2 lines,/.test(plain(output.slice(imagesStart))));
    terminal.write("\r");
    await until("mixed image provider request", () => requests.length === 4);
    const mixed = userContent(3);
    expect(mixed).toEqual([
      { type: "text", text: "#image01 #image02 compare hidden-caption\r\n한🙂" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
    ]);
    const painted = output.slice(imagesStart);
    expect(plain(painted)).not.toContain("hidden-caption");
    expect(painted).not.toContain("\x1b_G");
    expect(painted).not.toContain("\x1b]1337;File=");
    expect(painted).not.toContain(png.toString("base64"));
    await finishTurn(3);

    const deleteImageStart = output.length;
    paste(a);
    await waitOutput("#image01", deleteImageStart);
    paste(b);
    await waitOutput("#image02", deleteImageStart);
    await key("\x01");
    await key("\x1b[3~");
    await key("\x05");
    await type("only-second");
    terminal.write("\r");
    await until("deleted image provider request", () => requests.length === 5);
    expect(userContent(4)).toEqual([
      { type: "text", text: "#image01 only-second" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
    ]);
    await finishTurn(4);

    await type("keep ");
    const deletePasteStart = output.length;
    paste("deleted-private\r\nx");
    await until("paste marker before deletion", () => /\[Paste #\d+, 2 lines,/.test(plain(output.slice(deletePasteStart))));
    await type(" tail");
    await key("\x01" + "\x1b[C".repeat("keep ".length) + "\x1b[3~");
    terminal.write("\r");
    await until("deleted paste provider request", () => requests.length === 6);
    expect(userContent(5)).toBe("keep  tail");
    expect(plain(output.slice(deletePasteStart))).not.toContain("deleted-private");
    // A paste captured while the provider is busy must obey the same sanitation policy.
    const livePasteStart = output.length;
    paste("\x1b[32mlive-private-ansi\x1b[0m\t$&");
    await until("live compact draft", () => /\[Paste #\d+, 1 lines,/.test(plain(output.slice(livePasteStart))));
    expect(plain(output.slice(livePasteStart))).not.toContain("live-private-ansi");
    await finishTurn(5, "> [Paste #");
    terminal.write("\r");
    await until("live paste provider request", () => requests.length === 7);
    expect(userContent(6)).toBe("live-private-ansi\t$&");
    const liveHistory = await fs.readFile(path.join(workspace, ".jeo", "input-history"), "utf8");
    expect(liveHistory).toContain("live-private-ansi\t$&");
    expect(liveHistory).not.toContain("\x1b");
    expect(liveHistory).not.toContain("[Paste #");
    await finishTurn(6);
  } finally {
    clearTimeout(watchdog);
    for (const release of releases) release();
    const cleanup = Promise.withResolvers<never>();
    const timer = setTimeout(() => cleanup.reject(new Error("PTY guardian cleanup timed out")), 10_000);
    try {
      if (proc.exitCode === null) proc.send("stop");
      await Promise.race([proc.exited, cleanup.promise]);
    } catch (error) {
      try { proc.disconnect(); } catch {}
      throw error;
    } finally {
      clearTimeout(timer);
      terminal.close();
      provider.stop(true);
      if (proc.exitCode !== null) await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 75_000);
