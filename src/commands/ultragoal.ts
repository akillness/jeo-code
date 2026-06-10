import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkflowState, writeWorkflowState, getLocalJocDir, type WorkflowState } from "../agent/state";
import { bashTool } from "../agent/tools";

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
      `[ERROR] No crystallized requirements found. Please run 'joc deep-interview' first.`
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
      `[WARN] No completed 'joc team' execution found (run deep-interview → ralplan → approve → team first).\n` +
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

  log(`Loaded ${criteria.length} acceptance criteria for verification.\n`);

  const results: { criterion: string; passed: boolean; output: string }[] = [];

  for (const criterion of criteria) {
    if (opts.signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    log(`[CHECK] Verifying: "${criterion}"`);
    
    let cmd = "bun test";
    if (criterion.toLowerCase().includes("run") || criterion.toLowerCase().includes("cli")) {
      cmd = "bun run src/cli.ts --help";
    }

    log(`  └─ Running validation command: '${cmd}'`);
    if (opts.onProgress) {
      opts.onProgress({ skill: "ultragoal", phase: "verifying", detail: `Verifying: ${criterion}` });
    }

    const res = await bashTool(cmd, cwd);
    
    results.push({
      criterion,
      passed: res.success,
      output: res.output.slice(0, 300) + (res.output.length > 300 ? "..." : "")
    });

    log(`  └─ Result: ${res.success ? "PASSED" : "FAILED"}`);
  }

  if (opts.signal?.aborted) {
    return { ok: false, reason: "aborted" };
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

  log(`\n[VERIFICATION COMPLETE] Report saved to: ${reportPath}`);
  log(`Overall status: ${status} (${passedCount}/${totalCount} passed)`);

  if (opts.onProgress) {
    opts.onProgress({ skill: "ultragoal", phase: "complete" });
  }

  return { ok: status === "SUCCESS" };
}

export async function runUltragoalCommand(): Promise<void> {
  await runUltragoalEngine();
}
