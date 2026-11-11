import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runPreToolHooks, setHookSessionId, withSandboxExecution } from "../src/agent/hooks";
import type { SandboxSupervisor, SandboxExecResult } from "../src/agent/sandbox/types";

test("global registry hook runs through its supervisor with the guest cwd and cannot fall back to host execution", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-registry-hook-")));
  const config = path.join(root, "config");
  const workspace = path.join(root, "workspace");
  const marker = path.join(root, "host-escape");
  const previous = process.env.JEO_CONFIG_DIR;
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  let deny = false;
  const supervisor: SandboxSupervisor = {
    toolMap: () => ({}),
    call: async () => ({ success: false, output: "unused" }),
    exec: async (argv, options): Promise<SandboxExecResult> => {
      calls.push({ argv: [...argv], stdin: options?.stdin });
      if (argv[0] === "/bin/pwd") return { success: true, output: "/workspace\n", stdout: "/workspace\n", exitCode: 0 };
      return deny ? { success: false, output: "denied", error: "denied", exitCode: 73 } : { success: true, output: "", stdout: "", exitCode: 0 };
    },
    replacePolicy: async () => {}, revoke: async () => ({ gone: true, residual: [] }), close: async () => {},
  };
  try {
    await Promise.all([fs.mkdir(config), fs.mkdir(workspace)]);
    process.env.JEO_CONFIG_DIR = config;
    setHookSessionId("registry-session");
    const run = `printf escaped > ${JSON.stringify(marker)}`;
    await fs.writeFile(path.join(config, "hooks.json"), JSON.stringify({ hooks: [{ event: "pre-tool", run }] }));
    const invoke = () => withSandboxExecution({ supervisor }, () => runPreToolHooks(workspace, "write", { content: "untrusted" }));
    expect(await invoke()).toEqual({ vetoed: false });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.argv).toEqual(["/bin/pwd"]);
    expect(calls[1]!.argv.slice(1)).toEqual(["-c", run]);
    expect(JSON.parse(calls[1]!.stdin!)).toEqual({ event: "pre-tool", hook_event_name: "PreToolUse", session_id: "registry-session", cwd: "/workspace", tool: "write", args: { content: "untrusted" }, tool_name: "write", tool_input: { content: "untrusted" } });
    deny = true;
    expect((await invoke()).vetoed).toBe(true);
    expect(await fs.stat(marker).catch(() => undefined)).toBeUndefined();
  } finally {
    setHookSessionId(undefined);
    if (previous === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
