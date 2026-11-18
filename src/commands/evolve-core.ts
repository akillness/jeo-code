import { consultGjcForEvolution, formatProbeSummary } from "../agent/dev/evolution-bridge";
import chalk from "chalk";

export interface EvolveCoreCliOptions {
  domain?: string;
  target?: string;
  dryRun: boolean;
  help: boolean;
}

export function parseEvolveCoreArgs(args: string[]): EvolveCoreCliOptions {
  const opts: EvolveCoreCliOptions = { dryRun: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a === "--domain" && args[i + 1]) {
      opts.domain = args[++i];
    } else if (a.startsWith("--domain=")) {
      opts.domain = a.slice("--domain=".length);
    } else if (a === "--target" && args[i + 1]) {
      opts.target = args[++i];
    } else if (a.startsWith("--target=")) {
      opts.target = a.slice("--target=".length);
    }
  }
  return opts;
}

/**
 * jeo evolve-core: Runs Harness² Propose–Probe–Compose self-evolution.
 */
export async function runEvolveCoreCommand(args: string[]): Promise<void> {
  const opts = parseEvolveCoreArgs(args);
  if (opts.help) {
    console.log("Usage: jeo evolve-core [--domain <name>] [--target <path>] [--dry-run]");
    return;
  }

  const cwd = process.cwd();
  console.log("\n=== " + chalk.bold.magenta("jeo") + " Harness² Propose–Probe–Compose Evolution ===");

  try {
    const res = await consultGjcForEvolution(cwd, {
      domain: opts.domain,
      target: opts.target,
      dryRun: opts.dryRun,
    });
    console.log("Base probe     : " + formatProbeSummary(res.base));
    console.log("Candidate probe: " + formatProbeSummary(res.candidate));
    console.log("Verdict        : " + (res.adopted ? chalk.green("ADOPTED") : chalk.yellow("REJECTED")) + ` (${res.verdict.reason})`);
    console.log("Library        : " + res.libraryPath);
  } catch (err: any) {
    console.error("\n" + chalk.red("✘") + " Evolution turn failed: " + err.message);
    process.exit(1);
  }
}
