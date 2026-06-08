import { test, expect } from "bun:test";
import { parseFlags } from "../src/commands/launch";

test("parseFlags captures GJC-style model/provider/thinking launch flags", () => {
  const flags = parseFlags(["--model", "gpt-4o-mini", "--provider=OPENAI", "--thinking", "high", "fix", "it"]);
  expect(flags.model).toBe("gpt-4o-mini");
  expect(flags.provider).toBe("openai");
  expect(flags.thinking).toBe("high");
  expect(flags.message).toBe("fix it");
});

test("parseFlags captures model role tiers without consuming the prompt", () => {
  const slow = parseFlags(["--slow", "investigate", "this"]);
  expect(slow.modelRole).toBe("slow");
  expect(slow.message).toBe("investigate this");
  const plan = parseFlags(["--plan", "--max-steps=7", "draft"]);
  expect(plan.modelRole).toBe("plan");
  expect(plan.maxSteps).toBe(7);
  expect(plan.message).toBe("draft");
});

test("parseFlags records invalid provider/thinking values as launch errors", () => {
  const flags = parseFlags(["--provider", "bogus", "--thinking", "extreme", "hello"]);
  expect(flags.provider).toBeUndefined();
  expect(flags.thinking).toBeUndefined();
  expect(flags.errors).toEqual([
    "--provider must be one of: anthropic, openai, gemini, ollama",
    "--thinking must be one of: minimal, low, medium, high, xhigh",
  ]);
  expect(flags.message).toBe("hello");
});
