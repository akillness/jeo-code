import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const sessionModule = path.resolve(import.meta.dir, "../src/agent/session.ts");
const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const id = "crash-recovery-test";

function isolatedEnv(dir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: dir, JEO_SESSION_DIR: path.join(dir, "sessions"), NO_COLOR: "1", JEO_STATIC_MEMORY: "1" };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC|OPENAI|GEMINI|XAI|KIMI|LMSTUDIO)_/.test(key) || key === "JEO_DEFAULT_MODEL") delete env[key];
  }
  return env;
}

async function runChild(script: string, dir: string): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: dir, env: isolatedEnv(dir), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out: await out, err: await err, code };
}

async function resume(dir: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, cli, "--resume", id, "--no-tui"], { cwd: dir, env: isolatedEnv(dir), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.end();
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  const code = await proc.exited;
  const stdout = await out;
  expect({ code, stderr: await err }).toEqual({ code: 0, stderr: "" });
  return stdout;
}

test("SIGKILL, restart and append preserve completed records and report failed work despite a partial tail", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-crash-recovery-"));
  const writer = Bun.spawn([process.execPath, "-e", `
    import { createSession, appendMessage, appendParentResponse, appendSubagentEvent, appendSubagentMessage, sessionPath } from ${JSON.stringify(sessionModule)};
    import { appendFile } from "node:fs/promises";
    const cwd = process.cwd(), id = ${JSON.stringify(id)};
    await createSession(cwd, id);
    await appendMessage(id, { role: "user", content: "Crash task before restart" }, cwd);
    await appendParentResponse(id, "response-1", { role: "assistant", content: "Parent response before crash" }, cwd);
    await appendSubagentEvent(id, { runId: "child-1", role: "reviewer", kind: "start", detail: "Review started" }, cwd);
    await appendSubagentMessage(id, { runId: "child-1", role: "reviewer", message: { role: "assistant", content: "Review finding before crash" } }, cwd);
    await appendSubagentEvent(id, { runId: "child-1", role: "reviewer", kind: "done", detail: "Review did not complete", success: false }, cwd);
    await appendFile(sessionPath(id, cwd), '{"type":"message","message":{"role":"assistant","content":"partial');
    console.log("READY");
    await Bun.stdin.stream().getReader().read();
  `], { cwd: dir, env: isolatedEnv(dir), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(writer.stderr).text();
  try {
    const reader = writer.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("READY");
    writer.kill("SIGKILL");
    expect(await writer.exited).not.toBe(0);
    expect(await stderr).toBe("");

    const first = await resume(dir);
    const markers = ["Crash task before restart", "Parent response before crash", "Review started", "Review finding before crash", "Review did not complete"];
    let previous = -1;
    for (const marker of markers) {
      const index = first.indexOf(marker);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(first).toContain("(failed)");
    expect(first).not.toContain('"content":"partial');

    const appended = await runChild(`
      import { appendMessage, loadSession } from ${JSON.stringify(sessionModule)};
      await appendMessage(${JSON.stringify(id)}, { role: "user", content: "Message after restart" }, process.cwd());
      const loaded = await loadSession(${JSON.stringify(id)}, process.cwd());
      console.log(JSON.stringify({ messages: loaded.messages, events: loaded.subagentEvents }));
    `, dir);
    expect({ code: appended.code, stderr: appended.err }).toEqual({ code: 0, stderr: "" });
    const loaded = JSON.parse(appended.out.trim());
    expect(loaded.messages.filter((m: { content: string }) => !m.content.includes("[Interrupted tool execution]")).map((m: { content: string }) => m.content)).toEqual(["Crash task before restart", "Message after restart"]);
    expect(loaded.messages.some((m: { role: string; content: string }) => m.role === "user" && m.content.includes("[Interrupted tool execution]") && m.content.includes("Parent response before crash"))).toBe(true);
    expect(loaded.events.map((e: { kind: string; success?: boolean }) => [e.kind, e.success ?? null])).toEqual([["start", null], ["done", false]]);
    const second = await resume(dir);
    expect(second).toContain("Message after restart");
    expect(second).toContain("(failed)");
  } finally {
    try { writer.kill("SIGKILL"); } catch { /* already exited */ }
    await writer.exited;
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 40000);

test("a killed CLI restores the prompt from an in-flight model request", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-launch-crash-"));
  const reached = Promise.withResolvers<void>();
  const never = Promise.withResolvers<Response>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "gpt-4o" }] });
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("Not found", { status: 404 });
      reached.resolve();
      return never.promise;
    },
  });
  const env = { ...isolatedEnv(dir), OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `${server.url}v1` };
  const proc = Bun.spawn([process.execPath, cli, "--model", "openai/gpt-4o", "--no-tui", "A prompt surviving forced termination"], { cwd: dir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  try {
    proc.stdin.end();
    await Promise.race([reached.promise, proc.exited.then(async code => { throw new Error(`CLI exited before model request (${code}): ${await out} ${await err}`); })]);
    proc.kill("SIGKILL");
    expect(await proc.exited).not.toBe(0);
    const files = await fs.readdir(path.join(dir, "sessions"));
    expect(files).toHaveLength(1);
    const sessionId = files[0]!.replace(/\.jsonl$/, "");
    const replay = Bun.spawn([process.execPath, cli, "--resume", sessionId, "--no-tui"], { cwd: dir, env: isolatedEnv(dir), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    replay.stdin.end();
    const replayOut = new Response(replay.stdout).text();
    const replayErr = new Response(replay.stderr).text();
    expect(await replay.exited).toBe(0);
    expect(await replayErr).toBe("");
    expect(await replayOut).toContain("A prompt surviving forced termination");
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    await proc.exited;
    never.resolve(new Response(""));
    server.stop(true);
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 40000);

test("recovered model context warns only for an uncommitted parent tool response", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-recovery-context-"));
  try {
    const seeded = await runChild(`
      import { createSession, appendMessage, appendMessages, appendParentResponse } from ${JSON.stringify(sessionModule)};
      const cwd = process.cwd(), id = ${JSON.stringify(id)};
      const completed = JSON.stringify({ tool: "bash", arguments: { command: "echo completed" } });
      const interrupted = JSON.stringify({ tool: "bash", arguments: { command: "echo interrupted" } });
      await createSession(cwd, id);
      await appendMessage(id, { role: "user", content: "Run the checks" }, cwd);
      await appendParentResponse(id, "completed-response", { role: "assistant", content: completed }, cwd);
      await appendMessages(id, [{ role: "assistant", content: completed, toolUse: [{ id: "call_0_0", tool: "bash", arguments: { command: "echo completed" } }] }, { role: "user", content: "Tool [bash] result (ok): completed", toolResults: [{ id: "call_0_0", output: "completed", isError: false }] }], cwd, ["completed-response", undefined]);
      await appendParentResponse(id, "interrupted-response", { role: "assistant", content: interrupted }, cwd);
    `, dir);
    expect({ code: seeded.code, stderr: seeded.err }).toEqual({ code: 0, stderr: "" });
    const loaded = await runChild(`
      import { loadSession } from ${JSON.stringify(sessionModule)};
      console.log(JSON.stringify((await loadSession(${JSON.stringify(id)}, process.cwd())).messages));
    `, dir);
    expect({ code: loaded.code, stderr: loaded.err }).toEqual({ code: 0, stderr: "" });
    const messages: { role: string; content: string }[] = JSON.parse(loaded.out.trim());
    const warnings = messages.filter(message => message.content.includes("[Interrupted tool execution]"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.role).toBe("user");
    expect(warnings[0]!.content).toContain("echo interrupted");
    expect(warnings[0]!.content).not.toContain("echo completed");
    expect(warnings[0]!.content).toMatch(/unknown|uncertain|may have/i);
    expect(warnings[0]!.content).toMatch(/check|verify|inspect/i);
    expect(messages.some(message => message.content.includes("Tool [bash] result (ok): completed"))).toBe(true);
    expect(messages.find(message => message.content === "Tool [bash] result (ok): completed")).toMatchObject({ toolResults: [{ id: "call_0_0", output: "completed", isError: false }] });
    expect(messages.find(message => message.role === "assistant" && message.content.includes("echo completed"))).toMatchObject({ toolUse: [{ id: "call_0_0", tool: "bash" }] });
    expect(messages.some(message => message.content.includes("Tool [bash] result") && message.content.includes("interrupted"))).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 40000);

test("a killed writer with a complete responseId line but a torn tool result remains uncertain", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-crash-batch-"));
  const writer = Bun.spawn([process.execPath, "-e", `
    import { createSession, appendMessage, appendParentResponse, sessionPath } from ${JSON.stringify(sessionModule)};
    import { appendFile } from "node:fs/promises";
    const cwd = process.cwd(), id = ${JSON.stringify(id)};
    const message = { role: "assistant", content: JSON.stringify({ tool: "bash", arguments: { command: "echo side-effect" } }), toolUse: [{ id: "tool-pending", tool: "bash", arguments: { command: "echo side-effect" } }] };
    await createSession(cwd, id);
    await appendMessage(id, { role: "user", content: "Perform the side effect" }, cwd);
    await appendParentResponse(id, "pending-response", message, cwd);
    // This is the on-disk prefix of a torn appendMessages batch: the linked
    // assistant record made it to disk, but the following result did not.
    await appendFile(sessionPath(id, cwd), JSON.stringify({ type: "message", timestamp: new Date().toISOString(), responseId: "pending-response", message }) + '\\n' + '{"type":"message","message":{"role":"user","content":"Tool [bash] result');
    console.log("READY");
    await Bun.stdin.stream().getReader().read();
  `], { cwd: dir, env: isolatedEnv(dir), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(writer.stderr).text();
  try {
    const reader = writer.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("READY");
    writer.kill("SIGKILL");
    expect(await writer.exited).not.toBe(0);
    expect(await stderr).toBe("");
    const loaded = await runChild(`
      import { loadSession } from ${JSON.stringify(sessionModule)};
      import { sessionPromptHistory } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/commands/launch/session-slash.ts"))};
      const { messages } = await loadSession(${JSON.stringify(id)}, process.cwd());
      console.log(JSON.stringify({ messages, prompts: sessionPromptHistory(messages) }));
    `, dir);
    expect({ code: loaded.code, stderr: loaded.err }).toEqual({ code: 0, stderr: "" });
    const recovery: { messages: { role: string; content: string }[]; prompts: string[] } = JSON.parse(loaded.out.trim());
    const { messages } = recovery;
    expect(recovery.prompts).toEqual(["Perform the side effect"]);
    const warnings = messages.filter(message => message.content.includes("[Interrupted tool execution]"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.role).toBe("user");
    expect(warnings[0]!.content).toContain("echo side-effect");
    expect(warnings[0]!.content).toMatch(/unknown|uncertain|may have/i);
    expect(warnings[0]!.content).toMatch(/check|verify|inspect/i);
    expect(messages.some(message => message.content.includes("Tool [bash] result"))).toBe(false);
    expect(messages.some(message => "toolUse" in message && Array.isArray(message.toolUse) && message.toolUse.some((tool: { id: string }) => tool.id === "tool-pending"))).toBe(false);
  } finally {
    try { writer.kill("SIGKILL"); } catch { /* already exited */ }
    await writer.exited;
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 40000);

test("a partially recorded multi-tool response warns without losing its completed tool pair", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-crash-multitool-"));
  try {
    const seeded = await runChild(`
      import { createSession, appendMessage, appendMessages, appendParentResponse } from ${JSON.stringify(sessionModule)};
      const cwd = process.cwd(), id = ${JSON.stringify(id)};
      const first = { tool: "bash", arguments: { command: "echo first-done" } };
      const second = { tool: "bash", arguments: { command: "echo second-unknown" } };
      const response = JSON.stringify({ tools: [first, second] });
      await createSession(cwd, id);
      await appendMessage(id, { role: "user", content: "Run both tools" }, cwd);
      await appendParentResponse(id, "multi-response", { role: "assistant", content: response }, cwd);
      await appendMessages(id, [
        { role: "assistant", content: response, toolUse: [{ id: "call_1_0", ...first }] },
        { role: "user", content: "Tool [bash] result (ok): first-done", toolResults: [{ id: "call_1_0", output: "first-done", isError: false }] },
      ], cwd, ["multi-response", undefined]);
    `, dir);
    expect({ code: seeded.code, stderr: seeded.err }).toEqual({ code: 0, stderr: "" });
    const loaded = await runChild(`
      import { loadSession } from ${JSON.stringify(sessionModule)};
      console.log(JSON.stringify((await loadSession(${JSON.stringify(id)}, process.cwd())).messages));
    `, dir);
    expect({ code: loaded.code, stderr: loaded.err }).toEqual({ code: 0, stderr: "" });
    const messages: { role: string; content: string }[] = JSON.parse(loaded.out.trim());
    const warnings = messages.filter(message => message.content.includes("[Interrupted tool execution]"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.role).toBe("user");
    expect(warnings[0]!.content).toContain("second-unknown");
    expect(messages.find(message => message.role === "assistant" && message.content.includes("first-done"))).toMatchObject({ toolUse: [{ id: "call_1_0", tool: "bash" }] });
    expect(messages.find(message => message.content === "Tool [bash] result (ok): first-done")).toMatchObject({ toolResults: [{ id: "call_1_0", output: "first-done", isError: false }] });
    expect(messages.some(message => message.content.includes("Tool [bash] result") && message.content.includes("second-unknown"))).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 40000);
