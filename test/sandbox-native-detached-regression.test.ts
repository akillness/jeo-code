import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";

test.skipIf(process.platform !== "darwin")("native revocation terminates a detached double-generation descendant", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-detached-regression-")));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const marker = path.join(workspace, "escaped");
  const script = path.join(workspace, "descendant.js");
  await fs.writeFile(script, `
    const [generation, marker] = process.argv.slice(2);
    if (generation === 'leaf') {
      await Bun.write('leaf-ready', String(process.pid));
      // A real subprocess must remain alive until the host revokes it; fake timers cannot control it.
      await Bun.sleep(30000);
    } else {
      const child = Bun.spawn(['bun', import.meta.path, generation === 'root' ? 'middle' : 'leaf', marker],
        { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      child.unref();
      if (generation === 'root') {
        // Poll a real subprocess readiness file; fake timers cannot advance the child process.
        for (let i = 0; i < 200 && !(await Bun.file('leaf-ready').exists()); i++) await Bun.sleep(10);
        if (!(await Bun.file('leaf-ready').exists())) process.exit(2);
      }
    }
  `);
  const policy = await createSandboxPolicy({ sessionKey: "detached-regression", revision: 1, cwd: workspace, config: { backend: "native" } });
  const supervisor = createSandboxSupervisor({ policy });
  let pid: number | undefined;
  try {
    const result = await supervisor.exec(["bun", script, "root", marker]);
    expect(result.success).toBe(true);
    pid = Number(await fs.readFile(path.join(workspace, "leaf-ready"), "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    expect(() => process.kill(pid!, 0)).not.toThrow();
    const termination = await supervisor.revoke();
    expect(termination.gone).toBe(true);
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    if (pid && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await supervisor.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

// This host-provided writable prefix exercises a real path outside the existing denylist.
const hostVar = "/opt/homebrew/var";
const canCreateHostFixture = process.platform === "darwin" && await fs.access(hostVar, fs.constants.W_OK).then(() => true, () => false);
test.skipIf(!canCreateHostFixture)("native sandbox cannot read an unapproved host file outside user and temp roots", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-host-read-workspace-")));
  const outside = await fs.mkdtemp(path.join(hostVar, "jeo-host-read-fixture-"));
  const secret = path.join(outside, "secret");
  await fs.writeFile(secret, "unique-test-secret");
  const policy = await createSandboxPolicy({ sessionKey: "host-read-regression", revision: 1, cwd: root, config: { backend: "native" } });
  const supervisor = createSandboxSupervisor({ policy });
  try {
    expect(await fs.readFile(secret, "utf8")).toBe("unique-test-secret");
    const allowed = await supervisor.exec(["/bin/pwd"]);
    expect(allowed.success).toBe(true);
    const denied = await supervisor.exec(["/bin/cat", secret]);
    expect(denied.success).toBe(false);
    expect(denied.output).not.toContain("unique-test-secret");
  } finally {
    await supervisor.close().catch(() => {});
    await fs.rm(outside, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
