#!/usr/bin/env bun
/**
 * Runtime SUBPROCESS-leak probe for the bash tool (src/agent/tools.ts:bashTool).
 *
 * The heap probe (scripts/mem-probe.ts) only measures the parent V8 heap, so it is
 * BLIND to the resources a spawned child consumes: the child process itself (zombie
 * if never reaped), the two pipe file descriptors (stdout/stderr) the parent holds,
 * and the kernel pipe buffers behind them. This probe converts the "subprocess memory
 * is not released" hypothesis into RUNTIME EVIDENCE by counting, per iteration:
 *
 *   - open file descriptors held by THIS process  (lsof on macOS, /proc/self/fd on Linux)
 *   - live direct child processes of THIS process  (pgrep -P)
 *
 * It exercises three lifecycles that mirror real `runBash` usage:
 *   NORMAL   — full happy path: spawn, drain stdout+stderr, await exited (the control).
 *   TIMEOUT  — command outlives the timeout; SIGTERM→SIGKILL escalation must reap it.
 *   ABANDON  — the streaming `for await (proc.stdout)` loop is broken early and
 *              `proc.exited` is NEVER awaited, nor stderr drained — the exact shape of
 *              an aborted/cancelled turn. THIS is the suspected leak: the child keeps
 *              running and its two pipe FDs stay open.
 *
 * A healthy lifecycle returns FD/child counts to their pre-iteration baseline. A leak
 * shows a monotonically rising count. Exits non-zero if any mode leaks beyond tolerance.
 *
 *   bun run scripts/subproc-probe.ts            # default 60 iters per mode
 *   ITERS=200 bun run scripts/subproc-probe.ts
 */

const ITERS = Number(process.env.ITERS ?? 60);
const isLinux = process.platform === "linux";

/** Count open file descriptors held by this process. */
async function fdCount(): Promise<number> {
  if (isLinux) {
    // Cheapest + most accurate on Linux: enumerate /proc/self/fd.
    const { readdirSync } = await import("node:fs");
    try { return readdirSync("/proc/self/fd").length; } catch { return -1; }
  }
  // macOS/BSD: lsof is the portable way to enumerate this process's descriptors.
  const proc = Bun.spawn(["lsof", "-p", String(process.pid)], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  // Subtract 1 for the header line; lsof itself is a separate pid so it isn't counted.
  return Math.max(0, text.trim().split("\n").length - 1);
}

/** Count live DIRECT child processes of this process. */
async function childCount(): Promise<number> {
  const proc = Bun.spawn(["pgrep", "-P", String(process.pid)], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited; // pgrep exits 1 when no matches — that's fine, we count lines.
  const lines = text.trim().split("\n").filter(Boolean);
  return lines.length;
}

/** Spawn a child the way runBash does, then run `body` to simulate a lifecycle. */
async function withChild(command: string, body: (proc: Bun.Subprocess) => Promise<void>): Promise<void> {
  const proc = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
  await body(proc as unknown as Bun.Subprocess);
}

/** NORMAL: drain both streams + await exited (mirrors runBash happy path). */
async function normal(): Promise<void> {
  await withChild("echo hello; echo err 1>&2", async (proc) => {
    const stderrP = new Response(proc.stderr as ReadableStream).text();
    await new Response(proc.stdout as ReadableStream).text();
    await stderrP;
    await proc.exited;
  });
}

/** TIMEOUT: long-running child, SIGTERM→SIGKILL escalation must reap it. */
async function timeout(): Promise<void> {
  await withChild("sleep 30", async (proc) => {
    const stderrP = new Response(proc.stderr as ReadableStream).text();
    const killTimer = setTimeout(() => { try { proc.kill(9); } catch {} }, 3000);
    try { proc.kill(); } catch {}
    await proc.exited;
    clearTimeout(killTimer);
    await new Response(proc.stdout as ReadableStream).text();
    await stderrP;
  });
}

/** ABANDON: break the stdout stream loop early; never await exited, never drain stderr.
 *  This is the aborted/cancelled-turn shape — RAW spawn with NO guard. Kept as the
 *  before-fix control: it MUST leak, proving the probe has teeth. */
async function abandon(): Promise<void> {
  await withChild("for i in $(seq 1 100000); do echo line-$i; done; sleep 30", async (proc) => {
    let n = 0;
    for await (const _chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      if (++n >= 1) break; // bail out mid-stream, just like a cancelled turn
    }
    // intentionally: no proc.exited, no proc.kill, no stderr drain
  });
}

/** FIXED: drive the ACTUAL patched bashTool with an AbortSignal that fires mid-stream.
 *  The finally-block reap + abort wiring must release the child and both pipe FDs, so
 *  this mode must NOT leak. This is the regression guard for the (B) patch. */
async function fixed(): Promise<void> {
  const { bashTool } = await import("../src/agent/tools");
  const ac = new AbortController();
  let streamed = 0;
  const p = bashTool(
    "for i in $(seq 1 100000); do echo line-$i; done; sleep 30",
    process.cwd(), 120_000, undefined, undefined,
    () => { if (++streamed === 1) ac.abort(); }, // abort as soon as output streams
    ac.signal,
  );
  // Safety net in case onProgress never fires before completion.
  setTimeout(() => ac.abort(), 200);
  await p;
}


/** ORPHAN: the `next-server` accumulation case. Drive the ACTUAL bashTool to
 *  background an fd-redirected daemon (`sleep … >/dev/null 2>&1 </dev/null &`) — the
 *  shape of `next dev > log &`. The grandchild reparents to init, so it is NOT a
 *  direct child of THIS process; the only honest metric is "did the daemon survive
 *  the turn". With the process-group reaper ON (default) every iteration's daemon
 *  must be reaped; an opt-out run (KEEP_BACKGROUND=1) must preserve them — the
 *  before/after contract that proves the fix is what closes the leak. */
async function orphanSurvivors(label: string, keepBackground: boolean): Promise<number> {
  const { bashTool } = await import("../src/agent/tools");
  const prev = process.env.JEO_KEEP_BACKGROUND;
  if (keepBackground) process.env.JEO_KEEP_BACKGROUND = "1";
  else delete process.env.JEO_KEEP_BACKGROUND;
  const pids: number[] = [];
  try {
    for (let i = 0; i < ITERS; i++) {
      const pidfile = `/tmp/jeo-orphan-probe-${process.pid}-${i}`;
      await bashTool(`sleep 60 >/dev/null 2>&1 </dev/null & echo $! > ${pidfile}`, process.cwd(), 10_000).catch(() => {});
      try { pids.push(Number((await Bun.file(pidfile).text()).trim())); } catch {}
      try { await (await import("node:fs/promises")).unlink(pidfile); } catch {}
    }
    await Bun.sleep(200);
    const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    console.log(`\n[${label}]`);
    console.log(`  backgrounded daemons: ${pids.length}   still alive after their turns: ${alive.length}`);
    console.log(`  ${alive.length === 0 ? "✓ every orphan reaped (no next-server accumulation)" : `${keepBackground ? "✓ daemons preserved (opt-out honored)" : "✗ ORPHANS LEAKED — next-server would accumulate"}`}`);
    // Always clean up the survivors so the probe leaves no strays.
    for (const pid of alive) { try { process.kill(pid, 9); } catch {} }
    return alive.length;
  } finally {
    if (prev === undefined) delete process.env.JEO_KEEP_BACKGROUND;
    else process.env.JEO_KEEP_BACKGROUND = prev;
  }
}


async function measure(label: string, run: () => Promise<void>): Promise<{ fdSlope: number; childMax: number; leak: boolean }> {
  // Reap any strays a previous mode (notably the ABANDON control) intentionally
  // leaked, then wait for the OS to drain them, so THIS mode measures a clean
  // baseline instead of inheriting another mode's zombies/FDs.
  try { Bun.spawnSync(["pkill", "-P", String(process.pid)]); } catch {}
  for (let i = 0; i < 20; i++) {
    if (await childCount() === 0) break;
    await Bun.sleep(50);
  }
  // settle baseline
  await run().catch(() => {});
  await Bun.sleep(50);
  const fd0 = await fdCount();
  const samples: number[] = [];
  let childMax = 0;
  for (let i = 0; i < ITERS; i++) {
    await run().catch(() => {});
    // small yield so the OS can reap cleanly-closed children before we sample
    await Bun.sleep(5);
    samples.push(await fdCount());
    childMax = Math.max(childMax, await childCount());
  }
  // least-squares slope of FD count vs iteration
  const n = samples.length;
  const mx = (n - 1) / 2;
  const my = samples.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  samples.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  const fdSlope = den ? num / den : 0;
  const fdNet = samples[n - 1] - fd0;
  const leak = fdSlope > 0.25 || fdNet > 8 || childMax > 4;
  console.log(`\n[${label}]`);
  console.log(`  fd baseline: ${fd0}   fd final: ${samples[n - 1]}   net: ${fdNet >= 0 ? "+" : ""}${fdNet}`);
  console.log(`  fd slope/iter: ${fdSlope.toFixed(3)}   peak live children: ${childMax}`);
  console.log(`  ${leak ? "✗ LEAK SUSPECTED" : "✓ no leak: fd/children return to baseline"}`);
  return { fdSlope, childMax, leak };
}

console.log(`subproc-probe: ${ITERS} iters/mode  platform=${process.platform}`);
const results = {
  normal: await measure("NORMAL  (drain + await exited)", normal),
  timeout: await measure("TIMEOUT (SIGTERM→SIGKILL reap)", timeout),
  // Control: raw unguarded abandon MUST leak — proves the probe actually detects the bug.
  abandon: await measure("ABANDON (raw spawn, no guard — before-fix control, MUST leak)", abandon),
  // The real regression guard: the patched bashTool under abort MUST NOT leak.
  fixed: await measure("FIXED   (patched bashTool + AbortSignal — must NOT leak)", fixed),
};

// Clean up any children we abandoned so the probe doesn't leave strays.
try { Bun.spawnSync(["pkill", "-P", String(process.pid)]); } catch {}

// The `next-server` accumulation guard: default reaping must leave ZERO orphaned
// daemons; the opt-out (KEEP_BACKGROUND=1) must preserve them (proving the reaper,
// not chance, is what closes the leak).
const orphanLeaked = await orphanSurvivors("ORPHAN  (bashTool reap ON — must reap every daemon)", false);
const optOutPreserved = await orphanSurvivors("ORPHAN  (KEEP_BACKGROUND=1 — must preserve daemons)", true);

// Pass criteria: the guarded paths (normal/timeout/fixed) must NOT leak, AND the
// unguarded control (abandon) MUST leak — otherwise the probe has lost its teeth.
const guardedLeak = results.normal.leak || results.timeout.leak || results.fixed.leak;
const controlHeldTeeth = results.abandon.leak;
if (guardedLeak) {
  console.log("\nRESULT: ✗ a guarded lifecycle leaks subprocess + pipe FDs.");
  process.exit(1);
}
if (!controlHeldTeeth) {
  console.log("\nRESULT: ✗ control (ABANDON) did not leak — probe lost its teeth, cannot trust the FIXED pass.");
  process.exit(2);
}
if (orphanLeaked > 0) {
  console.log(`\nRESULT: ✗ ${orphanLeaked} backgrounded daemon(s) survived their turn — next-server would accumulate.`);
  process.exit(3);
}
if (optOutPreserved === 0) {
  console.log("\nRESULT: ✗ KEEP_BACKGROUND=1 reaped daemons — opt-out broken, probe cannot trust the reap pass.");
  process.exit(4);
}
console.log("\nRESULT: ✓ guarded lifecycles release everything, control leaks as expected, and the reaper claims every backgrounded orphan (opt-out preserves them).");
