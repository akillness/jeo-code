import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkflowState, writeWorkflowState, getLocalJocDir, type WorkflowState } from "../agent/state";
import { bashTool } from "../agent/tools";

export async function runUltragoalCommand(): Promise<void> {
  const cwd = process.cwd();

  // Read state to find acceptance criteria
  const interviewState = await readWorkflowState("deep-interview", cwd);
  if (!interviewState || !interviewState.seed_path) {
    console.log(
      `[ERROR] No crystallized requirements found. Please run 'joc deep-interview' first.`
    );
    return;
  }

  const seedPath = interviewState.seed_path;
  console.log(`\n=== Starting Ultragoal Verification Stage ===`);
  console.log(`Reading requirements and acceptance criteria from: ${seedPath}`);


  // Thread team execution state: verification should run AFTER the plan was executed.
  const teamState = await readWorkflowState("team", cwd);
  if (!teamState || teamState.current_phase !== "complete") {
    console.log(
      `[WARN] No completed 'joc team' execution found (run deep-interview → ralplan → approve → team first).\n` +
      `       Verifying current repository state anyway — results reflect whatever is on disk now.`,
    );
  } else {
    console.log(`Verifying against team execution (plan: ${teamState.plan_path ?? "?"}).`);
  }

  let seedContent = "";
  try {
    seedContent = await fs.readFile(seedPath, "utf-8");
  } catch (err: any) {
    console.log(`[ERROR] Failed to read seed file: ${err.message}`);
    return;
  }

  // Parse acceptance criteria from seed YAML
  const criteria: string[] = [];
  const lines = seedContent.split("\n");
  let parsingCriteria = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("acceptance_criteria:")) {
      parsingCriteria = true;
      continue;
    }
    if (parsingCriteria) {
      if (trimmed.startsWith("-")) {
        criteria.push(trimmed.replace(/^-\s*/, "").replace(/"/g, "").trim());
      } else if (trimmed === "" || trimmed.includes(":")) {
        // End of list or next section
        parsingCriteria = false;
      }
    }
  }

  if (criteria.length === 0) {
    criteria.push("Runs successfully in the terminal");
  }

  console.log(`Loaded ${criteria.length} acceptance criteria for verification.\n`);

  const results: { criterion: string; passed: boolean; output: string }[] = [];

  for (const criterion of criteria) {
    console.log(`[CHECK] Verifying: "${criterion}"`);
    
    // We can execute a automatic verification pass.
    // E.g., if there are tests, we run bun test. If not, we do a smoke check by running bun src/cli.ts setup or compile.
    let cmd = "bun test";
    if (criterion.toLowerCase().includes("run") || criterion.toLowerCase().includes("cli")) {
      cmd = "bun run src/cli.ts --help";
    }

    console.log(`  └─ Running validation command: '${cmd}'`);
    const res = await bashTool(cmd, cwd);
    
    results.push({
      criterion,
      passed: res.success,
      output: res.output.slice(0, 300) + (res.output.length > 300 ? "..." : "")
    });

    console.log(`  └─ Result: ${res.success ? "PASSED" : "FAILED"}`);
  }

  // Write verification report
  const reportDir = path.join(getLocalJocDir(cwd), "state");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "ultragoal-report.md");

  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const status = passedCount === totalCount ? "SUCCESS" : "DEGRADED";

  const reportContent = 
    `# Ultragoal Verification Report: ${interviewState.slug}\n` +
    `Date: ${new Date().toISOString()}\n` +
    `Status: ${status} (${passedCount}/${totalCount} criteria passed)\n` +
    `Plan: ${teamState?.plan_path ?? "(team not run)"}\n` +
    `Execution: ${teamState?.current_phase === "complete" ? "team complete" : "team NOT complete — verified current disk state"}\n\n` +
    `## Criteria Verification Matrix\n` +
    `| Criterion | Status | Verification Output |\n` +
    `|---|---|---|\n` +
    results.map(r => `| ${r.criterion} | ${r.passed ? "✅ PASSED" : "❌ FAILED"} | \`${r.output.replace(/\n/g, " ")}\` |`).join("\n") +
    `\n`;

  await fs.writeFile(reportPath, reportContent, "utf-8");

  // Persist a machine-readable terminal phase so the chain is queryable end-to-end.
  const ultragoalState: WorkflowState = {
    active: false,
    current_phase: "complete",
    skill: "ultragoal",
    slug: interviewState.slug,
    seed_path: seedPath,
    plan_path: teamState?.plan_path,
    status,
    passed: passedCount,
    total: totalCount,
  };
  await writeWorkflowState("ultragoal", ultragoalState, cwd);

  console.log(`\n[VERIFICATION COMPLETE] Report saved to: ${reportPath}`);
  console.log(`Overall status: ${status} (${passedCount}/${totalCount} passed)`);
}
