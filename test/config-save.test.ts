import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { saveConfigPatch, readRawGlobalConfig } from "../src/agent/state";
import { setApiKey, setOauthToken } from "../src/auth/storage";

let dir: string;
const saved = {
  cfg: process.env.JOC_CONFIG_DIR,
  model: process.env.JOC_DEFAULT_MODEL,
  oauth: process.env.ANTHROPIC_OAUTH_TOKEN,
  smol: process.env.JOC_SMOL_MODEL,
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-cfgsave-"));
  process.env.JOC_CONFIG_DIR = dir;
});

afterEach(async () => {
  for (const [k, v] of Object.entries({
    JOC_CONFIG_DIR: saved.cfg,
    JOC_DEFAULT_MODEL: saved.model,
    ANTHROPIC_OAUTH_TOKEN: saved.oauth,
    JOC_SMOL_MODEL: saved.smol,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("saveConfigPatch never bakes env-only values (OAuth token / JOC_DEFAULT_MODEL / role tiers) into config.json", async () => {
  // Env values that readGlobalConfig would overlay but must NOT be persisted.
  process.env.JOC_DEFAULT_MODEL = "gemini-2.5-flash";
  process.env.ANTHROPIC_OAUTH_TOKEN = "secret-bearer-should-not-persist";
  process.env.JOC_SMOL_MODEL = "ollama/qwen2.5:0.5b";

  // An unrelated change (e.g. /agents executor maxSteps 20).
  await saveConfigPatch(raw => ({
    subagents: { ...(raw.subagents ?? {}), executor: { maxSteps: 20 } },
  }));

  const onDisk = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8"));
  expect(onDisk.subagents.executor.maxSteps).toBe(20); // the intended change persisted
  expect(onDisk.defaultModel).not.toBe("gemini-2.5-flash"); // env model NOT baked in
  expect(JSON.stringify(onDisk)).not.toContain("secret-bearer-should-not-persist"); // OAuth token NOT leaked
  expect(onDisk.roles?.smol).toBeUndefined(); // env role tier NOT baked in
});

test("saveConfigPatch builds the patch from the RAW on-disk config, not the env overlay", async () => {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ providers: {}, defaultModel: "claude-3-5-sonnet", subagents: { planner: { model: "gpt-4o" } } }),
  );
  process.env.JOC_SMOL_MODEL = "env-smol-model";

  await saveConfigPatch(raw => ({ subagents: { ...(raw.subagents ?? {}), critic: { maxSteps: 8 } } }));

  const raw = await readRawGlobalConfig();
  expect(raw.subagents?.planner?.model).toBe("gpt-4o"); // pre-existing override preserved
  expect(raw.subagents?.critic?.maxSteps).toBe(8); // new patch merged
  expect(raw.roles?.smol).toBeUndefined(); // env tier not present in raw config
});

test("auth storage setters persist onto the RAW config — no env-only values baked in", async () => {
  process.env.OLLAMA_HOST = "http://env-ollama:9999"; // readGlobalConfig would overlay this
  process.env.JOC_DEFAULT_MODEL = "gemini-flash-latest";
  try {
    await setApiKey("anthropic", "sk-test-key");
    await setOauthToken("openai", "oauth-token-x");
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8"));
    expect(onDisk.providers.anthropic).toBe("sk-test-key"); // the intended write persisted
    expect(onDisk.oauth.openai).toBe("oauth-token-x");
    expect(onDisk.ollamaBaseUrl).toBeUndefined(); // env OLLAMA_HOST NOT baked
    expect(onDisk.defaultModel).not.toBe("gemini-flash-latest"); // env model NOT baked
  } finally {
    delete process.env.OLLAMA_HOST;
  }
});
