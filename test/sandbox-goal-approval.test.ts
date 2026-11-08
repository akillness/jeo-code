import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { clearGoalState, GoalStateCorruptError, readGoalFile, readGoalState, writeGoalState, type GoalState } from "../src/agent/goal-verifier";
import { withSandboxExecution } from "../src/agent/hooks";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";
import type { SandboxBackend, SandboxPolicy, SandboxProcess } from "../src/agent/sandbox/types";
import type { WorkflowState } from "../src/agent/state";
import { approvePlan, inspectApprovalPath } from "../src/commands/approve";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-goal-approval-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return fs.realpath(root);
}

const reviewedPlan = 'steps:\n  - name: "Implement the guest change"\n    role: executor\n  - name: "Verify the guest change"\n    role: critic\n';
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const goalPath = (cwd: string) => path.join(cwd, ".jeo", "state", "goal.json");
const workflowPath = (cwd: string) => path.join(cwd, ".jeo", "state", "ralplan-state.json");

async function writeFile(file: string, bytes: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, "utf8");
}

async function reviewedState(cwd: string, planPath: string, bytes: string, changes: Partial<WorkflowState> = {}) {
  const state: WorkflowState = {
    active: false, skill: "ralplan", current_phase: "complete", plan_path: planPath,
    approved: false, consensus: "okay", consensus_hash: hash(bytes), ...changes,
  };
  await writeFile(workflowPath(cwd), JSON.stringify(state, null, 2));
  return state;
}

// Real hands RPC with deliberately disjoint trees catches parent filesystem access.
// This is transport/authority regression coverage, not proof of OS-native isolation.
async function fixture() {
  const root = await directory();
  const host = path.join(root, "host");
  const guest = path.join(root, "guest");
  const outside = path.join(root, "private");
  const parentConfig = path.join(root, "parent-config");
  const guestConfig = path.join(root, "guest-config");
  await Promise.all([host, guest, outside, parentConfig, guestConfig].map(dir => fs.mkdir(dir)));
  await fs.writeFile(path.join(parentConfig, "config.json"), JSON.stringify({
    defaultModel: "ollama/fixture-no-provider",
    subagents: { parent_reviewer: { title: "Parent-only reviewer", readOnly: true } },
  }));
  await fs.writeFile(path.join(guestConfig, "config.json"), JSON.stringify({
    defaultModel: "ollama/fixture-no-provider",
    subagents: { guest_only_role: { title: "Guest-only untrusted role", readOnly: true } },
  }));
  const previousConfig = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = parentConfig;
  cleanups.push(() => {
    if (previousConfig === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previousConfig;
  });
  await fs.mkdir(path.join(outside, ".jeo", "state"), { recursive: true });
  await fs.symlink(path.join(outside, ".jeo"), path.join(host, ".jeo"));
  const policy: SandboxPolicy = {
    sessionKey: "goal-approval-fixture", revision: 1, digest: "fixture",
    mounts: [{ host, guest, mode: "rw" }],
    config: { image: "local-fixture", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } },
  };
  const backend: SandboxBackend = {
    async preflight() { return { imageId: "sha256:" + "b".repeat(64), platform: "linux/arm64" }; },
    async launch(): Promise<SandboxProcess> {
      const child = Bun.spawn([process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../src/agent/sandbox/hands-worker.ts")], {
        cwd: guest,
        env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`, HOME: guestConfig, JEO_CONFIG_DIR: guestConfig, JEO_SANDBOX_HANDS: "1" },
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      return {
        name: "goal-approval-rpc-fixture", stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: child.exited,
        async stop() { child.kill(); await child.exited; return { gone: true, residual: [] }; },
      };
    },
  };
  const supervisor = createSandboxSupervisor({ policy, backend, bundlePath: path.join(root, "unused.js") });
  cleanups.push(() => supervisor.close());
  const run = <T>(fn: () => T) => withSandboxExecution({ supervisor }, fn);
  return { host, guest, outside, run, supervisor };
}

test("sandbox goal read, replacement and clear use guest files without touching a host-private .jeo symlink", async () => {
  const { host, guest, outside, run } = await fixture();
  const sentinel = JSON.stringify({ condition: "HOST-PRIVATE-GOAL", setAt: 11, verdicts: [] });
  await writeFile(goalPath(outside), sentinel);
  await run(async () => {
    expect(await readGoalFile(host)).toBeNull();
    expect(await readGoalState(host)).toBeNull();
    const guestState: GoalState = {
      condition: "Complete and verify the guest change λ", setAt: 21,
      verdicts: [{ at: 22, verdict: "NOT_MET", gap: "Fresh verification required" }],
      pendingMutationVerification: true,
    };
    await writeFile(goalPath(guest), JSON.stringify(guestState));
    expect(await readGoalState(host)).toEqual(guestState);
    await writeGoalState({ ...guestState, verdicts: [{ at: 23, verdict: "MET", gap: "Guest tests passed" }], pendingMutationVerification: false }, host);
    expect(JSON.parse(await fs.readFile(goalPath(guest), "utf8"))).toEqual({
      ...guestState, verdicts: [{ at: 23, verdict: "MET", gap: "Guest tests passed" }], pendingMutationVerification: false,
    });
    expect(await fs.readFile(goalPath(outside), "utf8")).toBe(sentinel);
    await clearGoalState(host);
    await expect(fs.stat(goalPath(guest))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readGoalState(host)).toBeNull();
    await clearGoalState(host);
  });
  expect(await fs.readFile(goalPath(outside), "utf8")).toBe(sentinel);
});

for (const corrupt of [
  { name: "malformed JSON", bytes: '{"condition":', error: "malformed JSON" },
  { name: "invalid required fields", bytes: JSON.stringify({ condition: "guest goal", setAt: "yesterday", verdicts: [] }), error: "invalid required fields" },
  { name: "invalid verdict", bytes: JSON.stringify({ condition: "guest goal", setAt: 1, verdicts: [{ at: 2, verdict: "MAYBE" }] }), error: "invalid verdict entry" },
]) {
  test(`sandbox goal preserves parent corruption classification for guest ${corrupt.name}`, async () => {
    const { host, guest, outside, run } = await fixture();
    const sentinel = JSON.stringify({ condition: "Valid host state must not hide guest corruption", setAt: 1, verdicts: [] });
    await writeFile(goalPath(outside), sentinel);
    await writeFile(goalPath(guest), corrupt.bytes);
    await run(async () => {
      expect(await readGoalFile(host)).toBe(corrupt.bytes);
      const error = await readGoalState(host).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(GoalStateCorruptError);
      if (!(error instanceof GoalStateCorruptError)) throw new Error("Expected parent-classified goal corruption");
      expect(error.name).toBe("GoalStateCorruptError");
      expect(error.message).toContain(corrupt.error);
      expect(error.message).toContain(goalPath(host));
    });
    expect(await fs.readFile(goalPath(guest), "utf8")).toBe(corrupt.bytes);
    expect(await fs.readFile(goalPath(outside), "utf8")).toBe(sentinel);
  });
}

test("sandbox approval resolves guest aliases, hashes exact guest bytes and uses parent role configuration", async () => {
  const { host, guest, outside, run } = await fixture();
  const bytes = "# Reviewed 한글 λ \\\r\n".repeat(6000) + reviewedPlan.replace("role: executor", "role: parent_reviewer").replaceAll("\n", "\r\n") + "# exact trailing bytes\r\n";
  await fs.writeFile(path.join(outside, "private-plan.yaml"), "HOST-PRIVATE-PLAN\n");
  await fs.writeFile(path.join(outside, "other-plan.yaml"), "HOST-OTHER-PLAN\n");
  await fs.symlink(path.join(outside, "private-plan.yaml"), path.join(host, "actual.yaml"));
  await fs.symlink(path.join(outside, "other-plan.yaml"), path.join(host, "alias.yaml"));
  await fs.writeFile(path.join(guest, "actual.yaml"), bytes);
  await fs.symlink("actual.yaml", path.join(guest, "alias.yaml"));
  const originalState = await reviewedState(guest, path.join(host, "actual.yaml"), bytes);
  const privateState = await reviewedState(outside, path.join(host, "actual.yaml"), "HOST-PRIVATE-PLAN\n");
  await run(async () => {
    expect(await inspectApprovalPath("alias.yaml", host)).toEqual({ exists: true, canonical: path.join(guest, "actual.yaml") });
    expect(await approvePlan("alias.yaml", host)).toEqual({ ok: true, message: "[SUCCESS] Plan approved successfully." });
    expect(await approvePlan(path.join(host, "actual.yaml"), host)).toEqual({ ok: true, message: "[SUCCESS] Plan is already approved." });
  });
  expect(JSON.parse(await fs.readFile(workflowPath(guest), "utf8"))).toEqual({ ...originalState, approved: true, next_action: "jeo team", source_hash: hash(""), source_paths: [] });
  expect(JSON.parse(await fs.readFile(workflowPath(outside), "utf8"))).toEqual(privateState);
  expect(await fs.readFile(path.join(outside, "private-plan.yaml"), "utf8")).toBe("HOST-PRIVATE-PLAN\n");
  expect(await fs.readFile(path.join(outside, "other-plan.yaml"), "utf8")).toBe("HOST-OTHER-PLAN\n");
  expect(await fs.readFile(path.join(guest, "actual.yaml"), "utf8")).toBe(bytes);
});

test("sandbox approval rejects guest absence and canonical mismatch even when host paths exist and match", async () => {
  const { host, guest, outside, run } = await fixture();
  const privatePlan = path.join(outside, "private-plan.yaml");
  await fs.writeFile(privatePlan, reviewedPlan);
  await fs.symlink(privatePlan, path.join(host, "plan.yaml"));
  await fs.symlink(privatePlan, path.join(host, "alias.yaml"));
  const state = await reviewedState(guest, path.join(host, "plan.yaml"), reviewedPlan);
  await run(async () => {
    expect(await inspectApprovalPath("plan.yaml", host)).toEqual({ exists: false, canonical: path.join(guest, "plan.yaml") });
    const missing = await approvePlan("plan.yaml", host);
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("Plan file not found");
    await fs.writeFile(path.join(guest, "plan.yaml"), reviewedPlan);
    await fs.writeFile(path.join(guest, "other.yaml"), reviewedPlan);
    await fs.symlink("other.yaml", path.join(guest, "alias.yaml"));
    const mismatch = await approvePlan("alias.yaml", host);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toContain("Provided plan path does not match");
  });
  expect(JSON.parse(await fs.readFile(workflowPath(guest), "utf8"))).toEqual(state);
  expect(await fs.readFile(privatePlan, "utf8")).toBe(reviewedPlan);
});

for (const gate of [
  { name: "schema", bytes: "steps: []\n", changes: {}, message: "not in the shape 'jeo team' executes" },
  { name: "maker without independent verifier", bytes: 'steps:\n  - name: "Implement"\n    role: executor\n', changes: {}, message: "unverified mutation" },
  { name: "guest-only role", bytes: reviewedPlan.replace("role: executor", "role: guest_only_role"), changes: {}, message: "unknown subagent role(s): guest_only_role" },
  { name: "rejected consensus", bytes: reviewedPlan, changes: { consensus: "reject" }, message: "lacks an [OKAY] consensus verdict" },
  { name: "missing review hash", bytes: reviewedPlan, changes: { consensus_hash: undefined }, message: "lacks a consensus review hash" },
  { name: "changed bytes", bytes: reviewedPlan + "# unreviewed edit\n", changes: { consensus_hash: hash(reviewedPlan) }, message: "modified since the consensus critic reviewed it" },
  { name: "changed already-approved bytes", bytes: reviewedPlan + "# unreviewed edit\n", changes: { approved: true, consensus_hash: hash(reviewedPlan) }, message: "modified since the consensus critic reviewed it" },
]) {
  test(`sandbox approval keeps the parent ${gate.name} quality gate`, async () => {
    const { host, guest, outside, run } = await fixture();
    const privatePlan = path.join(outside, "private-plan.yaml");
    await fs.writeFile(privatePlan, reviewedPlan);
    await fs.symlink(privatePlan, path.join(host, "plan.yaml"));
    await fs.writeFile(path.join(guest, "plan.yaml"), gate.bytes);
    const guestState = await reviewedState(guest, path.join(host, "plan.yaml"), gate.bytes, gate.changes);
    const privateState = await reviewedState(outside, path.join(host, "plan.yaml"), reviewedPlan);
    const result = await run(() => approvePlan("plan.yaml", host));
    expect(result.ok).toBe(false);
    expect(result.message).toContain(gate.message);
    expect(JSON.parse(await fs.readFile(workflowPath(guest), "utf8"))).toEqual(JSON.parse(JSON.stringify(guestState)));
    expect(JSON.parse(await fs.readFile(workflowPath(outside), "utf8"))).toEqual(privateState);
    expect(await fs.readFile(privatePlan, "utf8")).toBe(reviewedPlan);
  });
}

test("ordinary nonsandbox goal persistence and canonical plan approval remain usable", async () => {
  const cwd = await directory();
  await fs.writeFile(path.join(cwd, "config.json"), JSON.stringify({ defaultModel: "ollama/fixture-no-provider" }));
  const previousConfig = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = cwd;
  cleanups.push(() => {
    if (previousConfig === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previousConfig;
  });
  const goal: GoalState = { condition: "Verify ordinary workspace", setAt: 41, verdicts: [{ at: 42, verdict: "NOT_MET", gap: "pending" }] };
  await writeGoalState(goal, cwd);
  expect(JSON.parse(await fs.readFile(goalPath(cwd), "utf8"))).toEqual(goal);
  expect(await readGoalState(cwd)).toEqual(goal);
  await clearGoalState(cwd);
  await expect(fs.stat(goalPath(cwd))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(goalPath(cwd), "{broken");
  await expect(readGoalState(cwd)).rejects.toBeInstanceOf(GoalStateCorruptError);
  await fs.writeFile(path.join(cwd, "plan.yaml"), reviewedPlan);
  await fs.symlink("plan.yaml", path.join(cwd, "alias.yaml"));
  const state = await reviewedState(cwd, path.join(cwd, "plan.yaml"), reviewedPlan);
  expect(await approvePlan("alias.yaml", cwd)).toEqual({ ok: true, message: "[SUCCESS] Plan approved successfully." });
  expect(JSON.parse(await fs.readFile(workflowPath(cwd), "utf8"))).toEqual({ ...state, approved: true, next_action: "jeo team", source_hash: hash(""), source_paths: [] });
});
