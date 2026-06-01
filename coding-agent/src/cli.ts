#!/usr/bin/env bun
import { runSetupCommand } from "./commands/setup";
import { runDeepInterviewCommand } from "./commands/deep-interview";
import { runRalplanCommand } from "./commands/ralplan";
import { runTeamCommand } from "./commands/team";
import { runUltragoalCommand } from "./commands/ultragoal";

const APP_NAME = "joc";
const VERSION = "0.1.0";

const argv = process.argv.slice(2);
const first = argv[0];

async function runCli(): Promise<void> {
  if (first === "--version" || first === "-v") {
    console.log(`${APP_NAME} v${VERSION}`);
    return;
  }

  if (first === "--help" || first === "-h" || !first) {
    showHelp();
    return;
  }

  const args = argv.slice(1);

  switch (first) {
    case "setup":
      await runSetupCommand();
      break;
    case "deep-interview":
      await runDeepInterviewCommand(args);
      break;
    case "ralplan":
      await runRalplanCommand();
      break;
    case "team":
      await runTeamCommand();
      break;
    case "ultragoal":
      await runUltragoalCommand();
      break;
    default:
      console.log(`Unknown command: ${first}`);
      showHelp();
      process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
=== @jeo-code CLI (${APP_NAME}) ===
Clean, highly optimized AI coding agent using a Socratic spec-first loop.

Usage:
  joc <command> [arguments]

Commands:
  setup            Configure LLM providers and default models interactively.
  deep-interview   Execute Socratic requirements interview.
                   Locks mutating tools while ambiguity score > 20%.
  ralplan          Create planning blueprint blueprint (Planner/Architect/Critic).
  team             Execute the planning blueprint (Executor subagent tools).
  ultragoal        Verify goals and run acceptance checks.

Options:
  -v, --version    Show version.
  -h, --help       Show help.
`);
}

await runCli();
