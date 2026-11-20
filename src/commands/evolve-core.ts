import { consultGjcForEvolution, formatProbeSummary } from "../agent/dev/evolution-bridge";
import {
  runHarness2OfflineEvolution,
  type OfflineEvolutionMode,
} from "../agent/dev/harness2-offline";
import chalk from "chalk";

export interface EvolveCoreCliOptions {
  domain?: string;
  target?: string;
  dryRun: boolean;
  help: boolean;
  offline?: boolean;
  mode?: OfflineEvolutionMode;
  k?: number;
}

function parseModeValue(raw: string | undefined): OfflineEvolutionMode | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "parallel" || v === "agg") return "parallel";
  if (v === "sequential" || v === "seq") return "sequential";
  return undefined;
}

export function parseEvolveCoreArgs(args: string[]): EvolveCoreCliOptions {
  const opts: EvolveCoreCliOptions = { dryRun: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a === "--offline") {
      opts.offline = true;
    } else if (a === "--domain" && args[i + 1]) {
      opts.domain = args[++i];
    } else if (a.startsWith("--domain=")) {
      opts.domain = a.slice("--domain=".length);
    } else if (a === "--target" && args[i + 1]) {
      opts.target = args[++i];
    } else if (a.startsWith("--target=")) {
      opts.target = a.slice("--target=".length);
    } else if (a === "--mode" && args[i + 1]) {
      const m = parseModeValue(args[++i]);
      if (m) opts.mode = m;
    } else if (a.startsWith("--mode=")) {
      const m = parseModeValue(a.slice("--mode=".length));
      if (m) opts.mode = m;
    } else if (a === "--k" && args[i + 1]) {
      const parsed = Number.parseInt(args[++i]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.k = parsed;
    } else if (a.startsWith("--k=")) {
      const parsed = Number.parseInt(a.slice("--k=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.k = parsed;
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
    console.log(
      "Usage: jeo evolve-core [--domain <name>] [--target <path>] [--offline] [--mode <parallel|sequential>] [--k <number>] [--dry-run]",
    );
    return;
  }

  const cwd = process.cwd();
  console.log("\n=== " + chalk.bold.magenta("jeo") + " Harness² Propose–Probe–Compose Evolution ===");

  try {
    if (opts.offline) {
      const res = await runHarness2OfflineEvolution(cwd, {
        domain: opts.domain,
        mode: opts.mode,
        k: opts.k,
        dryRun: opts.dryRun,
      });
      console.log("Mode           : " + res.mode + ` (k=${res.candidates.length})`);
      console.log("Base probe     : " + formatProbeSummary(res.base));
      console.log("Final probe    : " + formatProbeSummary(res.finalMeasurement));
      console.log(
        "Adopted        : " +
          (res.adoptedCandidates.length > 0
            ? chalk.green(`${res.adoptedCandidates.length} candidate(s)`)
            : chalk.yellow("0 (none adopted)")),
      );
      console.log("Library index  : " + res.indexPath);
      return;
    }

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
