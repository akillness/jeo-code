import pkg from "../../package.json";
import {
  loadBundledChangelog,
  parseChangelogSections,
  releaseSections,
  renderWhatsNew,
  RECENT_RELEASE_COUNT,
} from "../util/whats-new";
import { supportsUnicode } from "../tui/components/capability";

/** `jeo whats-new` — show the release notes bundled with the running version. */
export async function runWhatsNewCommand(args: string[] = []): Promise<void> {
  const isHelp = args.includes("--help") || args.includes("-h");
  const hasAll = args.includes("--all");
  const hasJson = args.includes("--json");

  const KNOWN = new Set(["--all", "--json", "-h", "--help"]);
  for (const arg of args) {
    if (!KNOWN.has(arg)) {
      console.log(`Unknown flag: ${arg}`);
      printUsage();
      process.exitCode = 1;
      return;
    }
  }

  if (isHelp) {
    printUsage();
    return;
  }

  const md = await loadBundledChangelog();
  const all = md ? releaseSections(parseChangelogSections(md)) : [];
  const sections = hasAll ? all : all.slice(0, RECENT_RELEASE_COUNT);

  if (hasJson) {
    console.log(JSON.stringify({ version: pkg.version, entries: sections }, null, 2));
    return;
  }

  if (sections.length === 0) {
    console.log(`No release notes found for jeo-code ${pkg.version}.`);
    return;
  }

  const cols = process.stdout.columns ?? 80;
  console.log(renderWhatsNew(sections, {
    cols: Math.min(100, Math.max(40, cols - 2)),
    unicode: supportsUnicode(),
    color: process.stdout.isTTY === true,
  }).join("\n"));
}

function printUsage(): void {
  console.log("Usage: jeo whats-new [options]");
  console.log("");
  console.log("Show the release notes bundled with the installed jeo-code version.");
  console.log("");
  console.log("Options:");
  console.log(`  --all        Show notes for every released version, not just the recent ${RECENT_RELEASE_COUNT}`);
  console.log("  --json       Output the notes as JSON");
  console.log("  -h, --help   Show this help message");
}
