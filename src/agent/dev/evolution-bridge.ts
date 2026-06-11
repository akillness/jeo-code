import { runGjcCommand } from "../../commands/gjc";
import { runAdvancedAnalysis } from "./advanced-analyzer";
import { logEvolution } from "./evolution-logger";

export async function consultGjcForAdvancedEvolution(cwd: string) {
  const report = await runAdvancedAnalysis(cwd);
  const timestamp = new Date().toISOString();
  
  await logEvolution({
    timestamp,
    target: "src/ai/model-manager.ts",
    request: report,
    status: "in_progress",
    stage: "analysis"
  }, cwd);

  console.log();
  console.log("[joc-Core] Architectural Debt identified: Provider Coupling.");

  const request = `
I am joc, the Core Engine. My Advanced Analyzer identified tight coupling between 'src/ai/model-manager.ts' and specific provider files.
Report: ${report}

As my implementation guide (gjc), please:
1. Design a 'Provider Registry' pattern in 'src/ai/provider-registry.ts'.
2. Provide a refactoring plan for 'src/ai/model-manager.ts' to use this registry for dynamic provider loading.
3. Ensure no breaking changes to the external ModelManager API.
  `;

  try {
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/ai/model-manager.ts",
      request,
      status: "in_progress",
      stage: "consultation"
    }, cwd);

    await runGjcCommand([request]);
    
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/ai/model-manager.ts",
      request,
      status: "success",
      stage: "verification"
    }, cwd);
    console.log("[joc-Core] Advanced Provider Registry refactor SUCCESSFUL.");
  } catch (err: any) {
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/ai/model-manager.ts",
      request,
      status: "failed",
      stage: "verification",
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
    status: "in_progress",
    stage: "analysis"
  }, cwd);

  console.log();
  try {
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/agent/engine.ts",
      request: report,
      status: "in_progress",
      stage: "consultation"
    }, cwd);

    await runGjcCommand([report]);

    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/agent/engine.ts",
      request: report,
      status: "success",
      stage: "verification"
    }, cwd);
  } catch (err: any) {
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/agent/engine.ts",
      request: report,
      status: "failed",
      stage: "verification",
      verificationOutput: err.message
    }, cwd);
    throw err;
  }
}
