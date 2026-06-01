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

const VERSION = "0.1.0";

function help(): void {
  console.log(
    [
      `jeoc v${VERSION} — jeo-code CLI`,
      "",
      "Usage: jeoc <group> <subcommand> [flags]",
      "",
      "Groups:",
      "  autopilot   Autonomous build loop (autopilot × autoresearch ratchet)",
      "  ledger      Cross-plan append-only ledger (ledger / review / cleanup)",
      "",
      "Examples:",
      '  jeoc autopilot init --task "tune X" --eval "bash eval.sh" --goal min',
      "  jeoc autopilot loop --runner \"bash mutate.sh\" --max 20",
      "  jeoc autopilot status --json",
      '  jeoc ledger register G001 --title "..." && jeoc ledger status',
    ].join("\n"),
  );
}

function main(): void {
  const [, , group, ...rest] = process.argv;
  switch (group) {
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
