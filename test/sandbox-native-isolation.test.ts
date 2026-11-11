import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";
import type { SandboxSupervisor } from "../src/agent/sandbox/types";
import { runPreToolHooks, withSandboxExecution } from "../src/agent/hooks";

// This exercises the actual Seatbelt backend and a globally registered hook, not a fake backend.
test.skipIf(process.platform !== "darwin")("native global hook can read skill resources but cannot read secrets, write skills, or reach the network", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-seatbelt-regression-")));
  const workspace = path.join(root, "workspace");
  const config = path.join(root, "config");
  const skill = path.join(root, "skills", "fixture");
  const secret = path.join(config, "secret.txt");
  const previous = process.env.JEO_CONFIG_DIR;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("host network reachable") });
  let supervisor: SandboxSupervisor | undefined;
  try {
    await Promise.all([workspace, config, skill].map(dir => fs.mkdir(dir, { recursive: true })));
    process.env.JEO_CONFIG_DIR = config;
    await fs.writeFile(secret, "SECRET-MUST-NOT-LEAK");
    await fs.writeFile(path.join(skill, "reference.txt"), "global skill support");
    const script = path.join(skill, "hook.js");
    await fs.writeFile(script, `
      import { readFile, writeFile } from 'node:fs/promises';
      const [reference, secret, forbiddenWrite, port] = process.argv.slice(2);
      const payload = JSON.parse(await Bun.stdin.text());
      const result = { payload, support: await readFile(reference, 'utf8'), secretDenied: false, writeDenied: false, networkDenied: false };
      try { result.secret = await readFile(secret, 'utf8'); } catch { result.secretDenied = true; }
      try { await writeFile(forbiddenWrite, 'must not write'); } catch { result.writeDenied = true; }
      try { await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(1000) }); } catch { result.networkDenied = true; }
      await writeFile('hook-result.json', JSON.stringify(result));
    `);
    const forbiddenWrite = path.join(skill, "forbidden.txt");
    const command = ["bun", script, path.join(skill, "reference.txt"), secret, forbiddenWrite, String(server.port)].map(value => JSON.stringify(value)).join(" ");
    await fs.writeFile(path.join(config, "hooks.json"), JSON.stringify({ enabled: true, hooks: [{ event: "pre-tool", run: command }] }));
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe("host network reachable");
    const policy = await createSandboxPolicy({ sessionKey: "seatbelt-regression", revision: 1, cwd: workspace, config: { backend: "native" } });
    supervisor = createSandboxSupervisor({ policy, readOnlyRoots: [path.dirname(skill)] });
    const pre = await withSandboxExecution({ supervisor }, () => runPreToolHooks(workspace, "write", { filePath: "target.txt" }));
    expect(pre).toEqual({ vetoed: false });
    const result = JSON.parse(await fs.readFile(path.join(workspace, "hook-result.json"), "utf8"));
    expect(result).toEqual({ payload: { event: "pre-tool", tool: "write", args: { filePath: "target.txt" }, cwd: workspace, hook_event_name: "PreToolUse", session_id: "", tool_name: "write", tool_input: { filePath: "target.txt" } }, support: "global skill support", secretDenied: true, writeDenied: true, networkDenied: true });
    expect(await fs.readFile(secret, "utf8")).toBe("SECRET-MUST-NOT-LEAK");
    expect(await fs.stat(forbiddenWrite).catch(() => undefined)).toBeUndefined();
  } finally {
    await supervisor?.close();
    server.stop(true);
    if (previous === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(process.platform !== "darwin")("native shell can use workspace files but cannot follow a workspace symlink to an unapproved host file", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-native-symlink-")));
  const workspace = path.join(root, "workspace");
  const secret = path.join(root, "outside-secret");
  await fs.mkdir(workspace);
  await fs.writeFile(secret, "outside-only-secret");
  await fs.symlink(secret, path.join(workspace, "link"));
  const policy = await createSandboxPolicy({ sessionKey: "native-symlink", revision: 1, cwd: workspace, config: { backend: "native" } });
  const supervisor = createSandboxSupervisor({ policy });
  try {
    const ordinary = await supervisor.exec(["/bin/sh", "-c", "printf workspace-data > local.txt && cat local.txt"]);
    expect(ordinary.success).toBe(true);
    expect(ordinary.output).toContain("workspace-data");
    expect(await fs.readFile(path.join(workspace, "local.txt"), "utf8")).toBe("workspace-data");
    const denied = await supervisor.exec(["/bin/cat", "link"]);
    expect(denied.success).toBe(false);
    expect(denied.output).not.toContain("outside-only-secret");
  } finally {
    await supervisor.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(process.platform !== "darwin")("a real global hook denied a host secret vetoes the tool instead of running on the host", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-native-hook-denial-")));
  const workspace = path.join(root, "workspace");
  const config = path.join(root, "config");
  const secret = path.join(root, "secret");
  const previous = process.env.JEO_CONFIG_DIR;
  await Promise.all([fs.mkdir(workspace), fs.mkdir(config)]);
  await fs.writeFile(secret, "hook-secret");
  await fs.writeFile(path.join(config, "hooks.json"), JSON.stringify({ hooks: [{ event: "pre-tool", run: `/bin/cat ${JSON.stringify(secret)}` }] }));
  process.env.JEO_CONFIG_DIR = config;
  const policy = await createSandboxPolicy({ sessionKey: "native-hook-denial", revision: 1, cwd: workspace, config: { backend: "native" } });
  const supervisor = createSandboxSupervisor({ policy });
  try {
    expect((await supervisor.exec(["/bin/pwd"])).success).toBe(true);
    const result = await withSandboxExecution({ supervisor }, () => runPreToolHooks(workspace, "write", {}));
    expect(result.vetoed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("hook-secret");
    expect(await fs.readFile(secret, "utf8")).toBe("hook-secret");
  } finally {
    await supervisor.close().catch(() => {});
    if (previous === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
