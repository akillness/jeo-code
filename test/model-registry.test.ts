import { test, expect } from "bun:test";
import {
  expandAlias,
  resolveModelId,
  listAliases
} from "../src/ai/model-registry";

test("expandAlias: expand known builtin aliases", () => {
  expect(expandAlias("fast")).toBe("ollama/qwen2.5:0.5b");
  expect(expandAlias("local")).toBe("ollama/qwen2.5:0.5b");
  expect(expandAlias("sonnet")).toBe("claude-sonnet-4-5");
  expect(expandAlias("gpt")).toBe("gpt-5.5");
  expect(expandAlias("flash")).toBe("gemini-2.5-flash");
});

test("expandAlias: pass through unknown aliases/model ids unchanged", () => {
  expect(expandAlias("gpt-4o")).toBe("gpt-4o");
  expect(expandAlias("ollama/x")).toBe("ollama/x");
  expect(expandAlias("unknown")).toBe("unknown");
});

test("expandAlias: custom aliases dictionary", () => {
  const custom = {
    fast: "custom-fast-model",
    other: "custom-other-model",
  };
  expect(expandAlias("fast", custom)).toBe("custom-fast-model");
  expect(expandAlias("other", custom)).toBe("custom-other-model");
  expect(expandAlias("sonnet", custom)).toBe("sonnet");
});

test("resolveModelId and listAliases", async () => {
  const resolved = await resolveModelId("fast");
  expect(resolved).toBe("ollama/qwen2.5:0.5b");

  const resolvedPassthrough = await resolveModelId("unknown-model");
  expect(resolvedPassthrough).toBe("unknown-model");

  const aliases = await listAliases();
  expect(aliases.fast).toBe("ollama/qwen2.5:0.5b");
  expect(aliases.sonnet).toBe("claude-sonnet-4-5");
});

import { describeModel } from "../src/ai/model-manager";

test("describeModel: expands aliases and reports the routed provider", async () => {
  const fast = await describeModel("fast");
  expect(fast.resolved).toBe("ollama/qwen2.5:0.5b");
  expect(fast.provider).toBe("ollama");

  const sonnet = await describeModel("sonnet");
  expect(sonnet.resolved).toBe("claude-sonnet-4-5");
  expect(sonnet.provider).toBe("anthropic");

  // A concrete id passes through unchanged.
  const direct = await describeModel("gpt-4o");
  expect(direct.input).toBe("gpt-4o");
  expect(direct.resolved).toBe("gpt-4o");
  expect(direct.provider).toBe("openai");
});
