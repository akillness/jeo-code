import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobRegistry } from "../src/agent/job-registry";
import { MonitorRegistry } from "../src/agent/monitor-registry";
import { createJobTool } from "../src/agent/job-tool";
import { createMonitorTool } from "../src/agent/monitor-tool";
import { settlesWithin, spawnLeasedShell } from "../src/agent/shell-lease";

const posix = process.platform !== "win32";
const decoder = new TextDecoder();
const pids: number[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-lease-"));
  dirs.push(dir);
  return dir;
}

async function readPid(dir: string): Promise<number> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await fs.readFile(path.join(dir, "child.pid"), "utf8")).trim());
      if (pid > 0) { pids.push(pid); return pid; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for child.pid");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  if (process.platform !== "linux") return true;
  try {
    // kill(pid, 0) also succeeds for terminated orphans awaiting init's wait().
    // The comm field can contain spaces and ')'; state follows its last ')'.
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function slurp(reader: { read(): Promise<{ done?: boolean; value?: Uint8Array }> }): Promise<string> {
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
  }
  return text;
}

test.skipIf(!posix)("lease holder reports the exit code, closes its own pipes, and is unpinned once released", async () => {
  const shell = spawnLeasedShell("printf 'out\\n'; printf 'err\\n' >&2; exit 3", process.cwd());
  const [out, err] = await Promise.all([slurp(shell.stdout), slurp(shell.stderr)]);
  expect(out).toBe("out\n");
  expect(err).toBe("err\n");
  expect(await shell.exit).toBe(3);
  shell.release();
  await shell.reaped;
  expect(shell.killGroup()).toBe("unpinned");
  shell.dispose();
});

test.skipIf(!posix)("a command cannot write to the lease channels or read the release pipe", async () => {
  const shell = spawnLeasedShell("(echo forged >&3) 2>/dev/null || echo fd3-closed; read -r line; echo \"stdin=[$line]\"", process.cwd());
  const out = await slurp(shell.stdout);
  expect(out).toContain("fd3-closed");
  expect(out).toContain("stdin=[]");
  expect(await shell.exit).toBe(0);
  shell.release();
  await shell.reaped;
  shell.dispose();
});

test.skipIf(!posix)("a signal-killed command leaves no holder notice on stderr", async () => {
  const shell = spawnLeasedShell("kill -9 $$", process.cwd());
  const [out, err] = await Promise.all([slurp(shell.stdout), slurp(shell.stderr)]);
  expect(out).toBe("");
  expect(err).toBe("");
  expect(await shell.exit).toBe(137);
  shell.release();
  await shell.reaped;
  shell.dispose();
});

test.skipIf(!posix)("BASH_ENV is sourced once, by the command's shell only", async () => {
  const dir = await tempDir();
  const startup = path.join(dir, "startup.sh");
  await fs.writeFile(startup, "echo startup-ran >&2\n");
  const previous = process.env.BASH_ENV;
  process.env.BASH_ENV = startup;
  try {
    const shell = spawnLeasedShell('echo "BE=$BASH_ENV"', dir);
    const [out, err] = await Promise.all([slurp(shell.stdout), slurp(shell.stderr)]);
    expect(out).toBe(`BE=${startup}\n`);
    expect(err).toBe("startup-ran\n");
    shell.release();
    await shell.reaped;
    shell.dispose();
  } finally {
    if (previous === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = previous;
  }
});

test.skipIf(!posix)("an unwritable status file ends the lease as unreported instead of hanging", async () => {
  const cwd = await tempDir();
  const gate = path.join(cwd, "gate");
  const fifo = Bun.spawnSync(["mkfifo", gate]);
  expect(fifo.exitCode).toBe(0);
  // Use the same resolved temp root as production, rather than mutating TMPDIR
  // after os.tmpdir() may already have cached it.
  const root = os.tmpdir();
  const before = new Set(fsSync.readdirSync(root));
  const shell = spawnLeasedShell('read -r _ < gate; echo done', cwd);
  try {
    const leaseDirs = fsSync.readdirSync(root).filter(name => name.startsWith("jeo-lease-") && !before.has(name));
    expect(leaseDirs).toHaveLength(1);
    await fs.rm(path.join(root, leaseDirs[0]!), { recursive: true, force: true });
    await fs.writeFile(gate, "continue\n");
    expect(await slurp(shell.stdout)).toBe("done\n");
    expect(await settlesWithin(shell.reaped, 3000)).toBe(true);
    expect(await shell.exit).toBeNull();
    expect(shell.killGroup()).toBe("unpinned");
  } finally {
    shell.killDirect();
    shell.dispose();
  }
}, 8000);

test.skipIf(!posix)("a synchronous spawn failure leaves no lease directory behind", async () => {
  const tmp = await tempDir();
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try { expect(() => spawnLeasedShell("echo \0bad", process.cwd())).toThrow(); }
  finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  expect(await fs.readdir(tmp)).toEqual([]);
});

test.skipIf(!posix)("a file or missing directory as cwd fails the start synchronously", () => {
  expect(() => spawnLeasedShell("true", path.join(os.tmpdir(), "jeo-lease-missing-dir-xyz"))).toThrow(/ENOENT/);
  expect(() => spawnLeasedShell("true", import.meta.path)).toThrow(/ENOTDIR/);
});

test.skipIf(!posix)("killGroup reaches a lingering descendant while the lease is held", async () => {
  const dir = await tempDir();
  const shell = spawnLeasedShell("sleep 30 & echo $! > child.pid; exit 0", dir);
  try {
    expect(await shell.exit).toBe(0);
    const pid = await readPid(dir);
    expect(alive(pid)).toBe(true);
    const drains = Promise.all([slurp(shell.stdout), slurp(shell.stderr)]);
    expect(await settlesWithin(drains, 300)).toBe(false);
    expect(shell.killGroup()).toBe("delivered");
    expect(shell.killGroup()).toBe("delivered");
    expect(await settlesWithin(drains, 2000)).toBe(true);
    await shell.reaped;
    expect(alive(pid)).toBe(false);
  } finally { shell.release(); await shell.reaped; shell.dispose(); }
});

test.skipIf(!posix)("a lost lease is never signalled as a group", async () => {
  const dir = await tempDir();
  const shell = spawnLeasedShell("sleep 4 & echo $! > child.pid; kill -9 $PPID; sleep 4", dir);
  const pid = await readPid(dir);
  await shell.reaped;
  expect(await shell.exit).toBeNull();
  expect(shell.killGroup()).toBe("unpinned");
  await Bun.sleep(50);
  expect(alive(pid)).toBe(true);
  shell.dispose();
});

test.skipIf(!posix)("job whose lease holder dies is failed, unobserved and never group-signalled", async () => {
  const dir = await tempDir();
  const registry = new JobRegistry();
  const job = registry.start("sleep 4 & echo $! > child.pid; kill -9 $PPID; sleep 4", dir);
  const pid = await readPid(dir);
  const [settled] = await registry.awaitIds([job.id], 3000);
  expect(settled!.status).toBe("failed");
  expect(registry.tail(job.id)).toMatch(/no longer pinned|lease ended/);
  expect(registry.consumeMutations([job.id])).toBe(true);
  expect(registry.unobserved().map(record => record.id)).toContain(job.id);
  registry.cancelAll();
  expect(registry.unobserved().map(record => record.id)).toContain(job.id);
  expect(alive(pid)).toBe(true);
}, 6000);

test.skipIf(!posix)("monitor whose lease holder dies is failed, unobserved and never group-signalled", async () => {
  const dir = await tempDir();
  const registry = new MonitorRegistry();
  const monitor = registry.start("sleep 4 & echo $! > child.pid; kill -9 $PPID; sleep 4", dir, true);
  const pid = await readPid(dir);
  const [settled] = await registry.awaitIds([monitor.id], 3000);
  expect(settled!.status).toBe("failed");
  expect(registry.consumeMutations([monitor.id])).toBe(true);
  expect(registry.unobserved().map(record => record.id)).toContain(monitor.id);
  registry.cancelAll();
  expect(registry.unobserved().map(record => record.id)).toContain(monitor.id);
  expect(alive(pid)).toBe(true);
}, 6000);

test.skipIf(!posix)("a lost lease with drained pipes never reports a verified exit", async () => {
  const jobs = new JobRegistry();
  const job = jobs.start("kill -9 $PPID; exit 0", process.cwd());
  const [settledJob] = await jobs.awaitIds([job.id], 3000);
  expect(settledJob!.status).toBe("failed");
  expect(jobs.unobserved().map(record => record.id)).toContain(job.id);
  const monitors = new MonitorRegistry();
  const monitor = monitors.start("kill -9 $PPID; exit 0", process.cwd(), true);
  const [settledMonitor] = await monitors.awaitIds([monitor.id], 3000);
  expect(settledMonitor!.status).toBe("failed");
  expect(monitors.unobserved().map(record => record.id)).toContain(monitor.id);
}, 6000);

const python = Bun.which("python3");
const ESCAPE = `python3 -c "import os,time; os.setsid(); open('child.tmp','w').write(str(os.getpid())); os.rename('child.tmp','child.pid'); time.sleep(30)" &
while [ ! -f child.pid ]; do :; done; exit 0`;

// The shell is still running when cancelled, so the group kill is delivered before the escape is visible.
const ESCAPE_BLOCKING = `python3 -c "import os,time; os.setsid(); open('child.tmp','w').write(str(os.getpid())); os.rename('child.tmp','child.pid'); time.sleep(30)" &
sleep 30`;

test.skipIf(!posix || !python)("job with a pipe holder that left the group stays unresolved", async () => {
  const dir = await tempDir();
  const registry = new JobRegistry();
  const job = registry.start(ESCAPE, dir);
  const pid = await readPid(dir);
  const [settled] = await registry.awaitIds([job.id], 3500);
  expect(settled!.status).toBe("failed");
  expect(registry.tail(job.id)).toContain("outside the process group");
  registry.consumeMutations([job.id]);
  expect(registry.unobserved().map(record => record.id)).toContain(job.id);
  registry.cancel([job.id]);
  expect(registry.unobserved().map(record => record.id)).toContain(job.id);
  expect(alive(pid)).toBe(true);
}, 6000);

test.skipIf(!posix || !python)("monitor with a pipe holder that left the group stays unresolved", async () => {
  const dir = await tempDir();
  const registry = new MonitorRegistry();
  const monitor = registry.start(ESCAPE, dir, true);
  const pid = await readPid(dir);
  const [settled] = await registry.awaitIds([monitor.id], 3500);
  expect(settled!.status).toBe("failed");
  expect(registry.tail(monitor.id)).toContain("outside the process group");
  registry.consumeMutations([monitor.id]);
  expect(registry.unobserved().map(record => record.id)).toContain(monitor.id);
  registry.cancel([monitor.id]);
  expect(registry.unobserved().map(record => record.id)).toContain(monitor.id);
  expect(alive(pid)).toBe(true);
}, 6000);

test("a missing working directory fails the start without leaving an active process", async () => {
  const registry = new JobRegistry();
  const job = registry.start("true", path.join(os.tmpdir(), "jeo-lease-missing-dir-xyz"));
  expect(job.status).toBe("failed");
  expect(registry.tail(job.id)).toContain("ENOENT");
  expect(registry.running()).toEqual([]);
});

test.skipIf(!posix || !python)("cancel tools do not report success for a pipe holder that left the group", async () => {
  const jobDir = await tempDir();
  const jobs = new JobRegistry();
  const jobTool = createJobTool(jobs);
  const job = jobs.start(`${ESCAPE_BLOCKING}`, jobDir);
  await readPid(jobDir);
  const jobCancel = await jobTool({ action: "cancel", ids: [job.id] }, jobDir);
  expect(jobCancel.success).toBe(false);
  expect(jobs.get(job.id)!.status).toBe("failed");

  const monitorDir = await tempDir();
  const monitors = new MonitorRegistry();
  const monitorTool = createMonitorTool(monitors);
  const monitor = monitors.start(`${ESCAPE_BLOCKING}`, monitorDir, true);
  await readPid(monitorDir);
  const monitorCancel = await monitorTool({ action: "cancel", ids: [monitor.id] }, monitorDir);
  expect(monitorCancel.success).toBe(false);
  expect(monitors.get(monitor.id)!.status).toBe("failed");
}, 10_000);
