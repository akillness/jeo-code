import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  normalizeThinkingLevels,
  supportedThinkingLevels,
  maxThinkingLevel,
  clampThinkingLevel,
  catalogMetadata,
  registerLiveModelMetadata,
  getLiveModelMetadata,
  resetLiveModelMetadata,
} from "../src/ai/model-catalog";
import { parseModelsMetadata } from "../src/ai/model-discovery";
import { parseModelsDevMetadata } from "../src/ai/model-enrich";
import {
  writeModelCache,
  readModelCache,
  applyCachedModels,
  refreshModelsDevMetadata,
} from "../src/ai/model-cache";
import { anthropicPayload } from "../src/ai/providers/anthropic";
import { codexResponsesRequest } from "../src/ai/providers/openai-responses";
import { openaiRequest } from "../src/ai/providers/openai";
import { geminiThinkingConfig } from "../src/ai/providers/gemini";

const savedEnv = { ...process.env };

afterEach(() => {
  resetLiveModelMetadata();
  if (savedEnv.JEO_CONFIG_DIR === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedEnv.JEO_CONFIG_DIR;
});

test("normalizeThinkingLevels: orders canonically, deduplicates, and ignores unknown values", () => {
  expect(normalizeThinkingLevels(["MAX", "low", "high", "low", "minimal", "none", "xhigh"])).toEqual([
    "low",
    "high",
    "xhigh",
    "max",
  ]);
  expect(normalizeThinkingLevels(["none", "minimal"])).toEqual([]);
});

test("per-model supportedThinkingLevels, maxThinkingLevel, and clampThinkingLevel", () => {
  // Anthropic 5.x & 4.7/4.8: full low..max
  expect(supportedThinkingLevels("claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(supportedThinkingLevels("claude-opus-4-7")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(maxThinkingLevel("claude-opus-5-5")).toBe("max");
  expect(clampThinkingLevel("claude-opus-5-5", "max")).toBe("max");
  expect(clampThinkingLevel("claude-opus-5-5", "xhigh")).toBe("xhigh");

  // Anthropic 4.6: low/medium/high/max (NO xhigh — xhigh clamps down to high, max stays max)
  expect(supportedThinkingLevels("claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
  expect(supportedThinkingLevels("claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"]);
  expect(clampThinkingLevel("claude-opus-4-6", "max")).toBe("max");
  expect(clampThinkingLevel("claude-opus-4-6", "xhigh")).toBe("high");
  expect(clampThinkingLevel("claude-opus-4-6", "medium")).toBe("medium");

  // Anthropic 4.5: low/medium/high
  expect(supportedThinkingLevels("claude-sonnet-4-5")).toEqual(["low", "medium", "high"]);
  expect(clampThinkingLevel("claude-sonnet-4-5", "max")).toBe("high");
  expect(clampThinkingLevel("claude-sonnet-4-5", "xhigh")).toBe("high");

  // OpenAI: 5.6/6/daybreak → max; 5.2..5.5 → xhigh; -pro → medium..xhigh; 5.1/o3 → high
  expect(supportedThinkingLevels("gpt-5.6")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(supportedThinkingLevels("gpt-daybreak")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(supportedThinkingLevels("gpt-5.4")).toEqual(["low", "medium", "high", "xhigh"]);
  expect(clampThinkingLevel("gpt-5.4", "max")).toBe("xhigh");
  expect(clampThinkingLevel("gpt-5.4", "xhigh")).toBe("xhigh");
  expect(supportedThinkingLevels("gpt-5.4-pro")).toEqual(["medium", "high", "xhigh"]);
  expect(clampThinkingLevel("gpt-5.4-pro", "low")).toBe("medium");
  expect(clampThinkingLevel("gpt-5.4-pro", "max")).toBe("xhigh");
  expect(supportedThinkingLevels("gpt-5.1")).toEqual(["low", "medium", "high"]);
  expect(clampThinkingLevel("gpt-5.1", "xhigh")).toBe("high");
  expect(clampThinkingLevel("o3", "max")).toBe("high");

  // Gemini: 4-hydrogen/neon → xhigh; 4-carbon/3.x → high; 3-pro-preview → low/high
  expect(supportedThinkingLevels("gemini-4-hydrogen")).toEqual(["low", "medium", "high", "xhigh"]);
  expect(supportedThinkingLevels("gemini-4-neon")).toEqual(["low", "medium", "high", "xhigh"]);
  expect(clampThinkingLevel("gemini-4-hydrogen", "max")).toBe("xhigh");
  expect(supportedThinkingLevels("gemini-4-carbon")).toEqual(["low", "medium", "high"]);
  expect(clampThinkingLevel("gemini-4-carbon", "xhigh")).toBe("high");
  expect(supportedThinkingLevels("gemini-3-pro-preview")).toEqual(["low", "high"]);
  expect(clampThinkingLevel("gemini-3-pro-preview", "medium")).toBe("low");
  expect(clampThinkingLevel("gemini-3-pro-preview", "max")).toBe("high");

  // xAI / Kimi / DeepSeek
  expect(supportedThinkingLevels("grok-4.20")).toEqual(["low", "medium", "high", "xhigh"]);
  expect(supportedThinkingLevels("kimi-k3")).toEqual(["low", "high", "max"]);
  expect(clampThinkingLevel("kimi-k3", "xhigh")).toBe("high");
  expect(supportedThinkingLevels("deepseek-v4")).toEqual(["low", "high", "max"]);
});

test("registerLiveModelMetadata: precedence is provider > models.dev > static catalog", () => {
  // Static catalog says gpt-5.4 caps at xhigh.
  expect(maxThinkingLevel("gpt-5.4")).toBe("xhigh");

  // models.dev overlay can extend or refine capabilities for known & brand-new models.
  registerLiveModelMetadata(
    {
      "gpt-5.4": { thinking: ["low", "medium", "high", "xhigh", "max"], contextTokens: 1_050_000, source: "models.dev" },
      "brand-new-model-x": { thinking: ["low", "high", "max"], contextTokens: 512_000, maxOutputTokens: 64_000, source: "models.dev" },
    },
    "models.dev",
  );
  expect(maxThinkingLevel("gpt-5.4")).toBe("max");
  expect(catalogMetadata("gpt-5.4")?.contextTokens).toBe(1_050_000);
  expect(supportedThinkingLevels("brand-new-model-x")).toEqual(["low", "high", "max"]);
  expect(catalogMetadata("brand-new-model-x")?.maxOutputTokens).toBe(64_000);

  // Provider-native metadata overrides models.dev.
  registerLiveModelMetadata(
    {
      "openai/gpt-5.4": { thinking: ["low", "medium", "high"], source: "provider" },
    },
    "provider",
  );
  expect(supportedThinkingLevels("gpt-5.4")).toEqual(["low", "medium", "high"]);
  expect(getLiveModelMetadata("openai/gpt-5.4")?.source).toBe("provider");

  // A subsequent models.dev refresh must NOT overwrite provider-native metadata.
  registerLiveModelMetadata(
    {
      "gpt-5.4": { thinking: ["low", "medium", "high", "xhigh", "max"], source: "models.dev" },
    },
    "models.dev",
  );
  expect(supportedThinkingLevels("gpt-5.4")).toEqual(["low", "medium", "high"]);
  expect(getLiveModelMetadata("gpt-5.4")?.source).toBe("provider");
});

test("parseModelsMetadata extracts capabilities from Anthropic, Codex, OpenRouter, and Gemini", () => {
  // Anthropic `/v1/models`
  const anthropicMeta = parseModelsMetadata("anthropic", {
    data: [
      {
        id: "claude-opus-4-6",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            xhigh: { supported: false },
            max: { supported: true },
          },
        },
      },
      {
        id: "claude-no-thinking",
        capabilities: { effort: { supported: false }, thinking: { supported: false } },
      },
      {
        id: "claude-haiku-4-5",
        capabilities: { effort: { supported: false }, thinking: { supported: true } },
      },
    ],
  });
  expect(anthropicMeta["claude-opus-4-6"]).toEqual({
    source: "provider",
    thinking: ["low", "medium", "high", "max"],
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
  });
  expect(anthropicMeta["claude-no-thinking"]).toEqual({
    source: "provider",
    thinking: [],
  });
  // Budget-only thinking (effort.supported: false, thinking.supported: true) must NOT be forced to thinking: []
  expect(anthropicMeta["claude-haiku-4-5"]).toBeUndefined();

  // OpenAI Codex `/backend-api/codex/models`
  const codexMeta = parseModelsMetadata("openai", {
    models: [
      {
        slug: "gpt-5.5",
        context_window: 400_000,
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "medium" },
          { effort: "high" },
          { effort: "xhigh" },
          { effort: "max" },
        ],
      },
    ],
  });
  expect(codexMeta["gpt-5.5"]).toEqual({
    source: "provider",
    thinking: ["low", "medium", "high", "xhigh", "max"],
    contextTokens: 400_000,
  });

  // OpenRouter `/api/v1/models`
  const openrouterMeta = parseModelsMetadata("openrouter", {
    data: [
      {
        id: "anthropic/claude-opus-4.7",
        context_length: 1_000_000,
        top_provider: { max_completion_tokens: 128_000 },
        reasoning: { supported_efforts: ["low", "medium", "high", "xhigh", "max"] },
      },
    ],
  });
  expect(openrouterMeta["openrouter/anthropic/claude-opus-4.7"]).toEqual({
    source: "provider",
    thinking: ["low", "medium", "high", "xhigh", "max"],
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
  });

  // Gemini `/v1beta/models`
  const geminiMeta = parseModelsMetadata("gemini", {
    models: [
      {
        name: "models/gemini-2.0-flash",
        thinking: false,
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 8_192,
      },
    ],
  });
  expect(geminiMeta["gemini-2.0-flash"]).toEqual({
    source: "provider",
    thinking: [],
    contextTokens: 1_048_576,
    maxOutputTokens: 8_192,
  });
});

test("parseModelsDevMetadata parses reasoning_options and limits from models.dev/api.json", () => {
  const parsed = parseModelsDevMetadata({
    anthropic: {
      id: "anthropic",
      models: {
        "claude-opus-4-7": {
          id: "claude-opus-4-7",
          reasoning: true,
          reasoning_options: { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
          limit: { context: 1_000_000, output: 128_000 },
        },
        "claude-non-reasoning": {
          id: "claude-non-reasoning",
          reasoning: false,
          limit: { context: 200_000, output: 8_192 },
        },
      },
    },
    openai: {
      id: "openai",
      models: {
        "gpt-5.6": {
          id: "gpt-5.6",
          reasoning: true,
          reasoning_options: { type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] },
          limit: { context: 1_050_000, output: 128_000 },
        },
      },
    },
  });
  expect(parsed["claude-opus-4-7"]).toEqual({
    source: "models.dev",
    thinking: ["low", "medium", "high", "xhigh", "max"],
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
  });
  expect(parsed["claude-non-reasoning"]).toEqual({
    source: "models.dev",
    thinking: [],
    contextTokens: 200_000,
    maxOutputTokens: 8_192,
  });
  expect(parsed["gpt-5.6"]).toEqual({
    source: "models.dev",
    thinking: ["low", "medium", "high", "xhigh", "max"],
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
  });
});

test("model-cache persists and rehydrates provider & models.dev metadata with provider precedence", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-live-meta-"));
  process.env.JEO_CONFIG_DIR = tmpDir;
  try {
    await writeModelCache([
      {
        provider: "anthropic",
        models: ["claude-opus-4-6"],
        ok: true,
        source: "api_key",
        metadata: {
          "claude-opus-4-6": {
            thinking: ["low", "medium", "high", "max"],
            contextTokens: 1_000_000,
            maxOutputTokens: 128_000,
            source: "provider",
          },
        },
      },
    ]);

    let fetchCalls = 0;
    const fakeFetch: typeof fetch = (async () => {
      fetchCalls++;
      return new Response(
        JSON.stringify({
          anthropic: {
            models: {
              // Deliberately differs from provider metadata to verify provider wins on rehydrate.
              "claude-opus-4-6": {
                reasoning: true,
                reasoning_options: { type: "effort", values: ["low", "high"] },
              },
            },
          },
          openai: {
            models: {
              "future-gpt-7": {
                reasoning: true,
                reasoning_options: { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
                limit: { context: 2_000_000, output: 256_000 },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const now = 1_700_000_000_000;
    await refreshModelsDevMetadata({ fetchImpl: fakeFetch, now });
    expect(fetchCalls).toBe(1);

    // Calling again within TTL uses cache without fetching.
    await refreshModelsDevMetadata({ fetchImpl: fakeFetch, now: now + 1000 });
    expect(fetchCalls).toBe(1);

    // Reset memory and rehydrate purely from disk cache.
    resetLiveModelMetadata();
    const cached = await readModelCache();
    expect(cached).not.toBeNull();
    applyCachedModels(cached!);

    // Provider metadata wins for claude-opus-4-6; models.dev populates future-gpt-7.
    expect(supportedThinkingLevels("claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(getLiveModelMetadata("claude-opus-4-6")?.source).toBe("provider");
    expect(supportedThinkingLevels("future-gpt-7")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(catalogMetadata("future-gpt-7")?.contextTokens).toBe(2_000_000);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("provider adapters clamp unsupported thinking levels per model on the wire", () => {
  const msgs = [{ role: "user" as const, content: "hi" }];
  const anthropicCred = { kind: "api_key" as const, provider: "anthropic" as const, token: "sk-ant" };
  const openaiCred = { kind: "api_key" as const, provider: "openai" as const, token: "sk-oai" };
  const codexCred = { kind: "oauth" as const, provider: "openai" as const, token: "ey.jwt.tok" };

  // Anthropic: Opus 5.5 accepts xhigh & max; Opus 4.6 accepts max and clamps xhigh→high; Opus 4.5 clamps max→high
  const ant = (model: string, reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max") =>
    JSON.parse(anthropicPayload(msgs, { model, reasoningEffort }, true, true, anthropicCred));
  expect(ant("claude-opus-5-5", "max").output_config?.effort).toBe("max");
  expect(ant("claude-opus-5-5", "xhigh").output_config?.effort).toBe("xhigh");
  expect(ant("claude-opus-4-6", "max").output_config?.effort).toBe("max");
  expect(ant("claude-opus-4-6", "xhigh").output_config?.effort).toBe("high");
  expect(ant("claude-opus-4-5", "max").output_config?.effort).toBe("high");

  // Codex / OpenAI Responses: gpt-5.4 accepts xhigh and clamps max→xhigh; gpt-5.6 accepts max; gpt-5.1 clamps xhigh→high
  expect(
    JSON.parse(codexResponsesRequest(msgs, { model: "gpt-5.4", reasoningEffort: "xhigh" }, codexCred).body).reasoning?.effort,
  ).toBe("xhigh");
  expect(
    JSON.parse(codexResponsesRequest(msgs, { model: "gpt-5.4", reasoningEffort: "max" }, codexCred).body).reasoning?.effort,
  ).toBe("xhigh");
  expect(
    JSON.parse(codexResponsesRequest(msgs, { model: "gpt-5.6", reasoningEffort: "max" }, codexCred).body).reasoning?.effort,
  ).toBe("max");
  expect(
    JSON.parse(codexResponsesRequest(msgs, { model: "gpt-5.1", reasoningEffort: "xhigh" }, codexCred).body).reasoning?.effort,
  ).toBe("high");

  // Live Codex metadata dynamically unlocks `max` on a model without code changes!
  registerLiveModelMetadata({ "gpt-5.5": { thinking: ["low", "medium", "high", "xhigh", "max"], source: "provider" } }, "provider");
  expect(
    JSON.parse(codexResponsesRequest(msgs, { model: "gpt-5.5", reasoningEffort: "max" }, codexCred).body).reasoning?.effort,
  ).toBe("max");

  // OpenAI Chat Completions: o3 clamps max→high; gpt-5.4 keeps xhigh and clamps max→xhigh; gpt-5.6 keeps max
  expect(
    JSON.parse(openaiRequest(msgs, { model: "o3", reasoningEffort: "max" } as any, openaiCred, false).body).reasoning_effort,
  ).toBe("high");
  expect(
    JSON.parse(openaiRequest(msgs, { model: "gpt-5.4", reasoningEffort: "xhigh" } as any, openaiCred, false).body).reasoning_effort,
  ).toBe("xhigh");
  expect(
    JSON.parse(openaiRequest(msgs, { model: "gpt-5.4", reasoningEffort: "max" } as any, openaiCred, false).body).reasoning_effort,
  ).toBe("xhigh");
  expect(
    JSON.parse(openaiRequest(msgs, { model: "gpt-5.6", reasoningEffort: "max" } as any, openaiCred, false).body).reasoning_effort,
  ).toBe("max");

  // Gemini: 4-hydrogen hits XHIGH; 3-pro-preview clamps medium→LOW and max→HIGH; 2.5-pro uses max budget
  expect(geminiThinkingConfig("gemini-4-hydrogen", "xhigh")).toEqual({ includeThoughts: true, thinkingLevel: "XHIGH" });
  expect(geminiThinkingConfig("gemini-4-hydrogen", "max")).toEqual({ includeThoughts: true, thinkingLevel: "XHIGH" });
  expect(geminiThinkingConfig("gemini-3-pro-preview", "medium")).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
  expect(geminiThinkingConfig("gemini-3-pro-preview", "max")).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
  expect(geminiThinkingConfig("gemini-2.5-pro", "max")).toEqual({ includeThoughts: true, thinkingBudget: 24575 });
});
