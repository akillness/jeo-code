import pkg from "../../package.json";
import { compareVersions } from "../commands/update";
import * as os from "node:os";
import * as path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { jeoEnv } from "./env";
import chalk from "chalk";
import { boxBlock, BOX_UNICODE, BOX_ASCII } from "../tui/components/layout";

// ---- "What's New" release notes ---------------------------------------------
// Mirrors gjc's post-upgrade release-notes surface. The bundled CHANGELOG.md
// (shipped via package.json `files`) is always the RUNNING version's changelog,
// so after a `bun install -g jeo-code` upgrade the next launch reads the NEW
// notes offline. `jeo whats-new` shows them on demand; `jeo update --install`
// shows them right after a successful self-update.

export interface ChangelogGroup {
  /** "Added" | "Changed" | "Fixed" | "" (ungrouped). */
  label: string;
  items: string[];
}

export interface ChangelogSection {
  version: string; // "0.5.9" | "Unreleased"
  date?: string;
  summary: string; // the `_italic_` one-liner under the header
  groups: ChangelogGroup[];
}

/** Default number of recent releases surfaced as "update news" (whats-new default, post-upgrade notice). Use --all for the full history. */
export const RECENT_RELEASE_COUNT = 5;

const HEADER = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?\s*$/;
const SUBHEADER = /^###\s+(.+?)\s*$/;
const BULLET = /^[-*]\s+(.+)$/;
const ITALIC = /^_(.+)_$/;

/** Parse `## [version] - date` sections with their summary line and grouped bullets. */
export function parseChangelogSections(markdown: string): ChangelogSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;
  let group: ChangelogGroup | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const head = line.match(HEADER);
    if (head) {
      current = { version: head[1]!, date: head[2], summary: "", groups: [] };
      group = null;
      sections.push(current);
      continue;
    }
    if (!current) continue;

    const trimmed = line.trim();
    if (trimmed === "") continue;

    const sub = trimmed.match(SUBHEADER);
    if (sub) {
      group = { label: sub[1]!, items: [] };
      current.groups.push(group);
      continue;
    }

    const bullet = trimmed.match(BULLET);
    if (bullet) {
      if (!group) {
        group = { label: "", items: [] };
        current.groups.push(group);
      }
      group.items.push(bullet[1]!.trim());
      continue;
    }

    const italic = trimmed.match(ITALIC);
    if (italic && !current.summary && current.groups.length === 0) {
      current.summary = italic[1]!.trim();
    }
  }

  return sections;
}

/** Real releases only (drops an `Unreleased` heading), newest-first as written. */
export function releaseSections(sections: ChangelogSection[]): ChangelogSection[] {
  return sections.filter(s => s.version.toLowerCase() !== "unreleased");
}

/**
 * Sections strictly newer than `fromVersion` and at most `toVersion`.
 * `fromVersion` null → every release up to and including `toVersion`.
 */
export function selectNewSections(
  sections: ChangelogSection[],
  fromVersion: string | null,
  toVersion: string,
): ChangelogSection[] {
  return releaseSections(sections).filter(s => {
    const newerThanFrom = fromVersion ? compareVersions(s.version, fromVersion) > 0 : true;
    const atMostTo = compareVersions(s.version, toVersion) <= 0;
    return newerThanFrom && atMostTo;
  });
}

export interface WhatsNewRenderOpts {
  cols?: number;
  unicode?: boolean;
  color?: boolean;
  /** Cap rendered body lines so a multi-release jump stays bounded. Default 22. */
  maxBodyLines?: number;
}

/** Word-wrap plain text to `width` columns, hard-breaking any single over-long token. */
function wrapWords(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  let cur = "";
  const flush = () => { if (cur) { out.push(cur); cur = ""; } };
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > w) {
      flush();
      out.push(word.slice(0, w));
      word = word.slice(w);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += " " + word;
    else { out.push(cur); cur = word; }
  }
  flush();
  return out.length ? out : [""];
}

/** Render a boxed "What's New" panel for the given sections (newest-first). */
export function renderWhatsNew(sections: ChangelogSection[], opts?: WhatsNewRenderOpts): string[] {
  if (sections.length === 0) return [];

  const cols = opts?.cols ?? 80;
  const useColor = opts?.color !== false;
  const useUnicode = opts?.unicode !== false;
  const maxBody = opts?.maxBodyLines ?? 22;
  const width = Math.max(32, Math.min(120, cols));
  const inner = Math.max(8, width - 2);

  const accent = useColor ? chalk.hex("#f2b84b") : (s: string) => s;
  const bold = useColor ? (s: string) => chalk.bold(accent(s)) : (s: string) => s;
  const boldPlain = useColor ? chalk.bold : (s: string) => s;
  const dim = useColor ? chalk.dim : (s: string) => s;
  const bulletChar = useUnicode ? "•" : "-";

  const body: string[] = [];
  let clipped = false;

  // Wrap `text` to the inner width, paint each line, and push — bullets indent
  // their continuation lines under the marker. Returns false once the cap is hit.
  const emit = (text: string, paint: (s: string) => string, kind: "plain" | "bullet" = "plain"): boolean => {
    const avail = kind === "bullet" ? inner - 2 : inner;
    const wrapped = wrapWords(text, avail);
    for (let i = 0; i < wrapped.length; i++) {
      if (body.length >= maxBody) { clipped = true; return false; }
      const prefix = kind === "bullet" ? (i === 0 ? `${bulletChar} ` : "  ") : "";
      body.push(paint(prefix + wrapped[i]!));
    }
    return true;
  };

  const headerLabel = sections.length === 1
    ? `What's New in jeo ${sections[0]!.version}`
    : `What's New (${sections.length} releases)`;
  emit(headerLabel, bold);

  outer:
  for (const s of sections) {
    if (sections.length > 1) {
      if (body.length >= maxBody) { clipped = true; break; }
      body.push("DIVIDER");
      const when = s.date ? ` — ${s.date}` : "";
      if (!emit(`${s.version}${when}`, accent)) break;
    }
    if (s.summary && !emit(s.summary, dim)) break;
    for (const g of s.groups) {
      if (g.label && !emit(g.label, boldPlain)) break outer;
      for (const item of g.items) {
        if (!emit(item, (l: string) => l, "bullet")) break outer;
      }
    }
  }
  if (clipped) body.push(dim("… see CHANGELOG.md for the full notes"));

  return boxBlock(body, width, {
    glyphs: useUnicode ? BOX_UNICODE : BOX_ASCII,
    paint: accent,
    align: "left",
  });
}

// ---- Bundled changelog + last-seen-version state ----------------------------

/** Read the CHANGELOG.md that ships next to this package (running version's notes). */
export async function loadBundledChangelog(): Promise<string | null> {
  // This module lives at src/util/whats-new.ts; CHANGELOG.md sits at the package
  // root, i.e. two levels up. Resolve against the module dir so it works from a
  // global install path just as from the repo.
  const candidate = path.join(import.meta.dir, "..", "..", "CHANGELOG.md");
  try {
    return await readFile(candidate, "utf-8");
  } catch {
    return null;
  }
}

interface WhatsNewState {
  lastSeenVersion: string;
  updatedAt: number;
}

function stateDir(): string {
  return jeoEnv("CONFIG_DIR") || path.join(os.homedir(), ".jeo");
}

function statePath(): string {
  return path.join(stateDir(), "whats-new.json");
}

export async function readLastSeenVersion(): Promise<string | null> {
  try {
    const raw = await readFile(statePath(), "utf-8");
    const data = JSON.parse(raw) as Partial<WhatsNewState>;
    if (!data || typeof data.lastSeenVersion !== "string" || !data.lastSeenVersion) return null;
    return data.lastSeenVersion;
  } catch {
    return null;
  }
}

/** Persist the last version the user has seen notes for (best-effort; never throws). */
export async function writeLastSeenVersion(version: string): Promise<void> {
  if (typeof version !== "string" || !version) return;
  try {
    await mkdir(stateDir(), { recursive: true, mode: 0o700 });
    const payload: WhatsNewState = { lastSeenVersion: version, updatedAt: Date.now() };
    await writeFile(statePath(), JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {
    // State is an optimization; a write failure must never break launch/update.
  }
}

/**
 * Launch-time hook: returns rendered notes the FIRST time jeo runs after an
 * upgrade, then records the current version so it never repeats. A fresh install
 * (no prior state) records silently and shows nothing — only genuine upgrades
 * surface notes, matching gjc / npm update-notice behaviour.
 */
export async function consumeLaunchWhatsNew(opts?: WhatsNewRenderOpts): Promise<string[] | null> {
  const current = pkg.version;
  const lastSeen = await readLastSeenVersion();

  if (!lastSeen) {
    await writeLastSeenVersion(current);
    return null;
  }
  if (compareVersions(current, lastSeen) <= 0) {
    // Not an upgrade (equal, or a local downgrade). Keep state monotonic-ish.
    if (compareVersions(current, lastSeen) < 0) await writeLastSeenVersion(current);
    return null;
  }

  // Genuine upgrade: mark seen up front so a render/parse failure never repeats.
  const md = await loadBundledChangelog();
  await writeLastSeenVersion(current);
  if (!md) return null;
  const sections = selectNewSections(parseChangelogSections(md), lastSeen, current).slice(0, RECENT_RELEASE_COUNT);
  if (sections.length === 0) return null;
  return renderWhatsNew(sections, opts);
}
