/**
 * AC-5(b) cost check for the host-side workspace snapshot (src/agent/workspace-snapshot.ts).
 * Usage: bun scripts/measure-workspace-snapshot.ts [root]   (default: current directory)
 * Runs 5 snapshots with the production limits, prints `entries=<n> median_ms=<x> runs=[...]`,
 * and exits 1 when any run is not ok or the median is >= 250 ms.
 */
import * as path from "node:path";
import { WORKSPACE_SNAPSHOT_LIMITS, snapshotWorkspace } from "../src/agent/workspace-snapshot";

const RUNS = 5;
const BUDGET_MS = 250;
const root = path.resolve(process.argv[2] ?? ".");

const runs: number[] = [];
let entries = 0;
for (let i = 0; i < RUNS; i++) {
  const started = performance.now();
  const result = await snapshotWorkspace(root, WORKSPACE_SNAPSHOT_LIMITS);
  const ms = performance.now() - started;
  if (!result.ok) {
    console.error(`snapshot ${i + 1} of ${root} failed: ${result.reason}: ${result.detail}`);
    process.exit(1);
  }
  entries = result.entries;
  runs.push(ms);
}

const median = [...runs].sort((a, b) => a - b)[Math.floor(RUNS / 2)]!;
console.log(`entries=${entries} median_ms=${median.toFixed(2)} runs=[${runs.map(ms => ms.toFixed(2)).join(", ")}]`);
if (median >= BUDGET_MS) {
  console.error(`median ${median.toFixed(2)} ms is not under the ${BUDGET_MS} ms budget`);
  process.exit(1);
}
