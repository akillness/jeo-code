#!/usr/bin/env bun
/**
 * jeoc — jeo-code umbrella CLI (rebrand of gjc / gajae-code).
 *
 * Subcommands:
 *   jeoc autopilot <...>   autonomous build loop with autoresearch ratcheting
 *   jeoc ledger <...>      cross-plan append-only ledger (ledger/review/cleanup)
 *   jeoc --version | -v
 *   jeoc help
 */

import { runAutopilot } from "../src/autopilot.ts";
import { runLedger } from "../src/ledger.ts";
import { runConfig } from "../src/config.ts";
import { runAgent } from "../src/agent.ts";
import { runSetup, runModels, runDoctor } from "../src/setup.ts";

const VERSION = "0.2.1";

function help(): void {
  console.log(
    [
      `jeoc v${VERSION} — jeo-code CLI`,
      "",
      "Usage: jeoc <group> <subcommand> [flags]",
      "",
      "Groups:",
      "  agent       Run the LLM coding-agent loop on a task",
      "  setup       Configure provider + model (onboarding)",
      "  models      List known/live models for a provider",
      "  doctor      Verify terminal install + provider/model readiness",
      "  config      Provider + model configuration (gemini/anthropic/openai/mock)",
      "  autopilot   Autonomous build loop (autopilot × autoresearch ratchet)",
      "  ledger      Cross-plan append-only ledger (ledger / review / cleanup)",
      "",
      "Examples:",
      "  jeoc setup --provider gemini --model gemini-2.5-flash",
      "  jeoc models --provider gemini --live",
      '  jeoc agent "add a hello() to util.ts and run the tests"',
      '  jeoc autopilot init --task "tune X" --eval "bash eval.sh" --goal min',
      '  jeoc ledger register G001 --title "..." && jeoc ledger status',
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [, , group, ...rest] = process.argv;
  switch (group) {
    case "agent":
    case "chat":
      await runAgent(rest);
      break;
    case "setup":
      runSetup(rest);
      break;
    case "models":
      await runModels(rest);
      break;
    case "doctor":
      await runDoctor(rest);
      break;
    case "config":
    case "cfg":
      runConfig(rest);
      break;
    case "autopilot":
    case "ap":
      runAutopilot(rest);
      break;
    case "ledger":
    case "l":
      runLedger(rest);
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      console.error(`jeoc: unknown group '${group}' (try: jeoc help)`);
      process.exit(1);
  }
}

main();
