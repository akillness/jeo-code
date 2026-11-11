import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig } from "../src/agent/config-schema";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const sandbox = { image: "test-local-image", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } };

async function launch(assets: unknown, useRemote = true, configMode: "present" | "missing" | "malformed" = "present") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-skill-guard-")));
  const cwd = path.join(root, "workspace");
  const configDir = path.join(root, "config");
  const sessionDir = path.join(root, "sessions");
  try {
    await Promise.all([fs.mkdir(cwd), fs.mkdir(configDir), fs.mkdir(sessionDir)]);
    if (configMode !== "missing") await fs.writeFile(path.join(configDir, "config.json"), configMode === "malformed" ? "{" : JSON.stringify({ defaultModel: "openai/gpt-4o-mini", sandbox, sandboxSkillAssets: assets }));
    const child = Bun.spawn([process.execPath, cli, "launch", "--list", "--no-tui"], {
      cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", JEO_CONFIG_DIR: configDir, JEO_SESSION_DIR: sessionDir,
        ...(useRemote ? { JEO_MESSENGER_SANDBOX: JSON.stringify(sandbox), JEO_MESSENGER_SESSION_KEY: "test-guard", JEO_MESSENGER_ALLOWED_USER_IDS: "[]" } : {}),
      },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("non-native sandbox refuses configured skill files rather than silently omitting them", async () => {
  const result = await launch(["/approved/skill/SKILL.md"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("SANDBOX_SKILLS: the selected backend cannot transport authorized skill assets");
  expect(result.stdout).not.toContain("No saved sessions");
}, 30_000);

test("non-native sandbox with no approved files retains normal launch behavior", async () => {
  const result = await launch([]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("No saved sessions");
  expect(result.stderr).not.toContain("SANDBOX_SKILLS");
}, 30_000);

for (const assets of ["/approved/skill/SKILL.md", [42], [""]] as const) {
  test(`invalid skill authorization config ${JSON.stringify(assets)} cannot disable the configured sandbox`, async () => {
    const result = await launch(assets, false);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("No saved sessions");
    expect(result.stderr).toMatch(/config|sandbox|invalid/i);
  }, 30_000);
}

test("sandbox schema accepts native and Docker forms but rejects unknown sandbox properties", () => {
  for (const value of [{ backend: "native" }, sandbox, { ...sandbox, backend: "docker" }]) {
    expect(parseConfig({ defaultModel: "openai/gpt-4o-mini", sandbox: value }).ok).toBe(true);
  }
  for (const value of [{ backend: "native", network: "open" }, { ...sandbox, network: "open" }, { ...sandbox, limits: { ...sandbox.limits, unrecognized: 1 } }]) {
    expect(parseConfig({ defaultModel: "openai/gpt-4o-mini", sandbox: value }).ok).toBe(false);
  }
});

test("malformed configuration stops launch rather than using defaults", async () => {
  const result = await launch(undefined, false, "malformed");
  expect(result.code).not.toBe(0);
  expect(result.stdout).not.toContain("No saved sessions");
  expect(result.stderr).toMatch(/config|invalid|json/i);
}, 30_000);

test("missing configuration still permits default launch", async () => {
  const result = await launch(undefined, false, "missing");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("No saved sessions");
}, 30_000);
