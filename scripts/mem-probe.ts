#!/usr/bin/env bun
/**
 * Runtime memory-leak probe for the per-turn LaunchTui lifecycle.
 *
 * The static investigation (see test/leak-guards.test.ts) proves every per-turn
 * allocation in the interactive REPL is released: the resize listener, the spinner
 * interval, the in-flight abort harness (SIGINT/stdin listeners), the single
 * process "exit" safety net, and the bounded ring buffers (forgeSummaries ≤ 8,
 * StreamRegion ≤ 500, ToolList ≤ 500, activityLog cap). This script converts that
 * static claim into RUNTIME EVIDENCE: it drives N realistic full turns through real
 * LaunchTui instances — the exact churn pattern of the `while(true)` REPL loop in
 * src/commands/launch.ts — forcing GC between batches and reporting the per-turn
 * heap-used slope.
 *
 * A healthy result: heap-used returns to a flat baseline after GC, slope ≈ 0 bytes
 * per turn (no monotonic growth). A leak would show a positive, persistent slope and
 * a growing `process` listener count.
 *
 *   bun run scripts/mem-probe.ts            # default 2000 turns, 10 batches
 *   TURNS=8000 BATCHES=20 bun run scripts/mem-probe.ts
 *
 * It exits non-zero if the post-GC heap slope or the process listener count grows
 * beyond a tolerance — so it doubles as a CI-able long-term-leak gate.
 */
import { LaunchTui } from "../src/tui/app";
import { Renderer } from "../src/tui/renderer";

const TURNS = Number(process.env.TURNS ?? 2000);
const BATCHES = Number(process.env.BATCHES ?? 10);
const TOOLS_PER_TURN = Number(process.env.TOOLS_PER_TURN ?? 40);
const perBatch = Math.max(1, Math.floor(TURNS / BATCHES));

// Silence the differential renderer so the probe measures allocation, not terminal I/O.
const realRender = Renderer.prototype.render;
(Renderer.prototype as unknown as { render: (f: string[]) => void }).render = function () {};

/** Drive one realistic full turn: start → step/assistant/tool-result × N → finish. */
function runTurn(turnIndex: number): void {
  const sink: string[] = [];
  const tui = new LaunchTui({ model: "probe-model", tty: true, write: s => sink.push(s) });
  tui.start();
  const ev = tui.events();
  for (let i = 0; i < TOOLS_PER_TURN; i++) {
    ev.onStep?.(i + 1);
    ev.onModelStream?.(`{"reasoning":"thinking about step ${i} of turn ${turnIndex}"}`);
    ev.onAssistant?.("", { tool: i % 2 === 0 ? "bash" : "read", arguments: { arg: i, turn: turnIndex } });
    ev.onToolResult?.(i % 2 === 0 ? "bash" : "read", true, `result-${i}-${"x".repeat(64)}`);
  }
  ev.onUsage?.({ inputTokens: 1234, outputTokens: 567 });
  tui.finish(`reply for turn ${turnIndex}`);
}

function gc(): void {
  // Bun.gc(true) is a synchronous full collection — the only reliable way to read a
  // settled baseline (Node's global.gc requires --expose-gc and is no-op under Bun).
  (Bun as unknown as { gc(force: boolean): void }).gc(true);
}

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

const exitBefore = process.listenerCount("exit");
const resizeBefore = process.stdout.listenerCount("resize");
const sigintBefore = process.listenerCount("SIGINT");

// Warm-up turn arms the module-level singletons (exit safety net, encoders) so they
// don't pollute the first measured batch as if they were a per-turn allocation.
runTurn(-1);
gc();
const baselineMB = heapMB();

const samples: { turn: number; heapMB: number; exitListeners: number }[] = [];
let done = 0;
// SYNC=1 keeps the old tight synchronous loop (starves the microtask/IO queue so the
// async readWorkflowStateStrict() promise opened in start() never resolves — its .then
// closure pins each LaunchTui, an ARTIFACT of the probe, not the REPL). The default
// drains the event loop between turns, exactly like the real `while(true)` REPL which
// awaits the model + tools between turns, letting those promises resolve and release.
const SYNC = process.env.SYNC === "1";
const drain = () => new Promise<void>(r => setTimeout(r, 0));
for (let b = 0; b < BATCHES; b++) {
  for (let i = 0; i < perBatch; i++) {
    runTurn(done++);
    if (!SYNC) await drain();
  }
  gc();
  await drain();
  gc();
  samples.push({ turn: done, heapMB: heapMB(), exitListeners: process.listenerCount("exit") });
}

Renderer.prototype.render = realRender;

// Least-squares slope of post-GC heap (MB) vs turns processed — the long-term trend.
const n = samples.length;
const meanX = samples.reduce((a, s) => a + s.turn, 0) / n;
const meanY = samples.reduce((a, s) => a + s.heapMB, 0) / n;
let num = 0;
let den = 0;
for (const s of samples) {
  num += (s.turn - meanX) * (s.heapMB - meanY);
  den += (s.turn - meanX) ** 2;
}
const slopeMBPerTurn = den === 0 ? 0 : num / den;
const slopeBytesPerTurn = slopeMBPerTurn * 1024 * 1024;
const lastMB = samples[n - 1]!.heapMB;
// Bun's incremental GC leaves the per-sample heap BIMODAL: a sample lands either on
// the settled floor (a turn's churn already collected) or on a transient peak (the
// most-recent batch's garbage not yet reclaimed when Bun.gc(true) returned). The
// TRUE retained-memory figure is the floor — the minimum settled heap the run keeps
// returning to. A real per-turn leak raises that floor monotonically; GC jitter only
// raises the peaks. Gate net growth on the settled floor (min over the trailing half
// of samples) so a final sample that happens to land on a peak can't false-positive.
const trailing = samples.slice(Math.floor(n / 2));
const settledFloorMB = Math.min(...trailing.map(s => s.heapMB));
const netGrowthMB = settledFloorMB - baselineMB;

const exitGrew = process.listenerCount("exit") - exitBefore;
const resizeGrew = process.stdout.listenerCount("resize") - resizeBefore;
const sigintGrew = process.listenerCount("SIGINT") - sigintBefore;

console.log(`mem-probe: ${done} turns × ${TOOLS_PER_TURN} tools/turn, ${BATCHES} post-GC samples\n`);
console.log("  turns      heapUsed(MB)   exit-listeners");
for (const s of samples) {
  console.log(`  ${String(s.turn).padStart(7)}    ${s.heapMB.toFixed(2).padStart(8)}      ${s.exitListeners}`);
}
console.log("");
console.log(`  baseline heap (post-warmup, post-GC): ${baselineMB.toFixed(2)} MB`);
console.log(`  final heap (post-GC):                 ${lastMB.toFixed(2)} MB`);
console.log(`  settled floor (min, trailing half):   ${settledFloorMB.toFixed(2)} MB`);
console.log(`  net heap growth over run (vs floor):  ${netGrowthMB >= 0 ? "+" : ""}${netGrowthMB.toFixed(2)} MB`);
console.log(`  per-turn heap slope:                  ${slopeBytesPerTurn >= 0 ? "+" : ""}${slopeBytesPerTurn.toFixed(0)} bytes/turn`);
console.log(`  process listener deltas:              exit ${exitGrew >= 0 ? "+" : ""}${exitGrew}, resize ${resizeGrew >= 0 ? "+" : ""}${resizeGrew}, SIGINT ${sigintGrew >= 0 ? "+" : ""}${sigintGrew}`);

// Leak gate. Tolerances are generous because GC timing adds MB-scale jitter to a
// settled baseline; a REAL per-turn leak compounds far past these bounds over 2000+
// turns. Listeners on the global `process`/`stdout` must NOT accumulate at all.
const SLOPE_TOLERANCE_BYTES = 4096; // 4 KB/turn ⇒ <8 MB over 2000 turns from jitter
const NET_TOLERANCE_MB = 12;
const failures: string[] = [];
if (slopeBytesPerTurn > SLOPE_TOLERANCE_BYTES)
  failures.push(`per-turn heap slope ${slopeBytesPerTurn.toFixed(0)} B/turn > ${SLOPE_TOLERANCE_BYTES} B/turn`);
if (netGrowthMB > NET_TOLERANCE_MB)
  failures.push(`net heap growth ${netGrowthMB.toFixed(2)} MB > ${NET_TOLERANCE_MB} MB`);
if (exitGrew > 1) failures.push(`process "exit" listeners grew by ${exitGrew} (expected ≤ 1)`);
if (resizeGrew !== 0) failures.push(`stdout "resize" listeners leaked: +${resizeGrew}`);
if (sigintGrew !== 0) failures.push(`process "SIGINT" listeners leaked: +${sigintGrew}`);

console.log("");
if (failures.length) {
  console.log("✗ LEAK SUSPECTED:");
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}
console.log("✓ no long-term leak detected: heap returns to baseline, no listener accumulation.");
