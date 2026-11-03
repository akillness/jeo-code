import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { createSession } from "../src/agent/session";
import * as path from "node:path";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

// Every literal/remote launch requires an explicit OS sandbox; there is no host fallback.
const sandbox = { image: "oven/bun:1.3.14", limits: { memoryBytes: 256 * 1024 * 1024, pids: 64, cpus: 1 } };

/** Disjoint workspace, private config and session directories. */
async function layout(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  const configDir = path.join(root, "config");
  const sessionDir = path.join(root, "sessions");
  for (const directory of [workspace, configDir, sessionDir]) await fs.mkdir(directory);
  return { root, workspace, configDir, sessionDir };
}

/** Real HOME is preserved so Docker keeps working; only fake local provider credentials are supplied. */
function launchEnv(dirs: { configDir: string; sessionDir: string }, port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    JEO_CONFIG_DIR: dirs.configDir,
    JEO_SESSION_DIR: dirs.sessionDir,
    JEO_MESSENGER_SANDBOX: JSON.stringify(sandbox),
    OPENAI_API_KEY: "local-test-key",
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    ...extra,
  };
}

const workerEnv = () => ({ JEO_MESSENGER_SESSION_KEY: crypto.randomUUID(), JEO_MESSENGER_ALLOWED_USER_IDS: "[]" });

test("literal messenger prompts reach the model instead of executing local slash commands", async () => {
  const dirs = await layout("jeo-literal-launch-");
  const { root, workspace, configDir } = dirs;
  const configPath = path.join(configDir, "config.json");
  const initial = JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini", theme: "cosmic" });
  await fs.writeFile(configPath, initial);
  const received: unknown[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] });
    const body = await request.json() as { stream?: boolean };
    received.push(body);
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "safe response" }, finish_reason: "stop" }] });
    return new Response('data: {"choices":[{"delta":{"content":"safe response"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    for (const prompt of ["/theme matrix", "/wiki off"]) {
      const child = Bun.spawn([process.execPath, cli, "launch", "--print", "--no-tui", "--no-skills", "--no-tools", "--literal-prompt", "--model", "openai/gpt-4o-mini", "--", prompt], {
        cwd: workspace, env: launchEnv(dirs, server.port!), stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "JEO_MESSENGER_ACTIVITY Step 1 · Thinking\n" });
      expect(stdout).toContain("safe response");
      expect(await fs.readFile(configPath, "utf8")).toBe(initial);
    }
    expect(received).toHaveLength(2);
    for (const [index, prompt] of ["/theme matrix", "/wiki off"].entries()) {
      expect(JSON.stringify(received[index])).toContain(prompt);
    }
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 120000);

test("literal messenger reports an HTTP provider failure but preserves the same words in a valid answer", async () => {
  const dirs = await layout("jeo-literal-provider-error-");
  const { root, workspace, configDir } = dirs;
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini" }));
  const errorText = "Gemini 3.5 Flash is no longer available. Please select a different model.";
  let calls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] });
    const body = await request.json() as { stream?: boolean };
    if (++calls === 1) return Response.json({ error: { message: errorText, type: "invalid_request_error" } }, { status: 400 });
    const answer = `The provider reported: ${errorText}`;
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const run = async (prompt: string) => {
      const child = Bun.spawn([process.execPath, cli, "launch", "--print", "--no-tui", "--no-skills", "--no-tools", "--literal-prompt", "--model", "openai/gpt-4o-mini", "--", prompt], {
        cwd: workspace, env: launchEnv(dirs, server.port!), stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    };
    const failure = await run("request unavailable model");
    expect(failure.code).not.toBe(0);
    expect(failure.stdout).not.toContain("JEO_MESSENGER_RESULT");
    expect(failure.stderr).toContain("Messenger agent turn did not complete");
    const success = await run("explain the provider error");
    expect(success.code).toBe(0);
    expect(success.stdout.trim()).toBe(`JEO_MESSENGER_RESULT ${JSON.stringify(`The provider reported: ${errorText}`)}`);
    expect(calls).toBe(2);
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 120000);

test("resumed literal launches frame only the fresh Markdown reply", async () => {
  const dirs = await layout("jeo-literal-resume-");
  const { root, workspace, sessionDir, configDir } = dirs;
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini" }));
  const id = "12345678-1234-4234-a234-123456789abc";
  await createSession(workspace, id, undefined, sessionDir, true);
  const replies = ["**first reply**", "## second reply\n\n- exact Markdown"];
  let calls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] });
    const body = await request.json() as { stream?: boolean };
    const content = replies[calls++] ?? "unexpected additional request";
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    for (const [index, prompt] of ["first request", "second request"].entries()) {
      const child = Bun.spawn([process.execPath, cli, "launch", "--print", "--no-tui", "--no-skills", "--no-tools", "--literal-prompt", "--model", "openai/gpt-4o-mini", "--resume", id, "--", prompt], {
        cwd: workspace, env: launchEnv(dirs, server.port!), stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "JEO_MESSENGER_ACTIVITY Step 1 · Thinking\n" });
      expect(stdout.trim()).toBe(`JEO_MESSENGER_RESULT ${JSON.stringify(replies[index])}`);
    }
    expect(calls).toBe(2);
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 120000);

test("literal launches cannot auto-commit local changes even when globally enabled", async () => {
  const dirs = await layout("jeo-literal-git-");
  const { root, configDir } = dirs;
  const repo = dirs.workspace;
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini", gitAutoCommit: true }));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  git(["init", "-q"]);
  await fs.writeFile(path.join(repo, "owned.txt"), "original\n");
  git(["add", "owned.txt"]);
  git(["commit", "-qm", "baseline"]);
  const baseline = git(["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(repo, "owned.txt"), "uncommitted user work\n");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] });
    return Response.json({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
  } });
  try {
    const child = Bun.spawn([process.execPath, cli, "launch", "--print", "--no-tui", "--no-skills", "--no-tools", "--literal-prompt", "--model", "openai/gpt-4o-mini", "--", "hello"], {
      cwd: repo, env: launchEnv(dirs, server.port!), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "JEO_MESSENGER_ACTIVITY Step 1 · Thinking\n" });
    expect(stdout.trim()).toBe('JEO_MESSENGER_RESULT "done"');
    expect(git(["rev-parse", "HEAD"])).toBe(baseline);
    expect(git(["status", "--porcelain", "--", "owned.txt"])).toBe("M owned.txt");
    expect(await fs.readFile(path.join(repo, "owned.txt"), "utf8")).toBe("uncommitted user work\n");
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 120000);

test("literal worker uses its explicit fallback only on a persistent quota failure", async () => {
  const dirs = await layout("jeo-worker-fallback-");
  const { root, workspace, configDir } = dirs;
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini", routing: { enabled: true } }));
  let mode = "quota";
  const models: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] });
    const body = await request.json() as { model: string; stream?: boolean };
    models.push(body.model);
    if (body.model === "gpt-4o-mini") return Response.json({ error: { message: mode === "quota" ? "quota exceeded" : "invalid credentials" } }, { status: mode === "quota" ? 429 : 401 });
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "fallback answer" }, finish_reason: "stop" }] });
    return new Response('data: {"choices":[{"delta":{"content":"fallback answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const run = async () => {
      const child = Bun.spawn([process.execPath, cli, "launch", "--print", "--no-tui", "--no-skills", "--no-tools", "--literal-worker", "--model", "openai/gpt-4o-mini", "--", "worker"], {
        cwd: workspace, env: launchEnv(dirs, server.port!, { ...workerEnv(), JEO_MESSENGER_FIXED_MODEL: "1", JEO_MESSENGER_USAGE_FALLBACK_MODEL: "openai/gpt-4o" }), stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      child.stdin.write('"hello"\n'); child.stdin.end();
      return { stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(), code: await child.exited };
    };
    const quota = await run();
    expect(quota.stdout).toContain('JEO_MESSENGER_RESULT "fallback answer"');
    expect(models).toEqual(["gpt-4o-mini", "gpt-4o"]);
    models.length = 0; mode = "auth";
    const auth = await run();
    expect(auth.stdout).toContain("JEO_MESSENGER_ERROR");
    expect(models).toEqual(["gpt-4o-mini"]);
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 120000);

test("literal worker can use explicitly enabled computer and file tools", async () => {
  const dirs = await layout("jeo-worker-tools-");
  const { root, workspace, configDir } = dirs;
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini", computer: { enabled: false } }));
  await fs.writeFile(path.join(workspace, "dummy.test.ts"), "import { test, expect } from 'bun:test'; test('ok', () => { expect(1).toBe(1); });\n");
  const requests: string[] = [];
  const replies = [
    JSON.stringify({ tool: "computer", arguments: { action: "wait", duration: 0 } }),
    JSON.stringify({ tool: "write", arguments: { filePath: "result.txt", content: "worker file" } }),
    JSON.stringify({ tool: "bash", arguments: { command: "bun test dummy.test.ts" } }),
    JSON.stringify({ tool: "done", arguments: { reason: "Summary: finished\nChanged Files: result.txt\nVerification: bun test dummy.test.ts" } }),
  ];



  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] });
    const body = await request.text();
    requests.push(body);
    const content = replies[requests.length - 1] ?? replies[2];
    if (!JSON.parse(body).stream) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const child = Bun.spawn([process.execPath, cli, "launch", "--print", "--no-tui", "--no-skills", "--tools", "computer,write,bash", "--literal-worker", "--model", "openai/gpt-4o-mini", "--", "worker"], {
      cwd: workspace, env: launchEnv(dirs, server.port!, { ...workerEnv(), JEO_MESSENGER_COMPUTER_ENABLED: "1" }), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write('"use tools"\n'); child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    expect(stdout).toContain('JEO_MESSENGER_RESULT');


    expect(await fs.readFile(path.join(workspace, "result.txt"), "utf8")).toBe("worker file");
    expect(JSON.parse((await fs.readFile(path.join(workspace, ".jeo", "computer-audit.jsonl"), "utf8")).trim())).toMatchObject({ action: { action: "wait" }, success: true });
    expect(requests[0]).toContain("computer {action");
    expect(requests[1]).toContain("Waited for 0 seconds");
    expect(requests.length).toBeGreaterThanOrEqual(4);
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 120000);

test("literal worker computer tool stays disabled in the real sandbox without explicit consent", async () => {
  const dirs = await layout("jeo-worker-computer-off-");
  const { root, workspace, configDir } = dirs;
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini", computer: { enabled: false } }));
  const requests: string[] = [];
  const replies = [
    JSON.stringify({ tool: "computer", arguments: { action: "wait", duration: 0, enabledOverride: true } }),
    JSON.stringify({ tool: "done", arguments: { reason: "Summary: computer disabled\nChanged Files: none\nVerification: none" } }),
  ];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [] });
    const body = await request.text();
    requests.push(body);
    const content = replies[Math.min(requests.length - 1, replies.length - 1)]!;
    if (!JSON.parse(body).stream) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const child = Bun.spawn([process.execPath, cli, "launch", "--print", "--no-tui", "--no-skills", "--tools", "computer", "--literal-worker", "--model", "openai/gpt-4o-mini", "--", "worker"], {
      cwd: workspace, env: launchEnv(dirs, server.port!, workerEnv()), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write('"try computer"\n'); child.stdin.end();
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1]).toContain("Computer use is disabled");
    expect(requests[1]).not.toContain("Waited for");
    // A host wait would also have created an audit file; the disabled guest must not.
    expect(await Bun.file(path.join(workspace, ".jeo", "computer-audit.jsonl")).exists()).toBe(false);
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 120000);