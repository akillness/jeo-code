/**
 * Regression test for the 0.8.4 fix: `/model <id>`'s "not in the live catalog"
 * note must NEVER fire when the pinned model's OWN provider discovery FAILED
 * (expired OAuth / timeout) — only when that provider's listing genuinely
 * SUCCEEDED without the id. Reproduces the exact 0.8.3 E2E finding
 * (antigravity/gemini-pro-agent falsely flagged as not-in-catalog while a
 * failed antigravity discovery was in the live cache).
 *
 * Calls `runModelSlash` directly with a constructed `ModelSlashCtx` (mirrors
 * test/launch-code-slash.test.ts's direct-handler convention) so the live
 * model cache is fully controlled — no real network discovery involved.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runModelSlash, type ModelSlashCtx } from "../src/commands/launch/model-slash";
import type { ProviderModelsResult } from "../src/ai/model-discovery";

let dir: string;
const savedCfgDir = process.env.JEO_CONFIG_DIR;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-modelslash-"));
  process.env.JEO_CONFIG_DIR = dir;
});

afterEach(async () => {
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
  await fs.rm(dir, { recursive: true, force: true });
});

function baseCtx(liveModelsCache: ProviderModelsResult[] | null): ModelSlashCtx {
  return {
    sessionModel: undefined,
    sessionThinking: undefined,
    defaultModel: "claude-sonnet-4-6",
    lastPickIndex: [],
    liveModelsCache,
    isTTY: false,
    getLiveModels: async () => liveModelsCache ?? [],
    applyPickedModelWithTarget: async () => false,
    persistSessionModel: async () => {},
    pickLiveProviderModel: async () => undefined,
  };
}

async function runPin(model: string, liveModelsCache: ProviderModelsResult[] | null): Promise<string[]> {
  const logs: string[] = [];
  const savedLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    await runModelSlash(`/model ${model}`, baseCtx(liveModelsCache));
    return logs;
  } finally {
    console.log = savedLog;
  }
}

test("/model <id>: the 'not in the live catalog' note is SUPPRESSED when that provider's discovery FAILED", async () => {
  // antigravity's discovery failed (expired OAuth) — the exact 0.8.3 E2E case:
  // 'antigravity/gemini-pro-agent' is a live, valid model, but the failed
  // discovery must never be reported as evidence the model is invalid.
  const live: ProviderModelsResult[] = [
    { provider: "antigravity", ok: false, source: "none", error: "OAuth token expired", models: [] },
  ];
  const logs = await runPin("antigravity/gemini-pro-agent", live);
  expect(logs.some(l => l.includes("not in the live") && l.includes("catalog"))).toBe(false);
});

test("/model <id>: the note STILL fires when that provider's discovery SUCCEEDED and the id is genuinely absent (positive control)", async () => {
  // Proves the harness actually exercises the gate (not a vacuous suppression):
  // antigravity's discovery succeeded but does not include this id.
  const live: ProviderModelsResult[] = [
    { provider: "antigravity", ok: true, source: "oauth", models: ["antigravity/gemini-3.1-pro-low"] },
  ];
  const logs = await runPin("antigravity/gemini-pro-agent", live);
  expect(logs.some(l => l.includes("not in the live") && l.includes("catalog"))).toBe(true);
});

test("/model <id>: the note is also suppressed when the provider is entirely absent from the live cache (no evidence)", async () => {
  const live: ProviderModelsResult[] = [
    { provider: "openai", ok: true, source: "oauth", models: ["gpt-4o"] },
  ];
  const logs = await runPin("antigravity/gemini-pro-agent", live);
  expect(logs.some(l => l.includes("not in the live") && l.includes("catalog"))).toBe(false);
});
