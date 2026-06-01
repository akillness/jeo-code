import { createInterface } from "node:readline/promises";
import { saveGlobalConfig, readGlobalConfig, type Config } from "../agent/state";

export async function runSetupCommand(): Promise<void> {
  const current = await readGlobalConfig();
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n=== @jeo-code CLI Configuration (joc setup) ===");
  console.log("Configure API keys, default models, and provider endpoints.\n");

  const anthropic = await rl.question(
    `Anthropic API Key [${current.providers.anthropic ? "********" : "None"}]: `
  );
  const openai = await rl.question(
    `OpenAI API Key [${current.providers.openai ? "********" : "None"}]: `
  );
  const gemini = await rl.question(
    `Gemini API Key [${current.providers.gemini ? "********" : "None"}]: `
  );

  const defaultModel = await rl.question(
    `Default Model [${current.defaultModel || "claude-3-5-sonnet"}]: `
  );

  const thinkingLevel = await rl.question(
    `Thinking Level (low, medium, high) [${current.thinkingLevel || "medium"}]: `
  );

  rl.close();

  const config: Config = {
    providers: {
      anthropic: anthropic.trim() || current.providers.anthropic,
      openai: openai.trim() || current.providers.openai,
      gemini: gemini.trim() || current.providers.gemini,
    },
    defaultModel: defaultModel.trim() || current.defaultModel || "claude-3-5-sonnet",
    thinkingLevel: (thinkingLevel.trim() || current.thinkingLevel || "medium") as "low" | "medium" | "high",
  };

  await saveGlobalConfig(config);
  console.log("\n[SUCCESS] Global configuration successfully saved to ~/.joc/config.json");
  console.log(`Default model: ${config.defaultModel}`);
  console.log(`Configured providers: ${Object.keys(config.providers).filter(k => config.providers[k as keyof typeof config.providers]).join(", ") || "None"}\n`);
}
