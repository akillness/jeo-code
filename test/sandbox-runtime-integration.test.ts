import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prepareHandsBundle } from "../src/agent/sandbox/bundle";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";
import type { SandboxBackend, SandboxExecResult, SandboxPolicy, SandboxProcess, SandboxSupervisor } from "../src/agent/sandbox/types";
import { DEFAULT_TOOLS, runAgentLoop } from "../src/agent/engine";
import { createEvalTool } from "../src/agent/eval-tool";
import { runPostImplementationHooks, runPostTurnHooks, runPreToolHooks, withSandboxExecution } from "../src/agent/hooks";
import { createTaskTool } from "../src/agent/task-tool";
import * as loop from "../src/agent/loop";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-runtime-integration-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return await fs.realpath(root);
}
async function configDirectory() {
  const root = await directory();
  const previous = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = root;
  cleanups.push(() => { if (previous === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = previous; });
  return root;
}

// Real worker subprocess exercises RPC and cwd behavior; this is not an OS-isolation qualification.
async function runtimeFixture() {
  const root = await directory();
  const host = path.join(root, "host");
  const guest = path.join(root, "guest");
  await Promise.all([fs.mkdir(path.join(host, "nested"), { recursive: true }), fs.mkdir(path.join(guest, "nested"), { recursive: true })]);
  const policy: SandboxPolicy = { sessionKey: "cwd-integration", revision: 1, digest: "fixture", mounts: [{ host, guest, mode: "rw" }], config: { image: "local-test-image", limits: { memoryBytes: 268435456, pids: 32, cpus: 1 } } };
  const backend: SandboxBackend = {
    async preflight() { return { imageId: "sha256:" + "a".repeat(64), platform: "linux/arm64" }; },
    async launch(): Promise<SandboxProcess> {
      const child = Bun.spawn([process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../src/agent/sandbox/hands-worker.ts")], {
        cwd: guest, env: { PATH: process.env.PATH ?? "", JEO_SANDBOX_HANDS: "1", JEO_CONFIG_DIR: path.join(root, "worker-config") }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      return { name: "test-hands-subprocess", stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: child.exited,
        async stop() { child.kill(); await child.exited; return { gone: true, residual: [] }; } };
    },
  };
  const supervisor = createSandboxSupervisor({ policy, backend, bundlePath: path.join(root, "unused-bundle.js") });
  cleanups.push(() => supervisor.close());
  return { host, guest, supervisor };
}

function denyingSupervisor(label: string): SandboxSupervisor {
  const denied = (): SandboxExecResult => ({ success: false, output: "", error: `SANDBOX_DENIED:${label}`, exitCode: 73, stdout: "", stderr: `SANDBOX_DENIED:${label}` });
  return {
    toolMap(names) { return Object.fromEntries(names.map(name => [name, (args: Record<string, unknown>, cwd: string) => this.call(name, args, { cwd })])); },
    async call() { return denied(); }, async exec(argv) { return argv[0] === "bun" ? { success: true, output: "{}", stdout: "{}", exitCode: 0 } : denied(); },
    async replacePolicy() {}, async revoke() { return { gone: true, residual: [] }; }, async close() {},
  };
}

test("bundle publication: concurrent callers receive complete content-addressed bytes without replacing an existing bundle", async () => {
  await configDirectory();
  const paths = await Promise.all(Array.from({ length: 32 }, () => prepareHandsBundle()));
  expect(new Set(paths).size).toBe(1);
  const file = paths[0]!;
  const bytes = await fs.readFile(file);
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  expect(path.basename(file)).toBe(`${digest}.js`);
  const before = await fs.stat(file);
  await Promise.all(Array.from({ length: 8 }, () => prepareHandsBundle()));
  expect(await fs.readFile(file)).toEqual(bytes);
  expect((await fs.stat(file)).ino).toBe(before.ino);
}, process.platform === "win32" ? 30_000 : 5000);

test("bundle publication: altered trusted bytes fail closed rather than being silently overwritten", async () => {
  await configDirectory();
  const file = await prepareHandsBundle();
  await fs.chmod(file, 0o600);
  await fs.writeFile(file, "throw new Error('tampered runtime');\n");
  await expect(prepareHandsBundle()).rejects.toThrow(/SANDBOX_BUNDLE/);
  expect(await fs.readFile(file, "utf8")).toBe("throw new Error('tampered runtime');\n");
});

test.skipIf(process.platform === "win32")("bundle publication: a symlink at the trusted digest is rejected without modifying its target", async () => {
  const root = await configDirectory();
  const file = await prepareHandsBundle();
  const victim = path.join(root, "victim");
  await fs.writeFile(victim, "do not execute or replace");
  await fs.unlink(file);
  await fs.symlink(victim, file);
  await expect(prepareHandsBundle()).rejects.toThrow();
  expect(await fs.readFile(victim, "utf8")).toBe("do not execute or replace");
});

for (const entry of ["toolMap", "defaultTools"] as const) test(`tool cwd: ${entry} relative effects follow the caller's mapped nested directory`, async () => {
  const { host, guest, supervisor } = await runtimeFixture();
  const result = await withSandboxExecution({ supervisor }, () => (entry === "toolMap" ? supervisor.toolMap(["write"]).write! : DEFAULT_TOOLS.write!)({ filePath: "result.txt", content: "nested guest bytes" }, path.join(host, "nested")));
  expect(result.success).toBe(true);
  expect(await fs.readFile(path.join(guest, "nested", "result.txt"), "utf8")).toBe("nested guest bytes");
  expect(await fs.readdir(host)).toEqual(["nested"]);
  expect(await fs.readdir(path.join(host, "nested"))).toEqual([]);
});

test("tool cwd: direct eval calls resolve relative filesystem access in the requested hands directory", async () => {
  const { host, guest, supervisor } = await runtimeFixture();
  await fs.writeFile(path.join(guest, "nested", "input.txt"), "guest nested input");
  const result = await supervisor.call("eval", { code: "return await Bun.file('input.txt').text();" }, { cwd: path.join(host, "nested") });
  expect(result.success).toBe(true);
  expect(result.output).toBe("guest nested input");
  await fs.mkdir(path.join(guest, "other"));
  await fs.writeFile(path.join(guest, "other", "input.txt"), "second cwd input");
  const next = await supervisor.call("eval", { code: "return await Bun.file('input.txt').text();" }, { cwd: path.join(host, "other") });
  expect(next.success).toBe(true);
  expect(next.output).toBe("second cwd input");
});

test("sandbox execution scopes keep overlapping tool denials session-local and never execute host writes", async () => {
  const root = await directory();
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = withSandboxExecution({ supervisor: denyingSupervisor("first") }, async () => {
    ready.resolve(); await release.promise;
    return DEFAULT_TOOLS.write!({ filePath: path.join(root, "first"), content: "host leak" }, root);
  });
  await ready.promise;
  const second = await withSandboxExecution({ supervisor: denyingSupervisor("second") }, () => DEFAULT_TOOLS.write!({ filePath: path.join(root, "second"), content: "host leak" }, root));
  release.resolve();
  expect((await first).error).toBe("SANDBOX_DENIED:first");
  expect(second.error).toBe("SANDBOX_DENIED:second");
  expect(await fs.readdir(root)).toEqual([]);
});

test("sandbox eval denial is returned without running model-authored JavaScript on the host", async () => {
  const root = await directory();
  const marker = path.join(root, "host-eval-leak");
  const tool = createEvalTool({ config: { defaultModel: "ollama/test", subagents: {} } });
  const result = await withSandboxExecution({ supervisor: denyingSupervisor("eval") }, () => tool({ code: `await Bun.write(${JSON.stringify(marker)}, 'host leak'); return 'escaped';` }, root));
  expect(result).toEqual({ success: false, output: "", error: "SANDBOX_DENIED:eval", exitCode: 73, stdout: "", stderr: "SANDBOX_DENIED:eval" });
  expect(await fs.readdir(root)).toEqual([]);
});

test("sandbox hooks preserve veto and diagnostics without running writable project commands on the host", async () => {
  const root = await configDirectory();
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  const marker = path.join(cwd, "host-hook-leak");
  const run = `printf escaped > ${JSON.stringify(marker)}`;
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ defaultModel: "ollama/test", providers: {}, hooks: { enabled: true, hooks: [{ event: "pre-tool", run }, { event: "post-turn", run }, { event: "post-implementation", run }] } }));
  const supervisor = denyingSupervisor("hook");
  supervisor.exec = async argv => argv[0] === "bun"
    ? { success: true, output: "{}", stdout: "{}", exitCode: 0 }
    : { success: false, output: "sandbox denied project hook", error: "SANDBOX_DENIED:hook", exitCode: 73 };
  await withSandboxExecution({ supervisor }, async () => {
    const pre = await runPreToolHooks(cwd, "write", { filePath: "x" });
    expect(pre.vetoed).toBe(true);
    expect(pre.error).toContain("73");
    const post = await runPostTurnHooks(cwd, "write", { filePath: "x" }, true, "written");
    expect(post.diags).toEqual([{ run, exitCode: 73, output: "sandbox denied project hook" }]);
    expect(post.ran).toBe(1);
    const implementation = await runPostImplementationHooks(cwd, "build it");
    expect(implementation.success).toBe(false);
  });
  expect(await fs.readdir(cwd)).toEqual([]);
});

test.skipIf(process.platform === "win32")("sandbox hooks deliver each event payload over stdin and apply relative effects in the mapped guest cwd", async () => {
  const root = await configDirectory();
  const { host, guest, supervisor } = await runtimeFixture();
  const code = "const payload = JSON.parse(await Bun.stdin.text()); await Bun.write('hook-' + payload.event + '.json', JSON.stringify(payload)); console.log('guest hook:' + payload.event);";
  const run = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ defaultModel: "ollama/test", providers: {}, hooks: { enabled: true, hooks: ["pre-tool", "post-turn", "post-implementation"].map(event => ({ event, run })) } }));
  const cwd = path.join(host, "nested");
  await withSandboxExecution({ supervisor }, async () => {
    expect(await runPreToolHooks(cwd, "write", { filePath: "target.txt" })).toEqual({ vetoed: false });
    expect((await runPostTurnHooks(cwd, "write", { filePath: "target.txt" }, true, "target written")).ran).toBe(1);
    expect(await runPostImplementationHooks(cwd, "implement target")).toEqual({ success: true, output: "guest hook:post-implementation" });
  });
  expect(JSON.parse(await fs.readFile(path.join(guest, "nested", "hook-pre-tool.json"), "utf8"))).toEqual({ event: "pre-tool", tool: "write", args: { filePath: "target.txt" } });
  expect(JSON.parse(await fs.readFile(path.join(guest, "nested", "hook-post-turn.json"), "utf8"))).toEqual({ event: "post-turn", tool: "write", args: { filePath: "target.txt" }, success: true, output: "target written" });
  expect(JSON.parse(await fs.readFile(path.join(guest, "nested", "hook-post-implementation.json"), "utf8"))).toEqual({ event: "post-implementation", request: "implement target" });
  expect(await fs.readdir(cwd)).toEqual([]);
});

test("sandbox engine mediates custom effect handlers rather than invoking their host implementation", async () => {
  const root = await directory();
  const marker = path.join(root, "host-custom-leak");
  let turn = 0;
  const model = spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(++turn === 1 ? { tool: "custom_effect", arguments: {} } : { tool: "done", arguments: { reason: "finished" } }));
  cleanups.push(() => model.mockRestore());
  const results: string[] = [];
  await withSandboxExecution({ supervisor: denyingSupervisor("custom") }, () => runAgentLoop([{ role: "user", content: "exercise custom effect" }], {
    cwd: root, maxSteps: 2, budget: { maxExtensions: 0 }, tools: { custom_effect: async () => { await fs.writeFile(marker, "escaped"); return { success: true, output: "host ran" }; } },
    events: { onToolResult: (_tool, _success, output) => { results.push(output); } },
  }));
  expect(results).toEqual(["SANDBOX_DENIED:custom"]);
  expect(await fs.readdir(root)).toEqual([]);
});

test("captured sandbox scope follows delegated work invoked outside the parent's async context", async () => {
  const root = await configDirectory();
  let turn = 0;
  const model = spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(++turn === 1 ? { tool: "write", arguments: { filePath: path.join(root, "host-nested-leak"), content: "escaped" } } : { tool: "done", arguments: { reason: "Summary: done\nChanged Files: none\nVerification: access denied\nOpen Risks: none" } }));
  cleanups.push(() => model.mockRestore());
  const outputs: string[] = [];
  const supervisor = denyingSupervisor("nested");
  supervisor.call = async (name, args) => {
    if (name === "__workflow" && args.operation === "loadContext") return { success: true, output: "[]" };
    if (name === "__workflow" && args.operation === "memory" && args.action === "prompt") return { success: true, output: JSON.stringify("") };
    return { success: false, output: "", error: "SANDBOX_DENIED:nested" };
  };
  const task = withSandboxExecution({ supervisor }, () => createTaskTool({ config: { defaultModel: "ollama/test", subagents: {} }, onEvent: event => { if (event.kind === "tool") outputs.push(event.summary ?? ""); } }));
  await task({ role: "executor", task: "attempt a restricted write" }, root);
  expect(turn).toBeGreaterThanOrEqual(2);
  expect(outputs.join("\n")).toContain("SANDBOX_DENIED:nested");
  expect(await fs.readdir(root)).not.toContain("host-nested-leak");
});
