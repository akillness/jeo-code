/**
 * jeoc end-to-end smoke tests — run the real CLI as a subprocess in temp dirs.
 * Covers: autopilot ratchet/convergence, regression revert + hook, gate mode,
 * frozen-eval immutability, and the cross-plan ledger verdict.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JEOC = join(import.meta.dir, "..", "bin", "jeoc.ts");
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jeoc-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", JEOC, ...args], { cwd: dir });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function writeEvalScripts() {
  // eval: score decreases with .ctr, plateaus at 5 (min goal => lower better)
  writeFileSync(
    join(dir, "eval.sh"),
    'ctr=$(cat .ctr 2>/dev/null || echo 0); s=$((10-ctr)); [ "$s" -lt 5 ] && s=5; echo "score: $s"\n',
  );
  // mutate: makes exactly ONE change
  writeFileSync(join(dir, "mutate.sh"), 'c=$(cat .ctr 2>/dev/null || echo 0); echo $((c+1)) > .ctr\n');
}

test("version prints", () => {
  const r = run(["--version"]);
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("0.2.0");
});

test("autopilot loop ratchets to best and converges", () => {
  writeEvalScripts();
  expect(run(["autopilot", "init", "--task", "min", "--eval", "bash eval.sh", "--goal", "min", "--patience", "3"]).code).toBe(0);
  expect(run(["autopilot", "baseline"]).code).toBe(0);
  expect(run(["autopilot", "loop", "--runner", "bash mutate.sh", "--max", "20"]).code).toBe(0);
  const st = JSON.parse(run(["autopilot", "status", "--json"]).out);
  expect(st.baseline).toBe(10);
  expect(st.best).toBe(5);
  expect(st.kept).toBe(5);
  expect(st.reverted).toBe(3);
  expect(st.converged).toBe(true);
});

test("frozen eval is immutable without --force", () => {
  writeEvalScripts();
  expect(run(["autopilot", "init", "--task", "t", "--eval", "bash eval.sh", "--goal", "min"]).code).toBe(0);
  const again = run(["autopilot", "init", "--task", "t2", "--eval", "echo score: 1", "--goal", "min"]);
  expect(again.code).not.toBe(0);
  // --force overrides
  expect(run(["autopilot", "init", "--task", "t2", "--eval", "bash eval.sh", "--goal", "min", "--force"]).code).toBe(0);
});

test("step reverts a regression and keeps an improvement", () => {
  writeFileSync(join(dir, "eval.sh"), 'v=$(cat .v 2>/dev/null || echo 100); echo "score: $v"\n');
  run(["autopilot", "init", "--task", "t", "--eval", "bash eval.sh", "--goal", "min"]);
  run(["autopilot", "baseline"]); // 100
  writeFileSync(join(dir, ".v"), "200"); // regression
  const bad = run(["autopilot", "step", "--change", "regress", "--on-revert", "echo 100 > .v"]);
  expect(bad.out).toContain("REVERT");
  writeFileSync(join(dir, ".v"), "80"); // improvement
  const good = run(["autopilot", "step", "--change", "improve"]);
  expect(good.out).toContain("KEEP");
  const st = JSON.parse(run(["autopilot", "status", "--json"]).out);
  expect(st.best).toBe(80);
  expect(st.kept).toBe(1);
  expect(st.reverted).toBe(1);
});

test("gate goal keys on exit code", () => {
  run(["autopilot", "init", "--task", "tests", "--eval", "test -f ok.flag", "--goal", "gate"]);
  expect(run(["autopilot", "step", "--change", "no flag"]).out).toContain("REVERT");
  writeFileSync(join(dir, "ok.flag"), "");
  expect(run(["autopilot", "step", "--change", "flag made"]).out).toContain("KEEP");
});

test("ledger reaches verified verdict", () => {
  run(["ledger", "init"]);
  run(["ledger", "register", "G001", "--title", "t"]);
  run(["ledger", "review", "G001", "--status", "CLEAR", "--evidence", "e"]);
  run(["ledger", "checkpoint", "G001", "--goal", "g1", "--status", "complete", "--evidence", "e"]);
  run(["ledger", "sweep", "G001", "--evidence", "e"]);
  expect(existsSync(join(dir, ".jeoc", "ledger.jsonl"))).toBe(true);
  const st = JSON.parse(run(["ledger", "status", "--json"]).out);
  expect(st.plans[0].verdict).toBe("verified");
});

test("ledger rejects bad review status", () => {
  run(["ledger", "init"]);
  run(["ledger", "register", "G001", "--title", "t"]);
  expect(run(["ledger", "review", "G001", "--status", "BOGUS", "--evidence", "e"]).code).not.toBe(0);
});
