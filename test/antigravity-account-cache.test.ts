import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as modelCache from "../src/ai/model-cache";

type CacheApi = Omit<typeof modelCache, "applyCachedModels"> & {
  antigravityAccountScope?: () => Promise<string | undefined>;
  applyCachedModels: (cache: Parameters<typeof modelCache.applyCachedModels>[0], openAIOauthAccountId?: string, antigravityAccountId?: string) => number;
};
const cache = modelCache as CacheApi;

import {
  isLiveProviderModel,
  recordLiveProviderModels,
  resetLiveProviderModels,
  setAntigravityAccountScope,
} from "../src/ai/model-catalog";

const ENV_KEYS = ["GEMINI_OAUTH_TOKEN", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID", "JEO_GEMINI_CREDS_PATH"] as const;
const originalConfigDir = process.env.JEO_CONFIG_DIR;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
let configDir: string;

async function writeConfig(oauth: unknown): Promise<void> {
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ providers: {}, oauth, defaultModel: "antigravity/cache-fixture" }),
    "utf8",
  );
}

function row(accountId: string, models: string[]) {
  return { provider: "antigravity" as const, models, source: "oauth" as const, accountId };
}

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-antigravity-cache-"));
  process.env.JEO_CONFIG_DIR = configDir;
  for (const key of ENV_KEYS) delete process.env[key];
  resetLiveProviderModels();
  setAntigravityAccountScope(undefined);
});

afterEach(async () => {
  setAntigravityAccountScope(undefined);
  resetLiveProviderModels();
  if (originalConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = originalConfigDir;
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(configDir, { recursive: true, force: true });
});

test("antigravityAccountScope: resolves the account scope without exposing OAuth or project plaintext", async () => {
  await writeConfig({ antigravity: { access: "cache-access-a", refresh: "cache-refresh-a", projectId: "cache-project-a" } });

  expect(typeof cache.antigravityAccountScope).toBe("function");
  if (typeof cache.antigravityAccountScope !== "function") return;
  const scope = await cache.antigravityAccountScope();

  expect(scope).toEqual(expect.any(String));
  expect(scope).not.toBe("");
  expect(scope).not.toContain("cache-access-a");
  expect(scope).not.toContain("cache-refresh-a");
  expect(scope).not.toContain("cache-project-a");
});
test("antigravityAccountScope: no-argument scope lookup does not refresh an expired stored credential", async () => {
  await writeConfig({ antigravity: {
    access: "expired-scope-access",
    refresh: "expired-scope-refresh",
    expires: Date.now() - 1,
    projectId: "expired-scope-project",
  } });
  const before = await fs.readFile(path.join(configDir, "config.json"), "utf8");
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("scope lookup must not refresh credentials");
  }) as typeof fetch;
  try {
    const scope = await cache.antigravityAccountScope?.();
    expect(scope).toEqual(expect.any(String));
    expect(fetchCalls).toBe(0);
    expect(await fs.readFile(path.join(configDir, "config.json"), "utf8")).toBe(before);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("antigravityAccountScope: explicit Gemini credential fixture is not auto-imported during a no-argument peek", async () => {
  await writeConfig({});
  const credsPath = path.join(configDir, "gemini-oauth-creds.json");
  await fs.writeFile(credsPath, JSON.stringify({
    access_token: "fixture-import-access",
    refresh_token: "fixture-import-refresh",
    expiry_date: Date.now() + 60_000,
  }), "utf8");
  process.env.JEO_GEMINI_CREDS_PATH = credsPath;

  const scope = await cache.antigravityAccountScope?.();
  const persisted = JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8")) as {
    oauth?: { gemini?: unknown };
  };
  expect(scope).toBeUndefined();
  expect(persisted.oauth?.gemini).toBeUndefined();
});
test("antigravityAccountScope: normalized same-email re-login keeps the account scope across token rotation", async () => {
  expect(typeof cache.antigravityAccountScope).toBe("function");
  if (typeof cache.antigravityAccountScope !== "function") return;

  await writeConfig({ antigravity: {
    access: "email-login-access-a",
    refresh: "email-login-refresh-a",
    email: "User@Example.com",
    projectId: "email-login-project",
  } });
  const first = await cache.antigravityAccountScope();

  await writeConfig({ antigravity: {
    access: "email-login-access-b",
    refresh: "email-login-refresh-b",
    email: " user@example.com ",
    projectId: "email-login-project",
  } });
  const second = await cache.antigravityAccountScope();

  expect(first).toBe(second);
});

test("applyCachedModels: rehydrates only the selected Antigravity account and logout applies none", () => {
  const cacheFile = {
    version: 3 as const,
    updatedAt: Date.now(),
    providers: [row("account-a", ["antigravity/model-a"]), row("account-b", ["antigravity/model-b"])],
  };

  expect(cache.applyCachedModels(cacheFile, undefined, "account-a")).toBe(1);
  expect(isLiveProviderModel("antigravity", "antigravity/model-a")).toBe(true);
  expect(isLiveProviderModel("antigravity", "antigravity/model-b")).toBe(false);

  resetLiveProviderModels();
  setAntigravityAccountScope(undefined);
  expect(cache.applyCachedModels(cacheFile, undefined, undefined)).toBe(0);
  expect(isLiveProviderModel("antigravity", "antigravity/model-a")).toBe(false);
  expect(isLiveProviderModel("antigravity", "antigravity/model-b")).toBe(false);
});

test("setAntigravityAccountScope: switching accounts evicts live rows from the previous account", () => {
  setAntigravityAccountScope("account-a");
  recordLiveProviderModels("antigravity", ["model-a"], { source: "oauth", accountId: "account-a" });
  recordLiveProviderModels("antigravity", ["model-b"], { source: "oauth", accountId: "account-b" });

  expect(isLiveProviderModel("antigravity", "antigravity/model-a")).toBe(true);
  expect(isLiveProviderModel("antigravity", "antigravity/model-b")).toBe(false);

  setAntigravityAccountScope("account-b");

  expect(isLiveProviderModel("antigravity", "antigravity/model-a")).toBe(false);
  expect(isLiveProviderModel("antigravity", "antigravity/model-b")).toBe(true);
});

test("mergeCacheEntries: account scopes do not clobber each other and empty success is authoritative", () => {
  const previous = [row("account-a", ["antigravity/old-a"]), row("account-b", ["antigravity/old-b"])];
  const refreshed = cache.mergeCacheEntries(previous, [{ ...row("account-a", ["antigravity/new-a"]), ok: true }]);

  expect(refreshed).toEqual([row("account-a", ["antigravity/new-a"]), row("account-b", ["antigravity/old-b"])]);

  const emptied = cache.mergeCacheEntries(refreshed, [{ ...row("account-a", []), ok: true }]);
  expect(emptied).toEqual([row("account-a", []), row("account-b", ["antigravity/old-b"])]);
});

test("mergeCacheEntries: failed, malformed, and fallback refreshes retain the prior account list", () => {
  const previous = [row("account-a", ["antigravity/known-good"])];
  const retained = cache.mergeCacheEntries(previous, [
    { ...row("account-a", []), ok: false },
    { ...row("account-a", ["antigravity/fabricated"]), ok: true, fallback: true },
  ]);

  expect(retained).toEqual(previous);
});

test("normalizeCacheEntries: rejects unscoped Antigravity rows and preserves a complete list over 500 models", () => {
  const models = Array.from({ length: 501 }, (_, index) => `antigravity/model-${index}`);
  const normalized = cache.normalizeCacheEntries([
    row("account-a", models),
    { provider: "antigravity", models: ["antigravity/legacy-unscoped"], source: "oauth" },
  ]);

  expect(normalized).toEqual([row("account-a", models)]);
  expect(normalized[0]?.models).toHaveLength(501);
});

test("writeModelCache: persists an authoritative empty Antigravity list and never persists credential material", async () => {
  const access = "persist-access-secret";
  const refresh = "persist-refresh-secret";
  const project = "persist-project-secret";
  await writeConfig({ antigravity: { access, refresh, projectId: project } });
  const scoped = "opaque-account-scope";

  await cache.writeModelCache([{ ...row(scoped, ["antigravity/old-model"]), ok: true }]);
  await cache.writeModelCache([{ ...row(scoped, []), ok: true }]);

  const cacheFile = await cache.readModelCache();
  expect(cacheFile?.providers).toEqual([row(scoped, [])]);
  const raw = await fs.readFile(path.join(configDir, "model-catalog-cache.json"), "utf8");
  expect(raw).not.toContain(access);
  expect(raw).not.toContain(refresh);
  expect(raw).not.toContain(project);
});

test("writeModelCache: retains every Antigravity model when the account has more than 500", async () => {
  const models = Array.from({ length: 501 }, (_, index) => `antigravity/model-${index}`);
  await cache.writeModelCache([{ ...row("account-a", models), ok: true }]);

  const cacheFile = await cache.readModelCache();

  expect(cacheFile?.providers).toEqual([row("account-a", models)]);
});

test("antigravityAccountScope: invalidates cached scope when client User-Agent version changes", async () => {
  await writeConfig({ antigravity: { access: "ua-access", refresh: "ua-refresh", projectId: "ua-project" } });
  const prevVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
  try {
    process.env.PI_AI_ANTIGRAVITY_VERSION = "1.104.0";
    const oldScope = await cache.antigravityAccountScope?.();
    process.env.PI_AI_ANTIGRAVITY_VERSION = "2.23.1";
    const newScope = await cache.antigravityAccountScope?.();
    expect(oldScope).toEqual(expect.any(String));
    expect(newScope).toEqual(expect.any(String));
    expect(newScope).not.toBe(oldScope);
  } finally {
    if (prevVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
    else process.env.PI_AI_ANTIGRAVITY_VERSION = prevVersion;
  }
});

