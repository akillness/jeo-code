import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeTool } from "../src/agent/tools";

let dir = "";

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-mutguard-"));
  await fs.mkdir(path.join(dir, ".joc", "state"), { recursive: true });
  // Active interview, not yet complete → mutations outside .joc/ are blocked.
  await fs.writeFile(
    path.join(dir, ".joc", "state", "deep-interview-state.json"),
    JSON.stringify({ active: true, current_phase: "interview", skill: "deep-interview", current_ambiguity: 0.8 })
  );
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test("MutationGuard allows writes under .joc/ during an active interview", async () => {
  const res = await writeTool(".joc/seeds/seed.yaml", "goal: x", dir);
  expect(res.success).toBe(true);
});

test("MutationGuard blocks code mutation outside .joc/ during an active interview", async () => {
  const res = await writeTool("src/evil.ts", "console.log(1)", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("MutationGuard Blocked");
});

test("MutationGuard blocks sibling dirs like .joc-backup (path-boundary, not prefix)", async () => {
  const res = await writeTool(".joc-backup/evil.ts", "console.log(1)", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("MutationGuard Blocked");
});

test("MutationGuard fails CLOSED on a corrupt deep-interview state (blocks mutation)", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "joc-mutguard-corrupt-"));
  try {
    await fs.mkdir(path.join(d, ".joc", "state"), { recursive: true });
    await fs.writeFile(path.join(d, ".joc", "state", "deep-interview-state.json"), "{ not valid json");
    const res = await writeTool("src/evil.ts", "console.log(1)", d);
    expect(res.success).toBe(false);
    expect(res.error).toContain("MutationGuard");
  } finally {
    await fs.rm(d, { recursive: true, force: true });
  }
});
