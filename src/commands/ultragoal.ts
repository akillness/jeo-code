import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkflowState, writeWorkflowState, getLocalJocDir, type WorkflowState } from "../agent/state";
import { bashTool } from "../agent/tools";
import { parseSeedAcceptanceCriteria } from "../agent/seed";

export interface UltragoalEngineOptions {
  cwd?: string;
  signal?: AbortSignal;
  onProgress?: (e: { skill: string; phase: string; detail?: string }) => void;
  io?: {
    output?: (line: string) => void;
  };
}

export async function runUltragoalEngine(opts: UltragoalEngineOptions = {}): Promise<{ ok: boolean; reason?: string }> {
  const cwd = opts.cwd ?? process.cwd();

  const log = (msg?: any) => {
    const str = msg !== undefined ? String(msg) : "";
    if (opts.io?.output) {
      const lines = str.split("\n");
      for (const line of lines) {
        opts.io.output(line);
      }
    } else {
      console.log(str);
    }
  };

  if (opts.onProgress) {
    opts.onProgress({ skill: "ultragoal", phase: "start" });
  }

  if (opts.signal?.aborted) {
    return { ok: false, reason: "aborted" };
  }

  // Read state to find acceptance criteria
  const interviewState = await readWorkflowState("deep-interview", cwd);
  if (!interviewState || !interviewState.seed_path) {
    log(
      `[ERROR] No crystallized requirements found. Please run 'jeo deep-interview' first.`
    );
    return { ok: false, reason: "No crystallized requirements found" };
  }

  const seedPath = interviewState.seed_path;
  log(`\n=== Starting Ultragoal Verification Stage ===`);
  log(`Reading requirements and acceptance criteria from: ${seedPath}`);

  // Thread team execution state: verification should run AFTER the plan was executed.
  const teamState = await readWorkflowState("team", cwd);
  if (!teamState || teamState.current_phase !== "complete") {
    log(
      `[WARN] No completed 'jeo team' execution found (run deep-interview → ralplan → approve → team first).\n` +
      `       Verifying current repository state anyway — results reflect whatever is on disk now.`
    );
  } else {
    log(`Verifying against team execution (plan: ${teamState.plan_path ?? "?"}).`);
  }

  let seedContent = "";
  try {
    seedContent = await fs.readFile(seedPath, "utf-8");
  } catch (err: any) {
    log(`[ERROR] Failed to read seed file: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  // Parse acceptance criteria via the SHARED seed module (round-12) — the old
  // inline scan stripped EVERY double quote and mangled criteria like
  // `Display "Done" message`; the shared parser JSON-decodes what the
  // deep-interview writer JSON-encoded, so values round-trip exactly.
  const criteria: string[] = parseSeedAcceptanceCriteria(seedContent);

  if (criteria.length === 0) {
    criteria.push("Runs successfully in the terminal");
  }

  log(`Loaded ${criteria.length} acceptance criteria for verification.\n`);

  // Round-7 #2 (architect ref 7-Round7Workflow): the previous per-criterion loop
  // was verification THEATER — every criterion ran the same global `bun test`
  // (or a guaranteed-green `--help` when the text mentioned run/cli) and a
  // fabricated per-criterion ✅/❌ matrix was written to the ledger. Honest
  // contract: run the suite ONCE as a global signal; individual criteria are
  // UNVERIFIED unless individually proven. SUCCESS is not claimable from a
  // signal that cannot fail for the cases it pretends to cover.
  log(`[CHECK] Running the verification suite once ('bun test') — a global signal, not per-criterion proof.`);
  if (opts.onProgress) {
    opts.onProgress({ skill: "ultragoal", phase: "verifying", detail: "Running verification suite" });
  }
  const suite = await bashTool("bun test", cwd);
  log(`  └─ Suite: ${suite.success ? "GREEN" : "FAILED"}`);

  const results: { criterion: string; status: "unverified" | "failed"; note: string }[] = criteria.map(criterion =>
    suite.success
      ? { criterion, status: "unverified", note: "suite green — criterion not individually verified" }
      : { criterion, status: "failed", note: "verification suite failed" },
  );

  if (opts.signal?.aborted) {
    return { ok: false, reason: "aborted" };
  }

  // Write verification report
  const reportDir = path.join(getLocalJocDir(cwd), "state");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "ultragoal-report.md");

  const totalCount = results.length;
  const status = suite.success ? "SUITE_GREEN" : "FAILED";

  const reportContent =
    `# Ultragoal Verification Report: ${interviewState.slug}\n` +
    `Date: ${new Date().toISOString()}\n` +
    `Status: ${status} — suite ${suite.success ? "green" : "FAILED"}; ${totalCount} acceptance criteria recorded (not individually verified)\n` +
    `Plan: ${teamState?.plan_path ?? "(team not run)"}\n` +
    `Execution: ${teamState?.current_phase === "complete" ? "team complete" : "team NOT complete — verified current disk state"}\n\n` +
    `## Criteria Record\n` +
    `| Criterion | Status | Note |\n` +
    `|---|---|---|\n` +
    results.map(r => `| ${r.criterion} | ${r.status === "failed" ? "❌ FAILED" : "⚠️ UNVERIFIED"} | ${r.note} |`).join("\n") +
    `\n`;

  // Atomic temp+rename (zeroclaw): a torn report must not disagree with the state JSON.
  const tmpReport = `${reportPath}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmpReport, reportContent, "utf-8");
    await fs.rename(tmpReport, reportPath);
  } catch (err) {
    await fs.unlink(tmpReport).catch(() => {});
    throw err;
  }

  // Persist a machine-readable terminal phase so the chain is queryable end-to-end.
  const ultragoalState: WorkflowState = {
    active: false,
    current_phase: "complete",
    skill: "ultragoal",
    slug: interviewState.slug,
    seed_path: seedPath,
    plan_path: teamState?.plan_path,
    status,
    suite_green: suite.success,
    total: totalCount,
  };
  await writeWorkflowState("ultragoal", ultragoalState, cwd);

  log(`\n[VERIFICATION COMPLETE] Report saved to: ${reportPath}`);
  log(`Overall status: ${status} — ${totalCount} criteria recorded; none individually verified (add per-criterion checks for stronger claims).`);

  if (opts.onProgress) {
    opts.onProgress({ skill: "ultragoal", phase: "complete" });
  }

  return { ok: suite.success };
}

export async function runUltragoalCommand(): Promise<void> {
  await runUltragoalEngine();
}
