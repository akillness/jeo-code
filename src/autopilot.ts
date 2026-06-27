/**
 * jeo autopilot — autonomous build loop hardened with autoresearch ratcheting.
 *
 * Fuses two skills:
 *  - /skill:autopilot  : end-to-end plan -> implement -> verify -> stop loop
 *  - /skill:autoresearch : frozen evaluator, one change per step, keep-if-improved /
 *                          revert-otherwise by score, append-only log, baseline-first,
 *                          convergence/stop discipline.
 *
 * The engine owns the RATCHET BRAIN (decision + evidence ledger), not destructive
 * git ops. Mutation ("make one change") is supplied by the operator/agent via a
 * runner command; reverts run an operator-supplied --on-revert hook.
 *
 * State (per cwd):
 *   .jeo/autopilot/session.json   frozen contract (immutable for the session)
 *   .jeo/autopilot/log.jsonl      append-only attempt log (baseline, steps, stops)
 *
 * No external dependencies (Node stdlib only). Runs under Bun or Node.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { renderAutopilotStatusPanel, type AutopilotStatusPanelData } from "./tui/components/autopilot-status";

const AP_DIR = path.join(".jeo", "autopilot");
const SESSION = path.join(AP_DIR, "session.json");
const LOG = path.join(AP_DIR, "log.jsonl");
function getShell(): string | undefined {
  if (process.platform === "win32") return undefined;
  return process.env.SHELL || "/bin/bash";
}

export type Goal = "min" | "max" | "gate";

interface Session {
  task: string;
  evalCmd: string;
  goal: Goal;
  timeoutSec: number;
  patience: number;
  createdAt: string;
  frozen: true;
}

const GOALS: readonly Goal[] = ["min", "max", "gate"];

function isGoal(value: string): value is Goal {
  return (GOALS as readonly string[]).includes(value);
}

function parseGoal(raw: string | undefined): Goal {
  const goal = raw ?? "min";
  if (!isGoal(goal)) die("--goal must be min|max|gate");
  return goal;
}

function parsePositiveIntegerFlag(flags: Record<string, string>, name: string, fallback: number): number {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) die(`--${name} must be a positive integer`);
  return parsed;
}

interface LogEvent {
  ts: string;
  type: "baseline" | "step" | "stop";
  [k: string]: unknown;
}

type LogEventInput = {
  type: LogEvent["type"];
  [k: string]: unknown;
};

function die(msg: string): never {
  console.error(`jeo autopilot: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = "true";
      else {
        flags[key] = next;
        i++;
      }
    } else positionals.push(a);
  }
  return { positionals, flags };
}

function loadSession(): Session {
  if (!fs.existsSync(SESSION)) die("no session — run: jeo autopilot init --task <t> --eval <cmd>");
  return JSON.parse(fs.readFileSync(SESSION, "utf8")) as Session;
}

function appendLog(ev: LogEventInput): LogEvent {
  const full: LogEvent = { ts: new Date().toISOString(), ...ev };
  fs.appendFileSync(LOG, JSON.stringify(full) + "\n");
  return full;
}

function readLog(): LogEvent[] {
  if (!fs.existsSync(LOG)) return [];
  return fs
    .readFileSync(LOG, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogEvent);
}

/** Run the frozen eval. Returns { score, passed }. score is NaN when no score: line. */
function runEval(s: Session): { score: number; passed: boolean; output: string } {
  let output = "";
  let passed = true;
  try {
    output = execSync(s.evalCmd, {
      encoding: "utf8",
      timeout: s.timeoutSec * 1000,
      stdio: ["ignore", "pipe", "pipe"],
      shell: getShell(),
    });
  } catch (e: unknown) {
    passed = false;
    const err = e as { stdout?: string; stderr?: string };
    output = (err.stdout ?? "") + (err.stderr ?? "");
  }
  const matches = [...output.matchAll(/score:\s*(-?\d+(?:\.\d+)?)/gi)];
  const score = matches.length ? Number(matches[matches.length - 1][1]) : NaN;
  return { score, passed, output: output.trim() };
}

/** Best kept score so far, folding baseline + kept steps. undefined if none. */
export function bestScoreFromLog(
  goal: Goal,
  log: Iterable<{ type: unknown; decision?: unknown; score?: unknown }>,
): number | undefined {
  let best: number | undefined;
  for (const ev of log) {
    if (ev.type === "baseline" || (ev.type === "step" && ev.decision === "keep")) {
      const sc = ev.score;
      if (typeof sc === "number" && !Number.isNaN(sc)) {
        best = foldBest(goal, best, sc);
      }
    }
  }
  return best;
}

function currentBest(s: Session): number | undefined {
  return bestScoreFromLog(s.goal, readLog());
}

function isImprovement(goal: Goal, score: number, best: number | undefined): boolean {
  if (best === undefined) return true;
  if (goal === "min") return score < best;
  if (goal === "max") return score > best;
  return true; // gate handled via passed, not score
}

/** Fold one KEPT step's score into the running best, mirroring currentBest's
 *  reduction so an in-memory best (loop hot path) never diverges from a fresh
 *  log re-scan. NaN scores never become the best; gate tracks the last value. */
export function foldBest(goal: Goal, best: number | undefined, score: number): number | undefined {
  if (Number.isNaN(score)) return best;
  if (best === undefined) return score;
  if (goal === "min") return Math.min(best, score);
  if (goal === "max") return Math.max(best, score);
  return score;
}

/**
 * Single source of truth for the ratchet keep/revert decision. Shared by step,
 * loop, and status so they can never diverge.
 *  - gate goal: keep iff the eval passed (score is irrelevant).
 *  - min/max goal: a non-measurable (NaN) score can never prove improvement, so
 *    it is always reverted; otherwise keep iff it improves on the best so far.
 */
export function decideStep(
  goal: Goal,
  score: number,
  passed: boolean,
  best: number | undefined,
): "keep" | "revert" {
  if (goal === "gate") return passed ? "keep" : "revert";
  if (Number.isNaN(score)) return "revert";
  return isImprovement(goal, score, best) ? "keep" : "revert";
}

/**
 * Convergence is a streak of consecutive no-progress steps (reverts) reaching
 * patience — for every goal, gate included. A gate loop that keeps failing has
 * made no forward progress and must stop early instead of burning the budget.
 */
export function isConverged(sinceImprove: number, patience: number): boolean {
  return sinceImprove >= patience;
}

function hasBaseline(): boolean {
  return readLog().some((e) => e.type === "baseline");
}

// ── commands ──────────────────────────────────────────────────────────────

function cmdInit(flags: Record<string, string>): void {
  if (fs.existsSync(SESSION) && flags.force !== "true") {
    die(`session already frozen at ${SESSION} (use --force to overwrite)`);
  }
  if (!flags.task) die("init requires --task");
  if (!flags.eval) die("init requires --eval <command that prints 'score: N' or exits 0/1>");
  const goal = parseGoal(flags.goal);
  fs.mkdirSync(AP_DIR, { recursive: true });
  const session: Session = {
    task: flags.task,
    evalCmd: flags.eval,
    goal,
    timeoutSec: parsePositiveIntegerFlag(flags, "timeout", 300),
    patience: parsePositiveIntegerFlag(flags, "patience", 3),
    createdAt: new Date().toISOString(),
    frozen: true,
  };
  fs.writeFileSync(SESSION, JSON.stringify(session, null, 2) + "\n");
  // fresh log on (re)init
  fs.writeFileSync(LOG, "");
  console.log(`jeo autopilot: session frozen → ${SESSION}`);
  console.log(`  task=${session.task}`);
  console.log(`  eval=${session.evalCmd}  goal=${session.goal}  timeout=${session.timeoutSec}s  patience=${session.patience}`);
}

function cmdBaseline(): void {
  const s = loadSession();
  if (hasBaseline()) die("baseline already recorded (re-init to reset)");
  const { score, passed, output } = runEval(s);
  appendLog({ type: "baseline", score, passed, output });
  console.log(`jeo autopilot: baseline score=${fmt(score)} passed=${passed}`);
}

function cmdStep(flags: Record<string, string>): void {
  const s = loadSession();
  if (s.goal !== "gate" && !hasBaseline()) die("record a baseline first: jeo autopilot baseline");
  const change = flags.change ?? "(unspecified change)";
  const best = currentBest(s);
  const { score, passed, output } = runEval(s);

  const decision = decideStep(s.goal, score, passed, best);

  if (decision === "revert" && flags["on-revert"]) {
    try {
      execSync(flags["on-revert"], { stdio: "inherit", shell: getShell() });
    } catch {
      console.error("jeo autopilot: --on-revert hook failed (decision still logged)");
    }
  }

  appendLog({ type: "step", change, score, passed, decision, prevBest: best ?? null, output });
  const cmp =
    s.goal === "gate"
      ? passed ? "pass" : "fail"
      : `${fmt(score)} vs best ${fmt(best)}`;
  console.log(`jeo autopilot: step ${decision.toUpperCase()}  (${cmp})  — ${change}`);
}

function cmdLoop(flags: Record<string, string>): void {
  const s = loadSession();
  const runner = flags.runner;
  if (!runner) die("loop requires --runner <command that makes ONE change>");
  const max = parsePositiveIntegerFlag(flags, "max", 10);
  if (s.goal !== "gate" && !hasBaseline()) {
    const { score, passed, output } = runEval(s);
    appendLog({ type: "baseline", score, passed, output });
    console.log(`jeo autopilot: auto-baseline score=${fmt(score)}`);
  }

  let sinceImprove = 0;
  // Keep `best` in memory across iterations instead of re-reading and re-parsing
  // the whole append-only log on every step (currentBest scans LOG each call).
  // Folded forward on each kept step to match a fresh currentBest() exactly.
  let best = currentBest(s);
  for (let i = 1; i <= max; i++) {
    // mutate: runner makes exactly one change
    let runnerOk = true;
    try {
      execSync(runner, { stdio: "inherit", timeout: s.timeoutSec * 1000, shell: getShell() });
    } catch {
      runnerOk = false;
    }
    if (!runnerOk) {
      appendLog({ type: "stop", reason: "runner_failed", iteration: i });
      console.log(`jeo autopilot: stop — runner failed at iteration ${i}`);
      return;
    }

    const { score, passed, output } = runEval(s);
    const decision = decideStep(s.goal, score, passed, best);

    if (decision === "revert" && flags["on-revert"]) {
      try {
        execSync(flags["on-revert"], { stdio: "inherit", shell: getShell() });
      } catch {
        /* logged below regardless */
      }
    }
    appendLog({ type: "step", iteration: i, change: `loop#${i}`, score, passed, decision, prevBest: best ?? null, output });
    // A keep is forward progress (min/max: provably an improvement; gate: a pass).
    // Anything else extends the no-progress streak toward convergence.
    if (decision === "keep") best = foldBest(s.goal, best, score);
    sinceImprove = decision === "keep" ? 0 : sinceImprove + 1;
    console.log(`jeo autopilot: loop ${i}/${max} ${decision.toUpperCase()} score=${fmt(score)} (sinceImprove=${sinceImprove})`);

    if (isConverged(sinceImprove, s.patience)) {
      appendLog({ type: "stop", reason: "converged", iteration: i, patience: s.patience });
      console.log(`jeo autopilot: stop — converged (no improvement in ${s.patience} steps)`);
      return;
    }
  }
  appendLog({ type: "stop", reason: "max_iterations", iteration: max });
  console.log(`jeo autopilot: stop — reached max ${max} iterations`);
}

function cmdStatus(flags: Record<string, string>): void {
  const s = loadSession();
  const log = readLog();
  const steps = log.filter((e) => e.type === "step");
  const kept = steps.filter((e) => e.decision === "keep").length;
  const reverted = steps.filter((e) => e.decision === "revert").length;
  const baseline = log.find((e) => e.type === "baseline");
  const best = bestScoreFromLog(s.goal, log);
  const stop = [...log].reverse().find((e) => e.type === "stop");

  // convergence: steps since last keep (forward progress)
  let sinceImprove = 0;
  for (const e of steps) {
    if (e.decision === "keep") sinceImprove = 0;
    else sinceImprove++;
  }
  const converged = isConverged(sinceImprove, s.patience);

  let recommendation: string;
  if (stop) recommendation = `stopped: ${stop.reason as string}`;
  else if (converged) recommendation = "converged — stop or change strategy";
  else recommendation = "continue";

  const out: AutopilotStatusPanelData = {
    task: s.task,
    goal: s.goal,
    eval: s.evalCmd,
    baseline: fmt(baseline ? (baseline.score as number) : null),
    best: fmt(best ?? null),
    attempts: steps.length,
    kept,
    reverted,
    sinceImprove,
    converged,
    recommendation,
  };

  if (flags.json === "true") {
    console.log(JSON.stringify({
      ...out,
      baseline: baseline ? (baseline.score as number) : null,
      best: best ?? null,
    }, null, 2));
    return;
  }
  console.log(renderAutopilotStatusPanel(out, {
    cols: process.stdout.columns || 88,
    color: !!process.stdout.isTTY,
    unicode: true,
  }).join("\n"));
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return String(n);
}

function help(): void {
  console.log(
    [
      "jeo autopilot — autonomous build loop with autoresearch ratcheting",
      "",
      "  init --task <t> --eval <cmd> [--goal min|max|gate] [--timeout S] [--patience N]",
      "  baseline",
      "  step --change <desc> [--on-revert <cmd>]",
      "  loop --runner <cmd> [--max N] [--on-revert <cmd>]",
      "  status [--json]",
      "",
      "eval contract: command prints 'score: <number>' (min/max goals) or exits 0/1 (gate goal).",
    ].join("\n"),
  );
}

export function runAutopilot(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const { flags } = parseArgs(rest);
  switch (cmd) {
    case "init": cmdInit(flags); break;
    case "baseline": cmdBaseline(); break;
    case "step": cmdStep(flags); break;
    case "loop": cmdLoop(flags); break;
    case "status": cmdStatus(flags); break;
    case undefined:
    case "help":
    case "--help": help(); break;
    default: die(`unknown subcommand: ${cmd} (try: jeo autopilot help)`);
  }
}

// allow running this module directly: bun src/autopilot.ts <args>
if (import.meta.main) runAutopilot(process.argv.slice(2));
