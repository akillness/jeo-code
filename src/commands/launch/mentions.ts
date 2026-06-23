import * as fs from "node:fs";
import * as path from "node:path";
import { tokenize } from "../../tui/components/autocomplete";

/** Directories never descended into / surfaced by `@path` recursive search. */
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".next", ".cache", ".turbo", ".svelte-kit", "vendor", "target",
  ".jeo", ".omc", ".omx", ".gjc",
]);
const MAX_RESULTS = 50;
/** Hard cap on directory entries visited per query (keeps per-keystroke cost bounded). */
const MAX_SCAN = 8000;
/** Deepest directory level the recursive walk descends to. */
const MAX_DEPTH = 10;

/** Fuzzy match tier for `name` against an already-lowercased `frag`.
 *  0 = prefix, 1 = substring, 2 = subsequence (chars in order), -1 = no match. */
function fuzzyRank(name: string, fragLower: string): number {
  if (!fragLower) return 0;
  const n = name.toLowerCase();
  if (n.startsWith(fragLower)) return 0;
  if (n.includes(fragLower)) return 1;
  let i = 0;
  for (let j = 0; j < n.length && i < fragLower.length; j++) {
    if (n[j] === fragLower[i]) i++;
  }
  return i === fragLower.length ? 2 : -1;
}

interface RecursiveHit {
  rel: string;
  isDir: boolean;
  rank: number;
  depth: number;
}

/** Recursively search the project tree under `cwd` for entries whose basename
 *  fuzzy-matches `frag`. Ignores hidden entries and well-known build/VCS dirs,
 *  bounded by depth / scan / result caps. Pure given the filesystem: never throws
 *  (unreadable directories are skipped). Returns relative POSIX paths, directories
 *  keeping a trailing `/`, ranked basename-prefix → substring → subsequence, then
 *  shallowest / shortest / alphabetical. */
function searchRecursive(cwd: string, frag: string): string[] {
  const fragLower = frag.toLowerCase();
  const hits: RecursiveHit[] = [];
  let scanned = 0;
  const stack: { abs: string; rel: string; depth: number }[] = [{ abs: cwd, rel: "", depth: 0 }];
  while (stack.length > 0) {
    const { abs, rel, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++scanned > MAX_SCAN) break;
      if (entry.name.startsWith(".")) continue;
      const isDir = entry.isDirectory();
      if (isDir && IGNORE_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const rank = fuzzyRank(entry.name, fragLower);
      if (rank >= 0) hits.push({ rel: childRel, isDir, rank, depth });
      if (isDir && depth + 1 <= MAX_DEPTH) {
        stack.push({ abs: path.join(abs, entry.name), rel: childRel, depth: depth + 1 });
      }
    }
    if (scanned > MAX_SCAN) break;
  }
  hits.sort((a, b) =>
    a.rank - b.rank ||
    a.depth - b.depth ||
    a.rel.length - b.rel.length ||
    a.rel.localeCompare(b.rel));
  return hits.slice(0, MAX_RESULTS).map(h => (h.isDir ? `${h.rel}/` : h.rel));
}

/** Filesystem completion for an `@path` mention prefix, relative to `cwd`.
 *
 *  - A bare fragment with no slash (e.g. `@loop`) triggers a recursive, fuzzy
 *    project-wide search so nested files surface without typing each directory
 *    level (`@loop` → `src/agent/loop.ts`).
 *  - A path containing a slash (or ending in `/`) lists that one directory,
 *    filtering the basename fragment fuzzily (prefix/substring/subsequence).
 *
 *  Directories keep a trailing `/` so the next Tab descends; hidden entries are
 *  dropped; results are capped at 50. Pure given `cwd`: never throws (an
 *  unreadable directory yields no matches). */
export function mentionPaths(cwd: string, prefix: string): string[] {
  const norm = prefix.replace(/\\/g, "/");
  const wantsDirChildren = norm.endsWith("/");

  // Bare non-empty fragment → recursive fuzzy search across the project.
  if (!wantsDirChildren && norm.length > 0 && !norm.includes("/")) {
    return searchRecursive(cwd, norm);
  }

  const dirPart = wantsDirChildren ? norm.slice(0, -1) : path.posix.dirname(norm) === "." ? "" : path.posix.dirname(norm);
  const namePart = wantsDirChildren ? "" : path.posix.basename(norm);
  const fragLower = namePart.toLowerCase();
  const absDir = path.resolve(cwd, dirPart || ".");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => !entry.name.startsWith("."))
    .filter(entry => fuzzyRank(entry.name, fragLower) >= 0)
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      const ra = fuzzyRank(a.name, fragLower);
      const rb = fuzzyRank(b.name, fragLower);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 50)
    .map(entry => {
      const rel = dirPart ? `${dirPart}/${entry.name}` : entry.name;
      return entry.isDirectory() ? `${rel}/` : rel;
    });
}

/** The `@ <dir>` label shown in the boxed-input footer for the last `@mention`
 *  token on the current line, or undefined when the line has no mention. Pure. */
export function currentAtLabel(line: string): string | undefined {
  const { tokens } = tokenize(line);
  const token = [...tokens].reverse().find(t => t.startsWith("@"));
  if (!token) return undefined;
  const norm = token.slice(1).replace(/\\/g, "/");
  if (!norm) return "@ .";
  if (norm.endsWith("/")) return `@ ${norm.slice(0, -1) || "."}`;
  const dir = path.posix.dirname(norm);
  return `@ ${dir === "." ? norm : dir}`;
}
