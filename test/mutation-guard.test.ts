import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeTool } from "../src/agent/tools";

let dir = "";

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-mutguard-"));
  await fs.mkdir(path.join(dir, ".jeo", "state"), { recursive: true });
  // Active interview, not yet complete → mutations outside .jeo/ are blocked.
  await fs.writeFile(
    path.join(dir, ".jeo", "state", "deep-interview-state.json"),
    JSON.stringify({ active: true, current_phase: "interview", skill: "deep-interview", current_ambiguity: 0.8 })
  );
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test("MutationGuard allows writes under .jeo/ during an active interview", async () => {
  const res = await writeTool(".jeo/seeds/seed.yaml", "goal: x", dir);
  expect(res.success).toBe(true);
});

test("MutationGuard blocks code mutation outside .jeo/ during an active interview", async () => {
  const res = await writeTool("src/evil.ts", "console.log(1)", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("MutationGuard Blocked");
});

test("MutationGuard blocks sibling dirs like .jeo-backup (path-boundary, not prefix)", async () => {
  const res = await writeTool(".jeo-backup/evil.ts", "console.log(1)", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("MutationGuard Blocked");
});

test("MutationGuard fails CLOSED on a corrupt deep-interview state (blocks mutation)", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-mutguard-corrupt-"));
  try {
    await fs.mkdir(path.join(d, ".jeo", "state"), { recursive: true });
    await fs.writeFile(path.join(d, ".jeo", "state", "deep-interview-state.json"), "{ not valid json");
    const res = await writeTool("src/evil.ts", "console.log(1)", d);
    expect(res.success).toBe(false);
    expect(res.error).toContain("MutationGuard");
  } finally {
    await fs.rm(d, { recursive: true, force: true });
  }
});
