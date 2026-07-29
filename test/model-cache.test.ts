import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyCachedModels,
  isModelCacheStale,
  mergeCacheEntries,
  normalizeCacheEntries,
  readModelCache,
  rehydrateLiveModels,
  writeModelCache,
  MODEL_CACHE_TTL_MS,
} from "../src/ai/model-cache";
import { setOauthCredentialNoLock } from "../src/auth/storage";
import { isCodexModel, isLiveProviderModel, resetLiveCodexModels, resetLiveProviderModels } from "../src/ai/model-catalog";

const origConfigDir = process.env.JEO_CONFIG_DIR;
const tempDirs: string[] = [];
const accountToken = "header." + Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
})).toString("base64url") + ".signature";

async function sandbox(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-model-cache-"));
  tempDirs.push(dir);
  process.env.JEO_CONFIG_DIR = dir;
  return dir;
}

afterEach(async () => {
  if (origConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = origConfigDir;
  resetLiveCodexModels();
  resetLiveProviderModels();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

test("discovered models round-trip through the cache file", async () => {
  await sandbox();
  await writeModelCache([
    { provider: "openai", models: ["gpt-5.5", "gpt-5.6-luna"], ok: true, source: "oauth", accountId: "acct-1" },
    { provider: "anthropic", models: ["claude-sonnet-5"], ok: true, source: "api_key" },
  ]);
  const cache = await readModelCache();
  expect(cache?.version).toBe(2);
  expect(cache?.providers.find(p => p.provider === "openai")?.models).toEqual(["gpt-5.5", "gpt-5.6-luna"]);
  expect(cache?.providers.find(p => p.provider === "anthropic")?.source).toBe("api_key");
  expect(cache!.updatedAt).toBeGreaterThan(0);
});

// The concrete gap this cache closes: a fresh process rejected every Codex model
// newer than the maintained static snapshot until network discovery happened to
// land, so an account holding gpt-5.6-* could not select it right after launch.
test("rehydration teaches the OAuth Codex gate the account's newer models", async () => {
  await sandbox();
  expect(isCodexModel("gpt-5.6-luna")).toBe(false); // static snapshot only

  await setOauthCredentialNoLock("openai", { access: accountToken });
  await writeModelCache([{ provider: "openai", models: ["gpt-5.5", "gpt-5.6-luna"], ok: true, source: "oauth", accountId: "acct-1" }]);
  resetLiveCodexModels();
  resetLiveProviderModels();

  const cache = await rehydrateLiveModels();
  expect(cache).not.toBeNull();
  expect(isCodexModel("gpt-5.6-luna")).toBe(true);
  expect(isCodexModel("openai/gpt-5.6-luna")).toBe(true);
  expect(isLiveProviderModel("openai", "gpt-5.6-luna")).toBe(true);
});

test("an API-key-sourced OpenAI list feeds routing but never widens the OAuth Codex gate", async () => {
  await sandbox();
  await writeModelCache([{ provider: "openai", models: ["gpt-4.1-custom"], ok: true, source: "api_key" }]);
  resetLiveCodexModels();
  resetLiveProviderModels();
  await rehydrateLiveModels();
  expect(isLiveProviderModel("openai", "gpt-4.1-custom")).toBe(true);
  expect(isCodexModel("gpt-4.1-custom")).toBe(false);
});

test("failed or empty discovery results never overwrite a known-good cached list", () => {
  const previous = [{ provider: "openai" as const, models: ["gpt-5.5"], source: "oauth" as const, accountId: "acct-1" }];
  const merged = mergeCacheEntries(previous, [
    { provider: "openai", models: [], ok: false, source: "oauth", accountId: "acct-1" },
    { provider: "anthropic", models: [], ok: true, source: "api_key" },
  ]);
  expect(merged).toEqual(previous);
});

test("a provider absent from this run keeps its previous entry (offline launch is not destructive)", () => {
  const merged = mergeCacheEntries(
    [
      { provider: "openai", models: ["gpt-5.5"], source: "oauth", accountId: "acct-1" },
      { provider: "anthropic", models: ["claude-sonnet-5"], source: "api_key" },
    ],
    [{ provider: "openai", models: ["gpt-5.5", "gpt-5.6-sol"], ok: true, source: "oauth", accountId: "acct-1" }],
  );
  expect(merged.find(e => e.provider === "openai")?.models).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
  expect(merged.find(e => e.provider === "anthropic")?.models).toEqual(["claude-sonnet-5"]);
});

test("entries are scoped per base URL so two OpenAI-compatible endpoints do not clobber each other", () => {
  const merged = mergeCacheEntries(
    [{ provider: "openai", models: ["a"], source: "api_key", baseUrl: "https://one.example" }],
    [{ provider: "openai", models: ["b"], ok: true, source: "api_key", baseUrl: "https://two.example" }],
  );
  expect(merged.length).toBe(2);
  expect(merged.map(e => e.baseUrl).sort()).toEqual(["https://one.example", "https://two.example"]);
});

test("a corrupt, empty, or version-mismatched cache degrades to null instead of throwing", async () => {
  const dir = await sandbox();
  const file = path.join(dir, "model-catalog-cache.json");

  expect(await readModelCache()).toBeNull(); // absent

  await fs.writeFile(file, "{ not json", "utf-8");
  expect(await readModelCache()).toBeNull();

  await fs.writeFile(file, JSON.stringify({ version: 99, providers: [{ provider: "openai", models: ["x"] }] }), "utf-8");
  expect(await readModelCache()).toBeNull();

  await fs.writeFile(file, JSON.stringify({ version: 1, updatedAt: Date.now(), providers: [] }), "utf-8");
  expect(await readModelCache()).toBeNull();
});

test("normalizeCacheEntries drops malformed rows and blank ids", () => {
  expect(
    normalizeCacheEntries([
      { provider: "openai", models: ["gpt-5.5", "", "  ", 7] },
      { provider: "openai" },
      { models: ["x"] },
      null,
      { provider: "anthropic", models: [] },
    ]),
  ).toEqual([{ provider: "openai", models: ["gpt-5.5"], source: "none" }]);
});

test("staleness drives the background refresh decision", () => {
  const now = Date.now();
  expect(isModelCacheStale(null, now)).toBe(true);
  expect(isModelCacheStale({ version: 2, updatedAt: now, providers: [] }, now)).toBe(false);
  expect(isModelCacheStale({ version: 2, updatedAt: now - MODEL_CACHE_TTL_MS - 1, providers: [] }, now)).toBe(true);
});

test("applyCachedModels reports how many ids it seeded and tolerates a null cache", () => {
  expect(applyCachedModels(null)).toBe(0);
  expect(
    applyCachedModels({
      version: 2,
      updatedAt: Date.now(),
      providers: [{ provider: "openai", models: ["gpt-5.5", "gpt-5.6-sol"], source: "oauth", accountId: "acct-1" }],
    }, "acct-1"),
  ).toBe(2);
});

test("a test run without an explicit JEO_CONFIG_DIR never writes the real ~/.jeo", async () => {
  const prev = process.env.JEO_CONFIG_DIR;
  delete process.env.JEO_CONFIG_DIR;
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    await writeModelCache([{ provider: "openai", models: ["should-not-persist"], ok: true, source: "oauth" }]);
    const real = path.join(os.homedir(), ".jeo", "model-catalog-cache.json");
    const contents = await fs.readFile(real, "utf-8").catch(() => "");
    expect(contents).not.toContain("should-not-persist");
  } finally {
    if (prev !== undefined) process.env.JEO_CONFIG_DIR = prev;
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  }
});
