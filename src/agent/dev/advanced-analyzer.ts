import { isDevMode } from "../state";
import { loadRecentTraces, summarizeTraces } from "./trace-collector";
import { checkAlwaysOnBudget } from "./harness2-offline";

export interface AdvancedAnalysisOptions {
  allowNonDev?: boolean;
  limit?: number;
  model?: string;
}

export async function runAdvancedAnalysis(
  cwd: string,
  opts: AdvancedAnalysisOptions = {},
): Promise<string> {
  if (!isDevMode() && !opts.allowNonDev) {
    throw new Error("Advanced analysis only available in Dev Mode");
  }

  const [traces, budget] = await Promise.all([
    loadRecentTraces(cwd, { limit: opts.limit ?? 50, model: opts.model }),
    checkAlwaysOnBudget(cwd),
  ]);

  const budgetLine = budget.ok
    ? `Always-on budget: OK (discipline=${budget.discipline.totalChars} chars, rules=${budget.ruleChars}/${budget.maxRuleChars} chars)`
    : `Always-on budget EXCEEDED: [${budget.exceeded.join(", ")}] (discipline=${budget.discipline.totalChars} chars, rules=${budget.ruleChars}/${budget.maxRuleChars} chars)`;

  if (traces.length === 0) {
    return (
      `Advanced Analysis Result: No execution traces recorded under .harness2/traces yet. ` +
      `${budgetLine}. Recommend baseline modularization and trace-guided Propose-Probe-Compose checks.`
    );
  }

  const summary = summarizeTraces(traces);
  const topTags =
    summary.recurringTags.length > 0
      ? summary.recurringTags
          .slice(0, 5)
          .map((t) => `${t.tag} (${t.count})`)
          .join(", ")
      : "none";

  const modelLines = Object.entries(summary.byModel)
    .map(
      ([m, stats]) =>
        `  - ${m}: ${stats.completed}/${stats.runs} completed (${(stats.successRate * 100).toFixed(0)}%)${
          stats.topTags.length > 0 ? ` [tags: ${stats.topTags.join(", ")}]` : ""
        }`,
    )
    .join("\n");

  return [
    `Advanced Trace-Backed Analysis (${summary.totalRuns} recent run(s)):`,
    `- Success rate: ${(summary.successRate * 100).toFixed(1)}% (${summary.completedRuns}/${summary.totalRuns}), avg steps: ${summary.avgSteps.toFixed(1)}, tool error rate: ${(summary.toolErrorRate * 100).toFixed(1)}%`,
    `- Recurring failure tags: ${topTags}`,
    `- ${budgetLine}`,
    ...(modelLines ? ["- Model breakdown:", modelLines] : []),
  ].join("\n");
}
