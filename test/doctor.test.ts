import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let cfgDir = "";
const savedCfgDir = process.env.JOC_CONFIG_DIR;
const savedFetch = globalThis.fetch;
// readGlobalConfig overlays env API keys onto provider gaps, so clear them to keep
// "no credential" / "oauth-only" diagnostics deterministic regardless of the host env.
const CRED_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_OAUTH_TOKEN", "GEMINI_OAUTH_TOKEN"];
const savedCredEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-doctor-"));
  process.env.JOC_CONFIG_DIR = cfgDir;
  for (const k of CRED_ENV) {
    savedCredEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  if (savedCfgDir === undefined) delete process.env.JOC_CONFIG_DIR;
  else process.env.JOC_CONFIG_DIR = savedCfgDir;
  for (const k of CRED_ENV) {
    if (savedCredEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedCredEnv[k];
  }
  if (cfgDir) await fs.rm(cfgDir, { recursive: true, force: true });
});

test("runDoctorCommand --json: openai without credential is skipped instead of probing api.openai.com", async () => {
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({
    providers: {},
    defaultModel: "gpt-4o",
  }));

  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const { runDoctorCommand } = await import("../src/commands/doctor");
    await runDoctorCommand(["--json"]);
  } finally {
    console.log = orig;
  }

  const report = JSON.parse(lines.join("\n"));
  const openai = report.providers.find((p: any) => p.name === "openai");
  expect(openai.status).toBe("skipped");
  expect(openai.detail).toContain("no credential");
  expect(urls.some(u => u.includes("api.openai.com"))).toBe(false);
});

test("runDoctorCommand --json: gemini oauth-only diagnostic does not leak an unrelated default model id", async () => {
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({
    providers: {},
    oauth: { gemini: "oauth-gem" },
    defaultModel: "claude-3-5-sonnet",
  }));

  globalThis.fetch = (async (_input: RequestInfo | URL) => new Response("{}", { status: 200 })) as typeof fetch;

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const { runDoctorCommand } = await import("../src/commands/doctor");
    await runDoctorCommand(["--json"]);
  } finally {
    console.log = orig;
  }

  const report = JSON.parse(lines.join("\n"));
  const gemini = report.providers.find((p: any) => p.name === "gemini");
  expect(gemini.status).toBe("fail");
  expect(gemini.detail).toContain("Gemini OAuth");
  expect(gemini.detail).not.toContain("claude-3-5-sonnet");
});