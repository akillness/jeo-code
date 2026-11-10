import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalConfig } from "../src/agent/state";
import { resolveStartupDefaultModel } from "../src/agent/session-model";
import { resetLiveCodexModels, resetLiveProviderModels } from "../src/ai/model-catalog";
import { setOauthCredentialNoLock } from "../src/auth/storage";

const keys = ["JEO_CONFIG_DIR", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(async () => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  dir = await mkdtemp(join(tmpdir(), "jeo-startup-oauth-"));
  process.env.JEO_CONFIG_DIR = dir;
  resetLiveCodexModels();
  resetLiveProviderModels();
});

afterEach(async () => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetLiveCodexModels();
  resetLiveProviderModels();
  await rm(dir, { recursive: true, force: true });
});

for (const scenario of [
  { name: "listed", response: () => new Response(JSON.stringify({ models: [{ slug: "gpt-account-only", visibility: "list" }] })), expected: "openai/gpt-account-only" },
  { name: "absent", response: () => new Response(JSON.stringify({ models: [{ slug: "gpt-other", visibility: "list" }] })), expected: "claude-haiku-4-5" },
  { name: "discovery rejected", response: () => new Response("unauthorized", { status: 401 }), expected: "claude-haiku-4-5" },
]) {
  test(`startup uses account-only OAuth model only when ${scenario.name}`, async () => {
    await writeFile(join(dir, "config.json"), JSON.stringify({
      defaultModel: "openai/gpt-account-only",
      providers: { anthropic: "test-key" },
      recentModels: ["claude-haiku-4-5"],
    }));
    await setOauthCredentialNoLock("openai", { access: "opaque-token", accountId: "startup-account" });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => scenario.response());
    try {
      const result = await resolveStartupDefaultModel(await readGlobalConfig());
      expect(result.model).toBe(scenario.expected);
    } finally {
      fetchSpy.mockRestore();
    }
  });
}

for (const scenario of [
  { name: "API key", config: { providers: { openai: "test-key" } } },
  { name: "custom base URL", config: { openaiBaseUrl: "http://127.0.0.1:9999/v1" } },
]) {
  test(`startup accepts an explicit ${scenario.name} without consulting the OAuth catalog`, async () => {
    await writeFile(join(dir, "config.json"), JSON.stringify({ defaultModel: "openai/gpt-account-only", ...scenario.config }));
    await setOauthCredentialNoLock("openai", { access: "opaque-token", accountId: "startup-account" });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => new Response("unavailable", { status: 503 }));
    try {
      const result = await resolveStartupDefaultModel(await readGlobalConfig());
      expect(result.model).toBe("openai/gpt-account-only");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
}
