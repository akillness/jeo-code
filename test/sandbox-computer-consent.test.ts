import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_TOOLS } from "../src/agent/engine";
import { TOOL_DESCRIPTIONS } from "../src/commands/launch/flags";
import { runHandsWorker } from "../src/agent/sandbox/hands-worker";

const repo = path.resolve(import.meta.dir, "..");
const cli = path.join(repo, "src/cli.ts");
const supportedPlatform = ["darwin", "linux"].includes(os.platform());
const sandbox = { image: "oven/bun:1.3.14", limits: { memoryBytes: 256 * 1024 * 1024, pids: 64, cpus: 1 } };

const cleanup: string[] = [];
afterEach(async () => {
  for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
async function temp(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

// ---------------------------------------------------------------------------
// Guest side: the private __computer hands tool, driven through the real worker loop.
// ---------------------------------------------------------------------------

type Result = { success: boolean; output: string; error?: string };

async function guestComputer(args: Record<string, unknown>, cwd: string, configEnabled = true): Promise<Result> {
  const configDir = path.join(cwd, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, computer: { enabled: configEnabled } }));
  const previousCwd = process.cwd();
  const previousConfig = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = configDir;
  process.chdir(cwd); // executeComputerAction writes its audit log below process.cwd()
  try {
    const frames: string[] = [];
    const request = JSON.stringify({ id: "req1", type: "tool", tool: "__computer", args }) + "\n";
    await runHandsWorker({ input: new Blob([request]).stream(), output: line => { frames.push(line); }, cwd });
    const response = frames.map(line => JSON.parse(line) as { id: string; type: string; result?: Result }).find(frame => frame.type === "result");
    expect(response?.id).toBe("req1");
    return response!.result!;
  } finally {
    process.chdir(previousCwd);
    if (previousConfig === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = previousConfig;
  }
}
const auditExists = (cwd: string) => Bun.file(path.join(cwd, ".jeo", "computer-audit.jsonl")).exists();

test("guest __computer rejects when consent is false, even with config enabled and a forged action.enabledOverride", async () => {
  const cwd = await temp("jeo-guest-consent-off-");
  const result = await guestComputer({ action: { action: "wait", duration: 0, enabledOverride: true }, enabled: false }, cwd, true);
  expect(result.success).toBe(false);
  expect(result.error).toContain("Computer use is disabled");
  expect(await auditExists(cwd)).toBe(false);
});

test("guest __computer rejects a forged override inside batch sub-actions when consent is false", async () => {
  const cwd = await temp("jeo-guest-batch-off-");
  const forged = { action: "wait", duration: 0, enabledOverride: true };
  const result = await guestComputer({ action: { action: "batch", actions: [forged], enabledOverride: true }, enabled: false }, cwd, true);
  expect(result.success).toBe(false);
  expect(await auditExists(cwd)).toBe(false);
});

test.skipIf(!supportedPlatform)("guest __computer honors explicit consent even when the guest config is disabled", async () => {
  const cwd = await temp("jeo-guest-consent-on-");
  const result = await guestComputer({ action: { action: "wait", duration: 0 }, enabled: true }, cwd, false);
  expect(result).toMatchObject({ success: true, output: "Waited for 0 seconds" });
  const audit = JSON.parse((await fs.readFile(path.join(cwd, ".jeo", "computer-audit.jsonl"), "utf8")).trim());
  expect(audit).toMatchObject({ action: { action: "wait" }, success: true });
});

test("guest __computer requires a boolean consent and an action object", async () => {
  const cwd = await temp("jeo-guest-malformed-");
  const wait = { action: "wait", duration: 0 };
  const malformed: Record<string, unknown>[] = [
    { action: wait },
    { action: wait, enabled: "true" },
    { action: wait, enabled: 1 },
    { action: wait, enabled: null },
    { enabled: true },
    { action: "wait", enabled: true },
    { action: null, enabled: true },
    { action: [wait], enabled: true },
  ];
  for (const args of malformed) {
    const result = await guestComputer(args, cwd, true);
    expect({ args, success: result.success }).toEqual({ args, success: false });
  }
  expect(await auditExists(cwd)).toBe(false);
});

test("__computer is a private transport tool and is never a public model tool", () => {
  expect(Object.keys(DEFAULT_TOOLS)).not.toContain("__computer");
  expect(Object.keys(TOOL_DESCRIPTIONS)).not.toContain("__computer");
});

// ---------------------------------------------------------------------------
// Parent side: real launch handler, controlled supervisor, host action spy.
// A Bun preload (written below, active only in the spawned child) replaces
// createSandboxSupervisor and executeComputerAction. The real handler wiring
// in launch.ts runs unchanged.
// ---------------------------------------------------------------------------

function preloadSource(): string {
  return `
import { mock } from "bun:test";
import * as fs from "node:fs";
const supervisorPath = ${JSON.stringify(path.join(repo, "src/agent/sandbox/supervisor.ts"))};
const computerPath = ${JSON.stringify(path.join(repo, "src/commands/computer.ts"))};
const supervisorLog = process.env.JEO_TEST_SUPERVISOR_LOG;
const hostLog = process.env.JEO_TEST_HOST_LOG;
const append = (file, value) => fs.appendFileSync(file, JSON.stringify(value) + "\\n");
const realSupervisor = await import(supervisorPath);
const realComputer = await import(computerPath);
mock.module(supervisorPath, () => ({
  ...realSupervisor,
  createSandboxSupervisor: () => {
    const call = async (tool, args, options) => {
      append(supervisorLog, { tool, args, cwd: options?.cwd, hasSignal: options?.signal instanceof AbortSignal });
      if (tool === "__computer") return { success: true, output: "GUEST_COMPUTER_HANDLED" };
      if (tool === "__workflow") {
        // Mirrors createWorkflowStateTool: output is JSON.stringify(value). loadContext returns
        // ProjectContextFile[] ({path, content}) and discoverGuidance returns
        // Array<{filePath, displayPath}>; both are validated as arrays by sandboxContext.
        // Operations with no value (clear*, ensureGitignore, writeFile, releaseLock) serialize null.
        const operation = args?.operation;
        const value = operation === "loadContext" || operation === "discoverGuidance" ? [] : null;
        return { success: true, output: JSON.stringify(value) };
      }
      return { success: true, output: "" };
    };
    return {
      call,
      toolMap: names => Object.fromEntries(names.map(name => [name, (args, cwd) => call(name, args, { cwd })])),
      exec: async () => ({ success: true, output: "", stdout: "", stderr: "", exitCode: 0 }),
      replacePolicy: async () => {},
      revoke: async () => ({ gone: true, residual: [] }),
      close: async () => {},
    };
  },
}));
mock.module(computerPath, () => ({
  ...realComputer,
  executeComputerAction: async (action, opts) => {
    append(hostLog, { action, opts });
    return { success: true, output: "HOST_COMPUTER_EXECUTED" };
  },
}));
`;
}

interface Scenario { name: string; configEnabled: boolean; session?: "1" | "0"; expected: boolean }
const scenarios: Scenario[] = [
  { name: "config consent", configEnabled: true, expected: true },
  { name: "session consent over disabled config", configEnabled: false, session: "1", expected: true },
  { name: "session denial over enabled config", configEnabled: true, session: "0", expected: false },
  { name: "no consent", configEnabled: false, expected: false },
];

for (const scenario of scenarios) {
  test(`sandboxed computer handler forwards ${scenario.name} to the guest and never runs the host action`, async () => {
    const root = await temp("jeo-parent-computer-");
    const workspace = path.join(root, "workspace");
    const configDir = path.join(root, "config");
    const sessionDir = path.join(root, "sessions");
    for (const directory of [workspace, configDir, sessionDir]) await fs.mkdir(directory);
    await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ providers: {}, defaultModel: "openai/gpt-4o-mini", computer: { enabled: scenario.configEnabled } }));
    const preload = path.join(root, "preload.ts");
    await fs.writeFile(preload, preloadSource());
    const supervisorLog = path.join(root, "supervisor.jsonl");
    const hostLog = path.join(root, "host.jsonl");
    await fs.writeFile(supervisorLog, "");
    await fs.writeFile(hostLog, "");

    const requests: string[] = [];
    const replies = [
      JSON.stringify({ tool: "computer", arguments: { action: "wait", duration: 0 } }),
      JSON.stringify({ tool: "done", arguments: { reason: "Summary: finished\nChanged Files: none\nVerification: none" } }),
    ];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      if (request.method !== "POST") return Response.json({ data: [] });
      const body = await request.text();
      requests.push(body);
      const content = replies[Math.min(requests.length - 1, replies.length - 1)]!;
      if (!JSON.parse(body).stream) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const child = Bun.spawn([process.execPath, "--preload", preload, cli, "launch", "--print", "--no-tui", "--no-skills", "--tools", "computer", "--literal-worker", "--model", "openai/gpt-4o-mini", "--", "worker"], {
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
          JEO_CONFIG_DIR: configDir, JEO_SESSION_DIR: sessionDir,
          JEO_MESSENGER_SANDBOX: JSON.stringify(sandbox),
          JEO_MESSENGER_SESSION_KEY: crypto.randomUUID(), JEO_MESSENGER_ALLOWED_USER_IDS: "[]",
          OPENAI_API_KEY: "local-test-key", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
          JEO_TEST_SUPERVISOR_LOG: supervisorLog, JEO_TEST_HOST_LOG: hostLog,
          ...(scenario.session ? { JEO_MESSENGER_COMPUTER_ENABLED: scenario.session } : {}),
        },
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      child.stdin.write('"use computer"\n'); child.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

      const calls = (await fs.readFile(supervisorLog, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { tool: string; args: Record<string, unknown>; cwd?: string; hasSignal: boolean });
      const computerCalls = calls.filter(call => call.tool === "__computer");
      const diagnostics = { exitCode, stdout, stderr, requestCount: requests.length, calls };
      // Child must succeed; failures surface captured stdout/stderr and every recorded supervisor call.
      expect(diagnostics).toMatchObject({ exitCode: 0 });
      expect({ ...diagnostics, computerCallCount: computerCalls.length }).toMatchObject({ computerCallCount: 1 });
      expect(computerCalls[0]!.args.enabled).toBe(scenario.expected);
      expect(computerCalls[0]!.args.action).toMatchObject({ action: "wait", duration: 0 });
      expect(path.basename(computerCalls[0]!.cwd ?? "")).toBe("workspace");
      // The public tool name is never forwarded as an ungated guest call.
      expect(calls.filter(call => call.tool === "computer")).toHaveLength(0);
      // Precise proof: the parent's host executeComputerAction spy was never invoked.
      expect(await fs.readFile(hostLog, "utf8")).toBe("");
      expect(await Bun.file(path.join(workspace, ".jeo", "computer-audit.jsonl")).exists()).toBe(false);
      // The model sees the guest's answer, not a host one.
      expect(requests[1]).toContain("GUEST_COMPUTER_HANDLED");
      expect(requests[1]).not.toContain("HOST_COMPUTER_EXECUTED");
    } finally { server.stop(true); }
  }, 120000);
}
