import { runAgentLoop, executorSystemPrompt, DEFAULT_TOOLS } from "../engine";
import { readGlobalConfig } from "../state";
import { runPostImplementationHooks } from "../hooks";
import { runAdvancedAnalysis } from "./advanced-analyzer";
import { logEvolution } from "./evolution-logger";

async function runEvolutionLoop(intent: string, cwd: string): Promise<void> {
  const config = await readGlobalConfig();
  const model = config.defaultModel || "fast";
  const systemPrompt = executorSystemPrompt();

  await runAgentLoop([{ role: "user", content: intent }], {
    cwd,
    systemPrompt,
    model,
    tools: DEFAULT_TOOLS,
    maxSteps: 50,
  });

  console.log("\n[jeo] Verifying implementation...");
  const verify = await runPostImplementationHooks(cwd, intent);
  
  if (!verify.success) {
    console.error("\n[jeo] Verification FAILED. Auto-repairing...");
    const repairTask = `Previous implementation failed verification.\nErrors:\n${verify.output}\n\nPlease fix.`;
    await runAgentLoop([{ role: "user", content: repairTask }], {
      cwd,
      systemPrompt,
      model,
      tools: DEFAULT_TOOLS,
      maxSteps: 30,
    });
  } else {
    console.log("\n[jeo] Verification SUCCESSFUL.");
  }
}

export async function consultGjcForAdvancedEvolution(cwd: string) {
  const report = await runAdvancedAnalysis(cwd);
  const timestamp = new Date().toISOString();
  
  await logEvolution({
    timestamp,
    target: "src/ai/model-manager.ts",
    request: report,
    status: "in_progress"
  }, cwd);

  console.log();
  console.log("[jeo-Core] Architectural Debt identified: Provider Coupling.");

  const request = `
I am jeo, the Core Engine. My Advanced Analyzer identified tight coupling between 'src/ai/model-manager.ts' and specific provider files.
Report: ${report}

As my implementation guide (gjc), please:
1. Design a 'Provider Registry' pattern in 'src/ai/provider-registry.ts'.
2. Provide a refactoring plan for 'src/ai/model-manager.ts' to use this registry for dynamic provider loading.
3. Ensure no breaking changes to the external ModelManager API.
  `;

  try {
    await runEvolutionLoop(request, cwd);
    
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/ai/model-manager.ts",
      request,
      status: "success"
    }, cwd);
    console.log("[jeo-Core] Advanced Provider Registry refactor SUCCESSFUL.");
  } catch (err: any) {
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/ai/model-manager.ts",
      request,
      status: "failed",
      verificationOutput: err.message
    }, cwd);
    throw err;
  }
}

export async function consultGjcForEvolution(cwd: string) {
  const { runSelfAnalysis } = await import("./self-analysis");
  const report = await runSelfAnalysis(cwd);
  const timestamp = new Date().toISOString();
  
  await logEvolution({
    timestamp,
    target: "src/agent/engine.ts",
    request: report,
    status: "in_progress"
  }, cwd);

  console.log();
  try {
    await runEvolutionLoop(report, cwd);
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/agent/engine.ts",
      request: report,
      status: "success"
    }, cwd);
  } catch (err: any) {
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/agent/engine.ts",
      request: report,
      status: "failed",
      verificationOutput: err.message
    }, cwd);
    throw err;
  }
}
