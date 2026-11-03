import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as loop from "../src/agent/loop";
import { withSandboxExecution } from "../src/agent/hooks";
import { loadProjectContext, discoverAgentGuidanceFiles } from "../src/agent/context-files";
import { acquireWorkflowRunLock, clearWorkflowState, ensureJeoGitignore, readWorkflowFile, readWorkflowState, readWorkflowStateStrict, writeWorkflowFile, writeWorkflowState, type WorkflowState } from "../src/agent/state";
import { createTodoTool, type TodoItem } from "../src/agent/todo-tool";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";
import type { SandboxBackend, SandboxPolicy, SandboxProcess } from "../src/agent/sandbox/types";
import { runTeamEngine } from "../src/commands/team";
import { runUltragoalEngine } from "../src/commands/ultragoal";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-workflow-containment-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return fs.realpath(root);
}

// A real RPC worker with disjoint host/guest trees catches brain-side effects.
// It is deliberately NOT a container or an OS-isolation qualification.
async function workflowFixture() {
  const root = await directory();
  const host = path.join(root, "host");
  const guest = path.join(root, "guest");
  const outside = path.join(root, "outside");
  const config = path.join(root, "config");
  await Promise.all([host, guest, outside, config].map(dir => fs.mkdir(dir)));
  await fs.writeFile(path.join(config, "config.json"), JSON.stringify({
    defaultModel: "ollama/workflow-fixture", routing: { enabled: false },
    subagents: { executor: { model: "ollama/workflow-fixture", maxSteps: 6 }, critic: { model: "ollama/workflow-fixture", maxSteps: 4 } },
  }));
  const previous = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = config;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previous;
  });
  const policy: SandboxPolicy = {
    sessionKey: "workflow-containment", revision: 1, digest: "fixture",
    mounts: [{ host, guest, mode: "rw" }],
    config: { image: "local-fixture", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } },
  };
  const backend: SandboxBackend = {
    async preflight() { return { imageId: "sha256:" + "b".repeat(64), platform: "linux/arm64" }; },
    async launch(): Promise<SandboxProcess> {
      const child = Bun.spawn([process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../src/agent/sandbox/hands-worker.ts")], {
        cwd: guest,
        env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`, HOME: config, JEO_SANDBOX_HANDS: "1", JEO_CONFIG_DIR: config },
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      return {
        name: "workflow-rpc-fixture", stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: child.exited,
        async stop() { child.kill(); await child.exited; return { gone: true, residual: [] }; },
      };
    },
  };
  const supervisor = createSandboxSupervisor({ policy, backend, bundlePath: path.join(root, "unused.js") });
  cleanups.push(() => supervisor.close());
  const run = <T>(fn: () => T) => withSandboxExecution({ supervisor }, fn);
  return { root, host, guest, outside, supervisor, run };
}

async function stateOnDisk(cwd: string, skill: string, state: WorkflowState) {
  await fs.mkdir(path.join(cwd, ".jeo", "state"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".jeo", "state", `${skill}-state.json`), JSON.stringify(state, null, 2));
}

test("sandbox workflow state reads, writes, clearing and gitignore leave a host .jeo symlink target unchanged", async () => {
  const { host, guest, outside, run } = await workflowFixture();
  const original = { active: true, skill: "team", current_phase: "host-private", slug: "HOST-SECRET" } satisfies WorkflowState;
  await stateOnDisk(outside, "team", original);
  await fs.writeFile(path.join(outside, ".jeo", ".gitignore"), "host-private-ignore\n");
  await fs.symlink(path.join(outside, ".jeo"), path.join(host, ".jeo"));
  const before = await fs.readFile(path.join(outside, ".jeo", "state", "team-state.json"), "utf8");
  const guestState = { active: true, skill: "team", current_phase: "executing", pending_tasks: ["guest task"], completed_tasks: [] } satisfies WorkflowState;
  await stateOnDisk(guest, "team", guestState);
  await run(async () => {
    expect(await readWorkflowState("team", host)).toEqual(guestState);
    expect(await readWorkflowStateStrict("team", host)).toEqual(guestState);
    await writeWorkflowState("team", { ...guestState, active: false, current_phase: "complete", pending_tasks: [], completed_tasks: ["guest task"] }, host);
    expect(JSON.parse(await fs.readFile(path.join(guest, ".jeo", "state", "team-state.json"), "utf8"))).toMatchObject({ current_phase: "complete", completed_tasks: ["guest task"] });
    await ensureJeoGitignore(host);
    await clearWorkflowState("team", host);
    expect(await readWorkflowStateStrict("team", host)).toBeNull();
  });
  expect(await fs.readFile(path.join(guest, ".jeo", ".gitignore"), "utf8")).toBe("*\n");
  expect(await fs.readFile(path.join(outside, ".jeo", "state", "team-state.json"), "utf8")).toBe(before);
  expect(await fs.readFile(path.join(outside, ".jeo", ".gitignore"), "utf8")).toBe("host-private-ignore\n");
});

test("sandbox workflow strict reads surface guest corruption instead of trusting valid host state", async () => {
  const { host, guest, run } = await workflowFixture();
  await stateOnDisk(host, "team", { active: false, skill: "team", current_phase: "complete" });
  await fs.mkdir(path.join(guest, ".jeo", "state"), { recursive: true });
  await fs.writeFile(path.join(guest, ".jeo", "state", "team-state.json"), "{not-json");
  await run(async () => {
    await expect(readWorkflowStateStrict("team", host)).rejects.toThrow(/corrupt/);
    expect(await readWorkflowState("team", host)).toBeNull();
  });
  expect(await fs.readFile(path.join(guest, ".jeo", "state", "team-state.json"), "utf8")).toBe("{not-json");
});

test("sandbox run lock excludes a second owner and release remains guest-owned after ALS scope ends", async () => {
  const { host, guest, outside, run } = await workflowFixture();
  await fs.mkdir(path.join(outside, "state"));
  const sentinel = path.join(outside, "state", "team.lock");
  const sentinelBytes = JSON.stringify({ pid: process.pid, at: Date.now() });
  await fs.writeFile(sentinel, sentinelBytes);
  await fs.symlink(outside, path.join(host, ".jeo"));
  const release = await run(() => acquireWorkflowRunLock("team", host));
  cleanups.push(release);
  const lockPath = path.join(guest, ".jeo", "state", "team.lock");
  const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
  expect(owner.pid).not.toBe(process.pid);
  await run(() => expect(acquireWorkflowRunLock("team", host)).rejects.toThrow(/another 'jeo team' run/));
  expect(JSON.parse(await fs.readFile(lockPath, "utf8")).pid).toBe(owner.pid);
  await release();
  await release();
  expect(await fs.readdir(path.dirname(lockPath))).not.toContain("team.lock");
  const nextRelease = await run(() => acquireWorkflowRunLock("team", host));
  cleanups.push(nextRelease);
  await nextRelease();
  expect(await fs.readFile(sentinel, "utf8")).toBe(sentinelBytes);
});

test("sandbox workflow file transport preserves exact large unicode bytes without reading or overwriting host file symlinks", async () => {
  const { host, guest, outside, run } = await workflowFixture();
  const sentinel = path.join(outside, "private-plan.yaml");
  await fs.writeFile(sentinel, "HOST-PRIVATE-PLAN\n");
  await fs.symlink(sentinel, path.join(host, "plan.yaml"));
  const content = "# reviewed plan\r\n" + "한글 λ \"quoted\" \\ path\r\n".repeat(6000) + "# exact trailing bytes\n";
  await fs.writeFile(path.join(guest, "plan.yaml"), content);
  await run(async () => {
    expect(await readWorkflowFile(path.join(host, "plan.yaml"), host)).toBe(content);
    const replacement = content + "# verified update\n";
    await writeWorkflowFile(path.join(host, "plan.yaml"), replacement, host);
    expect(await readWorkflowFile("plan.yaml", host)).toBe(replacement);
    expect(await fs.readFile(path.join(guest, "plan.yaml"), "utf8")).toBe(replacement);
  });
  expect(await fs.readFile(sentinel, "utf8")).toBe("HOST-PRIVATE-PLAN\n");
});

test("sandbox context and guidance consume guest content while todo denial cannot publish a host-normalized plan", async () => {
  const { host, guest, outside, supervisor, run } = await workflowFixture();
  await fs.writeFile(path.join(outside, "secret.md"), "HOST-CONTEXT-SECRET");
  await fs.symlink(path.join(outside, "secret.md"), path.join(host, "JEO.md"));
  await fs.writeFile(path.join(guest, "JEO.md"), "Approved guest project context\n");
  await fs.mkdir(path.join(guest, ".jeo", "rules"), { recursive: true });
  await fs.writeFile(path.join(guest, ".jeo", "rules", "scope.md"), "Only the guest workspace is authorized.\n");
  const published: TodoItem[][] = [];
  const todo = createTodoTool({ onChange: items => published.push(structuredClone(items)) });
  await run(async () => {
    const context = await loadProjectContext(host);
    expect(context.find(item => item.path === "JEO.md")?.content).toBe("Approved guest project context\n");
    expect(JSON.stringify(context)).not.toContain("HOST-CONTEXT-SECRET");
    expect(await discoverAgentGuidanceFiles(host)).toContainEqual({ filePath: path.join(guest, ".jeo", "rules", "scope.md"), displayPath: ".jeo/rules/scope.md" });
    expect(context.find(item => item.path === ".jeo/rules/scope.md")?.content).toBe("Only the guest workspace is authorized.\n");
    const result = await todo({ todos: [{ title: "inspect", status: "completed" }, { title: "verify", status: "pending" }] }, host);
    expect(result).toEqual({ success: true, output: "Plan updated (1/2 done):\n  [x] inspect\n  [>] verify" });
  });
  expect(published).toEqual([[{ title: "inspect", status: "done" }, { title: "verify", status: "in_progress" }]]);
  await supervisor.revoke();
  const denied = await run(() => todo({ items: ["must never publish"] }, host));
  expect(denied.success).toBe(false);
  expect(denied.error).toContain("SANDBOX_REVOKED");
  expect(published).toHaveLength(1);
  expect(await fs.readFile(path.join(outside, "secret.md"), "utf8")).toBe("HOST-CONTEXT-SECRET");
});

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`Fixture git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

test("sandbox team delegates cwd and git effects to the guest repository and releases its real run lock", async () => {
  const { host, guest, run } = await workflowFixture();
  for (const [cwd, branch] of [[host, "host-private"], [guest, "guest-authorized"]] as const) {
    await git(cwd, "init", "-b", branch);
    await git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  }
  await fs.writeFile(path.join(host, "delegated.txt"), "host sentinel\n");
  await fs.writeFile(path.join(guest, "delegated-proof.test.ts"), `import { test, expect } from 'bun:test'; test('delegated repository evidence', async () => { expect(await Bun.file('delegated.txt').text()).toBe(${JSON.stringify(`guest-authorized\n${guest}\n`)}); });\n`);
  const content = "name: guest-plan\nsteps:\n  - name: inspect delegated repository\n  - name: verify delegated evidence\n    role: critic\n";
  await fs.writeFile(path.join(guest, "plan.yaml"), content);
  await stateOnDisk(guest, "ralplan", {
    active: false, skill: "ralplan", current_phase: "complete", approved: true, slug: "guest-plan",
    plan_path: path.join(host, "plan.yaml"), consensus_hash: createHash("sha256").update(content).digest("hex"),
  });
  let turn = 0;
  const actions = [
    { tool: "bash", arguments: { command: "git branch --show-current > delegated.txt; pwd >> delegated.txt" } },
    { tool: "bash", arguments: { command: "bun test delegated-proof.test.ts" } },
    { tool: "done", arguments: { reason: "Summary: inspected guest repository\nChanged Files: delegated.txt\nVerification: branch and cwd recorded\nOpen Risks: none" } },
    { tool: "read", arguments: { filePath: "delegated.txt" } },
    { tool: "done", arguments: { reason: "[OKAY]\nJustification: inspected delegated branch and cwd evidence." } },
  ];
  const model = spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(actions[Math.min(turn++, actions.length - 1)]));
  cleanups.push(() => model.mockRestore());
  const logs: string[] = [];
  const result = await run(() => runTeamEngine({ cwd: host, strictMutations: true, io: { output: line => logs.push(line) } }));
  if (!result.ok) throw new Error(`Delegated workflow failed: ${result.reason}\n${logs.join("\n")}`);
  expect(result.ok).toBe(true);
  expect(await fs.readFile(path.join(guest, "delegated.txt"), "utf8")).toBe(`guest-authorized\n${guest}\n`);
  expect(await fs.readFile(path.join(host, "delegated.txt"), "utf8")).toBe("host sentinel\n");
  expect(JSON.parse(await fs.readFile(path.join(guest, ".jeo", "state", "team-state.json"), "utf8"))).toMatchObject({ current_phase: "complete", completed_tasks: ["inspect delegated repository", "verify delegated evidence"], pending_tasks: [] });
  expect(await fs.readdir(path.join(guest, ".jeo", "state"))).not.toContain("team.lock");
  expect(await fs.readdir(host)).not.toContain(".jeo");
});

test("sandbox ultragoal acceptance commands execute through hands and report the actual guest verdict", async () => {
  const { host, guest, run } = await workflowFixture();
  await fs.writeFile(path.join(host, "acceptance.txt"), "host sentinel\n");
  await fs.writeFile(path.join(guest, "acceptance.txt"), "guest source\n");
  await fs.writeFile(path.join(guest, "proof.test.ts"), "import { test, expect } from 'bun:test'; test('fixture artifact', async () => { expect(await Bun.file('acceptance.txt').text()).toBe('guest source\\n'); });\n");
  const command = "printf 'guest verified\\n' > acceptance.txt";
  await fs.writeFile(path.join(guest, "seed.yaml"), `acceptance_criteria:\n  - ${JSON.stringify(`Writes guest proof {verify: ${command}}`)}\n`);
  await stateOnDisk(guest, "deep-interview", { active: false, skill: "deep-interview", current_phase: "complete", slug: "guest-proof", seed_path: path.join(host, "seed.yaml") });
  await stateOnDisk(guest, "team", { active: false, skill: "team", current_phase: "complete" });
  expect(await run(() => runUltragoalEngine({ cwd: host, io: { output() {} } }))).toEqual({ ok: true });
  expect(await fs.readFile(path.join(guest, "acceptance.txt"), "utf8")).toBe("guest verified\n");
  expect(await fs.readFile(path.join(host, "acceptance.txt"), "utf8")).toBe("host sentinel\n");
  const state = JSON.parse(await fs.readFile(path.join(guest, ".jeo", "state", "ultragoal-state.json"), "utf8"));
  expect(state).toMatchObject({ status: "SUCCESS", suite_green: true, passed: 1, total: 1 });
  const report = await fs.readFile(path.join(guest, ".jeo", "state", "ultragoal-report.md"), "utf8");
  expect(report).toContain("1 criteria (1 verified, 0 unverified, 0 failed)");
  expect(report).toMatch(/Writes guest proof \| .*PASSED/);
  expect(await fs.readdir(host)).toEqual(["acceptance.txt"]);

  await fs.writeFile(path.join(guest, "acceptance.txt"), "guest source\n");
  await fs.writeFile(path.join(guest, "seed.yaml"), `acceptance_criteria:\n  - ${JSON.stringify("Rejects a failing proof {verify: printf 'guest failed\\n' > acceptance.txt; exit 7}")}\n`);
  expect(await run(() => runUltragoalEngine({ cwd: host, io: { output() {} } }))).toEqual({ ok: false });
  expect(await fs.readFile(path.join(guest, "acceptance.txt"), "utf8")).toBe("guest failed\n");
  expect(await fs.readFile(path.join(host, "acceptance.txt"), "utf8")).toBe("host sentinel\n");
  expect(JSON.parse(await fs.readFile(path.join(guest, ".jeo", "state", "ultragoal-state.json"), "utf8"))).toMatchObject({ status: "FAILED", suite_green: true, passed: 0, total: 1 });
  expect(await fs.readFile(path.join(guest, ".jeo", "state", "ultragoal-report.md"), "utf8")).toContain("1 criteria (0 verified, 0 unverified, 1 failed)");
});

test("sandbox context rejects malformed successful RPC payloads instead of exposing host context", async () => {
  const { host, supervisor, run } = await workflowFixture();
  await fs.writeFile(path.join(host, "JEO.md"), "HOST-PRIVATE-CONTEXT\n");
  const response = spyOn(supervisor, "call");
  cleanups.push(() => response.mockRestore());
  for (const malformed of [null, {}, [null], [{ path: "JEO.md", content: 7 }]]) {
    response.mockResolvedValue({ success: true, output: JSON.stringify(malformed) });
    await run(() => expect(loadProjectContext(host)).rejects.toThrow("SANDBOX_CONTEXT: invalid guest response"));
  }
  response.mockResolvedValue({ success: true, output: JSON.stringify([{ filePath: "scope.md", displayPath: false }]) });
  await run(() => expect(discoverAgentGuidanceFiles(host)).rejects.toThrow("SANDBOX_CONTEXT: invalid guest response"));
  expect(await fs.readFile(path.join(host, "JEO.md"), "utf8")).toBe("HOST-PRIVATE-CONTEXT\n");
});

test("sandbox todo rejects malformed guest plans and strips untrusted result attachments before returning model output", async () => {
  const { host, supervisor, run } = await workflowFixture();
  const published: TodoItem[][] = [];
  const todo = createTodoTool({ onChange: items => published.push(structuredClone(items)) });
  const response = spyOn(supervisor, "call");
  cleanups.push(() => response.mockRestore());
  response.mockResolvedValue({ success: true, output: JSON.stringify({ result: { success: true, output: "invalid plan" }, todos: [{ title: "not canonical", status: "intruder" }] }) });
  await run(() => expect(todo({ items: ["local input must not replace guest validation"] }, host)).rejects.toThrow("SANDBOX_TODO: invalid guest response"));
  expect(published).toEqual([]);
  response.mockResolvedValue({ success: true, output: JSON.stringify({
    result: { success: true, output: "Approved guest checklist", images: [{ path: "/host/private.png" }], mutationMayHaveOccurred: true, unauthorized: "do not surface" },
    todos: [{ title: "Guest-reviewed task", status: "done" }],
  }) });
  expect(await run(() => todo({ items: ["different brain-side input"] }, host))).toEqual({ success: true, output: "Approved guest checklist" });
  expect(published).toEqual([[{ title: "Guest-reviewed task", status: "done" }]]);
});
