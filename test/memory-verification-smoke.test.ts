/**
 * Smoke tests for the memory mechanical-verification work:
 *   1. `ensureJeoGitignore` self-ignores `.jeo/` (idempotent, never clobbers a
 *      user-customized file).
 *   2. `last_verified` is only stamped on a genuine verification event
 *      (`sessionVerified: true`), never on a bare write.
 *   3. `isConceptStale` pure staleness check.
 *
 * Uses the same `mock.module("../src/agent/loop", ...)` + dynamic re-import
 * pattern as the existing memory-distill-okf.test.ts suite (bun:test module
 * mocking requires the consumer to be imported AFTER the mock is installed).
 */
import { test, expect, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-memory-verify-"));
}

const HISTORY = [
  { role: "system" as const, content: "sys" },
  { role: "user" as const, content: "fix the parser" },
  { role: "assistant" as const, content: '{"tool":"bash","arguments":{"command":"bun test"}}' },
  { role: "user" as const, content: "Tool [bash] result (ok):\n3 pass" },
  { role: "assistant" as const, content: "done — parser fixed" },
];

const ONE_CONCEPT = JSON.stringify({
  concepts: [
    {
      type: "Command",
      title: "bun test",
      description: "Run the test suite",
      body: "Use `bun test` to run all unit tests.",
      tags: ["test", "bun"],
      confidence: "high",
      links: [],
    },
  ],
});

// ── .jeo/.gitignore self-ignore ─────────────────────────────────────────────

test("ensureJeoGitignore: distillSessionMemory creates .jeo/.gitignore containing '*' on first write", async () => {
  const dir = await tmp();
  await mock.module("../src/agent/loop", () => ({ callLlm: async () => ONE_CONCEPT }));
  const { distillSessionMemory } = await import("../src/agent/memory");

  const res = await distillSessionMemory(HISTORY, dir);
  expect(res.updated).toBe(true);

  const gitignorePath = path.join(dir, ".jeo", ".gitignore");
  const content = await fs.readFile(gitignorePath, "utf-8");
  expect(content).toBe("*\n");

  await fs.rm(dir, { recursive: true, force: true });
});

test("ensureJeoGitignore: appendSkillLesson also creates .jeo/.gitignore", async () => {
  const dir = await tmp();
  const { appendSkillLesson } = await import("../src/agent/skill-lessons");

  const res = await appendSkillLesson(dir, {
    skill: "some-skill",
    kind: "failure-mode",
    title: "Test lesson",
    detail: "Some detail about a failure mode.",
  });
  expect(res.appended).toBe(true);

  const gitignorePath = path.join(dir, ".jeo", ".gitignore");
  const content = await fs.readFile(gitignorePath, "utf-8");
  expect(content).toBe("*\n");

  await fs.rm(dir, { recursive: true, force: true });
});

test("ensureJeoGitignore is idempotent: a second call does not duplicate/overwrite", async () => {
  const dir = await tmp();
  const { ensureJeoGitignore } = await import("../src/agent/state");

  await ensureJeoGitignore(dir);
  const gitignorePath = path.join(dir, ".jeo", ".gitignore");
  const firstContent = await fs.readFile(gitignorePath, "utf-8");
  expect(firstContent).toBe("*\n");

  await ensureJeoGitignore(dir);
  const secondContent = await fs.readFile(gitignorePath, "utf-8");
  expect(secondContent).toBe("*\n"); // unchanged, not duplicated

  await fs.rm(dir, { recursive: true, force: true });
});

test("ensureJeoGitignore never clobbers a pre-existing user-customized .jeo/.gitignore", async () => {
  const dir = await tmp();
  const { ensureJeoGitignore } = await import("../src/agent/state");

  const jeoDir = path.join(dir, ".jeo");
  await fs.mkdir(jeoDir, { recursive: true });
  const gitignorePath = path.join(jeoDir, ".gitignore");
  const customContent = "!memory/keep-this.md\nmemory/scratch/\n";
  await fs.writeFile(gitignorePath, customContent, "utf-8");

  await ensureJeoGitignore(dir);
  const afterContent = await fs.readFile(gitignorePath, "utf-8");
  expect(afterContent).toBe(customContent); // untouched

  await fs.rm(dir, { recursive: true, force: true });
});

// ── last_verified: real verification-event signal ───────────────────────────

test("last_verified: a concept distilled WITHOUT sessionVerified has no last_verified stamp", async () => {
  const dir = await tmp();
  await mock.module("../src/agent/loop", () => ({ callLlm: async () => ONE_CONCEPT }));
  const { distillSessionMemory } = await import("../src/agent/memory");

  const res = await distillSessionMemory(HISTORY, dir); // sessionVerified omitted -> false
  expect(res.updated).toBe(true);

  const file = path.join(dir, ".jeo", "memory", "commands", "bun-test.md");
  const content = await fs.readFile(file, "utf-8");
  expect(content).not.toContain("last_verified");

  await fs.rm(dir, { recursive: true, force: true });
});

test("last_verified: a concept distilled WITH sessionVerified:true IS stamped with today's date", async () => {
  const dir = await tmp();
  await mock.module("../src/agent/loop", () => ({ callLlm: async () => ONE_CONCEPT }));
  const { distillSessionMemory } = await import("../src/agent/memory");

  const res = await distillSessionMemory(HISTORY, dir, { sessionVerified: true });
  expect(res.updated).toBe(true);

  const file = path.join(dir, ".jeo", "memory", "commands", "bun-test.md");
  const content = await fs.readFile(file, "utf-8");
  const today = new Date().toISOString().split("T")[0];
  expect(content).toContain(`last_verified: ${today}`);

  await fs.rm(dir, { recursive: true, force: true });
});

test("last_verified: re-upserting an already-verified concept WITHOUT new verification preserves the OLD stamp", async () => {
  const dir = await tmp();
  await mock.module("../src/agent/loop", () => ({ callLlm: async () => ONE_CONCEPT }));
  const { distillSessionMemory } = await import("../src/agent/memory");

  // First distill: verified -> stamps today's date.
  await distillSessionMemory(HISTORY, dir, { sessionVerified: true });
  const file = path.join(dir, ".jeo", "memory", "commands", "bun-test.md");
  const firstContent = await fs.readFile(file, "utf-8");
  const today = new Date().toISOString().split("T")[0];
  expect(firstContent).toContain(`last_verified: ${today}`);

  // Manually backdate the stamp to prove preservation isn't just "same day" luck.
  const backdated = firstContent.replace(`last_verified: ${today}`, "last_verified: 2020-01-01");
  await fs.writeFile(file, backdated, "utf-8");

  // Second distill of the SAME concept, this time unverified — must NOT bump it to today.
  const updatedResponse = JSON.stringify({
    concepts: [
      {
        type: "Command",
        title: "bun test",
        description: "Run the test suite (updated)",
        body: "Use `bun test` to run all unit tests (updated).",
        tags: ["test", "bun"],
        confidence: "high",
        links: [],
      },
    ],
  });
  await mock.module("../src/agent/loop", () => ({ callLlm: async () => updatedResponse }));
  const res2 = await distillSessionMemory(HISTORY, dir); // sessionVerified omitted -> false
  expect(res2.updated).toBe(true);

  const secondContent = await fs.readFile(file, "utf-8");
  expect(secondContent).toContain("last_verified: 2020-01-01"); // preserved, not bumped
  expect(secondContent).toContain("description: Run the test suite (updated)"); // other fields DID update

  await fs.rm(dir, { recursive: true, force: true });
});

// ── isConceptStale ────────────────────────────────────────────────────────

test("isConceptStale: a concept with no last_verified is stale", async () => {
  const { isConceptStale } = await import("../src/agent/memory");
  expect(isConceptStale({ confidence: "high" })).toBe(true);
});

test("isConceptStale: a concept verified today is NOT stale (default 30-day threshold)", async () => {
  const { isConceptStale } = await import("../src/agent/memory");
  const today = new Date().toISOString().split("T")[0]!;
  expect(isConceptStale({ confidence: "high", last_verified: today })).toBe(false);
});

test("isConceptStale: a concept verified 40 days ago IS stale (default 30-day threshold)", async () => {
  const { isConceptStale } = await import("../src/agent/memory");
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;
  expect(isConceptStale({ confidence: "high", last_verified: fortyDaysAgo })).toBe(true);
});

test("isConceptStale: staleDays option is honored (e.g. verified 10 days ago is stale at a 5-day threshold)", async () => {
  const { isConceptStale } = await import("../src/agent/memory");
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;
  expect(isConceptStale({ confidence: "high", last_verified: tenDaysAgo }, { staleDays: 5 })).toBe(true);
  expect(isConceptStale({ confidence: "high", last_verified: tenDaysAgo }, { staleDays: 30 })).toBe(false);
});
