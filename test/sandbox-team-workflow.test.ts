import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Message } from "../src/ai/types";
import * as loop from "../src/agent/loop";
import { currentSandboxExecution, withSandboxExecution } from "../src/agent/hooks";
import type { WorkflowState } from "../src/agent/state";
import type { SandboxExecResult, SandboxSupervisor } from "../src/agent/sandbox/types";
import { runTeamEngine } from "../src/commands/team";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const tasks = ["write alpha", "write beta"];
const verifiedTasks = [...tasks, "verify merged artifacts"];
const done = { tool: "done", arguments: { reason: "Summary: implemented\nChanged Files: artifact.txt\nVerification: checked artifact\nOpen Risks: none" } };

async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-sandbox-team-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function isolatedConfig() {
  const config = await directory();
  const previous = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = config;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previous;
  });
  await fs.writeFile(path.join(config, "config.json"), JSON.stringify({
    defaultModel: "ollama/team-regression", routing: { enabled: false },
    subagents: { executor: { model: "ollama/team-regression", maxSteps: 6 }, critic: { model: "ollama/team-regression", maxSteps: 4 } },
  }));
}

function approvedPlan(cwd: string, critic = false) {
  const content = "name: sandbox-team\nsteps:\n" + tasks.map(name =>
    `  - name: ${name}\n    parallel_group: files\n${critic ? "    role: critic\n" : ""}`,
  ).join("") + (critic ? "" : "  - name: verify merged artifacts\n    role: critic\n");
  const state: WorkflowState = {
    active: true, skill: "ralplan", current_phase: "complete", approved: true,
    slug: "mediation", plan_path: path.join(cwd, "plan.yaml"),
    consensus_hash: createHash("sha256").update(content).digest("hex"),
  };
  return { content, state };
}

function scriptedModel(critic = false) {
  const turns = new Map<string, number>();
  const model = spyOn(loop, "callLlm").mockImplementation(async (messages: Message[]) => {
    const prompt = String(messages[1]?.content ?? "");
    const name = prompt.match(/Current todo: \d+\/\d+ "([^"]+)"/)?.[1];
    if (!name || !verifiedTasks.includes(name)) throw new Error(`Unexpected delegated task: ${prompt}`);
    const turn = turns.get(name) ?? 0;
    turns.set(name, turn + 1);
    const actions = critic || name === "verify merged artifacts"
      ? [{ tool: "read", arguments: { filePath: "artifact.txt" } }, { tool: "done", arguments: { reason: "[OKAY]\nJustification: inspected the preserved artifact." } }]
      : [{ tool: "write", arguments: { filePath: "artifact.txt", content: name } }, { tool: "bash", arguments: { command: "bun test artifact.test.ts" } }, done];
    return JSON.stringify(actions[Math.min(turn, actions.length - 1)]);
  });
  cleanups.push(() => model.mockRestore());
}

interface ExecCall { argv: readonly string[]; cwd: string | undefined }
interface DelegatedCall { tool: string; args: Record<string, unknown>; cwd: string | undefined }
interface FixtureOptions {
  clean?: boolean;
  resume?: boolean;
  existing?: boolean;
  exec?: (call: ExecCall) => SandboxExecResult | undefined;
}

function execution(stdout = "", exitCode = 0, stderr = ""): SandboxExecResult {
  return { success: exitCode === 0, output: stdout, stdout, stderr, exitCode, ...(exitCode ? { error: stderr } : {}) };
}

// This fake is the external hands boundary, not a replacement for team or its
// subagent engine. Git requests and delegated tools must both cross it.
function sandboxFixture(cwd: string, options: FixtureOptions = {}) {
  const plan = approvedPlan(cwd);
  const states = new Map<string, WorkflowState>([["ralplan", plan.state]]);
  if (options.resume) states.set("team", {
    active: true, skill: "team", current_phase: "failed", failed_task: tasks[0],
    slug: plan.state.slug, plan_path: plan.state.plan_path, consensus_hash: plan.state.consensus_hash,
    completed_tasks: [], pending_tasks: [...verifiedTasks],
  });
  const execs: ExecCall[] = [];
  const calls: DelegatedCall[] = [];
  const artifacts = new Map<string, string>();
  let locked = false;
  const supervisor: SandboxSupervisor = {
    toolMap(names) {
      return Object.fromEntries(names.map(name => [name, (args: Record<string, unknown>, toolCwd: string) => this.call(name, args, { cwd: toolCwd })]));
    },
    async call(tool, args, callOptions) {
      const toolCwd = (callOptions as { cwd?: string } | undefined)?.cwd;
      calls.push({ tool, args: structuredClone(args), cwd: toolCwd });
      if (tool === "__workflow") {
        let value: unknown;
        switch (args.operation) {
          case "read": case "readStrict": value = states.get(String(args.skill)) ?? null; break;
          case "readFile": value = plan.content; break;
          case "write": {
            const state = structuredClone(args.state) as WorkflowState;
            states.set(String(args.skill), state);
            value = path.join(cwd, ".jeo", "state", `${String(args.skill)}-state.json`);
            break;
          }
          case "acquireLock":
            if (locked) throw new Error("Duplicate workflow lock");
            locked = true; value = "sandbox-team-lock"; break;
          case "releaseLock":
            if (!locked || args.token !== "sandbox-team-lock") throw new Error("Wrong workflow lock owner");
            locked = false; value = null; break;
          case "loadContext": case "discoverGuidance": value = []; break;
          case "ensureGitignore": value = null; break;
          case "memory":
            if (args.action !== "prompt") throw new Error(`Unexpected memory action ${String(args.action)}`);
            value = ""; break;
          default: throw new Error(`Unexpected workflow operation ${String(args.operation)}`);
        }
        return { success: true, output: JSON.stringify(value) };
      }
      if (tool === "write") {
        artifacts.set(String(toolCwd), String(args.content));
        return { success: true, output: "Wrote artifact.txt" };
      }
      if (tool === "read" && args.filePath === "artifact.txt") return { success: true, output: tasks.join("\n") };
      if (tool === "bash" && args.command === "bun test artifact.test.ts") return execution("1 pass\n0 fail");
      throw new Error(`Unexpected delegated tool ${tool}`);
    },
    async exec(argv, execOptions) {
      const call = { argv: [...argv], cwd: execOptions?.cwd };
      execs.push(call);
      const overridden = options.exec?.(call);
      if (overridden) return overridden;
      if (argv[0] === "test" && argv[1] === "-d") return execution("", options.existing ? 0 : 1);
      if (argv[0] === "bun" && argv[1] === "-e") return execution('{"enabled":false}');
      if (argv[0] !== "git") throw new Error(`Unexpected exec ${argv.join(" ")}`);
      if (argv[1] === "rev-parse") return execution(`${path.basename(String(execOptions?.cwd))}\n`);
      if (argv[1] === "status") return execution(options.clean ? "" : " M artifact.txt\n?? other.txt\n\n");
      if (["worktree", "add", "commit", "merge"].includes(String(argv[1]))) return execution();
      throw new Error(`Unexpected git operation ${argv.join(" ")}`);
    },
    async replacePolicy() { throw new Error("Team must not change sandbox policy"); },
    async revoke() { return { gone: true, residual: [] }; },
    async close() {},
  };
  return { supervisor, execs, calls, states, artifacts, lockHeld: () => locked };
}

function blockHostSpawns() {
  const attempted: unknown[][] = [];
  const spawn = spyOn(Bun, "spawnSync").mockImplementation((...args: unknown[]) => {
    attempted.push(args);
    throw new Error("Forbidden host spawn during sandbox team execution");
  });
  cleanups.push(() => spawn.mockRestore());
  return attempted;
}

function gitCalls(execs: ExecCall[]) { return execs.filter(call => call.argv[0] === "git"); }
function worktree(cwd: string, index: number) { return path.join(cwd, ".jeo", "team-worktrees", `mediation-${index}`); }

async function runSandbox(options: FixtureOptions = {}) {
  await isolatedConfig();
  const cwd = path.join(await directory(), "approved workspace");
  const fixture = sandboxFixture(cwd, options);
  scriptedModel();
  const host = blockHostSpawns();
  const logs: string[] = [];
  const run = () => withSandboxExecution({ supervisor: fixture.supervisor }, () => runTeamEngine({ cwd, strictMutations: true, io: { output: line => logs.push(line) } }));
  return { ...fixture, cwd, host, logs, run };
}

test("sandbox team mediates worktree creation, delegated writes, commits, ordered merges and removal at the owning cwd", async () => {
  const fixture = await runSandbox();
  expect(await fixture.run()).toEqual({ ok: true, mutationMayHaveOccurred: true });
  const { cwd } = fixture;
  const roots = [worktree(cwd, 0), worktree(cwd, 1)];
  expect(fixture.execs.filter(call => call.argv[0] === "test")).toEqual(roots.map(root => ({ argv: ["test", "-d", path.relative(cwd, root)], cwd })));
  expect(gitCalls(fixture.execs)).toEqual([
    ...roots.flatMap((root, i) => [
      { argv: ["git", "worktree", "add", "-b", `mediation-${i}`, "--", path.relative(cwd, root)], cwd },
      { argv: ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd: root },
    ]),
    ...roots.flatMap((root, i) => [
      { argv: ["git", "status", "--porcelain"], cwd: root },
      { argv: ["git", "add", "-A"], cwd: root },
      { argv: ["git", "commit", "-m", tasks[i]!], cwd: root },
    ]),
    ...roots.map((_root, i) => ({ argv: ["git", "merge", "--no-ff", `mediation-${i}`, "-m", `merge: ${tasks[i]}`], cwd })),
    ...roots.map(root => ({ argv: ["git", "worktree", "remove", path.relative(cwd, root)], cwd })),
  ]);
  expect(roots.map(root => fixture.artifacts.get(root))).toEqual(tasks);
  expect(fixture.calls.filter(call => call.tool === "bash").map(call => call.cwd).sort()).toEqual([...roots].sort());
  expect(fixture.states.get("team")).toMatchObject({ active: false, current_phase: "complete", completed_tasks: verifiedTasks, pending_tasks: [] });
  expect(fixture.lockHeld()).toBe(false);
  expect(fixture.host).toEqual([]);
  expect(await fs.readdir(path.dirname(cwd))).toEqual([]);
});

test("sandbox team counts resumed changes from sandbox status and skips commits for clean worktrees", async () => {
  const fixture = await runSandbox({ resume: true, clean: true, exec: call => call.argv[1] === "status" && call.cwd?.endsWith("approved workspace") ? execution(" M first.txt\n?? second.txt\n\n") : undefined });
  expect((await fixture.run()).ok).toBe(true);
  expect(fixture.logs.join("\n")).toContain("git reports 2 uncommitted change(s)");
  expect(gitCalls(fixture.execs).filter(call => ["add", "commit"].includes(String(call.argv[1])))).toEqual([]);
  expect(gitCalls(fixture.execs).filter(call => call.argv[1] === "merge").map(call => call.argv[3])).toEqual(["mediation-0", "mediation-1"]);
  expect(fixture.host).toEqual([]);
});

test("sandbox team reuses existing worktrees without creating replacements", async () => {
  const fixture = await runSandbox({ existing: true });
  expect((await fixture.run()).ok).toBe(true);
  expect(gitCalls(fixture.execs).filter(call => call.argv[1] === "worktree" && call.argv[2] === "add")).toEqual([]);
  expect([...fixture.artifacts.keys()].sort()).toEqual([worktree(fixture.cwd, 0), worktree(fixture.cwd, 1)].sort());
  expect(fixture.host).toEqual([]);
});

test("sandbox team retries a branch-creation failure only through sandbox worktree attach", async () => {
  const fixture = await runSandbox({ exec: call => call.argv[1] === "worktree" && call.argv.includes("-b") ? execution("", 128, "branch already exists") : undefined });
  expect((await fixture.run()).ok).toBe(true);
  expect(gitCalls(fixture.execs).filter(call => call.argv[1] === "worktree" && call.argv[2] === "add").map(call => call.argv)).toEqual([0, 1].flatMap(i => [
    ["git", "worktree", "add", "-b", `mediation-${i}`, "--", `.jeo/team-worktrees/mediation-${i}`],
    ["git", "worktree", "add", "--", `.jeo/team-worktrees/mediation-${i}`],
  ]));
  expect(fixture.host).toEqual([]);
});

const failures = [
  { name: "directory inspection", matches: (argv: readonly string[]) => argv[0] === "test", rejects: true },
  { name: "worktree creation and attach", matches: (argv: readonly string[]) => argv[1] === "worktree" && argv[2] === "add", rejects: true },
  { name: "branch lookup", matches: (argv: readonly string[]) => argv[1] === "rev-parse", rejects: true },
  { name: "dirty inspection", matches: (argv: readonly string[]) => argv[1] === "status", rejects: true },
  { name: "staging", matches: (argv: readonly string[]) => argv[1] === "add", rejects: false },
  { name: "commit", matches: (argv: readonly string[]) => argv[1] === "commit", rejects: false },
  { name: "merge", matches: (argv: readonly string[]) => argv[1] === "merge" && argv[2] !== "--abort", rejects: false },
];
for (const failure of failures) {
  test(`sandbox ${failure.name} denial halts team without host fallback or destructive worktree cleanup`, async () => {
    const error = `SANDBOX_DENIED:${failure.name}`;
    const fixture = await runSandbox({ exec: call => failure.matches(call.argv) ? execution("", 73, error) : undefined });
    if (failure.rejects) await expect(fixture.run()).rejects.toThrow(error);
    else {
      expect(await fixture.run()).toMatchObject({ ok: false, reason: `Failed on task: "${tasks[0]}"` });
      expect(fixture.states.get("team")).toMatchObject({ current_phase: "failed", failed_task: tasks[0], pending_tasks: verifiedTasks });
      expect(fixture.logs.join("\n")).toContain(error);
    }
    const commands = gitCalls(fixture.execs);
    expect(commands.filter(call => call.argv[1] === "worktree" && call.argv[2] === "remove")).toEqual([]);
    expect(commands.filter(call => call.argv[1] === "merge" && call.argv[2] !== "--abort").length).toBe(failure.name === "merge" ? 1 : 0);
    expect(commands.filter(call => call.argv[1] === "merge" && call.argv[2] === "--abort").length).toBe(failure.name === "merge" ? 1 : 0);
    expect(fixture.states.get("team")?.current_phase).not.toBe("complete");
    expect(fixture.lockHeld()).toBe(false);
    expect(fixture.host).toEqual([]);
  });
}

test("a rejected supervisor exec propagates without retrying git on the host", async () => {
  const fixture = await runSandbox({ exec: call => { if (call.argv[1] === "rev-parse") throw new Error("SANDBOX_REVOKED: session closed"); } });
  await expect(fixture.run()).rejects.toThrow("SANDBOX_REVOKED: session closed");
  expect(fixture.states.get("team")?.current_phase).not.toBe("complete");
  expect(fixture.lockHeld()).toBe(false);
  expect(fixture.host).toEqual([]);
});

test("sandbox worktree removal failure remains visible without turning successful merges into host cleanup", async () => {
  const fixture = await runSandbox({ exec: call => call.argv[1] === "worktree" && call.argv[2] === "remove" ? execution("", 73, "SANDBOX_DENIED:cleanup") : undefined });
  expect((await fixture.run()).ok).toBe(true);
  expect(fixture.logs.join("\n")).toContain("[WARN] Could not remove worktree");
  expect(fixture.logs.join("\n")).toContain("SANDBOX_DENIED:cleanup");
  expect(gitCalls(fixture.execs).filter(call => call.argv[1] === "merge").map(call => call.argv[3])).toEqual(["mediation-0", "mediation-1"]);
  expect(fixture.states.get("team")).toMatchObject({ active: false, current_phase: "complete", completed_tasks: verifiedTasks });
  expect(fixture.host).toEqual([]);
});

function nativeGit(cwd: string, argv: string[]) {
  const result = Bun.spawnSync(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

test("native team retains real git worktree helpers, preserves resumed edits and removes successful worktrees", async () => {
  await isolatedConfig();
  const cwd = await directory();
  nativeGit(cwd, ["init", "-q"]);
  nativeGit(cwd, ["config", "user.name", "Team regression"]);
  nativeGit(cwd, ["config", "user.email", "team@example.invalid"]);
  nativeGit(cwd, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(cwd, "artifact.txt"), "original\n");
  await fs.mkdir(path.join(cwd, ".jeo", "state"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".gitignore"), ".jeo/\nplan.yaml\n");
  await fs.writeFile(path.join(cwd, ".jeo", "hooks.json"), '{"enabled":false}');
  nativeGit(cwd, ["add", "-A"]);
  nativeGit(cwd, ["commit", "-qm", "initial artifact"]);
  const plan = approvedPlan(cwd, true);
  await fs.writeFile(plan.state.plan_path!, plan.content);
  await fs.writeFile(path.join(cwd, ".jeo", "state", "ralplan-state.json"), JSON.stringify(plan.state));
  await fs.writeFile(path.join(cwd, ".jeo", "state", "team-state.json"), JSON.stringify({
    ...plan.state, skill: "team", current_phase: "failed", failed_task: tasks[0], completed_tasks: [], pending_tasks: tasks,
  }));
  await fs.writeFile(path.join(cwd, "artifact.txt"), "user partial edit\n");
  scriptedModel(true);
  const previousMemory = process.env.JEO_NO_MEMORY;
  process.env.JEO_NO_MEMORY = "1";
  cleanups.push(() => { if (previousMemory === undefined) delete process.env.JEO_NO_MEMORY; else process.env.JEO_NO_MEMORY = previousMemory; });
  const logs: string[] = [];
  expect(currentSandboxExecution()).toBeUndefined();
  expect(await runTeamEngine({ cwd, io: { output: line => logs.push(line) } })).toEqual({ ok: true });
  expect(logs.join("\n")).toContain("git reports 1 uncommitted change(s)");
  expect(await fs.readFile(path.join(cwd, "artifact.txt"), "utf8")).toBe("user partial edit\n");
  expect(nativeGit(cwd, ["worktree", "list", "--porcelain"]).split("\n").filter(line => line.startsWith("worktree "))).toEqual([`worktree ${await fs.realpath(cwd)}`]);
  const state = JSON.parse(await fs.readFile(path.join(cwd, ".jeo", "state", "team-state.json"), "utf8"));
  expect(state).toMatchObject({ active: false, current_phase: "complete", completed_tasks: tasks, pending_tasks: [] });
});
