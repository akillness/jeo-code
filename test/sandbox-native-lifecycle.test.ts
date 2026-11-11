import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";

async function waitForPid(file: string): Promise<number> {
// These waits observe separate OS processes; fake timers cannot advance their lifecycle.
  for (let i = 0; i < 500; i++) {
    const value = await fs.readFile(file, "utf8").catch(() => "");
    const pid = Number(value);
    if (Number.isSafeInteger(pid) && pid > 1) return pid;
    await Bun.sleep(10);
  }
  throw new Error(`child did not publish its PID: ${file}`);
}

async function waitUntilGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 500; i++) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await Bun.sleep(10);
  }
  return false;
}

for (const mode of ["close", "worker-failure"] as const) {
  test.skipIf(process.platform !== "darwin")(`real native ${mode} terminates an active shell child`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-native-lifecycle-")));
    const policy = await createSandboxPolicy({ sessionKey: `native-${mode}`, revision: 1, cwd: root, config: { backend: "native" } });
    const supervisor = createSandboxSupervisor({ policy });
    let pid: number | undefined;
    try {
      const script = mode === "close"
        ? "echo $$ > child.pid; exec /bin/sleep 30"
        : "echo $$ > child.pid; kill -9 $PPID; exec /bin/sleep 30";
      const active = supervisor.exec(["/bin/sh", "-c", script]);
      pid = await waitForPid(path.join(root, "child.pid"));
      if (mode === "close") {
        expect(() => process.kill(pid!, 0)).not.toThrow();
        await supervisor.close();
      }
      const result = await active;
      expect(result.success).toBe(false);
      expect(await waitUntilGone(pid)).toBe(true);
      if (mode === "worker-failure") await supervisor.close();
      expect((await supervisor.exec(["/bin/echo", "must not run"])).success).toBe(false);
    } finally {
      if (pid && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await supervisor.close().catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}

test.skipIf(process.platform !== "darwin")("real native shell supports pipelines and commands before normal shutdown", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-native-shell-")));
  const policy = await createSandboxPolicy({ sessionKey: "native-shell-lifecycle", revision: 1, cwd: root, config: { backend: "native" } });
  const supervisor = createSandboxSupervisor({ policy });
  try {
    const result = await supervisor.exec(["/bin/sh", "-c", "printf 'hello\\n' | /usr/bin/tr a-z A-Z > result; /bin/cat result"]);
    expect(result.success).toBe(true);
    expect(result.output).toContain("HELLO");
    expect(await fs.readFile(path.join(root, "result"), "utf8")).toBe("HELLO\n");
    await supervisor.close();
    expect((await supervisor.exec(["/bin/echo", "must not run"])).success).toBe(false);
  } finally {
    await supervisor.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
