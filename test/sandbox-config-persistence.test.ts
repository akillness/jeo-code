import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadHooks } from "../src/agent/hooks";
import { readRawGlobalConfig, saveConfigPatch } from "../src/agent/state";

const sandbox = { backend: "native" as const };

async function withConfig(run: (file: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sandbox-config-"));
  const original = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = root;
  try { await run(path.join(root, "config.json")); }
  finally {
    if (original === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = original;
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const [name, contents] of [
  ["malformed JSON", '{"sandbox":{"backend":"native"},'],
  ["invalid authorization", JSON.stringify({ defaultModel: "openai/gpt-4o-mini", sandbox, sandboxSkillAssets: [42], providers: { openai: "preserve-me" } })],
  ["invalid sandbox", JSON.stringify({ defaultModel: "openai/gpt-4o-mini", sandbox: { backend: "native", network: "open" } })],
] as const) {
  test(`config patch refuses ${name} without modifying the original bytes`, async () => {
    await withConfig(async file => {
      await fs.writeFile(file, contents);
      await expect(readRawGlobalConfig()).rejects.toThrow();
      let called = false;
      await expect(saveConfigPatch(() => { called = true; return { defaultModel: "changed" }; })).rejects.toThrow();
      expect(called).toBe(false);
      expect(await fs.readFile(file, "utf8")).toBe(contents);
    });
  });
  test(`registry hooks cannot load with ${name}`, async () => {
    await withConfig(async file => {
      const root = path.dirname(file);
      await fs.writeFile(path.join(root, "hooks.json"), JSON.stringify({ hooks: [{ event: "pre-prompt", run: "echo unsafe-hook" }] }));
      await fs.writeFile(file, contents);
      await expect(loadHooks(root)).rejects.toThrow();
      expect(await fs.readFile(file, "utf8")).toBe(contents);
    });
  });
}

test("config patch creates a missing config using defaults", async () => {
  await withConfig(async file => {
    const result = await saveConfigPatch(() => ({ defaultModel: "openai/gpt-4o-mini" }));
    expect(result.defaultModel).toBe("openai/gpt-4o-mini");
    expect(JSON.parse(await fs.readFile(file, "utf8")).defaultModel).toBe("openai/gpt-4o-mini");
  });
});

test("config patch preserves a valid sandbox and authorized resources", async () => {
  await withConfig(async file => {
    const assets = ["/authorized/skill/SKILL.md"];
    await fs.writeFile(file, JSON.stringify({ defaultModel: "openai/gpt-4o-mini", sandbox, sandboxSkillAssets: assets }));
    await saveConfigPatch(() => ({ theme: "matrix" }));
    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    expect(persisted.sandbox).toEqual(sandbox);
    expect(persisted.sandboxSkillAssets).toEqual(assets);
    expect(persisted.theme).toBe("matrix");
  });
});
