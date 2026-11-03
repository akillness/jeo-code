import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { watch } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MonitorRegistry } from "../src/agent/monitor-registry";

const cwd = process.cwd();

test("persistent monitor drains normal stdout and stderr", async () => {
  const registry = new MonitorRegistry();
  const monitor = registry.start("printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2", cwd, true);
  const [settled] = await registry.awaitIds([monitor.id]);
  expect(settled!.status).toBe("exited");
  expect(settled!.exitCode).toBe(0);
  expect(registry.tail(monitor.id)).toContain("stdout-line");
  expect(registry.tail(monitor.id)).toContain("stderr-line");
});

test("fast notice consumer receives a burst of 2000 lines without overflow", async () => {
  const lines: string[] = [];
  const registry = new MonitorRegistry({ onLine: (_record, line) => { lines.push(line); } });
  const monitor = registry.start("seq 1 2000", cwd, true);
  const [settled] = await registry.awaitIds([monitor.id]);
  expect(settled!.status).toBe("exited");
  expect(settled!.exitCode).toBe(0);
  expect(lines).toEqual(Array.from({ length: 2000 }, (_, index) => String(index + 1)));
  expect(registry.tail(monitor.id)).not.toContain("notice queue limit exceeded");
});

for (const persistent of [true, false]) {
  test(`slow onLine callback does not look like inherited pipes (${persistent ? "persistent" : "one-shot"})`, async () => {
    const events: string[] = [];
    const registry = new MonitorRegistry({ onLine: async (_record, line) => {
      events.push(`start:${line}`);
      // Real time is required to cross the subprocess pipe-drain grace period.
      await Bun.sleep(650);
      events.push(`end:${line}`);
    } });
    const monitor = registry.start("printf 'first\\nsecond\\n'", cwd, persistent);
    const [settled] = await registry.awaitIds([monitor.id]);
    expect(settled!.status).not.toBe("failed");
    expect(registry.tail(monitor.id)).not.toMatch(/incomplete/i);
    expect(events).toEqual(persistent ? ["start:first", "end:first", "start:second", "end:second"] : ["start:first", "end:first"]);
  }, 5000);
}

test("notice queue overflow fails explicitly instead of silently dropping output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-monitor-overflow-"));
  let started = false;
  const registry = new MonitorRegistry({ onLine: async () => {
    if (!started) await fs.writeFile(path.join(dir, "ready"), "ready");
    started = true;
    // Real time holds the consumer behind the real subprocess producer.
    await Bun.sleep(650);
  } });
  const monitor = registry.start("printf 'first\\n'; until test -f ready; do sleep 0.01; done; seq 1 2000; sleep 30", dir, true);
  try {
    const [settled] = await registry.awaitIds([monitor.id], 4000);
    expect(settled!.status).toBe("failed");
    expect(started).toBe(true);
    expect(registry.tail(monitor.id)).toContain("notice queue limit exceeded");
  } finally { registry.cancel([monitor.id]); await fs.rm(dir, { recursive: true, force: true }); }
}, 5000);

test("oversized unterminated monitor line fails explicitly", async () => {
  const registry = new MonitorRegistry();
  const monitor = registry.start("head -c 21000 /dev/zero | tr '\\0' x; sleep 30", cwd, true);
  try {
    const [settled] = await registry.awaitIds([monitor.id], 4000);
    expect(settled!.status).toBe("failed");
    expect(registry.tail(monitor.id)).toContain("notice queue limit exceeded");
  } finally { registry.cancel([monitor.id]); }
}, 5000);

for (const mode of ["cancel", "one-shot", "linger"] as const) {
  test(`monitor ${mode} settles with inherited descendant pipes`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-monitor-drain-"));
    const registry = new MonitorRegistry();
    let pid: number | undefined;
    const ready = Promise.withResolvers<void>();
    const watcher = watch(dir, (_event, name) => { if (name === "child.pid") ready.resolve(); });
    try {
      const suffix = mode === "cancel" ? "wait" : mode === "one-shot" ? "printf 'first-line\\n'; wait" : "printf 'partial output\\n'; exit 0";
      const monitor = registry.start(`sleep 30 & echo $! > child.tmp; mv child.tmp child.pid; ${suffix}`, dir, mode !== "one-shot");
      await ready.promise;
      pid = Number((await fs.readFile(path.join(dir, "child.pid"), "utf8")).trim());
      expect(pid).toBeGreaterThan(0);
      if (mode === "cancel") registry.cancel([monitor.id]);
      const [settled] = await registry.awaitIds([monitor.id]);
      expect(settled!.status).toBe(mode === "linger" ? "failed" : "killed");
      if (mode === "linger") {
        expect(registry.tail(monitor.id)).toContain("partial output");
        expect(registry.tail(monitor.id)).toMatch(/incomplete/i);
      }
      expect(registry.unobserved().map(record => record.id)).toContain(monitor.id);
    } finally {
      watcher.close();
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 5000);
}
