/**
 * `jeo routine init` — generate a GitHub Actions workflow that runs
 * `jeo "<prompt>" -p` headlessly on a schedule or repo event.
 *
 * This is the SCOPED-SAFE take on "Routines": jeo-code itself never runs a
 * scheduler, listens on a port, or accepts a webhook — it's a pure template
 * generator. GitHub's own hosted runners do the actual triggering/running,
 * which achieves "runs without your laptop" with zero new attack surface
 * inside jeo-code's own process. See ../util/routine-template.ts for the
 * pure YAML-building logic this command wraps with flag parsing + I/O.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderRoutineWorkflow, validateCron, type RoutineConfig, type RoutineTrigger } from "../util/routine-template";
import { slugify } from "../agent/memory-okf";

const TRIGGERS: readonly RoutineTrigger[] = ["schedule", "issues", "pull_request"];
function isTrigger(val: string | undefined): val is RoutineTrigger {
  return val !== undefined && (TRIGGERS as readonly string[]).includes(val);
}

const VALUE_FLAGS: Record<string, true> = { "--name": true, "--trigger": true, "--cron": true, "--prompt": true, "--api-key-env": true, "--out": true };

interface ParsedInit {
  name: string;
  triggerRaw?: string;
  cron?: string;
  prompt?: string;
  apiKeyEnvVar: string;
  openPr: boolean;
  out?: string;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  /** Parse-level problems: unknown flags, or a value-flag given with no value. */
  errors: string[];
}

/** `--flag value` or `--flag=value`, matching launch/flags.ts's takeValue shape
 *  (a bare value-flag followed by another `-`-prefixed token is treated as
 *  missing, not as accidentally swallowing the next flag). */
function takeValue(args: string[], index: number, flag: string): { value?: string; nextIndex: number } {
  const current = args[index]!;
  const inline = `${flag}=`;
  if (current.startsWith(inline)) return { value: current.slice(inline.length), nextIndex: index };
  const next = args[index + 1];
  if (next !== undefined && !next.startsWith("-")) return { value: next, nextIndex: index + 1 };
  return { nextIndex: index };
}

function parseInitArgs(args: string[]): ParsedInit {
  const parsed: ParsedInit = {
    name: "jeo routine",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    openPr: true,
    force: false,
    dryRun: false,
    json: false,
    help: false,
    errors: [],
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;

    if (flag === "-h" || flag === "--help") { parsed.help = true; continue; }
    if (flag === "--no-pr") { parsed.openPr = false; continue; }
    if (flag === "--force") { parsed.force = true; continue; }
    if (flag === "--dry-run") { parsed.dryRun = true; continue; }
    if (flag === "--json") { parsed.json = true; continue; }

    if (VALUE_FLAGS[flag]) {
      const { value, nextIndex } = takeValue(args, i, flag);
      i = nextIndex;
      if (value === undefined) {
        parsed.errors.push(`${flag} requires a value`);
        continue;
      }
      switch (flag) {
        case "--name": parsed.name = value; break;
        case "--trigger": parsed.triggerRaw = value; break;
        case "--cron": parsed.cron = value; break;
        case "--prompt": parsed.prompt = value; break;
        case "--api-key-env": parsed.apiKeyEnvVar = value; break;
        case "--out": parsed.out = value; break;
      }
      continue;
    }

    parsed.errors.push(`Unknown flag: ${a}`);
  }

  return parsed;
}

function printUsage(): void {
  console.log("Usage: jeo routine init [options]");
  console.log("");
  console.log('Generate a GitHub Actions workflow that runs `jeo "<prompt>" -p` headlessly');
  console.log("on a schedule or repo event. GitHub's own hosted runners do the triggering —");
  console.log("jeo-code never runs a scheduler or listens on a port for this.");
  console.log("");
  console.log("Options:");
  console.log("  --trigger <schedule|issues|pull_request>  Required. What fires the routine.");
  console.log("  --prompt <text>            Required. The task/goal text passed to `jeo -p`.");
  console.log('  --cron <expr>              Required when --trigger schedule (e.g. "0 7 * * *").');
  console.log('  --name <name>              Workflow display name. Default: "jeo routine".');
  console.log("  --api-key-env <VAR_NAME>   Secret env var name. Default: ANTHROPIC_API_KEY.");
  console.log("  --no-pr                    Commit directly to the branch instead of opening a PR.");
  console.log("  --out <path>               Output path. Default: .github/workflows/jeo-routine-<slug>.yml");
  console.log("  --force                    Overwrite an existing file at --out.");
  console.log("  --dry-run                  Print the rendered YAML instead of writing it.");
  console.log("  --json                     Machine-readable output.");
  console.log("  -h, --help                 Show this help message.");
}

async function runInit(args: string[]): Promise<void> {
  const parsed = parseInitArgs(args);

  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) console.log(`Error: ${e}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    printUsage();
    return;
  }

  const problems: string[] = [];
  if (!isTrigger(parsed.triggerRaw)) {
    problems.push(
      parsed.triggerRaw
        ? `--trigger must be one of: schedule, issues, pull_request (got '${parsed.triggerRaw}')`
        : "--trigger is required (one of: schedule, issues, pull_request)",
    );
  }
  if (!parsed.prompt) {
    problems.push("--prompt is required");
  }
  const trigger = isTrigger(parsed.triggerRaw) ? parsed.triggerRaw : undefined;
  if (trigger === "schedule") {
    if (!parsed.cron) {
      problems.push("--cron is required when --trigger schedule");
    } else if (!validateCron(parsed.cron)) {
      problems.push(`--cron '${parsed.cron}' does not look like a valid 5-field cron expression`);
    }
  }

  if (problems.length > 0) {
    for (const p of problems) console.log(`Error: ${p}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const config: RoutineConfig = {
    name: parsed.name,
    trigger: trigger!,
    cron: parsed.cron,
    prompt: parsed.prompt!,
    apiKeyEnvVar: parsed.apiKeyEnvVar,
    openPr: parsed.openPr,
  };

  let yaml: string;
  try {
    yaml = renderRoutineWorkflow(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (parsed.json) console.log(JSON.stringify({ error: msg }));
    else console.log(`Error: ${msg}`);
    process.exitCode = 1;
    return;
  }

  const outPath = parsed.out ?? path.join(".github", "workflows", `jeo-routine-${slugify(parsed.name)}.yml`);
  const resolvedOut = path.resolve(process.cwd(), outPath);

  if (parsed.dryRun) {
    if (parsed.json) console.log(JSON.stringify({ dryRun: true, out: resolvedOut, yaml }, null, 2));
    else console.log(yaml);
    return;
  }

  let exists = true;
  try {
    await fs.access(resolvedOut);
  } catch {
    exists = false;
  }
  if (exists && !parsed.force) {
    const msg = `${resolvedOut} already exists. Use --force to overwrite.`;
    if (parsed.json) console.log(JSON.stringify({ error: msg }));
    else console.log(`Error: ${msg}`);
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
  // Atomic write: build the file fully off to the side, then rename into
  // place, so a crash mid-write never leaves a truncated workflow file.
  const tmpPath = `${resolvedOut}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, yaml, "utf-8");
  await fs.rename(tmpPath, resolvedOut);

  if (parsed.json) {
    console.log(JSON.stringify({ wrote: resolvedOut, trigger, apiKeyEnvVar: parsed.apiKeyEnvVar, openPr: parsed.openPr }, null, 2));
    return;
  }

  console.log(`Wrote ${resolvedOut}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  - Add '${parsed.apiKeyEnvVar}' as a repo secret: Settings -> Secrets and variables -> Actions.`);
  if (trigger === "schedule") {
    console.log("  - Scheduled workflows only run on the repo's default branch, and GitHub may");
    console.log("    delay or skip scheduled runs on low-activity repos — this is documented");
    console.log("    GitHub Actions behavior, not a bug in the generated workflow.");
  }
  console.log(`  - Commit and push ${resolvedOut} to enable it.`);
}

export async function runRoutineCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "-h" || sub === "--help") {
    printUsage();
    return;
  }

  if (sub === undefined) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (sub !== "init") {
    console.log(`Unknown 'jeo routine' subcommand '${sub}'. Usage: jeo routine init [options]`);
    process.exitCode = 1;
    return;
  }

  await runInit(args.slice(1));
}
