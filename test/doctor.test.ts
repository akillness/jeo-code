import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let cfgDir = "";
const savedCfgDir = process.env.JEO_CONFIG_DIR;
const savedFetch = globalThis.fetch;
// readGlobalConfig overlays env API keys onto provider gaps, so clear them to keep
// "no credential" / "oauth-only" diagnostics deterministic regardless of the host env.
const CRED_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_OAUTH_TOKEN", "GEMINI_OAUTH_TOKEN"];
const savedCredEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-doctor-"));
  process.env.JEO_CONFIG_DIR = cfgDir;
  for (const k of CRED_ENV) {
    savedCredEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
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

test("runDoctorCommand --json: gemini oauth-only probes Cloud Code Assist (the real call path)", async () => {
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
  expect(gemini.status).toBe("ok");
  // OAuth tokens are served via Cloud Code Assist, not generativelanguage.
  expect(gemini.detail).toContain("loadCodeAssist");
  expect(gemini.detail).not.toContain("claude-3-5-sonnet");
});

// --- routing diagnostic (design doc §7 risk #2) ---

test("runDoctorCommand --json: routing disabled -> no routing block in the report", async () => {
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({
    providers: {},
    defaultModel: "gpt-4o",
    // no `routing` key at all -> disabled by default
  }));
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

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
  expect(report.routing).toBeUndefined();
});

test("runDoctorCommand --json: routing enabled + roles.smol unset -> note present with escalation-skip wording", async () => {
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({
    providers: {},
    defaultModel: "gpt-4o",
    routing: { enabled: true },
    // no `roles` key -> roles.smol unconfigured
  }));
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

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
  expect(report.routing).toEqual({
    enabled: true,
    smolConfigured: false,
    notes: [expect.stringContaining("roles.smol is unset")],
  });
  expect(report.routing.notes[0]).toContain("LLM escalation");
});

test("runDoctorCommand --json: routing enabled + roles.smol set with a usable credential -> no notes", async () => {
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({
    providers: { openai: "sk-test-key" },
    defaultModel: "gpt-4o",
    routing: { enabled: true },
    roles: { smol: "gpt-4o-mini" },
  }));
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

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
  expect(report.routing).toEqual({ enabled: true, smolConfigured: true });
  expect(report.routing.notes).toBeUndefined();
});

test("runDoctorCommand --json: routing enabled + roles.smol set to an uncredentialed provider -> credential-readiness note", async () => {
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({
    providers: {},
    defaultModel: "claude-3-5-sonnet",
    routing: { enabled: true },
    roles: { smol: "gpt-4o-mini" }, // openai — no credential configured anywhere
  }));
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

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
  expect(report.routing.smolConfigured).toBe(true);
  expect(report.routing.notes).toHaveLength(1);
  expect(report.routing.notes[0]).toContain("routing.tiers.trivial");
  expect(report.routing.notes[0]).toContain("gpt-4o-mini");
  expect(report.routing.notes[0]).toContain("openai");
  expect(report.routing.notes[0]).toContain("no usable credential");
});

test("runDoctorCommand --json: routing.tiers.complex set to an uncredentialed provider -> tagged as complex, not trivial", async () => {
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({
    providers: { openai: "sk-test-key" },
    defaultModel: "claude-3-5-sonnet",
    routing: { enabled: true, tiers: { complex: { model: "gemini-2.0-flash" } } },
    roles: { smol: "gpt-4o-mini" },
    // gemini has no credential configured -> complex tier should be flagged, trivial (openai) should not
  }));
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

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
  expect(report.routing.notes).toHaveLength(1);
  expect(report.routing.notes[0]).toContain("routing.tiers.complex");
  expect(report.routing.notes[0]).toContain("gemini-2.0-flash");
});


test("runDoctorCommand (human output): routing on + roles.smol unset prints a yellow [routing] note; ready/strict logic unaffected", async () => {
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({
    providers: {},
    defaultModel: "gpt-4o",
    routing: { enabled: true },
  }));
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const { runDoctorCommand } = await import("../src/commands/doctor");
    await runDoctorCommand([]);
  } finally {
    console.log = orig;
  }

  const output = lines.join("\n");
  expect(output).toContain("[routing]");
  expect(output).toContain("roles.smol is unset");
  // Purely informational: the note must not turn NOT READY into a hard failure signal
  // beyond what provider connectivity already determines (openai has no credential here,
  // so NOT READY is expected from the provider gate, not from routing).
  expect(output).toContain("NOT READY");
});

test("runDoctorCommand (human output): routing off prints no [routing] block at all", async () => {
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify({
    providers: {},
    defaultModel: "gpt-4o",
  }));
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const { runDoctorCommand } = await import("../src/commands/doctor");
    await runDoctorCommand([]);
  } finally {
    console.log = orig;
  }

  expect(lines.join("\n")).not.toContain("[routing]");
});