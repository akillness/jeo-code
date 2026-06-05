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

const origDir = process.env.JOC_CONFIG_DIR;
afterEach(() => {
  if (origDir === undefined) delete process.env.JOC_CONFIG_DIR;
  else process.env.JOC_CONFIG_DIR = origDir;
});

test("readGlobalConfig: falls back to defaults when on-disk config is invalid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-cfg-"));
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ defaultModel: 123 }));
  process.env.JOC_CONFIG_DIR = dir;
  process.env.JOC_DEFAULT_MODEL = "fallback-model";
  const cfg = await readGlobalConfig();
  expect(typeof cfg.defaultModel).toBe("string");
  expect(cfg.defaultModel).toBe("fallback-model"); // env default, not the bad 123
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.JOC_DEFAULT_MODEL;
});

test("readGlobalConfig: loads a valid on-disk config", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-cfg-"));
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ defaultModel: "claude-3-5-haiku", providers: {} }));
  process.env.JOC_CONFIG_DIR = dir;
  const cfg = await readGlobalConfig();
  expect(cfg.defaultModel).toBe("claude-3-5-haiku");
  await fs.rm(dir, { recursive: true, force: true });
});
