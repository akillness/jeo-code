import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import pkg from "../package.json";
import {
  parseChangelogSections,
  releaseSections,
  selectNewSections,
  renderWhatsNew,
  readLastSeenVersion,
  writeLastSeenVersion,
  consumeLaunchWhatsNew,
  loadBundledChangelog,
} from "../src/util/whats-new";
import { runWhatsNewCommand } from "../src/commands/whats-new";
import { runUpdateCommandWith, type UpdateDeps } from "../src/commands/update";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visibleWidth = (s: string) => stripAnsi(s).length;

const SAMPLE = `# Changelog

Intro prose ignored.

## [Unreleased]
_work in progress_

### Added
- a future thing

## [0.5.9] - 2026-06-15
_Bounded per-frame wrap for the live blocks._

### Changed
- The live thinking block is now bounded to a 16 KiB window.

## [0.5.8] - 2026-06-14
_Native Opik observability._

### Added
- Opik tracing for the turn loop.

### Changed
- Autopilot convergence tracking.

## [0.5.0] - 2026-06-10
_Older release._

### Fixed
- Some bug.
`;

// ---- parser -----------------------------------------------------------------

test("parseChangelogSections extracts version, date, summary, grouped bullets", () => {
  const sections = parseChangelogSections(SAMPLE);
  expect(sections.map(s => s.version)).toEqual(["Unreleased", "0.5.9", "0.5.8", "0.5.0"]);

  const v59 = sections.find(s => s.version === "0.5.9")!;
  expect(v59.date).toBe("2026-06-15");
  expect(v59.summary).toBe("Bounded per-frame wrap for the live blocks.");
  expect(v59.groups).toEqual([
    { label: "Changed", items: ["The live thinking block is now bounded to a 16 KiB window."] },
  ]);

  const v58 = sections.find(s => s.version === "0.5.8")!;
  expect(v58.groups.map(g => g.label)).toEqual(["Added", "Changed"]);
  expect(v58.groups[0]!.items).toEqual(["Opik tracing for the turn loop."]);
});

test("releaseSections drops the Unreleased heading", () => {
  const all = parseChangelogSections(SAMPLE);
  expect(releaseSections(all).map(s => s.version)).toEqual(["0.5.9", "0.5.8", "0.5.0"]);
});

// ---- selection --------------------------------------------------------------

test("selectNewSections returns releases in (from, to] and drops Unreleased", () => {
  const all = parseChangelogSections(SAMPLE);
  const picked = selectNewSections(all, "0.5.0", "0.5.9");
  expect(picked.map(s => s.version)).toEqual(["0.5.9", "0.5.8"]);
});

test("selectNewSections with null from includes everything up to toVersion", () => {
  const all = parseChangelogSections(SAMPLE);
  const picked = selectNewSections(all, null, "0.5.8");
  expect(picked.map(s => s.version)).toEqual(["0.5.8", "0.5.0"]);
});

// ---- render -----------------------------------------------------------------

test("renderWhatsNew single section shows title, summary, bullets", () => {
  const all = parseChangelogSections(SAMPLE);
  const section = all.find(s => s.version === "0.5.9")!;
  const joined = stripAnsi(renderWhatsNew([section], { cols: 80, color: true }).join("\n"));
  expect(joined).toContain("What's New in jeo 0.5.9");
  expect(joined).toContain("Bounded per-frame wrap");
  expect(joined).toContain("16 KiB window");
});

test("renderWhatsNew color:false emits no ANSI", () => {
  const all = parseChangelogSections(SAMPLE);
  const lines = renderWhatsNew(all.slice(1, 2), { cols: 80, color: false });
  for (const line of lines) expect(line).toBe(stripAnsi(line));
});

test("renderWhatsNew box has equal visible widths", () => {
  const all = parseChangelogSections(SAMPLE);
  const lines = renderWhatsNew(releaseSections(all), { cols: 72, color: false });
  expect(lines.length).toBeGreaterThan(2);
  const w = visibleWidth(lines[0]!);
  for (const line of lines) expect(visibleWidth(line)).toBe(w);
});

test("renderWhatsNew clips a large jump and notes the overflow", () => {
  const all = releaseSections(parseChangelogSections(SAMPLE));
  const joined = stripAnsi(renderWhatsNew(all, { cols: 80, color: false, maxBodyLines: 4 }).join("\n"));
  expect(joined).toContain("see CHANGELOG.md");
});

test("renderWhatsNew returns [] for no sections", () => {
  expect(renderWhatsNew([])).toEqual([]);
});

// ---- last-seen state + launch hook ------------------------------------------

const made: string[] = [];
async function withConfigDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jeo-whats-new-"));
  made.push(dir);
  process.env.JEO_CONFIG_DIR = dir;
  return dir;
}

afterEach(async () => {
  delete process.env.JEO_CONFIG_DIR;
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

test("write/read last-seen version round-trips", async () => {
  await withConfigDir();
  expect(await readLastSeenVersion()).toBeNull();
  await writeLastSeenVersion("0.4.2");
  expect(await readLastSeenVersion()).toBe("0.4.2");
  await writeLastSeenVersion(""); // ignored
  expect(await readLastSeenVersion()).toBe("0.4.2");
});

test("consumeLaunchWhatsNew is silent on a fresh install but records the version", async () => {
  await withConfigDir();
  expect(await consumeLaunchWhatsNew({ color: false })).toBeNull();
  expect(await readLastSeenVersion()).toBe(pkg.version);
});

test("consumeLaunchWhatsNew is silent when already current", async () => {
  await withConfigDir();
  await writeLastSeenVersion(pkg.version);
  expect(await consumeLaunchWhatsNew({ color: false })).toBeNull();
  expect(await readLastSeenVersion()).toBe(pkg.version);
});

test("consumeLaunchWhatsNew renders notes once after an upgrade, then records current", async () => {
  await withConfigDir();
  await writeLastSeenVersion("0.0.1"); // pretend a big upgrade
  const lines = await consumeLaunchWhatsNew({ color: false });
  expect(lines).not.toBeNull();
  expect(stripAnsi(lines!.join("\n"))).toContain("What's New");
  // Marked seen → a second launch is silent.
  expect(await readLastSeenVersion()).toBe(pkg.version);
  expect(await consumeLaunchWhatsNew({ color: false })).toBeNull();
});

// ---- bundled changelog + command --------------------------------------------

test("loadBundledChangelog reads the shipped CHANGELOG.md", async () => {
  const md = await loadBundledChangelog();
  expect(md).not.toBeNull();
  expect(md!).toContain("# Changelog");
});

test("whats-new command --json reports the running version and recent releases", async () => {
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: any[]) => { logged.push(a.join(" ")); };
  try {
    await runWhatsNewCommand(["--json"]);
  } finally {
    console.log = orig;
  }
  expect(logged.length).toBe(1);
  const parsed = JSON.parse(logged[0]!);
  expect(parsed.version).toBe(pkg.version);
  expect(Array.isArray(parsed.entries)).toBe(true);
  expect(parsed.entries.length).toBeGreaterThan(1);
  expect(parsed.entries.length).toBeLessThanOrEqual(5);
});

test("whats-new --all returns the full history; default is capped to the recent few", async () => {
  const count = async (args: string[]): Promise<number> => {
    const logged: string[] = [];
    const orig = console.log;
    console.log = (...a: any[]) => { logged.push(a.join(" ")); };
    try { await runWhatsNewCommand(args); } finally { console.log = orig; }
    return JSON.parse(logged[0]!).entries.length as number;
  };
  const def = await count(["--json"]);
  const all = await count(["--all", "--json"]);
  expect(def).toBeLessThanOrEqual(5);
  expect(all).toBeGreaterThanOrEqual(def);
});

test("whats-new command rejects unknown flags", async () => {
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: any[]) => { logged.push(a.join(" ")); };
  process.exitCode = 0;
  try {
    await runWhatsNewCommand(["--bogus"]);
  } finally {
    console.log = orig;
  }
  expect(logged.some(l => l.includes("Unknown flag"))).toBe(true);
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
});

test("update --install calls showWhatsNew on success (human path)", async () => {
  let notesShown = false;
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: any[]) => { logged.push(a.join(" ")); };
  process.exitCode = 0;
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "9.9.9" }),
    localVersion: () => "0.1.0",
    install: async () => ({ success: true }),
    showWhatsNew: () => { notesShown = true; },
  };
  try {
    await runUpdateCommandWith(["--install"], deps);
  } finally {
    console.log = orig;
  }
  expect(logged.some(l => l.includes("Successfully installed"))).toBe(true);
  expect(notesShown).toBe(true);
  process.exitCode = 0;
});

test("update --install --json does not show notes", async () => {
  let notesShown = false;
  const orig = console.log;
  console.log = () => {};
  process.exitCode = 0;
  const deps: UpdateDeps = {
    fetchJson: async () => ({ version: "9.9.9" }),
    localVersion: () => "0.1.0",
    install: async () => ({ success: true }),
    showWhatsNew: () => { notesShown = true; },
  };
  try {
    await runUpdateCommandWith(["--install", "--json"], deps);
  } finally {
    console.log = orig;
  }
  expect(notesShown).toBe(false);
  process.exitCode = 0;
});
