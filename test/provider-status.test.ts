import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  describeProvider,
  describeAllProviders,
  providerEnvVar,
  credentialLabel,
  PROVIDER_NAMES,
} from "../src/ai/provider-status";

let dir: string;
const prevCfgDir = process.env.JOC_CONFIG_DIR;
const OAUTH_ENV = ["ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_OAUTH_TOKEN", "GEMINI_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-prov-"));
  process.env.JOC_CONFIG_DIR = dir;
  // A config file with an empty providers map + no credential env vars isolates each
  // scenario: readGlobalConfig overlays env API keys onto gaps, so they must be cleared.
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ providers: {}, defaultModel: "claude-3-5-sonnet" }),
  );
  for (const k of OAUTH_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterAll(async () => {
  if (prevCfgDir === undefined) delete process.env.JOC_CONFIG_DIR;
  else process.env.JOC_CONFIG_DIR = prevCfgDir;
  for (const k of OAUTH_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("providerEnvVar maps cloud providers to <NAME>_API_KEY; ollama has none", () => {
  expect(providerEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
  expect(providerEnvVar("openai")).toBe("OPENAI_API_KEY");
  expect(providerEnvVar("gemini")).toBe("GEMINI_API_KEY");
  expect(providerEnvVar("ollama")).toBeUndefined();
});

test("credentialLabel renders each kind", () => {
  expect(credentialLabel("api_key")).toBe("API key");
  expect(credentialLabel("oauth")).toBe("OAuth");
  expect(credentialLabel("keyless")).toContain("keyless");
  expect(credentialLabel("none")).toContain("none");
});

test("ollama is keyless and always ready with a base URL", async () => {
  const s = await describeProvider("ollama");
  expect(s.kind).toBe("keyless");
  expect(s.ready).toBe(true);
  expect(s.baseUrl).toBe("http://localhost:11434");
});

test("a credential-less cloud provider is not ready", async () => {
  const s = await describeProvider("anthropic");
  expect(s.kind).toBe("none");
  expect(s.ready).toBe(false);
  expect(s.envVar).toBe("ANTHROPIC_API_KEY");
});

test("openai with a base URL is ready even without a key (local OpenAI-compatible)", async () => {
  const s = await describeProvider("openai", {
    providers: {},
    defaultModel: "gpt-4o",
    openaiBaseUrl: "http://localhost:1234/v1",
  });
  expect(s.ready).toBe(true);
  expect(s.baseUrl).toBe("http://localhost:1234/v1");
});

test("describeAllProviders returns every provider, ollama keyless", async () => {
  const all = await describeAllProviders();
  expect(all.map(s => s.name)).toEqual([...PROVIDER_NAMES]);
  expect(all.find(s => s.name === "ollama")!.ready).toBe(true);
});
test("describeProvider: openai oauth-only → ready=true (served via Codex Responses)", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: {},
      oauth: { openai: "oauth-oai" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  const s = await describeProvider("openai");
  expect(s.ready).toBe(true);
  expect(s.label).toBe("OAuth");
});

test("describeProvider: openai oauth path hides local base URL because Codex backend is used instead", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: {},
      oauth: { openai: "oauth-oai" },
      openaiBaseUrl: "http://localhost:1234/v1",
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  const s = await describeProvider("openai");
  expect(s.ready).toBe(true);
  expect(s.kind).toBe("oauth");
  expect(s.baseUrl).toBeUndefined();
});

test("describeProvider: gemini oauth-only → ready=false, label contains 'API key' (no Codex-style backend)", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: {},
      oauth: { gemini: "oauth-gem" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  const s = await describeProvider("gemini");
  expect(s.ready).toBe(false);
  expect(s.label).toContain("API key");
});

test("describeProvider: openai oauth+key reports the effective API-key path", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: { openai: "sk-oai" },
      oauth: { openai: "oauth-oai" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  const s = await describeProvider("openai");
  expect(s.ready).toBe(true);
  expect(s.kind).toBe("api_key");
  expect(s.label).toBe("API key");
});

test("describeProvider: anthropic oauth-only → ready=true", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: {},
      oauth: { anthropic: "oauth-ant" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  const s = await describeProvider("anthropic");
  expect(s.ready).toBe(true);
  expect(s.label).toBe("OAuth");
});

test("describeProvider: gemini oauth+key reports ready API-key path instead of blocked OAuth", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: { gemini: "AIza-gem" },
      oauth: { gemini: "oauth-gem" },
      defaultModel: "claude-3-5-sonnet",
    }),
  );
  const s = await describeProvider("gemini");
  expect(s.ready).toBe(true);
  expect(s.kind).toBe("api_key");
  expect(s.label).toBe("API key");
});
