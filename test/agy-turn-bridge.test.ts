import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ImageAttachment, Message } from "../src/ai/types";
import { appendAgySession, createSession, loadSession, sessionPath } from "../src/agent/session";
import { runAgySessionTurn } from "../src/commands/launch/agy-turn";

const FIXTURE = join(import.meta.dir, "fixtures", "agy-fake-cli.ts");
const CLI = join(import.meta.dir, "../src/cli.ts");
const MODEL = "agy/gemini-4-argon-low";
const dirs: string[] = [];

function ndjson(...events: unknown[]): string[] {
  return events.map(event => `${JSON.stringify(event)}\n`);
}

function initEvent(conversationId: string): unknown {
  return {
    event: "init",
    conversation_id: conversationId,
    init: { model: "gemini-4-argon-low", cwd: "/fixture", tools: [], permission_mode: "request-review" },
  };
}

function resultEvent(conversationId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    event: "result",
    result: {
      conversation_id: conversationId,
      status: "SUCCESS",
      response: "final answer",
      model: "gemini-4-argon-low",
      num_turns: 1,
      ...overrides,
    },
  };
}

async function fixtureDir(stdout: string[], exitCode?: number): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "jeo-agy-bridge-"));
  dirs.push(cwd);
  await writeFile(join(cwd, "agy-fixture.json"), JSON.stringify({ stdout, ...(exitCode === undefined ? {} : { exitCode }) }));
  return cwd;
}

async function observed(cwd: string): Promise<{ args: string[]; stdin: string }> {
  return JSON.parse(await readFile(join(cwd, "agy-observed.json"), "utf8")) as { args: string[]; stdin: string };
}

async function sessionMessages(cwd: string, id: string): Promise<Message[]> {
  return (await loadSession(id, cwd)).messages;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test("successful agy session turns persist one assistant each and resume the exact CLI conversation", async () => {
  const cwd = await fixtureDir(ndjson(initEvent("conv-success"), resultEvent("conv-success")));
  const sessionId = "session-success";
  await createSession(cwd, sessionId, MODEL);

  const first = await runAgySessionTurn({
    model: MODEL,
    prompt: "first prompt",
    cwd,
    history: [],
    sessionId,
    executable: FIXTURE,
    timeoutMs: 2_000,
  });
  expect(first.response).toBe("final answer");
  expect(await sessionMessages(cwd, sessionId)).toEqual([
    { role: "user", content: "first prompt" },
    { role: "assistant", content: "final answer" },
  ]);
  expect((await loadSession(sessionId, cwd)).header.agy).toEqual({ conversationId: "conv-success", messageCount: 2 });

  const second = await runAgySessionTurn({
    model: MODEL,
    prompt: "second prompt",
    cwd,
    history: [
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "final answer" },
    ],
    sessionId,
    executable: FIXTURE,
    timeoutMs: 2_000,
  });
  expect(second.response).toBe("final answer");
  expect((await observed(cwd)).args).toContain("conv-success");
  expect(await sessionMessages(cwd, sessionId)).toEqual([
    { role: "user", content: "first prompt" },
    { role: "assistant", content: "final answer" },
    { role: "user", content: "second prompt" },
    { role: "assistant", content: "final answer" },
  ]);
  expect((await loadSession(sessionId, cwd)).header.agy).toEqual({ conversationId: "conv-success", messageCount: 4 });
});

test("explicit resume uses the selected agy session conversation, never the latest unrelated CLI conversation", async () => {
  const cwd = await fixtureDir(ndjson(initEvent("conv-selected"), resultEvent("conv-selected")));
  await createSession(cwd, "session-selected", MODEL);
  await createSession(cwd, "session-latest", MODEL);
  await appendAgySession("session-selected", { conversationId: "conv-selected", messageCount: 1 }, cwd);
  await appendAgySession("session-latest", { conversationId: "conv-latest", messageCount: 1 }, cwd);

  await runAgySessionTurn({
    model: MODEL,
    prompt: "continue selected",
    cwd,
    history: [{ role: "user", content: "previous selected" }],
    sessionId: "session-selected",
    executable: FIXTURE,
    timeoutMs: 2_000,
  });

  const invocation = await observed(cwd);
  expect(invocation.args).toContain("--conversation");
  expect(invocation.args).toContain("conv-selected");
  expect(invocation.args).not.toContain("conv-latest");
});

test("stale agy metadata does not resume a backend conversation after history changes", async () => {
  const cwd = await fixtureDir(ndjson(initEvent("conv-fresh"), resultEvent("conv-fresh")));
  await createSession(cwd, "session-stale", MODEL);
  await appendAgySession("session-stale", { conversationId: "conv-stale", messageCount: 1 }, cwd);

  await runAgySessionTurn({
    model: MODEL,
    prompt: "fresh context",
    cwd,
    history: [
      { role: "system", content: "jeo private system instructions" },
      { role: "user", content: "old one" },
      { role: "assistant", content: "old answer" },
    ],
    executable: FIXTURE,
    timeoutMs: 2_000,
  });

  const invocation = await observed(cwd);
  expect(invocation.args).not.toContain("--conversation");
  expect(invocation.stdin).toContain("old one");
  expect(invocation.stdin).toContain("old answer");
  expect(invocation.stdin).not.toContain("jeo private system instructions");
});

test("malformed agy session metadata is discarded instead of becoming resumable state", async () => {
  const cwd = await fixtureDir([]);
  const sessionId = "session-malformed-metadata";
  await createSession(cwd, sessionId, MODEL);
  await appendFile(sessionPath(sessionId, cwd), JSON.stringify({
    type: "agy_session",
    state: { conversationId: "", messageCount: -1 },
  }) + "\n", "utf8");

  expect((await loadSession(sessionId, cwd)).header.agy).toBeUndefined();
});

test("agy quota failure propagates and persists no assistant fallback", async () => {
  const quota = "Individual quota RESOURCE_EXHAUSTED 429: daily limit reached";
  const cwd = await fixtureDir(ndjson(initEvent("conv-quota"), resultEvent("conv-quota", { status: "ERROR", response: "", error: quota })), 3);
  const sessionId = "session-quota";
  await createSession(cwd, sessionId, MODEL);

  await expect(runAgySessionTurn({
    model: MODEL,
    prompt: "quota prompt",
    cwd,
    history: [],
    sessionId,
    executable: FIXTURE,
    timeoutMs: 2_000,
  })).rejects.toThrow(/RESOURCE_EXHAUSTED.*429|429.*RESOURCE_EXHAUSTED/);

  const messages = await sessionMessages(cwd, sessionId);
  expect(messages).toEqual([{ role: "user", content: "quota prompt" }]);
  expect(messages.some(message => message.role === "assistant")).toBe(false);
});

test("agy rejects unsupported images before child launch or user persistence", async () => {
  const cwd = await fixtureDir(ndjson(initEvent("conv-image"), resultEvent("conv-image")));
  const sessionId = "session-image";
  await createSession(cwd, sessionId, MODEL);
  const images: ImageAttachment[] = [{ mediaType: "image/png", data: "aGVsbG8=" }];

  await expect(runAgySessionTurn({
    model: MODEL,
    prompt: "image prompt",
    cwd,
    history: [],
    sessionId,
    images,
    timeoutMs: 2_000,
  })).rejects.toThrow(/image|unsupported/i);

  expect(await Bun.file(join(cwd, "agy-observed.json")).exists()).toBe(false);
  expect(await sessionMessages(cwd, sessionId)).toEqual([]);
});
test("isolated root launch branches an explicit agy model into the CLI session without raw HTTP", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jeo-agy-root-"));
  dirs.push(cwd);
  const bin = join(cwd, "bin");
  await mkdir(bin, { recursive: true });
  await symlink(FIXTURE, join(bin, "agy"));
  await writeFile(join(cwd, "agy-fixture.json"), JSON.stringify({ stdout: ndjson(initEvent("conv-root"), resultEvent("conv-root")) }));

  const proc = Bun.spawn([process.execPath, CLI, "--no-tui", "--no-session", "--no-skills", "--model", MODEL, "-p", "root prompt"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      JEO_CONFIG_DIR: join(cwd, ".jeo"),
      NO_COLOR: "1",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      OPENAI_OAUTH_TOKEN: "",
      GEMINI_OAUTH_TOKEN: "",
    },
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exit = await proc.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  expect(exit).toBe(0);
  expect(stdout).toContain("final answer");
  expect(stderr).not.toMatch(/No credential for provider|api\.anthropic\.com|api\.openai\.com/);
  expect((await observed(cwd)).args).toContain("--model");
  expect((await observed(cwd)).args).toContain("gemini-4-argon-low");
});
test("isolated root agy quota failure exits nonzero without assistant fallback or raw-provider routing", async () => {
  const quota = "\u001b[31mIndividual quota RESOURCE_EXHAUSTED 429: daily limit reached; reset after 60s\u001b[0m";
  const cwd = await mkdtemp(join(tmpdir(), "jeo-agy-root-quota-"));
  dirs.push(cwd);
  const bin = join(cwd, "bin");
  await mkdir(bin, { recursive: true });
  await symlink(FIXTURE, join(bin, "agy"));
  await writeFile(join(cwd, "agy-fixture.json"), JSON.stringify({
    stdout: ndjson(initEvent("conv-root-quota"), resultEvent("conv-root-quota", { status: "ERROR", response: "", error: quota })),
    exitCode: 3,
  }));

  const proc = Bun.spawn([process.execPath, CLI, "--no-tui", "--no-session", "--no-skills", "--model", MODEL, "-p", "root quota prompt"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      JEO_CONFIG_DIR: join(cwd, ".jeo"),
      NO_COLOR: "1",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      OPENAI_OAUTH_TOKEN: "",
      GEMINI_OAUTH_TOKEN: "",
    },
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exit = await proc.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  expect(exit).not.toBe(0);
  const combined = `${stdout}\n${stderr}`;
  expect(combined).toMatch(/RESOURCE_EXHAUSTED/);
  expect(combined).toMatch(/429/);
  expect(combined).toMatch(/reset after 60s/);
  expect(combined).not.toContain("\u001b[");
  expect(stdout).not.toContain("final answer");
  expect(`${stdout}\n${stderr}`).not.toMatch(/fallback|No credential for provider|api\.anthropic\.com|api\.openai\.com/i);
  expect((await observed(cwd)).args).toContain("gemini-4-argon-low");
});
test("root agy provider discovery preserves quota guidance without terminal controls", async () => {
  const diagnostic = "\u001b[31mIndividual quota RESOURCE_EXHAUSTED 429; reset after 60s\u001b]8;;https://example.invalid\u0007account\u001b]8;;\u0007";
  const cwd = await mkdtemp(join(tmpdir(), "jeo-agy-discovery-error-"));
  dirs.push(cwd);
  const bin = join(cwd, "bin");
  await mkdir(bin, { recursive: true });
  await symlink(FIXTURE, join(bin, "agy"));
  await writeFile(join(cwd, "agy-fixture.json"), JSON.stringify({ models: [], stderr: [diagnostic], exitCode: 3 }));

  const proc = Bun.spawn([process.execPath, CLI, "--no-tui", "--no-session", "--no-skills", "--provider", "agy"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      JEO_CONFIG_DIR: join(cwd, ".jeo"),
      NO_COLOR: "1",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GEMINI_API_KEY: "",
      OPENAI_OAUTH_TOKEN: "",
      GEMINI_OAUTH_TOKEN: "",
    },
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exit = await proc.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  expect(exit).not.toBe(0);
  expect(stderr).toContain("Individual quota RESOURCE_EXHAUSTED 429; reset after 60s");
  expect(stderr).not.toMatch(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
  expect(stderr).not.toContain("https://example.invalid");
  expect(stdout).not.toContain("final answer");
});
