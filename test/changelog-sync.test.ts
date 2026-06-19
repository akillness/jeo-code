import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  parseChangelogEntries,
  renderChangelogBlock,
  injectChangelogBlock,
  CHANGELOG_START,
  CHANGELOG_END,
  CHANGELOG_START_HTML,
  CHANGELOG_END_HTML,
  CHANGELOG_COUNT,
  README_FILES,
} from "../scripts/sync-changelog";

const root = path.resolve(import.meta.dir, "..");

test("parseChangelogEntries: reads version headers + italic summaries, newest first", () => {
  const md = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "_in-flight work._",
    "### Added",
    "- something",
    "",
    "## [0.4.1] - 2026-06-12",
    "_polish._",
    "",
    "## [0.4.0] - 2026-06-12",
    "_big one._",
  ].join("\n");
  const entries = parseChangelogEntries(md);
  expect(entries.map(e => e.version)).toEqual(["Unreleased", "0.4.1", "0.4.0"]);
  expect(entries[0]).toEqual({ version: "Unreleased", date: undefined, summary: "in-flight work." });
  expect(entries[1]).toEqual({ version: "0.4.1", date: "2026-06-12", summary: "polish." });
});

test("renderChangelogBlock: latest N entries, markers + full-history link", () => {
  const entries = [
    { version: "Unreleased", summary: "a" },
    { version: "0.4.1", date: "2026-06-12", summary: "b" },
    { version: "0.4.0", date: "2026-06-12", summary: "c" },
    { version: "0.3.0", date: "2026-06-02", summary: "d" },
    { version: "0.2.1", date: "2026-06-02", summary: "e" },
    { version: "0.2.0", date: "2026-06-02", summary: "f" },
  ];
  const block = renderChangelogBlock(entries, 5);
  expect(block.startsWith(CHANGELOG_START)).toBe(true);
  expect(block.endsWith(CHANGELOG_END)).toBe(true);
  const items = block.split("\n").filter(l => l.startsWith("- **["));
  expect(items.length).toBe(5); // capped at 5
  expect(items[0]).toBe("- **[Unreleased]** — a"); // no date → no parens
  expect(items[1]).toBe("- **[0.4.1]** (2026-06-12) — b");
  expect(block).not.toContain("[0.2.0]"); // 6th entry dropped
  expect(block).toContain("CHANGELOG.md");
});

test("injectChangelogBlock: replaces only the marked region, throws when markers absent", () => {
  const readme = `# x\n\n## Changelog\n\n${CHANGELOG_START}\nstale\n${CHANGELOG_END}\n\n## After\n`;
  const next = injectChangelogBlock(readme, `${CHANGELOG_START}\n- fresh\n${CHANGELOG_END}`);
  expect(next).toContain("- fresh");
  expect(next).not.toContain("stale");
  expect(next).toContain("## After"); // content outside the markers preserved
  expect(() => injectChangelogBlock("# no markers here", "x")).toThrow();
});

test("drift guard: every README's changelog region matches the latest 5 from CHANGELOG.md", async () => {
  const changelog = await fs.readFile(path.join(root, "CHANGELOG.md"), "utf-8");
  const entries = parseChangelogEntries(changelog);
  expect(entries.length).toBeGreaterThanOrEqual(CHANGELOG_COUNT);
  const block = renderChangelogBlock(entries);
  for (const file of README_FILES) {
    const body = await fs.readFile(path.join(root, file), "utf-8");
    let startMarker = CHANGELOG_START;
    let endMarker = CHANGELOG_END;
    let start = body.indexOf(startMarker);
    if (start === -1) {
      startMarker = CHANGELOG_START_HTML;
      endMarker = CHANGELOG_END_HTML;
      start = body.indexOf(startMarker);
    }
    const end = body.indexOf(endMarker);
    expect(start, `${file} missing changelog markers — run 'bun run changelog:sync'`).toBeGreaterThanOrEqual(0);
    const region = body.slice(start, end + endMarker.length);
    let expectedBlock = block;
    if (startMarker === CHANGELOG_START_HTML) {
      expectedBlock = block
        .replaceAll(CHANGELOG_START, CHANGELOG_START_HTML)
        .replaceAll(CHANGELOG_END, CHANGELOG_END_HTML);
    }
    expect(region, `${file} changelog drifted — run 'bun run changelog:sync'`).toBe(expectedBlock);
  }
});
