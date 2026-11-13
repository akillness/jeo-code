import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSession, type SessionEntry, type SessionHeader } from "../src/agent/session";
import { createNativeBackend } from "../src/agent/sandbox/native";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");
const GUARDIAN = path.resolve(import.meta.dir, "fixtures/sandbox-terminal-guardian.ts");
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
type RequestBody = { messages: { role: string; content: string }[]; stream?: boolean };
const primaryQuestion = `saved primary question ${"resume 한글 ASCII ".repeat(24)}USER-TAIL-END`;
const primaryAnswer = `saved primary answer ${"answer 한국어 ASCII ".repeat(24)}ANSWER-TAIL-END`;
const secondaryAnswer = `secondary answer ${"review 한국어 ASCII ".repeat(24)}SECONDARY-TAIL-END`;

async function withCleanup(run: (defer: (cleanup: () => void | Promise<void>) => void) => Promise<void>): Promise<void> {
  const cleanups: (() => void | Promise<void>)[] = [];
  try {
    await run(cleanup => cleanups.push(cleanup));
  } finally {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Resume PTY cleanup failed");
  }
}

// Linux needs both bubblewrap and usable namespaces; qualify the real mechanism, not just its executable.
const linuxNativeUnavailable = process.platform === "linux" && await createNativeBackend().preflight({ backend: "native" }).then(
  () => false,
  error => {
    if (!(error instanceof Error) || !error.message.startsWith("SANDBOX_UNAVAILABLE:")) throw error;
    console.warn(`Skipping resume PTY: ${error.message}`);
    return true;
  },
);

for (const entry of ["direct", "picker"] as const) {
  test.skipIf(process.platform === "win32" || linuxNativeUnavailable)(`launch PTY: ${entry} resume restores recorded work and accepts subsequent input`, async () => withCleanup(async defer => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-resume-pty-")));
    let childStopped = true;
    defer(async () => { if (childStopped) await fs.rm(root, { recursive: true, force: true }); });
    const config = path.join(root, "config");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(config, { mode: 0o700 });
    await fs.mkdir(workspace);
    const resource = path.join(root, "resource");
    const secretFile = path.join(resource, "secret.txt");
    await fs.mkdir(resource);
    await fs.writeFile(secretFile, "approved-resource-secret");
    const sessions = path.join(root, "sessions");
    const seed = async (title: string, question: string, answer: string, draft?: string) => {
      const session = await createSession(workspace, undefined, "openai/resume-pty-model", sessions);
      const header: SessionHeader = JSON.parse(await fs.readFile(session.path, "utf8"));
      const timestamp = "2026-01-01T00:00:00.000Z";
      const records = [
        { ...header, title, ...(draft ? { draft } : {}) },
        { type: "message", timestamp, message: { role: "user", content: question } },
        { type: "message", timestamp, message: { role: "assistant", content: answer } },
        { type: "subagent_event", timestamp, event: { runId: "saved-review", role: "reviewer", kind: "done", detail: "saved review complete", success: true } },
      ];
      await fs.writeFile(session.path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
      return session;
    };
    const selected = await seed("resume-primary", primaryQuestion, primaryAnswer, "saved draft");
    const other = await seed("resume-secondary", "secondary question", secondaryAnswer);
    const savedMessages = async (file: string) => (await fs.readFile(file, "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as SessionEntry).filter(entry => entry.type === "message").map(entry => entry.message);
    const requests: RequestBody[] = [];
    const releases: ((text?: string) => void)[] = [];
    let output = "";
    let changed = Promise.withResolvers<void>();
    const signal = () => { const previous = changed; changed = Promise.withResolvers<void>(); previous.resolve(); };
    const deadline = Promise.withResolvers<never>();
    deadline.promise.catch(() => {});
    let phase = "startup";
    // Fake time cannot control a child process; this watchdog only bounds stalled event-driven IO.
    const watchdog = setTimeout(() => deadline.reject(new Error(`Resume PTY stalled at ${phase}: ${JSON.stringify(output.slice(-3500))}`)), 55_000);
    defer(() => clearTimeout(watchdog));
    const until = async (label: string, predicate: () => boolean) => {
      phase = label;
      while (!predicate()) await Promise.race([changed.promise, deadline.promise]);
    };
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method !== "POST") return Response.json({ data: [{ id: "resume-pty-model" }] });
      const body = await request.json() as RequestBody;
      const release = Promise.withResolvers<string | undefined>();
      requests.push(body);
      releases.push(text => release.resolve(text));
      signal();
      const reply = await release.promise;
      const text = reply ?? `resumed turn ${requests.indexOf(body)} complete`;
      return body.stream
        ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] });
    } });
    defer(() => { provider.stop(true); });
    await fs.writeFile(path.join(config, "config.json"), JSON.stringify({
      providers: {}, defaultModel: "openai/resume-pty-model", openaiBaseUrl: `http://127.0.0.1:${provider.port}/v1`,
      sandbox: { backend: "native" }, routing: { enabled: false }, computer: { enabled: false }, gitAutoCommit: false,
    }));
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({ cols: 160, rows: 45, data(_terminal, bytes) {
      output += decoder.decode(bytes, { stream: true });
      signal();
      if (output.includes("! SESSION_MISMATCH:")) deadline.reject(new Error(`Resume rejected subsequent input: SESSION_MISMATCH at ${phase}`));
    } });
    defer(() => terminal.close());
    const args = entry === "direct" ? ["launch", "--resume", selected.id] : ["resume"];
    const proc = Bun.spawn([process.execPath, GUARDIAN, process.execPath, CLI, ...args, "--no-skills", "--model", "openai/resume-pty-model"], {
      cwd: workspace, terminal, detached: true,
      env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", JEO_CONFIG_DIR: config, JEO_SESSION_DIR: sessions, OPENAI_API_KEY: "sk-test-local-only", JEO_STATIC_MEMORY: "1", NO_COLOR: "1", TERM: "xterm-256color" },
      ipc(message) { if (message.type === "exit") deadline.reject(new Error(`CLI exited at ${phase}: ${message.exitCode}; ${JSON.stringify(output.slice(-3500))}`)); },
    });
    childStopped = false;
    defer(async () => {
      for (const release of releases) release();
      const cleanup = Promise.withResolvers<never>();
      // The guardian must finish revoking the real sandbox before fixtures can be removed.
      const timer = setTimeout(() => cleanup.reject(new Error("Resume PTY guardian cleanup timed out")), 10_000);
      try {
        if (proc.exitCode === null) proc.send("stop");
        await Promise.race([proc.exited, cleanup.promise]);
      } finally {
        clearTimeout(timer);
        childStopped = proc.exitCode !== null;
      }
    });
    const waitOutput = (needle: string, from = 0) => until(`output ${needle}`, () => plain(output.slice(from)).includes(needle));
    const key = async (sequence: string) => {
      const from = output.length;
      terminal.write(sequence);
      await until(`key ${JSON.stringify(sequence)}`, () => output.length > from);
    };
    const type = async (text: string) => { for (const character of text) await key(character); };
    const assertRestored = (from: number, markers: string[]) => {
      // An earlier printed transcript does not count if a later full-screen clear erased it.
      const start = Math.max(from, output.lastIndexOf("\x1b[2J"), output.lastIndexOf("\x1bc"));
      const rendered = plain(output.slice(start));
      let previous = -1;
      for (const marker of markers) {
        const index = rendered.indexOf(marker);
        expect(index, `visible restored marker ${marker}`).toBeGreaterThan(previous);
        previous = index;
      }
    };
    const submit = async (text: string, expectedUsers: string[], savedAnswer: string) => {
      const index = requests.length;
      await type(text);
      terminal.write("\r");
      await until(`provider request ${index}`, () => requests.length > index);
      expect(requests[index]!.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(expectedUsers);
      expect(requests[index]!.messages.filter(message => message.role === "assistant").map(message => message.content)).toContain(savedAnswer);
      const from = output.length;
      releases[index]!();
      await waitOutput("[DONE]", from);
      await waitOutput("Type your message", output.indexOf("[DONE]", from));
    };
    const control = async (command: string, response: string) => {
      const from = output.length;
      await type(command);
      terminal.write("\r");
      await waitOutput(response, from);
      await waitOutput("Type your message", from);
      return plain(output.slice(from));
    };
    const toolTurn = async (prompt: string, tool: string, args: Record<string, unknown>, check: (feedback: string) => void) => {
      const index = requests.length;
      await type(prompt);
      terminal.write("\r");
      await until(`tool request ${index}`, () => requests.length > index);
      releases[index]!(JSON.stringify({ tool, arguments: args }));
      await until(`tool feedback ${index + 1}`, () => requests.length > index + 1);
      check(requests[index + 1]!.messages.at(-1)!.content);
      const from = output.length;
      releases[index + 1]!(JSON.stringify({ tool: "done", arguments: { reason: "security probe complete" } }));
      await waitOutput("[DONE]", from);
      await waitOutput("Type your message", output.indexOf("[DONE]", from));
    };
    let approvedRequestId = "";
    let originalSandboxKey = "";
      if (entry === "picker") {
        await waitOutput("Resume a session");
        await type("resume-primary");
        terminal.write("\r");
      }
      await waitOutput("saved review complete");
      await waitOutput("> saved draft");
      assertRestored(0, ["saved primary question", "USER-TAIL-END", "saved primary answer", "ANSWER-TAIL-END", "saved review complete"]);
      await submit(" edited", [primaryQuestion, "saved draft edited"], primaryAnswer);
      expect((await savedMessages(selected.path)).filter(message => message.role === "user").map(message => message.content)).toEqual([primaryQuestion, "saved draft edited"]);

      // Escape closes the actual raw-mode menu without switching sessions or swallowing the next prompt.
      const menuStart = output.length;
      await type("/resume");
      terminal.write("\r");
      await waitOutput("Resume a session", menuStart);
      const cancelStart = output.length;
      terminal.write("\x1b");
      await waitOutput("resume cancelled", cancelStart);
      await waitOutput("Type your message", cancelStart);
      await submit("after cancelled picker", [primaryQuestion, "saved draft edited", "after cancelled picker"], primaryAnswer);
      expect((await savedMessages(other.path)).map(message => message.content)).toEqual(["secondary question", secondaryAnswer]);
      if (entry === "direct") {
        const status = await control("/sandbox status", "Sandbox session ");
        originalSandboxKey = status.match(/Sandbox session ([^,]+),/)![1]!;
        await toolTurn("Request access to the external resource", "sandbox_request", { host: resource, mode: "ro" }, feedback => {
          approvedRequestId = feedback.match(/"id"\s*:\s*"([^"]+)"/)![1]!;
        });
        await control(`/sandbox approve ${approvedRequestId}`, `Sandbox request ${approvedRequestId}: approved`);
        await toolTurn("Read the approved resource", "read", { filePath: secretFile }, feedback => {
          expect(feedback).toContain("approved-resource-secret");
        });
      }

      // Select a different saved session through the live slash menu, then prove context and input ownership moved together.
      const switchStart = output.length;
      await type("/resume");
      terminal.write("\r");
      await waitOutput("Resume a session", switchStart);
      await type("resume-secondary");
      terminal.write("\r");
      await waitOutput("secondary answer", output.lastIndexOf("Resume a session"));
      await waitOutput("Type your message", output.lastIndexOf("secondary answer"));
      assertRestored(switchStart, ["secondary question", "secondary answer", "SECONDARY-TAIL-END"]);
      await key("\x1b[A");
      await submit(" continued", ["secondary question", "secondary question continued"], secondaryAnswer);
      expect((await savedMessages(other.path)).filter(message => message.role === "user").map(message => message.content)).toEqual(["secondary question", "secondary question continued"]);
      if (entry === "direct") {
        const status = await control("/sandbox status", "Sandbox session ");
        const resumedSandboxKey = status.match(/Sandbox session ([^,]+),/)![1]!;
        expect(resumedSandboxKey).not.toBe(originalSandboxKey);
        await control(`/sandbox approve ${approvedRequestId}`, "UNKNOWN_REQUEST");
        await toolTurn("Read the old resource without new approval", "read", { filePath: secretFile }, feedback => {
          expect(feedback).toContain("Tool [read] result (fail):");
          expect(feedback).toMatch(/SANDBOX_DENIED|\bEPERM\b|\bEACCES\b/);
          expect(feedback).not.toContain("approved-resource-secret");
        });
      }
  }), 75_000);
}
