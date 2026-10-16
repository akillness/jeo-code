import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { listAgyModels } from "../src/agent/antigravity-cli";
import { describeProvider, type ProviderStatus } from "../src/ai/provider-status";
import { catalogOr, discoverModels, listProviderModels } from "../src/ai/model-discovery";
import { applyCachedModels, mergeCacheEntries, normalizeCacheEntries, readModelCache, writeModelCache } from "../src/ai/model-cache";
import { liveProviderCatalogModels, recordLiveProviderModels, resetLiveProviderModels } from "../src/ai/model-catalog";
import { providerModelFor, qualifyModelId, resolveCall, resolveProvider } from "../src/ai/model-manager";
import { tierModelPool, type RoutingConfig } from "../src/agent/prompt-router";
import type { Config } from "../src/agent/state";

const CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GEMINI_OAUTH_TOKEN",
  "GOOGLE_API_KEY",
  "GOOGLE_OAUTH_TOKEN",
] as const;
let previousCredentialEnv: Record<string, string | undefined>;
let previousFetch: typeof fetch;

let configDir: string;
const previousConfigDir = process.env.JEO_CONFIG_DIR;
const fakeAgy = path.join(import.meta.dir, "fixtures", "agy-fake-cli.ts");

async function configureFakeAgy(config: { models?: string[]; exitCode?: number; stderr?: string[] }): Promise<void> {
  await fs.writeFile(path.join(configDir, "agy-fixture.json"), JSON.stringify(config), "utf8");
}

async function describeAgyInIsolatedPath(pathValue: string): Promise<ProviderStatus> {
  const providerStatusModule = path.resolve(import.meta.dir, "../src/ai/provider-status.ts");
  const script = `import { describeProvider } from ${JSON.stringify(providerStatusModule)}; const status = await describeProvider("agy", { providers: {}, oauth: {} }); process.stdout.write(JSON.stringify(status));`;
  const proc = Bun.spawn([process.execPath, "--eval", script], {
    env: { ...process.env, PATH: pathValue },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`isolated agy status probe failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout) as ProviderStatus;
}

beforeEach(async () => {
  previousCredentialEnv = Object.fromEntries(CREDENTIAL_ENV_KEYS.map(key => [key, process.env[key]]));
  previousFetch = globalThis.fetch;
  for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key];
  globalThis.fetch = (async () => { throw new Error("agy model discovery must not use HTTP"); }) as typeof fetch;
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agy-config-"));
  process.env.JEO_CONFIG_DIR = configDir;
  resetLiveProviderModels();
});

afterEach(async () => {
  resetLiveProviderModels();
  globalThis.fetch = previousFetch;
  for (const key of CREDENTIAL_ENV_KEYS) {
    const value = previousCredentialEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (previousConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = previousConfigDir;
  await fs.rm(configDir, { recursive: true, force: true });
});

test("agy namespace is explicit, qualified, and never routed through CCA heuristics", () => {
  const model = "gemini-4-argon-low";
  expect(resolveProvider(`agy/${model}`)).toBe("agy");
  expect(qualifyModelId(model, "agy")).toBe(`agy/${model}`);
  expect(providerModelFor(`agy/${model}`)).toBe(`agy/${model}`);
  expect(resolveProvider(model)).not.toBe("agy");
});

test("raw resolveCall rejects agy before credential resolution with an explicit full-agent error", async () => {
  await expect(resolveCall({ model: "agy/gemini-4-argon-low" })).rejects.toThrow(/agy.*(full-agent|CLI)/i);
});

test("agy provider status reports an available external CLI without OAuth claims", async () => {
  const binDir = path.join(configDir, "available-bin");
  await fs.mkdir(binDir, { recursive: true });
  await fs.symlink(fakeAgy, path.join(binDir, "agy"));
  const status = await describeAgyInIsolatedPath(binDir);
  expect(status.name).toBe("agy");
  expect(status.kind).toBe("cli_session");
  expect(status.ready).toBe(true);
  expect(status.label).toContain("UNKNOWN");
  expect(status.label).toMatch(/external.*CLI|CLI.*session/i);
  expect(status.label).toMatch(/not probed/i);
  expect(status.loggedIn).toBeUndefined();
  expect(status.oauthEmail).toBeUndefined();
  expect(status.oauthExpires).toBeUndefined();
});

test("agy provider status gives install/login guidance when the CLI is absent", async () => {
  const emptyPath = path.join(configDir, "empty-bin");
  await fs.mkdir(emptyPath, { recursive: true });
  const status = await describeAgyInIsolatedPath(emptyPath);
  expect(status.name).toBe("agy");
  expect(status.kind).toBe("cli_session");
  expect(status.ready).toBe(false);
  expect(status.label).toMatch(/not found on PATH/i);
  expect(status.label).toMatch(/install\/login/i);
  expect(status.loggedIn).toBeUndefined();
  expect(status.oauthEmail).toBeUndefined();
  expect(status.oauthExpires).toBeUndefined();
});


test("listProviderModels discovers a fresh agy CLI catalog without jeo credentials or HTTP", async () => {
  await configureFakeAgy({ models: ["gemini-4-argon-high\tArgon High", "gemini-4-argon-low\tArgon Low", "gemini-4-argon-low\tduplicate"] });
  const result = await listProviderModels("agy", { cwd: configDir, executable: fakeAgy });
  expect(result).toEqual({
    provider: "agy",
    models: ["agy/gemini-4-argon-high", "agy/gemini-4-argon-low"],
    ok: true,
    source: "cli_session",
  });
});
test("default all-provider discovery reports agy as unselected without spawning it, while explicit agy probes", async () => {
  await configureFakeAgy({ models: ["gemini-4-argon-low\tArgon Low"] });
  const fetchImpl = (async () => { throw new Error("unexpected network discovery"); }) as typeof fetch;
  const config = { providers: {}, defaultModel: "claude-3-5-sonnet" } as Config;

  const defaults = await discoverModels({ config, cwd: configDir, executable: fakeAgy, fetchImpl });
  expect(defaults.find(result => result.provider === "agy")).toEqual({
    provider: "agy",
    models: [],
    ok: false,
    source: "none",
    error: "official CLI discovery requires explicit selection",
  });
  expect(await Bun.file(path.join(configDir, "agy-observed.json")).exists()).toBe(false);

  const explicit = await discoverModels({ providers: ["agy"], config, cwd: configDir, executable: fakeAgy, fetchImpl });
  expect(explicit).toEqual([{ provider: "agy", models: ["agy/gemini-4-argon-low"], ok: true, source: "cli_session" }]);
  expect(await Bun.file(path.join(configDir, "agy-observed.json")).exists()).toBe(true);
});


test("agy discovery keeps a valid empty CLI list empty and does not invent a static fallback", async () => {
  await configureFakeAgy({ models: [] });
  const result = await listProviderModels("agy", { cwd: configDir, executable: fakeAgy });
  expect(result.ok).toBe(true);
  expect(result.models).toEqual([]);
  expect(result.fallback).toBeUndefined();
  expect(catalogOr(result).models).toEqual([]);
});

test("agy discovery surfaces CLI quota failure without static or CCA fallback", async () => {
  await configureFakeAgy({ exitCode: 3, stderr: ["RESOURCE_EXHAUSTED: quota exceeded"] });
  const result = await listProviderModels("agy", { cwd: configDir, executable: fakeAgy });
  expect(result.ok).toBe(false);
  expect(result.models).toEqual([]);
  expect(result.error).toMatch(/RESOURCE_EXHAUSTED|quota/i);
  expect(result.fallback).toBeUndefined();
  expect(catalogOr(result).ok).toBe(false);
  expect(catalogOr(result).models).toEqual([]);
});

test("malformed agy model records fail honestly rather than creating IDs", async () => {
  await configureFakeAgy({ models: ["not-a-tab-separated-model-record"] });
  await expect(listAgyModels({ cwd: configDir, executable: fakeAgy })).rejects.toThrow(/model|record|invalid|malformed/i);
  const result = await listProviderModels("agy", { cwd: configDir, executable: fakeAgy });
  expect(result.ok).toBe(false);
  expect(result.models).toEqual([]);
});

test("agy model catalogs never enter persistent cache or cached runtime hydration", async () => {
  const raw = normalizeCacheEntries([{ provider: "agy", models: ["agy/gemini-4-argon-low"], source: "none" }]);
  expect(raw).toEqual([]);
  expect(mergeCacheEntries([], [{ provider: "agy", models: ["agy/gemini-4-argon-low"], ok: true, source: "none" }])).toEqual([]);
  expect(applyCachedModels({ version: 3, updatedAt: Date.now(), providers: [{ provider: "agy", models: ["agy/gemini-4-argon-low"], source: "none" }] })).toBe(0);
  expect(liveProviderCatalogModels({} as never).some(model => model.provider === "agy")).toBe(false);

  await fs.writeFile(path.join(configDir, "model-catalog-cache.json"), JSON.stringify({
    version: 3,
    updatedAt: Date.now(),
    providers: [{ provider: "agy", models: ["agy/gemini-4-argon-low"], source: "none" }],
  }), "utf8");
  expect(await readModelCache()).toBeNull();
  await fs.rm(path.join(configDir, "model-catalog-cache.json"), { force: true });
  await writeModelCache([{ provider: "agy", models: ["agy/gemini-4-argon-low"], ok: true, source: "none" }]);
  expect(await Bun.file(path.join(configDir, "model-catalog-cache.json")).exists()).toBe(false);
});

test("agy live observations are not auto-routing candidates", () => {
  recordLiveProviderModels("agy", ["agy/gemini-4-argon-low"], { source: "none" });
  const config = {
    defaultModel: "claude-3-5-sonnet",
    roles: {},
    routing: {},
    providers: { agy: "externally-managed" },
  } as unknown as RoutingConfig;
  expect(tierModelPool("high", config)).not.toContain("agy/gemini-4-argon-low");
});
