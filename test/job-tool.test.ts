import { test, expect } from "bun:test";

// ── JobRegistry ──────────────────────────────────────────────────────────────

test("registry: start then tail eventually contains stdout, and exits cleanly", async () => {
  const { JobRegistry } = await import("../src/agent/job-registry");
  const reg = new JobRegistry();
  const rec = reg.start("echo hello && sleep 0.05 && echo world", process.cwd());
  expect(rec.id).toBe("job-1");
  expect(rec.status).toBe("running");

  const [settled] = await reg.awaitIds([rec.id], 3000);
  expect(settled!.status).toBe("exited");
  expect(settled!.exitCode).toBe(0);
  const out = reg.tail(rec.id);
  expect(out).toContain("hello");
  expect(out).toContain("world");
});

test("registry: a command exiting non-zero settles exited with the correct exit code", async () => {
  const { JobRegistry } = await import("../src/agent/job-registry");
  const reg = new JobRegistry();
  const rec = reg.start("exit 7", process.cwd());
  const [settled] = await reg.awaitIds([rec.id], 3000);
  expect(settled!.status).toBe("exited");
  expect(settled!.exitCode).toBe(7);
});

test("registry: cancel on a long-running job kills it promptly", async () => {
  const { JobRegistry } = await import("../src/agent/job-registry");
  const reg = new JobRegistry();
  const rec = reg.start("sleep 5", process.cwd());
  expect(rec.status).toBe("running");
  const [cancelled] = reg.cancel([rec.id]);
  expect(cancelled!.status).toBe("killed");
  // Give the process a moment to actually die, then confirm the state sticks.
  await reg.awaitIds([rec.id], 500);
  expect(reg.get(rec.id)!.status).toBe("killed");
});

test("registry: awaitIds honours a short timeout, leaving an unfinished job running", async () => {
  const { JobRegistry } = await import("../src/agent/job-registry");
  const reg = new JobRegistry();
  const rec = reg.start("sleep 5", process.cwd());
  const snap = await reg.awaitIds([rec.id], 20);
  expect(snap[0]!.status).toBe("running");
  reg.cancelAll(); // release the process so the test exits cleanly
});

// ── job control tool ─────────────────────────────────────────────────────────

test("job tool: list shows a running job before/after start with its command", async () => {
  const { JobRegistry } = await import("../src/agent/job-registry");
  const { createJobTool } = await import("../src/agent/job-tool");
  const reg = new JobRegistry();
  const tool = createJobTool(reg);
  const cwd = process.cwd();

  let res = await tool({ action: "list" }, cwd);
  expect(res.output).toContain("No background jobs");

  res = await tool({ action: "start", command: "sleep 0.1" }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("job-1");

  res = await tool({ action: "list" }, cwd);
  expect(res.output).toContain("job-1");
  expect(res.output).toContain("sleep 0.1");

  await reg.awaitIds(["job-1"], 3000);
});

test("job tool: tail returns buffered output for a completed job", async () => {
  const { JobRegistry } = await import("../src/agent/job-registry");
  const { createJobTool } = await import("../src/agent/job-tool");
  const reg = new JobRegistry();
  const tool = createJobTool(reg);
  const cwd = process.cwd();

  await tool({ action: "start", command: "echo hi-there" }, cwd);
  await reg.awaitIds(["job-1"], 3000);

  const res = await tool({ action: "tail", ids: ["job-1"] }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("hi-there");
});

test("job tool: unknown action fails with a clear message", async () => {
  const { JobRegistry } = await import("../src/agent/job-registry");
  const { createJobTool } = await import("../src/agent/job-tool");
  const reg = new JobRegistry();
  const tool = createJobTool(reg);
  const res = await tool({ action: "bogus" }, process.cwd());
  expect(res.success).toBe(false);
  expect(res.error).toContain("Unknown job action");
});

test("job tool: start with a missing command errors", async () => {
  const { JobRegistry } = await import("../src/agent/job-registry");
  const { createJobTool } = await import("../src/agent/job-tool");
  const reg = new JobRegistry();
  const tool = createJobTool(reg);
  const res = await tool({ action: "start" }, process.cwd());
  expect(res.success).toBe(false);
  expect(res.error).toContain("requires a non-empty");
});
