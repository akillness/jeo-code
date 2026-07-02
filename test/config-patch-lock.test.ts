import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { saveConfigPatch, readRawGlobalConfig } from "../src/agent/state";

// HIGH-1 lost-update regression: saveConfigPatch used to do an unserialized whole-file
// read-modify-write of config.json. Two concurrent per-provider OAuth refreshes (e.g.
// commands/doctor.ts Promise.all) both read the same base config, and the later write
// clobbered the earlier one's just-rotated refresh token → silent logout. The whole
// RMW cycle now holds a global config lock file (config.json.lock).

let dir: string;
const prevConfigDir = process.env.JEO_CONFIG_DIR;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-cfglock-"));
  process.env.JEO_CONFIG_DIR = dir;
});

afterEach(async () => {
  if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = prevConfigDir;
  await fs.rm(dir, { recursive: true, force: true });
});

test("saveConfigPatch: two concurrent OAuth patches never lose an update", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({
      providers: {},
      oauth: { anthropic: { access: "OLD-A", refresh: "OLD-RA", expires: 1 } },
      defaultModel: "claude-3-5-sonnet",
    }),
    "utf-8"
  );

  // The doctor.ts Promise.all shape: two per-provider refreshes persisting concurrently.
  await Promise.all([
    saveConfigPatch(raw => ({
      oauth: { ...(raw.oauth ?? {}), anthropic: { access: "NEW-A", refresh: "ROTATED-RA", expires: 9_999 } },
    })),
    saveConfigPatch(raw => ({
      oauth: { ...(raw.oauth ?? {}), openai: { access: "NEW-O", refresh: "NEW-RO", expires: 9_999 } },
    })),
  ]);

  const raw = await readRawGlobalConfig();
  const anthropic = raw.oauth?.anthropic;
  const openai = raw.oauth?.openai;
  // Pre-fix, whichever write landed second wiped the other's patch: the rotated
  // anthropic refresh token vanished (silent logout) or the openai credential did.
  expect(typeof anthropic === "object" && anthropic.refresh).toBe("ROTATED-RA");
  expect(typeof openai === "object" && openai.access).toBe("NEW-O");
});

test("saveConfigPatch: N-way interleaved patches all survive", async () => {
  // Real provider names — the config schema strips unknown `providers` keys.
  const providers = ["anthropic", "openai", "gemini", "xai", "kimi", "groq", "deepseek", "mistral"] as const;
  await Promise.all(
    providers.map(p =>
      saveConfigPatch(raw => ({ providers: { ...(raw.providers ?? {}), [p]: `key-${p}` } }))
    )
  );
  const raw = await readRawGlobalConfig();
  for (const p of providers) expect(raw.providers[p]).toBe(`key-${p}`);
}, 15_000);

test("saveConfigPatch: a stale config lock left by a dead process does not block", async () => {
  // A crashed holder left the lock behind long ago — acquisition must remove it
  // (same stale-lock semantics as src/auth/storage.ts acquireLock).
  await fs.writeFile(
    path.join(dir, "config.json.lock"),
    JSON.stringify({ pid: 999_999, createdAt: Date.now() - 60_000 }),
    "utf-8"
  );
  const started = Date.now();
  const next = await saveConfigPatch(() => ({ defaultModel: "claude-sonnet-4-6" }));
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(next.defaultModel).toBe("claude-sonnet-4-6");
  // Lock released after the patch.
  await expect(fs.stat(path.join(dir, "config.json.lock"))).rejects.toThrow();
}, 10_000);
