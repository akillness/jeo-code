import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { createSession } from "../src/agent/session";
import * as path from "node:path";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");

test("literal messenger prompts reach the model instead of executing local slash commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-literal-launch-"));
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir);
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
        cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root, JEO_CONFIG_DIR: configDir, OPENAI_API_KEY: "local-test-key", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "JEO_MESSENGER_STEP\n" });
      expect(stdout).toContain("safe response");
      expect(await fs.readFile(configPath, "utf8")).toBe(initial);
    }
    expect(received).toHaveLength(2);
    for (const [index, prompt] of ["/theme matrix", "/wiki off"].entries()) {
      expect(JSON.stringify(received[index])).toContain(prompt);
    }
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

test("literal messenger reports an HTTP provider failure but preserves the same words in a valid answer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-literal-provider-error-"));
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir);
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
        cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root, JEO_CONFIG_DIR: configDir, OPENAI_API_KEY: "local-test-key", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` }, stdout: "pipe", stderr: "pipe",
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
}, 30000);

test("resumed literal launches frame only the fresh Markdown reply", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-literal-resume-"));
  const sessionDir = path.join(root, "sessions");
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini" }));
  const id = "12345678-1234-4234-a234-123456789abc";
  await createSession(root, id, undefined, sessionDir, true);
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
        cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root, JEO_CONFIG_DIR: configDir, JEO_SESSION_DIR: sessionDir, OPENAI_API_KEY: "local-test-key", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "JEO_MESSENGER_STEP\n" });
      expect(stdout.trim()).toBe(`JEO_MESSENGER_RESULT ${JSON.stringify(replies[index])}`);
    }
    expect(calls).toBe(2);
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

test("literal launches cannot auto-commit local changes even when globally enabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-literal-git-"));
  const configDir = path.join(root, "config");
  const repo = path.join(root, "repo");
  await fs.mkdir(configDir);
  await fs.mkdir(repo);
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
      cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: root, JEO_CONFIG_DIR: configDir, OPENAI_API_KEY: "local-test-key", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "JEO_MESSENGER_STEP\n" });
    expect(stdout.trim()).toBe('JEO_MESSENGER_RESULT "done"');
    expect(git(["rev-parse", "HEAD"])).toBe(baseline);
    expect(git(["status", "--porcelain", "--", "owned.txt"])).toBe("M owned.txt");
    expect(await fs.readFile(path.join(repo, "owned.txt"), "utf8")).toBe("uncommitted user work\n");
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
