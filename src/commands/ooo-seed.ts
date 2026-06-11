import { syncSpecificationToSeed } from "../agent/dev/spec-automation";
import { categoryBadge } from "../tui/components/category-index";
import chalk from "chalk";

/**
 * jeo ooo-seed: Syncs .specify/specification.md to an ooo seed.
 */
export async function runOooSeedCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();
  console.log(`\n=== ${chalk.bold("ooo seed")} Specification Sync ===`);
  
  try {
    await syncSpecificationToSeed(cwd);
    console.log(`\n${categoryBadge("done")} ooo seed sync completed.`);
  } catch (err: any) {
    console.error(`\n${categoryBadge("error")} ooo seed sync failed: ${err.message}`);
    process.exit(1);
  }
}
