/**
 * Antigravity fetchAvailableModels regressions.
 *
 * The fixture shape is source-grounded: the endpoint uses a keyed `models` map,
 * `agentModelSorts` positive groups, and (for separately offered Gemini tiers)
 * a `tieredModelIds` object. Every id below is synthetic; none claims a live
 * account entitlement or assigns an Argon display-name mapping.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseModelsBody, listProviderModels, type ProviderModelsResult } from "../src/ai/model-discovery";
import { flattenModels, resolveSelection } from "../src/ai/model-picker";
import { isLiveProviderModel, resetLiveProviderModels } from "../src/ai/model-catalog";
import { providerModelFor, resolveProvider } from "../src/ai/model-manager";
import { antigravityRequest } from "../src/ai/providers/antigravity";
import { runAgentsSlash, type AgentsSlashCtx } from "../src/commands/launch/agents-slash";

const OAUTH_ENV_KEYS = [
  "GEMINI_OAUTH_TOKEN",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "JEO_GEMINI_CREDS_PATH",
] as const;
const originalConfigDir = process.env.JEO_CONFIG_DIR;
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(OAUTH_ENV_KEYS.map(key => [key, process.env[key]]));
let configDir: string;

const CLAUDE = "fixture-recommended-claude";
const SHARED = "fixture-tiered-gemini";
const FLASH_LITE = "fixture-tiered-flash-lite";
const INTERNAL = "fixture-tiered-internal";
const ABSENT = "fixture-tiered-absent";
const OPAQUE = "opaque-tiered-default-v9";

function antigravityConfig() {
  return {
    providers: {},
    oauth: { antigravity: { access: "fixture-access", refresh: "fixture-refresh", projectId: "fixture-project" } },
    defaultModel: "antigravity/fixture-default",
  };
}

async function writeConfig(): Promise<void> {
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify(antigravityConfig()), "utf8");
}

function jsonFetch(body: unknown): typeof fetch {
  return (async () => Response.json(body, { status: 200 })) as typeof fetch;
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    models: {
      [CLAUDE]: { model: "MODEL_PLACEHOLDER_CLAUDE" },
      [SHARED]: { model: "MODEL_PLACEHOLDER_SHARED" },
      [FLASH_LITE]: { model: "MODEL_PLACEHOLDER_FLASH_LITE" },
      [INTERNAL]: { model: "MODEL_PLACEHOLDER_INTERNAL", isInternal: true },
    },
    agentModelSorts: [{ name: "Recommended", groups: [{ modelIds: [CLAUDE] }] }],
    tieredModelIds: {
      flashLite: [FLASH_LITE],
      flash: [SHARED],
      pro: [SHARED],
    },
    commitMessageModelIds: [FLASH_LITE],
    mqueryModelIds: [FLASH_LITE],
    ...overrides,
  };
}

function selectionCtx(live: ProviderModelsResult[]): AgentsSlashCtx {
  return {
    sessionModel: undefined,
    sessionThinking: undefined,
    lastPickIndex: [],
    getLiveModels: async () => live,
    pickLiveProviderModel: async () => undefined,
    setRoleThinking: async () => true,
    pickFromOptions: async () => undefined,
    pickThinkingLevel: async () => undefined,
  };
}

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-antigravity-tiered-"));
  process.env.JEO_CONFIG_DIR = configDir;
  for (const key of OAUTH_ENV_KEYS) delete process.env[key];
  globalThis.fetch = (async () => { throw new Error("real network disabled in Antigravity tiered-model tests"); }) as typeof fetch;
  resetLiveProviderModels();
  await writeConfig();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetLiveProviderModels();
  if (originalConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = originalConfigDir;
  for (const key of OAUTH_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(configDir, { recursive: true, force: true });
});

test("Antigravity parser shows recommended Claude and separately offered tiered Gemini rows", () => {
  const body = baseBody();
  expect(parseModelsBody("antigravity", body)).toEqual([
    `antigravity/${CLAUDE}`,
    `antigravity/${SHARED}`,
    `antigravity/${FLASH_LITE}`,
  ]);
});

test("listProviderModels unions tiered rows, normalizes resource/provider prefixes, and deduplicates flash/pro", async () => {
  const body = baseBody({
    agentModelSorts: [{ name: "Recommended", groups: [{ modelIds: [`models/${CLAUDE}`] }] }],
    tieredModelIds: {
      flashLite: [`models/${FLASH_LITE}`],
      flash: [`models/${SHARED}`],
      pro: [`antigravity/${SHARED}`],
    },
  });
  const result = await listProviderModels("antigravity", { fetchImpl: jsonFetch(body) });

  expect(result.ok).toBe(true);
  expect(result.models).toEqual([
    `antigravity/${CLAUDE}`,
    `antigravity/${FLASH_LITE}`,
    `antigravity/${SHARED}`,
  ]);
  expect(result.models).toHaveLength(new Set(result.models).size);
  for (const id of result.models) expect(isLiveProviderModel("antigravity", id)).toBe(true);
});

test("tiered flashLite remains selectable when the same row is also a commit and mquery utility model", async () => {
  const body = baseBody({
    agentModelSorts: [{ name: "Recommended", groups: [{ modelIds: [CLAUDE] }] }],
    tieredModelIds: { flashLite: [FLASH_LITE], flash: [], pro: [] },
  });
  const result = await listProviderModels("antigravity", { fetchImpl: jsonFetch(body) });
  const flat = flattenModels([result]);

  expect(result.models).toContain(`antigravity/${FLASH_LITE}`);
  expect(resolveSelection(flat, `antigravity/${FLASH_LITE}`)).toEqual({
    kind: "match",
    entry: expect.objectContaining({ model: `antigravity/${FLASH_LITE}` }),
  });
});

test("tiered ids are offered only when their callable row exists and is not internal", () => {
  const body = {
    models: {
      [CLAUDE]: { model: "MODEL_PLACEHOLDER_CLAUDE" },
      [INTERNAL]: { model: "MODEL_PLACEHOLDER_INTERNAL", isInternal: true },
    },
    agentModelSorts: [{ name: "Recommended", groups: [{ modelIds: [CLAUDE] }] }],
    tieredModelIds: { pro: [ABSENT, INTERNAL] },
  };

  expect(parseModelsBody("antigravity", body)).toEqual([`antigravity/${CLAUDE}`]);
});

test.each([
  { name: "an empty tiered map", body: { models: { [SHARED]: {} }, tieredModelIds: {} } },
  { name: "an empty sort list and empty tiered map", body: { models: { [SHARED]: {} }, agentModelSorts: [], tieredModelIds: {} } },
])("explicitly empty positive metadata stays authoritative ($name)", async ({ body }) => {
  const result = await listProviderModels("antigravity", { fetchImpl: jsonFetch(body) });

  expect(result.ok).toBe(true);
  expect(result.models).toEqual([]);
  expect(isLiveProviderModel("antigravity", `antigravity/${SHARED}`)).toBe(false);
});

test("generic opaque defaultAgentModelId is honored exactly, without an inferred Argon alias", async () => {
  const body = {
    models: { [OPAQUE]: { model: "MODEL_PLACEHOLDER_OPAQUE" } },
    agentModelSorts: [],
    tieredModelIds: {},
    defaultAgentModelId: OPAQUE,
  };
  const result = await listProviderModels("antigravity", { fetchImpl: jsonFetch(body) });

  expect(result.models).toEqual([`antigravity/${OPAQUE}`]);
  expect(result.models).not.toContain("antigravity/gemini-3.8-flash-tiered");
  expect(resolveProvider(`antigravity/${OPAQUE}`)).toBe("antigravity");
  expect(providerModelFor(`antigravity/${OPAQUE}`)).toBe(`antigravity/${OPAQUE}`);
});

const malformedPositiveMetadataBodies = [
  { name: "tiered map string", body: baseBody({ tieredModelIds: "bad" }) },
  { name: "tiered member non-array", body: baseBody({ tieredModelIds: { flash: "bad" } }) },
  { name: "tiered member non-string", body: baseBody({ tieredModelIds: { flash: [SHARED, 42] } }) },
  { name: "default model id non-string", body: baseBody({ defaultAgentModelId: 42 }) },
  { name: "default model id empty", body: baseBody({ defaultAgentModelId: "" }) },
  { name: "tiered resource prefix only", body: baseBody({ tieredModelIds: { flash: ["models/"] } }) },
  { name: "tiered provider prefix only", body: baseBody({ tieredModelIds: { flash: ["antigravity/"] } }) },
  { name: "default resource prefix only", body: baseBody({ defaultAgentModelId: "models/" }) },
  { name: "default provider prefix only", body: baseBody({ defaultAgentModelId: "antigravity/" }) },
  { name: "agent sort resource prefix only", body: baseBody({ agentModelSorts: [{ groups: [{ modelIds: ["models/"] }] }] }) },
  { name: "agent sort provider prefix only", body: baseBody({ agentModelSorts: [{ groups: [{ modelIds: ["antigravity/"] }] }] }) },
  ...(["tabModelIds", "imageGenerationModelIds", "audioTranscriptionModelIds", "commitMessageModelIds", "mqueryModelIds"] as const).map(field => ({
    name: `${field} prefix only`,
    body: baseBody({ [field]: ["models/"] }),
  })),
  { name: "deprecated array prefix only", body: baseBody({ deprecatedModelIds: ["models/"] }) },
  { name: "deprecated map key prefix only", body: baseBody({ deprecatedModelIds: { "antigravity/": {} } }) },
  {
    name: "models map key prefix only",
    body: baseBody({ models: { [CLAUDE]: {}, "models/": {} } }),
  },
  {
    name: "models array canonical id prefix only",
    body: baseBody({ models: [{ slug: CLAUDE }, { slug: "models/" }] }),
  },
  {
    name: "models array prefix slug wins over valid id",
    body: baseBody({ models: [{ slug: "models/", id: CLAUDE, name: "valid-name" }] }),
  },
  { name: "tiered top-level array", body: baseBody({ tieredModelIds: [] }) },
] as const;

for (const { name, body } of malformedPositiveMetadataBodies) {
  test(`malformed Antigravity ${name} fails honestly without clearing the prior good registry`, async () => {
    const valid = await listProviderModels("antigravity", {
      fetchImpl: jsonFetch(baseBody({ tieredModelIds: { flash: [SHARED] } })),
    });
    expect(valid.ok).toBe(true);
    expect(valid.models).toEqual([`antigravity/${CLAUDE}`, `antigravity/${SHARED}`]);
    expect(isLiveProviderModel("antigravity", `antigravity/${SHARED}`)).toBe(true);

    const malformed = await listProviderModels("antigravity", { fetchImpl: jsonFetch(body) });

    expect(malformed.ok).toBe(false);
    expect(malformed.models).toEqual([]);
    expect(malformed.error).toBe("invalid models response");
    expect(isLiveProviderModel("antigravity", `antigravity/${CLAUDE}`)).toBe(true);
    expect(isLiveProviderModel("antigravity", `antigravity/${SHARED}`)).toBe(true);
});
}

test("tiered opaque id survives saved-role selection and reaches the exact outbound Antigravity model id", async () => {
  const body = {
    models: { [OPAQUE]: { model: "MODEL_PLACEHOLDER_OPAQUE" } },
    agentModelSorts: [],
    tieredModelIds: { pro: [OPAQUE] },
    defaultAgentModelId: OPAQUE,
  };
  const discovered = await listProviderModels("antigravity", { fetchImpl: jsonFetch(body) });
  expect(discovered.models).toEqual([`antigravity/${OPAQUE}`]);

  await runAgentsSlash("/agents executor provider antigravity #1", selectionCtx([discovered]));
  const saved = JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8")) as {
    subagents?: { executor?: { model?: string } };
  };
  const selected = saved.subagents?.executor?.model;
  expect(selected).toBe(`antigravity/${OPAQUE}`);

  const request = antigravityRequest(
    [{ role: "user", content: "hello" }],
    { model: providerModelFor(selected!) },
    { kind: "oauth", provider: "antigravity", token: "fixture-access", projectId: "fixture-project" },
  );
  expect(JSON.parse(request.body).model).toBe(OPAQUE);
});

test("listProviderModels: surfaces Gemini 4 Argon tiers and named non-recommended chat models while excluding non-chat and unnamed rows", async () => {
  const body = {
    models: {
      "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)", model: "MODEL_PLACEHOLDER_ARGON_LOW" },
      "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)", model: "MODEL_PLACEHOLDER_ARGON_MED" },
      "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", model: "MODEL_PLACEHOLDER_ARGON_HIGH" },
      "gemini-3-flash-agent": { displayName: "Gemini 3.5 Flash (High)", model: "MODEL_PLACEHOLDER_M84" },
      "tab_flash_lite_preview": { model: "MODEL_PLACEHOLDER_M19" },
      "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image", model: "MODEL_PLACEHOLDER_M21" },
      "chat_20706": { isInternal: true, model: "MODEL_CHAT_20706" },
    },
    agentModelSorts: [{
      groups: [{
        modelIds: ["gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-low"],
      }],
    }],
    tieredModelIds: { flash: ["gemini-3.8-flash-tiered"] },
    defaultAgentModelId: "gemini-4-argon-medium",
    tabModelIds: ["chat_20706"],
    imageGenerationModelIds: ["gemini-3.1-flash-image"],
  };

  const result = await listProviderModels("antigravity", { fetchImpl: jsonFetch(body) });

  expect(result.ok).toBe(true);
  expect(result.models).toEqual([
    "antigravity/gemini-3-flash-agent",
    "antigravity/gemini-4-argon-high",
    "antigravity/gemini-4-argon-low",
    "antigravity/gemini-4-argon-medium",
  ]);
});

