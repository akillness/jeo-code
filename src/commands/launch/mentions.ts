import * as fs from "node:fs";
import * as path from "node:path";
import { tokenize } from "../../tui/components/autocomplete";

/** Filesystem completion for an `@path` mention prefix, relative to `cwd`.
 *  Lists the directory the prefix points at, filtering by the basename fragment,
 *  directories first, hidden entries dropped, capped at 50 — directories keep a
 *  trailing `/` so the next Tab descends. Pure given `cwd`: never throws (an
 *  unreadable directory yields no matches). Extracted verbatim from the launch
 *  REPL so it can be unit-tested in isolation. */
export function mentionPaths(cwd: string, prefix: string): string[] {
  const norm = prefix.replace(/\\/g, "/");
  const wantsDirChildren = norm.endsWith("/");
  const dirPart = wantsDirChildren ? norm.slice(0, -1) : path.posix.dirname(norm) === "." ? "" : path.posix.dirname(norm);
  const namePart = wantsDirChildren ? "" : path.posix.basename(norm);
  const absDir = path.resolve(cwd, dirPart || ".");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => !entry.name.startsWith("."))
    .filter(entry => !namePart || entry.name.toLowerCase().startsWith(namePart.toLowerCase()))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
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
