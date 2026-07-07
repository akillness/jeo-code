import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig } from "../src/agent/config-schema";
import { readGlobalConfig } from "../src/agent/state";

test("parseConfig: accepts a well-formed config (incl. extra passthrough keys)", () => {
  const r = parseConfig({
    providers: { anthropic: "sk-x" },
    defaultModel: "gemini-flash-latest",
    thinkingLevel: "high",
    modelAliases: { fast: "ollama/qwen2.5:0.5b" },
    oauth: { gemini: { access: "tok", expires: 123 } },
    futureField: true,
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.config.defaultModel).toBe("gemini-flash-latest");
});

test("parseConfig: rejects wrong types with a located message", () => {
  const r = parseConfig({ defaultModel: 42 });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("defaultModel");

  const r2 = parseConfig({ defaultModel: "m", thinkingLevel: "ludicrous" });
  expect(r2.ok).toBe(false);
  if (!r2.ok) expect(r2.message).toContain("thinkingLevel");
});

test("parseConfig: retired 'minimal' thinkingLevel migrates to 'low' instead of failing validation (backward compat)", () => {
  // Regression: a config.json persisted while "minimal" was still a valid tier must
  // NOT hard-fail once the enum is tightened — readGlobalConfig's schema-invalid path
  // resets the ENTIRE config to defaults (see state.ts's salvageCredentials doc
  // comment), so this migration is load-bearing for every pre-existing user config.
  const r = parseConfig({ defaultModel: "m", thinkingLevel: "minimal", modelAliases: { fast: "x" } });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.config.thinkingLevel).toBe("low");
    // Sibling fields survive the migration untouched.
    expect(r.config.modelAliases).toEqual({ fast: "x" });
  }
});

test("parseConfig: 'minimal' subagent-role thinking overrides migrate to 'low'", () => {
  const r = parseConfig({
    defaultModel: "m",
    subagents: {
      executor: { thinking: "minimal", model: "gpt-4o" },
      planner: { thinking: "high" },
    },
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.config.subagents?.executor?.thinking).toBe("low");
    expect(r.config.subagents?.executor?.model).toBe("gpt-4o"); // untouched
    expect(r.config.subagents?.planner?.thinking).toBe("high"); // untouched (not "minimal")
  }
});

test("parseConfig: 'minimal' routing-tier thinking overrides migrate to 'low'", () => {
  const r = parseConfig({
    defaultModel: "m",
    routing: {
      enabled: true,
      tiers: {
        trivial: { thinking: "minimal", model: "gpt-4o-mini" },
        complex: { thinking: "xhigh" },
      },
    },
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.config.routing?.tiers?.trivial?.thinking).toBe("low");
    expect(r.config.routing?.tiers?.trivial?.model).toBe("gpt-4o-mini"); // untouched
    expect(r.config.routing?.tiers?.complex?.thinking).toBe("xhigh"); // untouched
  }
});

test("parseConfig: accepts routing.tiers.high and routing.crossProviderPool (4-tier PromptTier + cross-provider pooling)", () => {
  const r = parseConfig({
    defaultModel: "m",
    routing: {
      enabled: true,
      crossProviderPool: true,
      tiers: {
        high: { model: "gpt-5.4", thinking: "high" },
      },
    },
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.config.routing?.crossProviderPool).toBe(true);
    expect(r.config.routing?.tiers?.high?.model).toBe("gpt-5.4");
    expect(r.config.routing?.tiers?.high?.thinking).toBe("high");
  }
});

test("parseConfig: a genuinely invalid thinking level (not the retired 'minimal') still fails validation", () => {
  // Confirms the migration is an exact-match rewrite, not an over-broad pass-through
  // that would silently swallow real typos/garbage.
  const r = parseConfig({ defaultModel: "m", thinkingLevel: "minimal-plus" });
  expect(r.ok).toBe(false);
});

test("parseConfig: accepts a retry budget block (gjc parity)", () => {
  const r = parseConfig({
    defaultModel: "m",
    retry: { requestMaxRetries: 4, streamMaxRetries: 100, maxRetries: 3, maxDelayMs: 300000 },
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.config.retry?.requestMaxRetries).toBe(4);
});

test("parseConfig: retry.failFastStatuses/failFastPatterns survive validation (regression — were silently stripped by the nested retry z.object lacking .passthrough())", () => {
  const r = parseConfig({
    defaultModel: "m",
    retry: { requestMaxRetries: 3, failFastStatuses: [503, 529], failFastPatterns: ["overloaded", "capacity"] },
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.config.retry?.failFastStatuses).toEqual([503, 529]);
    expect(r.config.retry?.failFastPatterns).toEqual(["overloaded", "capacity"]);
    // Sibling fields on the same nested object are unaffected by the fix.
    expect(r.config.retry?.requestMaxRetries).toBe(3);
  }
});

test("parseConfig: rejects a non-integer entry in retry.failFastStatuses", () => {
  const r = parseConfig({ defaultModel: "m", retry: { failFastStatuses: [503.5] } });
  expect(r.ok).toBe(false);
});

test("parseConfig: rejects a negative retry budget", () => {
  const r = parseConfig({ defaultModel: "m", retry: { requestMaxRetries: -1 } });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("retry");
});

const origDir = process.env.JEO_CONFIG_DIR;
afterEach(() => {
  if (origDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = origDir;
});

test("readGlobalConfig: falls back to defaults when on-disk config is invalid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-cfg-"));
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ defaultModel: 123 }));
  process.env.JEO_CONFIG_DIR = dir;
  process.env.JEO_DEFAULT_MODEL = "fallback-model";
  const cfg = await readGlobalConfig();
  expect(typeof cfg.defaultModel).toBe("string");
  expect(cfg.defaultModel).toBe("fallback-model"); // env default, not the bad 123
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.JEO_DEFAULT_MODEL;
});

test("readGlobalConfig: loads a valid on-disk config", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-cfg-"));
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ defaultModel: "claude-3-5-haiku", providers: {} }));
  process.env.JEO_CONFIG_DIR = dir;
  const cfg = await readGlobalConfig();
  expect(cfg.defaultModel).toBe("claude-3-5-haiku");
  await fs.rm(dir, { recursive: true, force: true });
});

test("readGlobalConfig: a pre-existing on-disk config with the retired 'minimal' thinkingLevel does NOT get reset to defaults (real user-impact regression guard)", async () => {
  // Proves the fix end-to-end through the ACTUAL disk-read path, not just parseConfig
  // in isolation: before the migration existed, this exact scenario hit the
  // schema-invalid branch in readGlobalConfig, which wipes modelAliases/subagents/
  // routing/retry/hooks/notifications back to defaults (only oauth/providers survive
  // via salvageCredentials) — a real user with a "minimal" config would have silently
  // lost every one of those settings the instant this release shipped.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-cfg-"));
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({
    defaultModel: "claude-3-5-haiku",
    thinkingLevel: "minimal",
    modelAliases: { fast: "ollama/qwen2.5:0.5b" },
    subagents: { executor: { thinking: "minimal" } },
  }));
  process.env.JEO_CONFIG_DIR = dir;
  const cfg = await readGlobalConfig();
  // The old value migrated — config was NOT treated as schema-invalid.
  expect(cfg.thinkingLevel).toBe("low");
  expect(cfg.subagents?.executor?.thinking).toBe("low");
  // Every OTHER field survived intact (the actual regression this guards against).
  expect(cfg.defaultModel).toBe("claude-3-5-haiku");
  expect(cfg.modelAliases).toEqual({ fast: "ollama/qwen2.5:0.5b" });
  await fs.rm(dir, { recursive: true, force: true });
});

test("parseConfig: accepts valid subagents config and rejects invalid provider", () => {
  const r = parseConfig({
    defaultModel: "m",
    subagents: {
      executor: {
        model: "ollama/qwen2.5:0.5b",
        provider: "ollama",
        maxSteps: 5,
      },
    },
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.config.subagents?.executor?.provider).toBe("ollama");
  }

  const r2 = parseConfig({
    defaultModel: "m",
    subagents: {
      executor: {
        model: "ollama/qwen2.5:0.5b",
        provider: "not-a-valid-provider",
        maxSteps: 5,
      },
    },
  });
  expect(r2.ok).toBe(false);
  if (!r2.ok) {
    expect(r2.message).toContain("provider");
  }
});
test("parseConfig: accepts a notifications block (Telegram daemon parity)", () => {
  const r = parseConfig({
    defaultModel: "m",
    notifications: { enabled: true, telegram: { botToken: "123:ABC", chatId: "999" } },
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.config.notifications?.enabled).toBe(true);
    expect(r.config.notifications?.telegram?.chatId).toBe("999");
  }
});

test("parseConfig: rejects a non-string notifications.telegram.botToken", () => {
  const r = parseConfig({ defaultModel: "m", notifications: { telegram: { botToken: 12345 } } });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("notifications");
});
