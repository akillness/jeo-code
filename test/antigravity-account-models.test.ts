import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoveryRequest, listProviderModels } from "../src/ai/model-discovery";
import { runAgentsSlash, type AgentsSlashCtx } from "../src/commands/launch/agents-slash";
import { antigravityRequest, getAntigravityUserAgent, resolveAntigravityProjectId } from "../src/ai/providers/antigravity";
import { isLiveProviderModel, resetLiveProviderModels } from "../src/ai/model-catalog";
import { providerModelFor, resolveProvider } from "../src/ai/model-manager";

const OAUTH_ENV_KEYS = [
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_OAUTH_TOKEN",
  "GEMINI_OAUTH_TOKEN",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
] as const;

const originalConfigDir = process.env.JEO_CONFIG_DIR;
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(OAUTH_ENV_KEYS.map(key => [key, process.env[key]]));
let configDir: string;

function antigravityConfig(access: string, refresh: string, projectId?: string) {
  return {
    providers: {},
    oauth: { antigravity: { access, refresh, projectId } },
    defaultModel: "antigravity/fixture-model",
  };
}

async function writeAntigravityConfig(access: string, refresh: string, projectId?: string): Promise<void> {
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify(antigravityConfig(access, refresh, projectId)),
    "utf8",
  );
}

function modelsPayload(ids: readonly string[]) {
  return {
    models: Object.fromEntries(ids.map(id => [id, {}])),
    agentModelSorts: [{ groups: [{ modelIds: [...ids] }] }],
  };
}

function jsonFetch(body: unknown): typeof fetch {
  return (async () => Response.json(body, { status: 200 })) as typeof fetch;
}

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-antigravity-models-"));
  process.env.JEO_CONFIG_DIR = configDir;
  for (const key of OAUTH_ENV_KEYS) delete process.env[key];
  // A test that accidentally bypasses opts.fetchImpl must fail without touching a real endpoint.
  globalThis.fetch = (async () => { throw new Error("real network disabled in Antigravity model tests"); }) as typeof fetch;
  resetLiveProviderModels();
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

test("discoveryRequest: Antigravity sends the project-scoped body and shared provider User-Agent", () => {
  const request = discoveryRequest("antigravity", {
    kind: "oauth",
    provider: "antigravity",
    token: "access-token",
    projectId: "project-123",
  });

  expect(request.method).toBe("POST");
  expect(JSON.parse(request.body ?? "null")).toEqual({ project: "project-123" });
  expect(request.headers.authorization).toBe("Bearer access-token");
  expect(request.headers["User-Agent"]).toBe(getAntigravityUserAgent());
});

test("listProviderModels: Antigravity lazily resolves a missing project through the injected fetch", async () => {
  const access = "lazy-project-access";
  await writeAntigravityConfig(access, "lazy-project-refresh");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes(":loadCodeAssist")) {
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe(getAntigravityUserAgent());
      return Response.json({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "lazy-project" });
    }
    if (url.includes("fetchAvailableModels")) {
      expect(JSON.parse(String(init?.body))).toEqual({ project: "lazy-project" });
      return Response.json(modelsPayload(["lazy-model"]));
    }
    throw new Error(`unexpected injected request: ${url}`);
  }) as typeof fetch;

  const result = await listProviderModels("antigravity", { fetchImpl });

  expect(result.ok).toBe(true);
  expect(result.models).toEqual(["antigravity/lazy-model"]);
  expect(calls.map(call => call.url)).toEqual([
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  ]);
});

test("listProviderModels: Antigravity default discovery preserves every account model beyond 100", async () => {
  const ids = Array.from({ length: 125 }, (_, index) => `account-model-${String(index).padStart(3, "0")}`);
  await writeAntigravityConfig("many-models-access", "many-models-refresh", "many-models-project");

  const result = await listProviderModels("antigravity", {
    fetchImpl: jsonFetch(modelsPayload(ids)),
  });

  expect(result.ok).toBe(true);
  expect(result.models).toEqual(ids.map(id => `antigravity/${id}`).sort());
  expect(result.models).toHaveLength(125);
});

test("listProviderModels: an explicit limit caps the otherwise complete Antigravity list", async () => {
  const ids = ["account-model-003", "account-model-001", "account-model-002", "account-model-004"];
  await writeAntigravityConfig("limited-access", "limited-refresh", "limited-project");

  const result = await listProviderModels("antigravity", {
    fetchImpl: jsonFetch(modelsPayload(ids)),
    limit: 2,
  });

  expect(result.ok).toBe(true);
  expect(result.models).toEqual(["antigravity/account-model-001", "antigravity/account-model-002"]);
});

test("listProviderModels: an opaque Argon model id from server metadata remains unchanged and routable", async () => {
  const argonId = "argon-account-model-v9";
  await writeAntigravityConfig("argon-access", "argon-refresh", "argon-project");

  const result = await listProviderModels("antigravity", {
    fetchImpl: jsonFetch({
      models: {
        [argonId]: { model: "MODEL_PLACEHOLDER_OPAQUE" },
        "internal-only": { isInternal: true },
      },
      agentModelSorts: [{ groups: [{ modelIds: [argonId, "internal-only"] }] }],
    }),
  });

  expect(result.models).toEqual([`antigravity/${argonId}`]);
  expect(resolveProvider(`antigravity/${argonId}`)).toBe("antigravity");
  expect(providerModelFor(`antigravity/${argonId}`)).toBe(`antigravity/${argonId}`);
  expect(isLiveProviderModel("antigravity", `antigravity/${argonId}`)).toBe(true);
});

test("listProviderModels: a valid empty Antigravity account list is authoritative", async () => {
  await writeAntigravityConfig("empty-access", "empty-refresh", "empty-project");

  const result = await listProviderModels("antigravity", {
    fetchImpl: jsonFetch({
      models: { "empty-account-model": {} },
      agentModelSorts: [{ groups: [{ modelIds: [] }] }],
      tabModelIds: [],
    }),
  });

  expect(result).toEqual(expect.objectContaining({
    provider: "antigravity",
    models: [],
    ok: true,
    source: "oauth",
  }));
});

const malformedAntigravityBodies = [
  { name: "models map", body: { models: "not-a-model-map" } },
  { name: "sort list", body: { ...modelsPayload(["known-good-model"]), agentModelSorts: ["bad"] } },
  { name: "sort groups", body: { ...modelsPayload(["known-good-model"]), agentModelSorts: [{ groups: "bad" }] } },
  { name: "sort model ids", body: { ...modelsPayload(["known-good-model"]), agentModelSorts: [{ groups: [{ modelIds: "bad" }] }] } },
  { name: "tab role", body: { models: { "known-good-model": {}, "tab-only": {} }, tabModelIds: "tab-only" } },
  { name: "image role", body: { models: { "known-good-model": {}, "image-only": {} }, imageGenerationModelIds: "image-only" } },
  { name: "audio role", body: { models: { "known-good-model": {}, "audio-only": {} }, audioTranscriptionModelIds: "audio-only" } },
  { name: "commit role", body: { models: { "known-good-model": {}, "commit-only": {} }, commitMessageModelIds: "commit-only" } },
  { name: "mquery role", body: { models: { "known-good-model": {}, "mquery-only": {} }, mqueryModelIds: "mquery-only" } },
  { name: "deprecated role", body: { models: { "known-good-model": {}, "deprecated-only": {} }, deprecatedModelIds: "deprecated-only" } },
] as const;

for (const { name, body } of malformedAntigravityBodies) {
  test(`listProviderModels: malformed Antigravity ${name} fails without wiping the last valid live model set`, async () => {
    await writeAntigravityConfig("malformed-access", "malformed-refresh", "malformed-project");
    const valid = await listProviderModels("antigravity", {
      fetchImpl: jsonFetch(modelsPayload(["known-good-model"])),
    });
    expect(valid.models).toEqual(["antigravity/known-good-model"]);
    expect(isLiveProviderModel("antigravity", "antigravity/known-good-model")).toBe(true);

    const malformed = await listProviderModels("antigravity", { fetchImpl: jsonFetch(body) });

    expect(malformed.ok).toBe(false);
    expect(malformed.models).toEqual([]);
    expect(malformed.error).toBe("invalid models response");
    expect(isLiveProviderModel("antigravity", "antigravity/known-good-model")).toBe(true);
  });
}

test("listProviderModels: OAuth account scope is opaque, stable across access rotation, and changes with refresh or project", async () => {
  await writeAntigravityConfig("scope-access-a", "scope-refresh-a", "scope-project-a");
  const fetchImpl = jsonFetch(modelsPayload(["scope-model"]));

  const first = await listProviderModels("antigravity", { fetchImpl });
  const firstScope = first.accountId ?? "";
  expect(firstScope).not.toBe("");
  expect(firstScope).not.toContain("scope-access-a");
  expect(firstScope).not.toContain("scope-refresh-a");
  expect(firstScope).not.toContain("scope-project-a");

  await writeAntigravityConfig("scope-access-b", "scope-refresh-a", "scope-project-a");
  const rotatedAccess = await listProviderModels("antigravity", { fetchImpl });
  expect(rotatedAccess.accountId).toBe(firstScope);

  await writeAntigravityConfig("scope-access-b", "scope-refresh-b", "scope-project-a");
  const rotatedRefresh = await listProviderModels("antigravity", { fetchImpl });
  expect(rotatedRefresh.accountId).not.toBe(firstScope);

  await writeAntigravityConfig("scope-access-b", "scope-refresh-a", "scope-project-b");
  const rotatedProject = await listProviderModels("antigravity", { fetchImpl });
  expect(rotatedProject.accountId).not.toBe(firstScope);
});
test("listProviderModels: project lookup failure is best-effort and does not block an empty account catalog", async () => {
  await writeAntigravityConfig("best-effort-access", "best-effort-refresh");
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.includes(":loadCodeAssist")) return new Response("denied", { status: 403 });
    if (url.includes("fetchAvailableModels")) return Response.json({ models: {}, agentModelSorts: [] });
    throw new Error(`unexpected injected request: ${url}`);
  }) as typeof fetch;

  const result = await listProviderModels("antigravity", { fetchImpl });

  expect(result.ok).toBe(true);
  expect(result.models).toEqual([]);
  expect(result.accountId).toEqual(expect.any(String));
  expect(calls.map(call => call.url)).toEqual([
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  ]);
  expect(JSON.parse(calls[1]!.body)).toEqual({});
});

test("listProviderModels: an older in-flight account response cannot replace a newer account catalog", async () => {
  await writeAntigravityConfig("race-access-a", "race-refresh-a", "race-project-a");
  let releaseA!: () => void;
  const aReleased = new Promise<void>(resolve => { releaseA = resolve; });
  let aStarted!: () => void;
  const aStartedPromise = new Promise<void>(resolve => { aStarted = resolve; });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    if (url.includes("fetchAvailableModels") && auth === "Bearer race-access-a") {
      aStarted();
      await aReleased;
      return Response.json(modelsPayload(["account-a-model"]));
    }
    if (url.includes("fetchAvailableModels") && auth === "Bearer race-access-b") {
      return Response.json(modelsPayload(["account-b-model"]));
    }
    throw new Error(`unexpected injected request: ${url}`);
  }) as typeof fetch;

  const pendingA = listProviderModels("antigravity", { fetchImpl });
  await aStartedPromise;
  await writeAntigravityConfig("race-access-b", "race-refresh-b", "race-project-b");
  const resultB = await listProviderModels("antigravity", { fetchImpl });
  releaseA();
  const resultA = await pendingA;

  expect(resultB.ok).toBe(true);
  expect(resultB.models).toEqual(["antigravity/account-b-model"]);
  expect(resultA.ok).toBe(false);
  expect(resultA.models).toEqual([]);
  expect(isLiveProviderModel("antigravity", "antigravity/account-b-model")).toBe(true);
  expect(isLiveProviderModel("antigravity", "antigravity/account-a-model")).toBe(false);
});
test("listProviderModels: reverting disk credentials to A lets A commit after B without exposing B", async () => {
  await writeAntigravityConfig("revert-access-a", "revert-refresh-a", "revert-project-a");
  let releaseA!: () => void;
  const aReleased = new Promise<void>(resolve => { releaseA = resolve; });
  let aStarted!: () => void;
  const aStartedPromise = new Promise<void>(resolve => { aStarted = resolve; });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    if (url.includes("fetchAvailableModels") && auth === "Bearer revert-access-a") {
      aStarted();
      await aReleased;
      return Response.json(modelsPayload(["revert-account-a-model"]));
    }
    if (url.includes("fetchAvailableModels") && auth === "Bearer revert-access-b") {
      return Response.json(modelsPayload(["revert-account-b-model"]));
    }
    throw new Error(`unexpected injected request: ${url}`);
  }) as typeof fetch;

  const pendingA = listProviderModels("antigravity", { fetchImpl });
  await aStartedPromise;
  await writeAntigravityConfig("revert-access-b", "revert-refresh-b", "revert-project-b");
  const resultB = await listProviderModels("antigravity", { fetchImpl });
  await writeAntigravityConfig("revert-access-a", "revert-refresh-a", "revert-project-a");
  releaseA();
  const resultA = await pendingA;

  expect(resultB.ok).toBe(true);
  expect(resultA.ok).toBe(true);
  expect(isLiveProviderModel("antigravity", "antigravity/revert-account-a-model")).toBe(true);
  expect(isLiveProviderModel("antigravity", "antigravity/revert-account-b-model")).toBe(false);
});
test("resolveAntigravityProjectId: does not persist a discovered project into a rotated stored credential", async () => {
  await writeAntigravityConfig("stored-access-token", "stored-refresh-token");
  const credential = {
    kind: "oauth" as const,
    provider: "antigravity" as const,
    token: "rotated-access-token",
  };

  await expect(resolveAntigravityProjectId(credential, {
    discover: async () => "discovered-project",
  })).resolves.toBe("discovered-project");

  const persisted = JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8")) as {
    oauth?: { antigravity?: { access?: string; projectId?: string } };
  };
  expect(persisted.oauth?.antigravity?.access).toBe("stored-access-token");
  expect(persisted.oauth?.antigravity?.projectId).toBeUndefined();
});
test("discovered Antigravity model survives /agents selection, saved config, routing, and callable request payload", async () => {
  const argonId = "argon-account-model-v9";
  const access = "selection-access";
  const projectId = "selection-project";
  await writeAntigravityConfig(access, "selection-refresh", projectId);
  const discovered = await listProviderModels("antigravity", {
    fetchImpl: jsonFetch(modelsPayload([argonId])),
  });
  expect(discovered.models).toEqual([`antigravity/${argonId}`]);

  const ctx: AgentsSlashCtx = {
    sessionModel: undefined,
    sessionThinking: undefined,
    lastPickIndex: [],
    getLiveModels: async () => [discovered],
    pickLiveProviderModel: async () => undefined,
    setRoleThinking: async () => true,
    pickFromOptions: async () => undefined,
    pickThinkingLevel: async () => undefined,
  };
  await runAgentsSlash("/agents executor provider antigravity #1", ctx);

  const saved = JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf8")) as {
    subagents?: { executor?: { model?: string } };
  };
  const selected = saved.subagents?.executor?.model;
  expect(selected).toBe(`antigravity/${argonId}`);
  expect(resolveProvider(selected)).toBe("antigravity");

  const request = antigravityRequest(
    [{ role: "user", content: "hello" }],
    { model: providerModelFor(selected) },
    { kind: "oauth", provider: "antigravity", token: access, projectId },
  );
  expect(JSON.parse(request.body).model).toBe(argonId);
});
