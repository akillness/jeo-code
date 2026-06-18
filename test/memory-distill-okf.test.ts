import { test, expect, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateBundle } from "../src/agent/memory-okf";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-memory-okf-"));
}

/** Recursively collect concept/reserved .md files as OKF BundleFile[] (skips raw/). */
async function readBundleFiles(bundleDir: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  async function recurse(cur: string) {
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "raw") continue;
        await recurse(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push({ path: path.relative(bundleDir, full), content: await fs.readFile(full, "utf-8") });
      }
    }
  }
  await recurse(bundleDir);
  return out;
}

const HISTORY = [
  { role: "system" as const, content: "sys" },
  { role: "user" as const, content: "fix the parser" },
  { role: "assistant" as const, content: '{"tool":"bash","arguments":{"command":"bun test"}}' },
  { role: "user" as const, content: "Tool [bash] result (ok):\n3 pass" },
  { role: "assistant" as const, content: "done — parser fixed" },
];

const MOCK_JSON_RESPONSE = JSON.stringify({
  concepts: [
    {
      type: "Command",
      title: "bun test",
      description: "Run the test suite",
      body: "Use `bun test` to run all unit tests in the repository.",
      tags: ["test", "bun"],
      confidence: "high",
      links: []
    },
    {
      type: "RepoFact",
      title: "Bun runtime",
      description: "The project uses Bun",
      body: "Bun >= 1.3.14 is required.",
      tags: ["bun"],
      confidence: "high",
      links: []
    }
  ]
});

test("distillSessionMemory writes OKF concepts, index.md, and log.md conformant to OKF", async () => {
  const dir = await tmp();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => MOCK_JSON_RESPONSE,
  }));

  const { distillSessionMemory } = await import("../src/agent/memory");
  const res = await distillSessionMemory(HISTORY, dir);
  expect(res.updated).toBe(true);

  // Verify files exist
  const cmdFile = path.join(dir, ".jeo", "memory", "commands", "bun-test.md");
  const factFile = path.join(dir, ".jeo", "memory", "facts", "bun-runtime.md");
  const indexFile = path.join(dir, ".jeo", "memory", "index.md");
  const logFile = path.join(dir, ".jeo", "memory", "log.md");

  expect(await fs.access(cmdFile).then(() => true).catch(() => false)).toBe(true);
  expect(await fs.access(factFile).then(() => true).catch(() => false)).toBe(true);
  expect(await fs.access(indexFile).then(() => true).catch(() => false)).toBe(true);
  expect(await fs.access(logFile).then(() => true).catch(() => false)).toBe(true);

  // Validate bundle against the Sprint 01 OKF conformance checker.
  const bundleDir = path.join(dir, ".jeo", "memory");
  const bundleFiles = await readBundleFiles(bundleDir);
  const report = validateBundle(bundleFiles);
  expect(report.issues.filter(i => i.level === "error").length).toBe(0);
  expect(report.conformant).toBe(true);

  // Verify index content
  const indexContent = await fs.readFile(indexFile, "utf-8");
  expect(indexContent).toContain("okf_version: \"0.1\"");
  expect(indexContent).toContain("[bun test](/commands/bun-test.md)");
  expect(indexContent).toContain("[Bun runtime](/facts/bun-runtime.md)");

  // Verify log content
  const logContent = await fs.readFile(logFile, "utf-8");
  const today = new Date().toISOString().split("T")[0];
  expect(logContent).toContain(`## ${today}`);
  expect(logContent).toContain("* **Command**: bun test");
  expect(logContent).toContain("* **RepoFact**: Bun runtime");

  await fs.rm(dir, { recursive: true, force: true });
});

test("re-distilling the same session does not duplicate concepts but upserts them", async () => {
  const dir = await tmp();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => MOCK_JSON_RESPONSE,
  }));

  const { distillSessionMemory } = await import("../src/agent/memory");
  await distillSessionMemory(HISTORY, dir);

  // Modify MOCK_JSON_RESPONSE slightly to simulate an update
  const updatedResponse = JSON.stringify({
    concepts: [
      {
        type: "Command",
        title: "bun test",
        description: "Run the test suite (updated)",
        body: "Use `bun test` to run all unit tests in the repository (updated).",
        tags: ["test", "bun", "updated"],
        confidence: "medium",
        links: []
      }
    ]
  });

  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => updatedResponse,
  }));

  const res = await distillSessionMemory(HISTORY, dir);
  expect(res.updated).toBe(true);

  const cmdFile = path.join(dir, ".jeo", "memory", "commands", "bun-test.md");
  const content = await fs.readFile(cmdFile, "utf-8");
  expect(content).toContain("description: Run the test suite (updated)");
  expect(content).toContain("confidence: medium");
  expect(content).toContain("Use `bun test` to run all unit tests in the repository (updated).");

  // Check that there is no duplicate file like bun-test-1.md
  const dupFile = path.join(dir, ".jeo", "memory", "commands", "bun-test-1.md");
  expect(await fs.access(dupFile).then(() => true).catch(() => false)).toBe(false);

  await fs.rm(dir, { recursive: true, force: true });
});

test("raw payload is saved in raw/ and stale pending files are cleaned up", async () => {
  const dir = await tmp();
  const { runMemoryDistillCommand } = await import("../src/agent/memory");

  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => MOCK_JSON_RESPONSE,
  }));

  const payloadPath = path.join(dir, "pending-distill-123-456.json");
  await fs.writeFile(payloadPath, JSON.stringify({ model: "m", messages: HISTORY }));

  const savedCwd = process.cwd();
  try {
    process.chdir(dir);
    await runMemoryDistillCommand([payloadPath]);
  } finally {
    process.chdir(savedCwd);
  }

  // Verify raw payload exists in raw/
  const rawDir = path.join(dir, ".jeo", "memory", "raw");
  const rawFiles = await fs.readdir(rawDir);
  expect(rawFiles.length).toBe(1);
  expect(rawFiles[0]).toContain("session-");

  // Verify pending payload is cleaned up
  expect(await fs.access(payloadPath).then(() => true).catch(() => false)).toBe(false);

  await fs.rm(dir, { recursive: true, force: true });
});

test("JEO_NO_MEMORY=1 disables the distillation", async () => {
  const dir = await tmp();
  const { distillSessionMemory } = await import("../src/agent/memory");

  process.env.JEO_NO_MEMORY = "1";
  try {
    const res = await distillSessionMemory(HISTORY, dir);
    expect(res.updated).toBe(false);
    expect(res.skipped).toContain("disabled");
  } finally {
    delete process.env.JEO_NO_MEMORY;
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test("a malformed concepts array (null/string/number elements + non-string fields) still persists the valid concepts", async () => {
  const dir = await tmp();
  // Mimic a text-only/small model: stray non-object elements and non-string
  // type/title fields interleaved with two valid concepts. The pre-hardening
  // loop threw a TypeError on the first bad element, which the outer catch
  // swallowed as "distill failed" — silently losing the WHOLE batch.
  const messyResponse = JSON.stringify({
    concepts: [
      null,
      "oops not an object",
      42,
      { type: "Command", title: "bun test", description: "Run tests", body: "Use `bun test`.", tags: ["test"], confidence: "high", links: [] },
      { type: 123, title: "bad type" },                       // non-string type → skipped
      { type: "RepoFact", title: "" },                        // empty title → skipped
      { type: "RepoFact", title: "Bun runtime", description: 99, body: null, tags: "notarray", links: 5 }, // valid type/title, junk fields → coerced
    ],
  });
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => messyResponse,
  }));

  const { distillSessionMemory } = await import("../src/agent/memory");
  const res = await distillSessionMemory(HISTORY, dir);
  expect(res.updated).toBe(true);

  const cmdFile = path.join(dir, ".jeo", "memory", "commands", "bun-test.md");
  const factFile = path.join(dir, ".jeo", "memory", "facts", "bun-runtime.md");
  expect(await fs.access(cmdFile).then(() => true).catch(() => false)).toBe(true);
  expect(await fs.access(factFile).then(() => true).catch(() => false)).toBe(true);

  // The junk-field concept must coerce non-string fields to safe defaults and stay conformant.
  const factContent = await fs.readFile(factFile, "utf-8");
  expect(factContent).toContain("title: Bun runtime");
  expect(factContent).toContain("description:");
  const bundleFiles = await readBundleFiles(path.join(dir, ".jeo", "memory"));
  const report = validateBundle(bundleFiles);
  expect(report.conformant).toBe(true);

  await fs.rm(dir, { recursive: true, force: true });
});
