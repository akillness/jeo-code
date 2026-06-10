import { parseConfig } from "../src/agent/config-schema";
import { test, expect } from "bun:test";
import { qualifyModelId } from "../src/ai/model-manager";

test("qualifyModelId matches all spec cases", () => {
  // 1. (qwen2.5:0.5b, ollama) -> ollama/qwen2.5:0.5b
  expect(qualifyModelId("qwen2.5:0.5b", "ollama")).toBe("ollama/qwen2.5:0.5b");

  // 2. (gpt-oss:20b, ollama) -> ollama/gpt-oss:20b
  expect(qualifyModelId("gpt-oss:20b", "ollama")).toBe("ollama/gpt-oss:20b");

  // 3. (ollama/qwen2.5:0.5b, ollama) unchanged
  expect(qualifyModelId("ollama/qwen2.5:0.5b", "ollama")).toBe("ollama/qwen2.5:0.5b");

  // 4. (claude-sonnet-4-5, anthropic) unchanged
  expect(qualifyModelId("claude-sonnet-4-5", "anthropic")).toBe("claude-sonnet-4-5");

  // 5. (gpt-5.5, openai) unchanged
  expect(qualifyModelId("gpt-5.5", "openai")).toBe("gpt-5.5");

  // 6. (gemini-2.5-flash, gemini) unchanged
  expect(qualifyModelId("gemini-2.5-flash", "gemini")).toBe("gemini-2.5-flash");

  // 7. a gemini-routed id pinned from an openai list gets openai/ prefix
  expect(qualifyModelId("gemini-2.5-flash", "openai")).toBe("openai/gemini-2.5-flash");

  // 8. empty string passes through
  expect(qualifyModelId("", "ollama")).toBe("");
  expect(qualifyModelId("   ", "ollama")).toBe("");
});

test("parseConfig normalizes colon-containing un-prefixed model IDs to ollama/", () => {
  const rawConfig = {
    defaultModel: "gpt-oss:20b",
    roles: {
      smol: "qwen2.5:0.5b",
      slow: "claude-sonnet-4-5",
      plan: "gpt-5.5",
    },
    subagents: {
      executor: {
        model: "custom-ollama:latest",
      },
    },
  };

  const res = parseConfig(rawConfig);
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.config.defaultModel).toBe("ollama/gpt-oss:20b");
    expect(res.config.roles?.smol).toBe("ollama/qwen2.5:0.5b");
    expect(res.config.roles?.slow).toBe("claude-sonnet-4-5");
    expect(res.config.roles?.plan).toBe("gpt-5.5");
    expect(res.config.subagents?.executor?.model).toBe("ollama/custom-ollama:latest");
  }
});
