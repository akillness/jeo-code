/**
 * Regression test for the 0.8.4 fix at the `/agents` slash-command level:
 * `/agents <role> <model>`'s "not in the live model list" note must NEVER
 * fire when the pinned model's OWN provider discovery FAILED (expired OAuth
 * / timeout) — only when that provider's listing genuinely SUCCEEDED without
 * the id. Reproduces the exact 0.8.3 E2E finding (antigravity/gemini-pro-agent
 * falsely flagged as not-in-catalog while antigravity discovery had failed).
 *
 * Calls `runAgentsSlash` directly with a constructed `AgentsSlashCtx` (mirrors
 * test/launch-code-slash.test.ts's direct-handler convention) so the live
 * model cache is fully controlled — no real network discovery involved.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAgentsSlash, type AgentsSlashCtx } from "../src/commands/launch/agents-slash";
import type { ProviderModelsResult } from "../src/ai/model-discovery";

let dir: string;
const savedCfgDir = process.env.JEO_CONFIG_DIR;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agentsslash-"));
  process.env.JEO_CONFIG_DIR = dir;
});

afterEach(async () => {
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
  await fs.rm(dir, { recursive: true, force: true });
});

function baseCtx(liveModelsCache: ProviderModelsResult[]): AgentsSlashCtx {
  return {
    sessionModel: undefined,
    sessionThinking: undefined,
    lastPickIndex: [],
    getLiveModels: async () => liveModelsCache,
    pickLiveProviderModel: async () => undefined,
    setRoleThinking: async () => true,
    pickFromOptions: async () => undefined,
    pickThinkingLevel: async () => undefined,
  };
}

async function runPin(role: string, model: string, liveModelsCache: ProviderModelsResult[]): Promise<string[]> {
  const logs: string[] = [];
  const savedLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    await runAgentsSlash(`/agents ${role} ${model}`, baseCtx(liveModelsCache));
    return logs;
  } finally {
    console.log = savedLog;
  }
}

test("/agents <role> <model>: the 'not in the live model list' note is SUPPRESSED when that provider's discovery FAILED", async () => {
  // antigravity's discovery failed (expired OAuth) — the exact 0.8.3 E2E case:
  // 'antigravity/gemini-pro-agent' is a live, valid model, but the failed
  // discovery must never be reported as evidence the model is invalid.
  const live: ProviderModelsResult[] = [
    { provider: "antigravity", ok: false, source: "none", error: "OAuth token expired", models: [] },
  ];
  const logs = await runPin("executor", "antigravity/gemini-pro-agent", live);
  expect(logs.some(l => l.includes("not in the live") && l.includes("model list"))).toBe(false);
});

test("/agents <role> <model>: the note STILL fires when that provider's discovery SUCCEEDED and the id is genuinely absent (positive control)", async () => {
  // Proves the harness actually exercises the gate (not a vacuous suppression):
  // antigravity's discovery succeeded but does not include this id.
  const live: ProviderModelsResult[] = [
    { provider: "antigravity", ok: true, source: "oauth", models: ["antigravity/gemini-3.1-pro-low"] },
  ];
  const logs = await runPin("executor", "antigravity/gemini-pro-agent", live);
  expect(logs.some(l => l.includes("not in the live") && l.includes("model list"))).toBe(true);
});

test("/agents <role> <model>: the note is also suppressed when the provider is entirely absent from the live cache (no evidence)", async () => {
  const live: ProviderModelsResult[] = [
    { provider: "openai", ok: true, source: "oauth", models: ["gpt-4o"] },
  ];
  const logs = await runPin("executor", "antigravity/gemini-pro-agent", live);
  expect(logs.some(l => l.includes("not in the live") && l.includes("model list"))).toBe(false);
});
