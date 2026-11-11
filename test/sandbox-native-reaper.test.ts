import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createNativeBackend, reapOrphanedNativeProcesses, type HostProcess } from "../src/agent/sandbox/native";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";
import type { SandboxSupervisor } from "../src/agent/sandbox/types";

const isDarwin = process.platform === "darwin";
const SCRATCH_PREFIX = "jeo-sandbox-native-";

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// These waits observe separate OS processes; fake timers cannot advance their lifecycle.
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(25);
  }
  return condition();
}

/** `nohup sleep &` from a shell: the sleeper is re-parented to launchd as soon as the shell exits. */
const DAEMON = "nohup /bin/sleep 300 >/dev/null 2>&1 & echo $! > sleeper.pid";

async function openSession(label: string): Promise<{ root: string; supervisor: SandboxSupervisor }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `jeo-reaper-${label}-`)));
  const policy = await createSandboxPolicy({ sessionKey: `reaper-${label}`, revision: 1, cwd: root, config: { backend: "native" } });
  return { root, supervisor: createSandboxSupervisor({ policy }) };
}

async function sleeperPid(root: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const pid = Number(await fs.readFile(path.join(root, "sleeper.pid"), "utf8").catch(() => ""));
    if (Number.isSafeInteger(pid) && pid > 1) return pid;
    await Bun.sleep(25);
  }
  throw new Error(`no sleeper pid in ${root}`);
}

const scratchDirectories = async (): Promise<string[]> => (await fs.readdir(os.tmpdir())).filter(name => name.startsWith(SCRATCH_PREFIX));

test.skipIf(!isDarwin)("closing one session kills only its own re-parented daemon; the other session's survives until it closes", async () => {
  const a = await openSession("A");
  const b = await openSession("B");
  let pidA = 0;
  let pidB = 0;
  try {
    for (const session of [a, b]) expect((await session.supervisor.exec(["/bin/sh", "-c", DAEMON])).success).toBe(true);
    [pidA, pidB] = [await sleeperPid(a.root), await sleeperPid(b.root)];
    expect(alive(pidA) && alive(pidB)).toBe(true);
    await a.supervisor.close();
    expect(await waitFor(() => !alive(pidA))).toBe(true);
    expect(alive(pidB)).toBe(true);
    await b.supervisor.close();
    expect(await waitFor(() => !alive(pidB))).toBe(true);
  } finally {
    for (const pid of [pidA, pidB]) if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
    await Promise.all([a, b].map(async session => { await session.supervisor.close().catch(() => {}); await fs.rm(session.root, { recursive: true, force: true }); }));
  }
}, 60_000);

test.skipIf(!isDarwin)("after a host is killed, the reaper ends its orphaned sandbox processes and removes its scratch, leaving a live host's session alone", async () => {
  const live = await openSession("live");
  const hostRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-reaper-host-")));
  let orphan = 0;
  let liveDaemon = 0;
  let host: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
  try {
    expect((await live.supervisor.exec(["/bin/sh", "-c", DAEMON])).success).toBe(true);
    liveDaemon = await sleeperPid(live.root);
    const before = new Set(await scratchDirectories());
    // A separate host process owns a session, starts a daemon in it, then is killed without any cleanup.
    const script = path.join(hostRoot, "host.ts");
    const src = (name: string): string => JSON.stringify(path.resolve(import.meta.dir, "../src/agent/sandbox", name));
    await fs.writeFile(script, [
      `import { createSandboxPolicy } from ${src("policy")};`,
      `import { createSandboxSupervisor } from ${src("supervisor")};`,
      `const root = ${JSON.stringify(hostRoot)};`,
      `const policy = await createSandboxPolicy({ sessionKey: "reaper-crashed-host", revision: 1, cwd: root, config: { backend: "native" } });`,
      `const supervisor = createSandboxSupervisor({ policy });`,
      `const result = await supervisor.exec(["/bin/sh", "-c", ${JSON.stringify(DAEMON)}]);`,
      `console.log(result.success ? "ready" : "failed");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"));
    host = Bun.spawn([process.execPath, script], { cwd: hostRoot, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const reader = host.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready");
    orphan = await sleeperPid(hostRoot);
    expect(alive(orphan)).toBe(true);
    const created = (await scratchDirectories()).filter(name => !before.has(name));
    expect(created.length).toBeGreaterThan(0);

    host.kill("SIGKILL");
    await host.exited;
    // The sandbox outlives its killed host: this is the leak the reaper exists for.
    expect(alive(orphan)).toBe(true);

    const result = await reapOrphanedNativeProcesses();
    expect(result.complete).toBe(true);
    expect(await waitFor(() => !alive(orphan))).toBe(true);
    for (const name of created) {
      expect(await fs.stat(path.join(os.tmpdir(), name)).then(() => true, () => false)).toBe(false);
    }
    // The live host's session was not an orphan.
    expect(alive(liveDaemon)).toBe(true);
    expect((await live.supervisor.exec(["/bin/echo", "still running"])).success).toBe(true);
  } finally {
    host?.kill("SIGKILL");
    for (const pid of [orphan, liveDaemon]) if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
    await live.supervisor.close().catch(() => {});
    await fs.rm(live.root, { recursive: true, force: true });
    await fs.rm(hostRoot, { recursive: true, force: true });
  }
}, 90_000);

/** A scratch directory owned by `owner`, as a native session leaves it. */
async function staleSession(scratchRoot: string, owner: number): Promise<string> {
  const session = await fs.mkdtemp(path.join(scratchRoot, SCRATCH_PREFIX));
  await fs.mkdir(path.join(session, "runtime"), { recursive: true });
  await fs.writeFile(path.join(session, "runtime", "owner"), String(owner));
  return session;
}

test("the reaper only touches sessions whose owner is gone and kills only their members", async () => {
  const scratchRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-reaper-fake-")));
  try {
    const dead = await staleSession(scratchRoot, 4_000_001);
    const livingOwner = await staleSession(scratchRoot, process.pid);
    const processes: HostProcess[] = [{ pid: 41, ppid: 1 }, { pid: 42, ppid: 1 }, { pid: 43, ppid: 1 }];
    const members = new Map<string, number[]>([[dead, [41]], [livingOwner, [42]]]);
    const signals: Array<[number, string]> = [];
    const gone = new Set<number>();
    const result = await reapOrphanedNativeProcesses({
      platform: "darwin",
      scratchRoot,
      ownerAlive: pid => pid === process.pid,
      listProcesses: async () => processes.filter(entry => !gone.has(entry.pid)),
      isMember: (pid, session) => members.get(session)?.includes(pid) ?? false,
      signal: (pid, name) => { signals.push([pid, String(name)]); if (name === "SIGKILL") gone.add(Math.abs(pid)); },
    });
    expect(result).toMatchObject({ complete: true, reaped: 1 });
    // Only the dead owner's member was signalled: not the live owner's member, not a bystander.
    expect([...new Set(signals.map(([pid]) => pid))]).toEqual([41]);
    expect(signals.some(([, name]) => name === "SIGKILL")).toBe(true);
    expect(await fs.stat(dead).then(() => true, () => false)).toBe(false);
    expect(await fs.stat(livingOwner).then(() => true, () => false)).toBe(true);
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
});

test("the reaper never signals pid 1 or its own process, even for a member of a dead session", async () => {
  const scratchRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-reaper-protected-")));
  try {
    const dead = await staleSession(scratchRoot, 4_000_004);
    const signals: number[] = [];
    const result = await reapOrphanedNativeProcesses({
      platform: "darwin",
      scratchRoot,
      deadlineMs: 200,
      ownerAlive: () => false,
      listProcesses: async () => [{ pid: 1, ppid: 0 }, { pid: process.pid, ppid: 1 }],
      isMember: () => true,
      signal: pid => { signals.push(pid); },
    });
    expect(signals).toEqual([]);
    // A member that can never be signalled is never reported as cleaned up.
    expect(result.complete).toBe(false);
    expect(await fs.stat(dead).then(() => true, () => false)).toBe(true);
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
});

test("a reap that cannot prove the members are gone is incomplete and keeps the scratch directory", async () => {
  const scratchRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-reaper-stuck-")));
  try {
    const stale = await staleSession(scratchRoot, 4_000_002);
    const signals: number[] = [];
    // A member that survives every signal: the deadline must report failure instead of success.
    const result = await reapOrphanedNativeProcesses({
      platform: "linux",
      scratchRoot,
      deadlineMs: 200,
      ownerAlive: () => false,
      listProcesses: async () => [{ pid: 77, ppid: 1 }],
      isMember: pid => pid === 77,
      signal: pid => { signals.push(pid); },
    });
    expect(result.complete).toBe(false);
    expect(signals.length).toBeGreaterThan(0);
    expect(await fs.stat(stale).then(() => true, () => false)).toBe(true);
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
});

test("a failing process scan makes the reap incomplete instead of claiming success", async () => {
  const scratchRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-reaper-scan-")));
  try {
    const stale = await staleSession(scratchRoot, 4_000_003);
    const result = await reapOrphanedNativeProcesses({
      platform: "linux",
      scratchRoot,
      ownerAlive: () => false,
      listProcesses: async () => { throw new Error("ps failed"); },
      isMember: () => true,
      signal: () => {},
    });
    expect(result.complete).toBe(false);
    expect(await fs.stat(stale).then(() => true, () => false)).toBe(true);
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
});

/** A native backend whose process table, membership and signals are fakes the test controls. */
async function fakeBackend(members: { scan: () => Promise<HostProcess[]>; onKill: (pid: number) => void }, deadlineMs: number) {
  const leader = 31_337;
  const signals: Array<[number, string]> = [];
  const exited = Promise.withResolvers<number>();
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-stop-ws-")));
  const bundle = path.join(workspace, "hands.js");
  await fs.writeFile(bundle, "// fixture");
  const backend = createNativeBackend({
    platform: "darwin",
    run: async () => 0,
    deadlineMs,
    spawn: () => ({ pid: leader, stdin: { write() {}, flush() {}, end() {} }, stdout: new ReadableStream<Uint8Array>(), stderr: new ReadableStream<Uint8Array>(), exited: exited.promise }),
    listProcesses: members.scan,
    isMember: pid => pid === 41,
    signal: (target, name) => {
      signals.push([target, String(name)]);
      if (name === "SIGKILL") { members.onKill(Math.abs(target)); if (Math.abs(target) === leader) exited.resolve(137); }
    },
  });
  const policy = await createSandboxPolicy({ sessionKey: "stop-fake", revision: 1, cwd: workspace, config: { backend: "native" } });
  return { backend, policy, bundle, signals, leader, workspace };
}

test("stop() reports gone only after a fresh scan finds no member, and signals nothing outside the session", async () => {
  const gone = new Set<number>();
  const table: HostProcess[] = [{ pid: 31_337, ppid: 1 }, { pid: 41, ppid: 1 }, { pid: 999, ppid: 1 }];
  const fixture = await fakeBackend({ scan: async () => table.filter(entry => !gone.has(entry.pid)), onKill: pid => { gone.add(pid); } }, 5_000);
  try {
    const sandbox = await fixture.backend.launch(fixture.policy, fixture.bundle);
    expect(await sandbox.stop()).toEqual({ gone: true, residual: [] });
    // The leader and the re-parented member (pid 41) die; the bystander (pid 999), pid 1 and this process are never signalled.
    const targets = new Set(fixture.signals.map(([target]) => Math.abs(target)));
    expect(targets.has(41) && targets.has(31_337)).toBe(true);
    expect(targets.has(999) || targets.has(1) || targets.has(process.pid)).toBe(false);
  } finally {
    await fs.rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("stop() reports not-gone when a member survives every signal, and when the process scan fails", async () => {
  const stuck = await fakeBackend({ scan: async () => [{ pid: 31_337, ppid: 1 }, { pid: 41, ppid: 1 }], onKill: () => {} }, 200);
  const blind = await fakeBackend({ scan: async () => { throw new Error("ps failed"); }, onKill: () => {} }, 200);
  try {
    for (const fixture of [stuck, blind]) {
      const sandbox = await fixture.backend.launch(fixture.policy, fixture.bundle);
      const result = await sandbox.stop();
      expect(result.gone).toBe(false);
      expect(result.residual).toHaveLength(1);
    }
  } finally {
    await Promise.all([stuck, blind].map(fixture => fs.rm(fixture.workspace, { recursive: true, force: true })));
  }
});
