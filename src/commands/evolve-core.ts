import { consultGjcForEvolution } from "../agent/dev/evolution-bridge";
import chalk from "chalk";

/**
 * joc evolve-core: Triggers a self-evolution turn using gjc as a guide.
 */
export async function runEvolveCoreCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();
  console.log("\n=== " + chalk.bold.magenta("joc") + " Autonomous Core Evolution ===");
  
  try {
    await consultGjcForEvolution(cwd);
    console.log("\n" + chalk.green("✔") + " Evolution turn completed.");
  } catch (err: any) {
    console.error("\n" + chalk.red("✘") + " Evolution turn failed: " + err.message);
    process.exit(1);
  }
}
