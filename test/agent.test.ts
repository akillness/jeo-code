/**
 * jeoc agent/config/provider tests.
 *  - config set/get/show round-trip (subprocess, isolated HOME+cwd)
 *  - agent mock tool-calling loop (subprocess, scripted mock provider)
 *  - provider request builders (in-process, stubbed fetch) for gemini/anthropic/openai
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callProvider, type ChatMessage } from "../src/provider.ts";
import type { ResolvedConfig } from "../src/config.ts";

const JEOC = join(import.meta.dir, "..", "bin", "jeoc.ts");
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jeoc-agent-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", JEOC, ...args], {
    cwd: dir,
    env: { ...process.env, HOME: dir, ...extraEnv },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

test("config set/get/show round-trips and masks the api key", () => {
  expect(run(["config", "set", "provider", "gemini"]).code).toBe(0);
  expect(run(["config", "set", "model", "gemini-2.0-flash"]).code).toBe(0);
  expect(run(["config", "set", "apiKey", "SECRET-abcdef-123456"]).code).toBe(0);
  expect(existsSync(join(dir, ".jeoc", "config.json"))).toBe(true);

  expect(run(["config", "get", "provider"]).out.trim()).toBe("gemini");
  expect(run(["config", "get", "model"]).out.trim()).toBe("gemini-2.0-flash");

  const show = run(["config", "show"]).out;
  expect(show).toContain("provider    gemini");
  expect(show).toContain("model       gemini-2.0-flash");
  expect(show).not.toContain("SECRET-abcdef-123456"); // masked
  expect(show).toContain("source: config");
});

test("config resolves api key from env when not in config", () => {
  run(["config", "set", "provider", "anthropic"]);
  const show = run(["config", "show"], { ANTHROPIC_API_KEY: "env-key-xyz-987" }).out;
  expect(show).toContain("source: env");
  expect(show).not.toContain("env-key-xyz-987");
});

test("agent runs a mock tool-calling loop end to end", () => {
  const script = JSON.stringify([
    { toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "hello-from-tool" } }] },
    { text: "Done: wrote out.txt" },
  ]);
  const r = run(["agent", "create out.txt", "--provider", "mock"], { JEOC_MOCK_SCRIPT: script });
  expect(r.code).toBe(0);
  expect(existsSync(join(dir, "out.txt"))).toBe(true);
  expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("hello-from-tool");
  expect(r.out).toContain("write_file");
  expect(r.out).toContain("Done: wrote out.txt");
  expect(r.out).toContain("toolRuns=1");
});

test("agent --dry reports resolved config without calling a provider", () => {
  run(["config", "set", "provider", "mock"]);
  const r = run(["agent", "anything", "--dry"]);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.provider).toBe("mock");
  expect(j).toHaveProperty("maxTurns");
});

test("agent errors clearly when a real provider has no key", () => {
  const r = run(["agent", "task", "--provider", "openai"], { OPENAI_API_KEY: "" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("credential");
});

// ── provider request builders (stub fetch) ──────────────────────────────────
function stubFetch(responseObj: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responseObj), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}
const baseMsgs: ChatMessage[] = [{ role: "user", content: "hi" }];
const tool = { name: "bash", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } };
function cfg(provider: ResolvedConfig["provider"], model: string): ResolvedConfig {
  return { provider, model, apiKey: "K", apiKeySource: "config", configPath: null, maxTurns: 20 };
}

test("gemini builder: endpoint + key query + functionDeclarations", async () => {
  const calls = stubFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  const res = await callProvider(cfg("gemini", "gemini-2.0-flash"), { system: "s", messages: baseMsgs, tools: [tool] });
  expect(res.text).toBe("ok");
  expect(calls[0].url).toContain("/models/gemini-2.0-flash:generateContent?key=K");
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.tools[0].functionDeclarations[0].name).toBe("bash");
  expect(body.system_instruction.parts[0].text).toBe("s");
});

test("gemini builder groups consecutive tool results into one user content", async () => {
  const calls = stubFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "bash", args: { cmd: "one" } }, { id: "b", name: "bash", args: { cmd: "two" } }] },
    { role: "tool", content: "one", toolCallId: "a", toolName: "bash" },
    { role: "tool", content: "two", toolCallId: "b", toolName: "bash" },
  ];
  await callProvider(cfg("gemini", "gemini-2.0-flash"), { system: "s", messages, tools: [tool] });
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.contents[2].role).toBe("user");
  expect(body.contents[2].parts).toHaveLength(2);
});

test("anthropic builder: /v1/messages + x-api-key + input_schema", async () => {
  const calls = stubFetch({ content: [{ type: "text", text: "ok" }] });
  const res = await callProvider(cfg("anthropic", "claude-3-5-sonnet-latest"), { system: "s", messages: baseMsgs, tools: [tool] });
  expect(res.text).toBe("ok");
  expect(calls[0].url).toContain("/v1/messages");
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("K");
  expect(headers["anthropic-version"]).toBe("2023-06-01");
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.tools[0].input_schema).toBeDefined();
});

test("anthropic builder groups consecutive tool results into one user message", async () => {
  const calls = stubFetch({ content: [{ type: "text", text: "ok" }] });
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "bash", args: { cmd: "one" } }, { id: "b", name: "bash", args: { cmd: "two" } }] },
    { role: "tool", content: "one", toolCallId: "a", toolName: "bash" },
    { role: "tool", content: "two", toolCallId: "b", toolName: "bash" },
  ];
  await callProvider(cfg("anthropic", "claude-3-5-sonnet-latest"), { system: "s", messages, tools: [tool] });
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.messages[2].role).toBe("user");
  expect(body.messages[2].content).toHaveLength(2);
});

test("openai builder: /v1/chat/completions + Bearer + function tool", async () => {
  const calls = stubFetch({ choices: [{ message: { content: "ok" } }] });
  const res = await callProvider(cfg("openai", "gpt-4o-mini"), { system: "s", messages: baseMsgs, tools: [tool] });
  expect(res.text).toBe("ok");
  expect(calls[0].url).toContain("/v1/chat/completions");
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer K");
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.tools[0].type).toBe("function");
  expect(body.messages[0].role).toBe("system");
});

test("gemini parses functionCall into a toolCall", async () => {
  stubFetch({ candidates: [{ content: { parts: [{ functionCall: { name: "bash", args: { cmd: "ls" } } }] } }] });
  const res = await callProvider(cfg("gemini", "g"), { system: "s", messages: baseMsgs, tools: [tool] });
  expect(res.toolCalls[0].name).toBe("bash");
  expect(res.toolCalls[0].args.cmd).toBe("ls");
});

// ── setup / models ──────────────────────────────────────────────────────────
test("setup writes provider+model and defaults model when omitted", () => {
  expect(run(["setup", "--provider", "gemini"]).out).toContain("gemini/gemini-2.5-flash");
  expect(run(["config", "get", "provider"]).out.trim()).toBe("gemini");
  expect(run(["config", "get", "model"]).out.trim()).toBe("gemini-2.5-flash");
});

test("setup respects an explicit model", () => {
  run(["setup", "--provider", "openai", "--model", "gpt-4o"]);
  expect(run(["config", "get", "model"]).out.trim()).toBe("gpt-4o");
});

test("models lists the known registry with the default marked", () => {
  const r = run(["models", "--provider", "gemini"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("gemini-2.5-flash");
  expect(r.out).toContain("(default)");
});

test("doctor verifies mock provider readiness and can probe", () => {
  run(["setup", "--provider", "mock"]);
  const r = run(["doctor", "--probe"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("provider    mock");
  expect(r.out).toContain("probe       ok");
  expect(r.out).toContain("status      READY");
});

test("doctor fails real provider without an API key", () => {
  const r = run(["doctor", "--provider", "gemini"], { GEMINI_API_KEY: "", GOOGLE_API_KEY: "" });
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("provider    gemini");
  expect(r.out).toContain("NOT READY");
});

// ── auth (OAuth) + ollama (local provider) ──────────────────────────────────
test("auth login stores a masked oauth token and status reports it", () => {
  const r = run(["auth", "login", "--provider", "anthropic", "--token", "oauth-tok-abcdef-123456"]);
  expect(r.code).toBe(0);
  expect(existsSync(join(dir, ".jeoc", "auth.json"))).toBe(true);
  const st = run(["auth", "status"]);
  expect(st.out).toContain("anthropic");
  expect(st.out).not.toContain("oauth-tok-abcdef-123456"); // masked
});

test("oauth token makes a real provider keyless and drives Bearer auth", () => {
  run(["auth", "login", "--provider", "anthropic", "--token", "oauth-tok-abcdef-123456"]);
  // dry run shows authMode oauth without an api key
  const dry = JSON.parse(run(["agent", "x", "--provider", "anthropic", "--dry"]).out);
  expect(dry.authMode).toBe("oauth");
  expect(dry.hasOAuth).toBe(true);
});

test("auth logout removes the stored token", () => {
  run(["auth", "login", "--provider", "openai", "--token", "tok-zzz-aaaaaa-bbbbbb"]);
  run(["auth", "logout", "--provider", "openai"]);
  const dry = JSON.parse(run(["agent", "x", "--provider", "openai", "--dry"], { OPENAI_API_KEY: "" }).out);
  expect(dry.authMode).toBe("none");
});

test("anthropic uses Authorization: Bearer when an oauth token is set", async () => {
  const calls = stubFetch({ content: [{ type: "text", text: "ok" }] });
  const c: ResolvedConfig = { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: null, apiKeySource: "none", oauthToken: "OToken", authMode: "oauth", configPath: null, maxTurns: 20 };
  await callProvider(c, { system: "s", messages: baseMsgs, tools: [] });
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer OToken");
  expect(headers["x-api-key"]).toBeUndefined();
  expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
});

test("ollama is keyless and posts to /api/chat with tools, parsing tool_calls", async () => {
  const calls = stubFetch({ message: { content: "", tool_calls: [{ function: { name: "bash", arguments: { cmd: "ls" } } }] } });
  const c: ResolvedConfig = { provider: "ollama", model: "qwen2.5:0.5b", apiKey: null, apiKeySource: "none", oauthToken: null, authMode: "local", configPath: null, maxTurns: 20 };
  const res = await callProvider(c, { system: "s", messages: baseMsgs, tools: [tool] });
  expect(calls[0].url).toContain("http://localhost:11434/api/chat");
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.stream).toBe(false);
  expect(body.tools[0].function.name).toBe("bash");
  expect(res.toolCalls[0].name).toBe("bash");
  expect(res.toolCalls[0].args.cmd).toBe("ls");
});

test("agent allows ollama without any key (keyless local)", () => {
  const dry = JSON.parse(run(["agent", "x", "--provider", "ollama", "--dry"]).out);
  expect(dry.authMode).toBe("local");
});
