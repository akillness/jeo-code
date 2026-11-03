import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMessengerCliReply } from "../src/commands/messenger";
import { parseMessengerConfig, validateMessengerStorage } from "../src/messenger/config";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

interface PrivacyReport {
  updated: boolean;
  parentSawHistory: boolean;
  detachedSpawns: number;
  distillRpc: string;
  sharedFiles: Record<string, string>;
  hostFiles: Record<string, string>;
  afterRawFiles: Record<string, string>;
  rawError: string;
  rejectedRawRpc: { success: boolean; error: string };
  plainSpawned: boolean;
  pending: { model: string; messages: Array<{ role: string; content: string }> };
  retained: { messages: Array<{ role: string; content: string }> };
  guestLogs: string[];
  skills: Array<{ name: string; raw: string }>;
  parentReadSentinel: boolean;
  rpc: Array<{ tool?: string; args?: { action: string }; cwd?: string }>;
  unsafeRoot?: string;
}

async function scenario(mode: string): Promise<PrivacyReport> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-metadata-privacy-")));
  roots.push(root);
  const home = path.join(root, "empty-startup-home");
  const config = path.join(root, "empty-startup-config");
  await Promise.all([fs.mkdir(home), fs.mkdir(config)]);
  const sourceRoot = process.env.JEO_METADATA_PRIVACY_SOURCE_ROOT ?? path.resolve(import.meta.dir, "..");
  const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "fixtures", "sandbox-metadata-privacy.ts"), mode, root, sourceRoot], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: home, JEO_CONFIG_DIR: config },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout);
}

test("sandbox exit distills in the parent and publishes only derived learning, never transcript or system prompt", async () => {
  const report = await scenario("memory");
  expect(report.updated).toBe(true);
  expect(report.parentSawHistory).toBe(true);
  expect(report.sharedFiles[".jeo/memory/commands/focused-verification.md"]).toContain("Use bun test test/focused.test.ts after a change.");
  expect(report.sharedFiles[".jeo/memory/index.md"]).toContain("Focused verification");
  expect(report.sharedFiles[".jeo/memory/log.md"]).toContain("Focused verification");
  expect(report.hostFiles).toEqual({});
  for (const marker of ["HISTORY-PRIVATE-2f9a", "SYSTEM-PROMPT-PRIVATE-8c7d"]) {
    expect(report.distillRpc).not.toContain(marker);
    expect(JSON.stringify(report.sharedFiles)).not.toContain(marker);
    expect(JSON.stringify(report.guestLogs)).not.toContain(marker);
  }
  expect(Object.keys(report.sharedFiles).some(file => /pending-distill-|\/raw\//.test(file))).toBe(false);
  expect(report.rawError).toContain("raw session payloads are parent-only");
  expect(report.afterRawFiles).toEqual(report.sharedFiles);
  expect(report.rejectedRawRpc).toMatchObject({ success: false, error: "Unknown memory operation" });
  // Only the explicitly nonsandbox path may detach or retain the original bytes.
  expect(report.detachedSpawns).toBe(1);
  expect(report.plainSpawned).toBe(true);
  expect(report.pending.model).toBe("fixture/no-network");
  expect(report.pending.messages[0]).toEqual({ role: "system", content: "SYSTEM-PROMPT-PRIVATE-8c7d" });
  expect(report.retained.messages).toEqual(report.pending.messages);
}, 30_000);

for (const mode of ["configured", "home"] as const) {
  test(`sandbox catalog treats ${mode === "configured" ? "arbitrary JEO_SKILLS_DIR" : "overridden HOME roots"} as guest-owned even when another session can replace their files`, async () => {
    const report = await scenario(mode);
    expect(report.parentReadSentinel).toBe(false);
    expect(report.skills.map(skill => skill.name)).toEqual(["guest-guidance"]);
    expect(report.skills[0]!.raw).toContain("Guest authorized guidance");
    expect(JSON.stringify(report.skills)).not.toContain("PARENT-PRIVATE-CATALOG-a81e");
    expect(JSON.stringify(report.rpc)).not.toContain("PARENT-PRIVATE-CATALOG-a81e");
    expect(report.rpc.some(call => call.args?.action === "scan" && call.cwd === report.unsafeRoot)).toBe(true);
  }, 30_000);
}

test("sandbox catalog skips an unmounted unsafe root instead of reading its parent-private symlink", async () => {
  const report = await scenario("unmounted");
  expect(report.parentReadSentinel).toBe(false);
  expect(report.skills).toEqual([]);
  expect(report.rpc.some(call => call.cwd === report.unsafeRoot)).toBe(false);
  expect(JSON.stringify(report.rpc)).not.toContain("PARENT-PRIVATE-CATALOG-a81e");
}, 30_000);

test("protected native agent roots and canonical .claude to .agents aliases load, but a workspace then dot-dot escape never becomes a parent read", async () => {
  const report = await scenario("protected");
  expect(report.skills.map(skill => skill.name)).toEqual(["protected-alias", "protected-store", "protected-native"]);
  expect(report.skills[0]!.raw).toContain("Protected native alias guidance");
  expect(report.skills[1]!.raw).toContain("Canonical protected store guidance");
  expect(report.skills[2]!.raw).toContain("Protected native install guidance");
  expect(report.parentReadSentinel).toBe(false);
  expect(JSON.stringify(report.skills)).not.toContain("PARENT-PRIVATE-CATALOG-a81e");
  expect(JSON.stringify(report.rpc)).not.toContain("PARENT-PRIVATE-CATALOG-a81e");
}, 30_000);

test("legacy workspace raw memory refuses sandbox startup without rewriting history or starting a worker/model", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-legacy-privacy-")));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  const raw = path.join(cwd, ".jeo", "memory", "raw");
  await fs.mkdir(raw, { recursive: true });
  const history = Buffer.from(JSON.stringify({
    model: "fixture/private-history",
    messages: [
      { role: "system", content: "LEGACY-PRIVATE-SYSTEM-971d" },
      { role: "user", content: "LEGACY-PRIVATE-USER-28b1" },
      { role: "assistant", content: "LEGACY-PRIVATE-ANSWER-a03f" },
    ],
  }, null, 2) + "\n");
  const file = path.join(raw, "historical-session.json");
  await fs.writeFile(file, history);
  const config = parseMessengerConfig({
    cwd, sessionDir: path.join(root, "sessions"),
    sandbox: { image: "oven/bun:1.3.14", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } },
    platforms: { discord: { allowedUserIds: ["operator"], model: "fixture/no-network" } },
  }, root);
  const refusal = "Legacy session transcripts or raw history may be exposed in the sandbox workspace";
  await expect(validateMessengerStorage(config)).rejects.toThrow(refusal);
  let workers = 0;
  let models = 0;
  const spawn = (() => { workers++; throw new Error("Private history must prevent worker startup"); }) as typeof Bun.spawn;
  const reply = createMessengerCliReply(config, spawn, async () => { models++; throw new Error("Private history must prevent model selection"); });
  try {
    await expect(reply({ platform: "discord", accountId: "offline-bot", channelId: "offline-thread", senderId: "operator", messageId: "1", text: "Do not expose historical memory", direct: true, mentioned: false }, new AbortController().signal)).rejects.toThrow(refusal);
    expect({ workers, models }).toEqual({ workers: 0, models: 0 });
    expect(await fs.readFile(file)).toEqual(history);
    expect(await fs.readdir(raw)).toEqual(["historical-session.json"]);
    expect(await fs.readdir(root)).toEqual(["workspace"]);
  } finally {
    await reply.close();
  }
});
