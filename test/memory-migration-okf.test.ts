import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseLegacyMemory,
  migrateLegacyMemory,
  loadConcepts,
  memoryFilePath,
  memoryPromptSection,
} from "../src/agent/memory";
import { validateBundle } from "../src/agent/memory-okf";

// Sprint 05 — Migration & Rollout (docs/okf_mem/sprint-05-migration-rollout):
// lossless + idempotent migration of the legacy single-doc MEMORY.md into the
// OKF concept bundle, with a bundle/legacy fallback and a JEO_MEMORY_LEGACY
// rollback toggle.

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-memory-migrate-"));
}

const LEGACY_DOC = [
  "# Project Memory",
  "",
  "## Repo Facts",
  "- **Bun runtime**: zero native deps",
  "  Uses Bun >= 1.3.14 for everything.",
  "- Pure TypeScript codebase",
  "",
  "## Commands",
  "- **bun test**: run the suite",
  "",
  "## Gotchas",
  "- **Missing tool field**: JSON responses must include a tool key",
  "",
  "## User Preferences",
  "- Korean-language status reports",
  "",
].join("\n");

async function writeLegacy(dir: string, doc = LEGACY_DOC): Promise<void> {
  await fs.mkdir(path.dirname(memoryFilePath(dir)), { recursive: true });
  await fs.writeFile(memoryFilePath(dir), doc, "utf-8");
}

test("parseLegacyMemory: headings map to types, bold bullets split title/description, indents become body", () => {
  const concepts = parseLegacyMemory(LEGACY_DOC);
  expect(concepts.length).toBe(5);
  const byTitle = Object.fromEntries(concepts.map(c => [c.title, c]));
  expect(byTitle["Bun runtime"]).toMatchObject({ type: "RepoFact", description: "zero native deps" });
  expect(byTitle["Bun runtime"]!.body).toContain("Bun >= 1.3.14");
  expect(byTitle["Pure TypeScript codebase"]).toMatchObject({ type: "RepoFact", description: "" });
  expect(byTitle["bun test"]!.type).toBe("Command");
  expect(byTitle["Missing tool field"]!.type).toBe("Gotcha");
  expect(byTitle["Korean-language status reports"]!.type).toBe("UserPreference");
});

test("migrateLegacyMemory: lossless conversion to a conformant OKF bundle + rollback backup", async () => {
  const dir = await tmp();
  await writeLegacy(dir);
  const res = await migrateLegacyMemory(dir);
  expect(res.migrated).toBe(true);
  expect(res.conceptCount).toBe(5);

  const concepts = await loadConcepts(dir);
  expect(concepts.length).toBe(5);
  // Type partitioning landed each concept in the right subdir.
  const cmd = concepts.find(c => c.title === "bun test")!;
  expect(cmd.relPath.startsWith("commands/")).toBe(true);
  expect(cmd.type).toBe("Command");
  // Body content preserved (lossless).
  const bun = concepts.find(c => c.title === "Bun runtime")!;
  expect(bun.body).toContain("Bun >= 1.3.14");

  // The whole produced bundle is OKF-conformant (no error-level issues).
  const files: { path: string; content: string }[] = [];
  async function recurse(cur: string) {
    for (const e of await fs.readdir(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { if (e.name !== "raw") await recurse(full); }
      else if (e.name.endsWith(".md")) files.push({ path: path.relative(path.join(dir, ".jeo", "memory"), full), content: await fs.readFile(full, "utf-8") });
    }
  }
  await recurse(path.join(dir, ".jeo", "memory"));
  expect(validateBundle(files).conformant).toBe(true);

  // index.md + log.md were generated.
  expect(files.some(f => f.path === "index.md")).toBe(true);
  expect(files.some(f => f.path === "log.md")).toBe(true);

  // Legacy doc moved aside to the rollback backup, off the active read path.
  expect(res.backupPath).toBe(`${memoryFilePath(dir)}.bak`);
  await expect(fs.access(memoryFilePath(dir))).rejects.toThrow();
  expect(await fs.readFile(res.backupPath!, "utf-8")).toContain("Bun runtime");
  await fs.rm(dir, { recursive: true, force: true });
});

test("migrateLegacyMemory: idempotent — a second run is a no-op when the bundle exists", async () => {
  const dir = await tmp();
  await writeLegacy(dir);
  const first = await migrateLegacyMemory(dir);
  expect(first.migrated).toBe(true);
  const before = (await loadConcepts(dir)).length;

  const second = await migrateLegacyMemory(dir);
  expect(second.migrated).toBe(false);
  expect(second.skipped).toContain("already has concepts");
  expect((await loadConcepts(dir)).length).toBe(before); // no duplication
  await fs.rm(dir, { recursive: true, force: true });
});

test("migrateLegacyMemory: no-ops cleanly when there is nothing to migrate", async () => {
  const dir = await tmp();
  const none = await migrateLegacyMemory(dir);
  expect(none.migrated).toBe(false);
  expect(none.skipped).toContain("no legacy MEMORY.md");
  await fs.rm(dir, { recursive: true, force: true });
});

test("memoryPromptSection: bundle is the default read path after migration", async () => {
  const dir = await tmp();
  await writeLegacy(dir);
  await migrateLegacyMemory(dir);
  const section = await memoryPromptSection(dir);
  expect(section).toContain("<project_memory>");
  expect(section).toContain("Bun runtime");
  expect(section).toContain("## Commands"); // grouped/rendered from the bundle
  await fs.rm(dir, { recursive: true, force: true });
});

test("JEO_MEMORY_LEGACY=1: rollback toggle reads the backup, ignoring the bundle", async () => {
  const dir = await tmp();
  await writeLegacy(dir);
  await migrateLegacyMemory(dir); // MEMORY.md → bundle, legacy moved to .bak
  process.env.JEO_MEMORY_LEGACY = "1";
  try {
    const section = await memoryPromptSection(dir);
    // Reads the .bak rollback copy (raw legacy doc), not the rendered bundle.
    expect(section).toContain("<project_memory>");
    expect(section).toContain("zero native deps");
  } finally {
    delete process.env.JEO_MEMORY_LEGACY;
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("JEO_NO_MEMORY=1 still wins over the legacy toggle", async () => {
  const dir = await tmp();
  await writeLegacy(dir);
  process.env.JEO_NO_MEMORY = "1";
  process.env.JEO_MEMORY_LEGACY = "1";
  try {
    expect(await memoryPromptSection(dir)).toBe("");
  } finally {
    delete process.env.JEO_NO_MEMORY;
    delete process.env.JEO_MEMORY_LEGACY;
  }
  await fs.rm(dir, { recursive: true, force: true });
});
