import { runAgentLoop, executorSystemPrompt, DEFAULT_TOOLS } from "../agent/engine";
import { loadSkills, buildSkillTask, getSkillFrom } from "../skills/catalog";
import { readGlobalConfig, isDevMode } from "../agent/state";
import { runPostImplementationHooks } from "../agent/hooks";

export async function runGjcCommand(args: string[]): Promise<void> {
  const intent = args.join(" ").trim();
  const config = await readGlobalConfig();
  
  if (intent.toLowerCase().includes("self-improve") && !isDevMode()) {
    console.error("Error: Self-improvement tasks are only allowed in JEO_DEV_MODE=1.");
    process.exit(1);
  }

  const model = config.defaultModel || "fast";
  const skills = await loadSkills();
  const gjcSkill = getSkillFrom(skills, "gjc");

  if (!gjcSkill) {
    console.error("Error: gjc skill not found.");
    process.exit(1);
  }

  // Correct signature: executorSystemPrompt(role?, protocol?, verificationDirective?)
  const systemPrompt = executorSystemPrompt();
  const task = buildSkillTask(gjcSkill, intent);

  await runAgentLoop([{ role: "user", content: task }], {
    cwd: process.cwd(),
    systemPrompt,
    model,
    tools: DEFAULT_TOOLS,
    maxSteps: 50,
  });

  console.log("\n[jeo] Verifying implementation...");
  const verify = await runPostImplementationHooks(process.cwd(), intent);
  
  if (!verify.success) {
    console.error("\n[jeo] Verification FAILED. Auto-repairing...");
    const repairTask = `Previous implementation failed verification.\nErrors:\n${verify.output}\n\nPlease fix.`;
    await runAgentLoop([{ role: "user", content: repairTask }], {
      cwd: process.cwd(),
      systemPrompt,
      model,
      tools: DEFAULT_TOOLS,
      maxSteps: 30,
    });
  } else {
    console.log("\n[jeo] Verification SUCCESSFUL.");
  }
}
