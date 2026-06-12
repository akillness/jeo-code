#!/usr/bin/env bun
/**
 * Mirror the latest N CHANGELOG.md entries into a marked region of every README.
 *
 * Single source of truth: CHANGELOG.md. The READMEs only display a compact,
 * auto-generated digest between the START/END markers — never hand-edit that
 * block; run `bun run changelog:sync` (CI enforces parity via changelog-sync.test).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const CHANGELOG_START = "<!-- CHANGELOG:START (auto-generated from CHANGELOG.md — run `bun run changelog:sync`) -->";
export const CHANGELOG_END = "<!-- CHANGELOG:END -->";
export const CHANGELOG_COUNT = 5;

/** READMEs that carry the mirrored changelog digest (English entries, localized heading). */
export const README_FILES = ["README.md", "README.ko.md", "README.ja.md", "README.zh.md"] as const;

export interface ChangelogEntry {
  version: string; // "Unreleased" | "0.4.1" | …
  date?: string; // ISO date when present
  summary: string; // the `_italic_` one-liner under the version header
}

/** Parse `## [version] - date` sections + their `_summary_` line, newest-first as written. */
export function parseChangelogEntries(markdown: string): ChangelogEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];
  const header = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(header);
    if (!m) continue;
    // First non-blank line after the header is the italic summary (if any).
    let summary = "";
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trim();
      if (t === "") continue;
      const it = t.match(/^_(.+)_$/);
      summary = it ? it[1]!.trim() : "";
      break;
    }
    entries.push({ version: m[1]!, date: m[2], summary });
  }
  return entries;
}

/** Render the compact digest block (markers included) for the latest `count` entries. */
export function renderChangelogBlock(entries: ChangelogEntry[], count = CHANGELOG_COUNT): string {
  const top = entries.slice(0, count);
  const items = top.map(e => {
    const when = e.date ? ` (${e.date})` : "";
    const sum = e.summary ? ` — ${e.summary}` : "";
    return `- **[${e.version}]**${when}${sum}`;
  });
  const tail = "\nSee [CHANGELOG.md](CHANGELOG.md) for the full history.";
  return [CHANGELOG_START, ...items, tail, CHANGELOG_END].join("\n");
}

/** Replace the marked region in a README body. Throws if the markers are missing. */
export function injectChangelogBlock(readme: string, block: string): string {
  const start = readme.indexOf(CHANGELOG_START);
  const end = readme.indexOf(CHANGELOG_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`changelog markers not found (expected ${CHANGELOG_START} … ${CHANGELOG_END})`);
  }
  const before = readme.slice(0, start);
  const after = readme.slice(end + CHANGELOG_END.length);
  return before + block + after;
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dir, "..");
  const changelog = await fs.readFile(path.join(root, "CHANGELOG.md"), "utf-8");
  const block = renderChangelogBlock(parseChangelogEntries(changelog));
  let changed = 0;
  for (const file of README_FILES) {
    const p = path.join(root, file);
    const body = await fs.readFile(p, "utf-8");
    const next = injectChangelogBlock(body, block);
    if (next !== body) {
      await fs.writeFile(p, next, "utf-8");
      changed++;
      console.log(`synced changelog digest → ${file}`);
    }
  }
  console.log(changed === 0 ? "all READMEs already up to date." : `updated ${changed} README(s).`);
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`[sync-changelog] ${(err as Error).message}`);
    process.exit(1);
  });
}
