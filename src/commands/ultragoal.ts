import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkflowState, writeWorkflowState, getLocalJeoDir, type WorkflowState } from "../agent/state";
import { bashTool } from "../agent/tools";
import { parseSeedAcceptanceCriteria, parseCriterion } from "../agent/seed";

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

  // Round-7 #2 (architect ref 7-Round7Workflow) + per-criterion verification:
  // The suite still runs ONCE as a global signal — a green suite NEVER fabricates a
  // per-criterion PASS (the old "run/cli → guaranteed-green --help" theater is gone).
  // What's new: a criterion authored with a trailing `{verify: <command>}` directive
  // is INDIVIDUALLY verifiable — ultragoal runs that command and records a real
  // PASS/FAIL. Criteria without a directive stay UNVERIFIED on green (we never
  // specifically proved them): honest by default, strengthenable on demand.
  const parsed = criteria.map(parseCriterion);
  const verifiableCount = parsed.filter(c => c.verify).length;

  log(`[CHECK] Running the verification suite once ('bun test') — a global signal, not per-criterion proof.`);
  if (opts.onProgress) {
    opts.onProgress({ skill: "ultragoal", phase: "verifying", detail: "Running verification suite" });
  }
  const suite = await bashTool("bun test", cwd);
  log(`  └─ Suite: ${suite.success ? "GREEN" : "FAILED"}`);

  if (opts.signal?.aborted) {
    return { ok: false, reason: "aborted" };
  }

  // Per-criterion checks: only a criterion carrying a {verify:...} directive runs an
  // individual command; everything else inherits the global suite signal.
  const results: { criterion: string; status: "passed" | "unverified" | "failed"; note: string }[] = [];
  for (const c of parsed) {
    if (c.verify) {
      if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
      if (opts.onProgress) {
        opts.onProgress({ skill: "ultragoal", phase: "verifying", detail: `Verifying: ${c.text}` });
      }
      log(`[CHECK] ${c.text}\n  └─ $ ${c.verify}`);
      const check = await bashTool(c.verify, cwd);
      log(`     ${check.success ? "PASS" : "FAIL"}`);
      results.push(
        check.success
          ? { criterion: c.text, status: "passed", note: `verified by \`${c.verify}\`` }
          : { criterion: c.text, status: "failed", note: `\`${c.verify}\` exited non-zero` },
      );
    } else if (suite.success) {
      results.push({ criterion: c.text, status: "unverified", note: "suite green — criterion not individually verified (add {verify: <cmd>})" });
    } else {
      results.push({ criterion: c.text, status: "failed", note: "verification suite failed" });
    }
  }

  if (opts.signal?.aborted) {
    return { ok: false, reason: "aborted" };
  }

  // Write verification report
  const reportDir = path.join(getLocalJeoDir(cwd), "state");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "ultragoal-report.md");

  const totalCount = results.length;
  const passedCount = results.filter(r => r.status === "passed").length;
  const failedCount = results.filter(r => r.status === "failed").length;
  const unverifiedCount = results.filter(r => r.status === "unverified").length;

  // Overall status taxonomy:
  //  FAILED      — the global suite is red, OR any individually-checked criterion failed.
  //  SUCCESS     — every criterion was individually verified and passed (no UNVERIFIED left).
  //  PARTIAL     — some criteria individually passed, but others remain UNVERIFIED.
  //  SUITE_GREEN — suite green but NO criterion was individually verified (legacy honest default).
  let status: string;
  if (!suite.success || failedCount > 0) {
    status = "FAILED";
  } else if (passedCount > 0 && unverifiedCount === 0) {
    status = "SUCCESS";
  } else if (passedCount > 0) {
    status = "PARTIAL";
  } else {
    status = "SUITE_GREEN";
  }

  const reportContent =
    `# Ultragoal Verification Report: ${interviewState.slug}\n` +
    `Date: ${new Date().toISOString()}\n` +
    `Status: ${status} — suite ${suite.success ? "green" : "FAILED"}; ` +
      `${totalCount} criteria (${passedCount} verified, ${unverifiedCount} unverified, ${failedCount} failed)\n` +
    `Plan: ${teamState?.plan_path ?? "(team not run)"}\n` +
    `Execution: ${teamState?.current_phase === "complete" ? "team complete" : "team NOT complete — verified current disk state"}\n\n` +
    `## Criteria Record\n` +
    `| Criterion | Status | Note |\n` +
    `|---|---|---|\n` +
    results.map(r => `| ${r.criterion} | ${r.status === "passed" ? "✅ PASSED" : r.status === "failed" ? "❌ FAILED" : "⚠️ UNVERIFIED"} | ${r.note} |`).join("\n") +
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
    passed: passedCount,
    total: totalCount,
  };
  await writeWorkflowState("ultragoal", ultragoalState, cwd);

  log(`\n[VERIFICATION COMPLETE] Report saved to: ${reportPath}`);
  log(
    verifiableCount > 0
      ? `Overall status: ${status} — ${passedCount}/${totalCount} criteria individually verified, ${unverifiedCount} unverified, ${failedCount} failed.`
      : `Overall status: ${status} — ${totalCount} criteria recorded; none individually verified (add {verify: <cmd>} to a criterion for a real per-criterion check).`,
  );


  if (opts.onProgress) {
    opts.onProgress({ skill: "ultragoal", phase: "complete" });
  }

  return { ok: status !== "FAILED" };
}

export async function runUltragoalCommand(): Promise<void> {
  await runUltragoalEngine();
}
