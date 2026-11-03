import { test, expect } from "bun:test";
import { JobRegistry } from "../src/agent/job-registry";
import { createJobTool } from "../src/agent/job-tool";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cwd = process.cwd();

async function readChildPid(directory: string): Promise<number> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { return Number((await fs.readFile(path.join(directory, "child.pid"), "utf8")).trim()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // The real shell writes this file; fake timers cannot drive another process.
      await Bun.sleep(10);
    }
  }
  throw new Error("Timed out waiting for child.pid");
}

async function killChild(directory: string, pid?: number): Promise<void> {
  if (!pid) {
    for (const file of ["child.pid", "child.tmp"]) {
      try { pid = Number((await fs.readFile(path.join(directory, file), "utf8")).trim()); if (pid > 0) break; } catch {}
    }
  }
  if (pid && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
}

test("await reports successful and unsuccessful exit codes", async () => {
  const registry = new JobRegistry();
  const tool = createJobTool(registry);
  const ok = registry.start("exit 0", cwd);
  const bad = registry.start("exit 7", cwd);
  const success = await tool({ action: "await", ids: [ok.id], timeoutMs: 3000 }, cwd);
  expect(success.success).toBe(true);
  expect(success.output).toContain("exit code 0");
  const failure = await tool({ action: "await", ids: [bad.id], timeoutMs: 3000 }, cwd);
  expect(failure.success).toBe(false);
  expect(failure.output).toContain("exit code 7");
});

test("default await includes jobs already settled", async () => {
  const registry = new JobRegistry();
  const tool = createJobTool(registry);
  const job = registry.start("exit 7", cwd);
  await registry.awaitIds([job.id], 3000);
  const result = await tool({ action: "await" }, cwd);
  expect(result.success).toBe(false);
  expect(result.output).toContain(job.id);
  expect(result.output).toContain("exit code 7");
  const next = await tool({ action: "await" }, cwd);
  expect(next.success).toBe(true);
  expect(next.output).not.toContain(job.id);
  const explicit = await tool({ action: "await", ids: [job.id] }, cwd);
  expect(explicit.success).toBe(false);
  expect(explicit.output).toContain("exit code 7");
});

test("unknown await IDs fail, even when mixed with a running job", async () => {
  const registry = new JobRegistry();
  const tool = createJobTool(registry);
  const job = registry.start("sleep 5", cwd);
  try {
    for (const ids of [["missing"], [job.id, "missing"]]) {
      const result = await tool({ action: "await", ids, timeoutMs: 100 }, cwd);
      expect(result.success).toBe(false);
      expect(result.error).toContain("missing");
      expect(registry.get(job.id)?.status).toBe("running");
    }
  } finally {
    registry.cancel([job.id]);
  }
});

test("timed out and cancelled jobs do not count as successful", async () => {
  const registry = new JobRegistry();
  const tool = createJobTool(registry);
  const job = registry.start("sleep 5", cwd);
  try {
    expect((await tool({ action: "await", ids: [job.id], timeoutMs: 20 }, cwd)).success).toBe(false);
    registry.cancel([job.id]);
    expect((await tool({ action: "await", ids: [job.id] }, cwd)).success).toBe(false);
  } finally {
    registry.cancel([job.id]);
  }
});

test("newly settled jobs invalidate prior verification once, including failure and cancellation", async () => {
  const registry = new JobRegistry();
  const tool = createJobTool(registry);
  const ok = registry.start("exit 0", cwd);
  const bad = registry.start("exit 7", cwd);
  await registry.awaitIds([ok.id, bad.id], 3000);
  const first = await tool({ action: "list" }, cwd);
  expect(first.mutationMayHaveOccurred).toBe(true);
  expect((await tool({ action: "list" }, cwd)).mutationMayHaveOccurred).not.toBe(true);
  const running = registry.start("sleep 5", cwd);
  try {
    const timeout = await tool({ action: "await", ids: [running.id], timeoutMs: 20 }, cwd);
    expect(timeout.mutationMayHaveOccurred).not.toBe(true);
    const cancelled = await tool({ action: "cancel", ids: [running.id] }, cwd);
    expect(cancelled.mutationMayHaveOccurred).toBe(true);
  } finally { registry.cancel([running.id]); }
});

test("cancelled shell settles even while a child retains stdout and stderr", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-job-drain-"));
  const registry = new JobRegistry();
  let childPid: number | undefined;
  try {
    const job = registry.start('sleep 30 & echo $! > child.tmp; mv child.tmp child.pid; wait', directory);
    childPid = await readChildPid(directory);
    expect(childPid).toBeGreaterThan(0);
    registry.cancel([job.id]);
    const [settled] = await registry.awaitIds([job.id], 2500);
    expect(settled!.status).toBe("killed");
    expect(registry.unobserved().some(entry => entry.id === job.id)).toBe(true);
    expect(registry.consumeMutations([job.id])).toBe(true);
    expect(registry.unobserved().some(entry => entry.id === job.id)).toBe(false);
  } finally {
    registry.cancelAll();
    await killChild(directory, childPid);
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 5000);

test("normal shell exit with inherited pipes reports incomplete drain and blocks unobserved completion", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-job-linger-"));
  const registry = new JobRegistry();
  const tool = createJobTool(registry);
  let childPid: number | undefined;
  try {
    const job = registry.start('sleep 30 & echo $! > child.tmp; mv child.tmp child.pid; printf "partial output\\n"; exit 0', directory);
    childPid = await readChildPid(directory);
    const [settled] = await registry.awaitIds([job.id], 2500);
    expect(settled!.status).toBe("failed");
    expect(registry.tail(job.id)).toContain("partial output");
    expect(registry.tail(job.id)).toMatch(/incomplete/i);
    expect(registry.unobserved().map(record => record.id)).toContain(job.id);
    const observed = await tool({ action: "await", ids: [job.id] }, directory);
    expect(observed.success).toBe(false);
    expect(observed.mutationMayHaveOccurred).toBe(true);
    expect(registry.unobserved()).toEqual([]);
    expect((await tool({ action: "list" }, directory)).mutationMayHaveOccurred).not.toBe(true);
  } finally {
    registry.cancelAll();
    await killChild(directory, childPid);
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 5000);

test("job cancel rejects mixed unknown IDs without killing the valid job", async () => {
  const registry = new JobRegistry();
  const tool = createJobTool(registry);
  const job = registry.start("sleep 30", cwd);
  try {
    const result = await tool({ action: "cancel", ids: [job.id, "job-999"] }, cwd);
    expect(result.success).toBe(false);
    expect(result.error).toContain("job-999");
    expect(registry.running().map(record => record.id)).toContain(job.id);
  } finally {
    registry.cancelAll();
    await registry.awaitIds([job.id]);
  }
});

test.skipIf(process.platform === "win32")("incomplete job drain terminates descendants before they can mutate", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-job-late-"));
  const registry = new JobRegistry();
  let childPid: number | undefined;
  try {
    const job = registry.start('(sleep 2; echo mutated > late.txt) & echo $! > child.tmp; mv child.tmp child.pid; exit 0', directory);
    childPid = await readChildPid(directory);
    const [result] = await registry.awaitIds([job.id], 2500);
    expect(result!.status).toBe("failed");
    // The child is scheduled to write at two seconds; checking earlier cannot prove prevention.
    await Bun.sleep(2200);
    expect(await Bun.file(path.join(directory, "late.txt")).exists()).toBe(false);
  } finally {
    registry.cancelAll();
    await killChild(directory, childPid);
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 6000);


test.skipIf(process.platform !== "linux")("escaped job pipe holder stays unobserved after group disappears", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-job-escaped-"));
  const registry = new JobRegistry();
  let childPid: number | undefined;
  try {
    const job = registry.start("setsid sh -c 'echo $$ > child.tmp; mv child.tmp child.pid; exec sleep 30' & while [ ! -f child.pid ]; do :; done; exit 0", directory);
    childPid = await readChildPid(directory);
    const [result] = await registry.awaitIds([job.id], 2500);
    expect(result!.status).toBe("failed");
    registry.consumeMutations([job.id]);
    expect(registry.unobserved().map(record => record.id)).toContain(job.id);
    registry.cancel([job.id]);
    expect(registry.unobserved().map(record => record.id)).toContain(job.id);
  } finally {
    registry.cancelAll();
    await killChild(directory, childPid);
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 5000);

test.skipIf(process.platform !== "win32")("Windows job cancellation remains unresolved after the shell exits", async () => {
  const registry = new JobRegistry();
  const tool = createJobTool(registry);
  const job = registry.start("while :; do :; done", cwd);
  try {
    const result = await tool({ action: "cancel", ids: [job.id] }, cwd);
    expect(result.success).toBe(false);
    const [settled] = await registry.awaitIds([job.id], 2500);
    expect(settled!.status).toBe("failed");
    registry.consumeMutations([job.id]);
    expect(registry.unobserved().map(record => record.id)).toContain(job.id);
    expect(registry.cancellable().map(record => record.id)).toContain(job.id);
    const retry = await tool({ action: "cancel" }, cwd);
    expect(retry.success).toBe(false);
    expect(registry.unobserved().map(record => record.id)).toContain(job.id);
  } finally {
    registry.cancelAll();
    await registry.awaitIds([job.id], 2500);
  }
}, 5000);
