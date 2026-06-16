import { applyBashFixups } from "./bash-fixups";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkflowStateStrict, type WorkflowState } from "./state";
import { jeoEnv } from "../util/env";
import { READ_OUTPUT_MAX } from "./tool-output";

/** Read the deep-interview lock; on corrupt state fail CLOSED (treat as active lock). */
async function readMutationLock(cwd: string): Promise<WorkflowState | null> {
  try {
    return await readWorkflowStateStrict("deep-interview", cwd);
  } catch {
    return { active: true, current_phase: "locked", skill: "deep-interview" };
  }
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Directories that pollute `find`/`search` results and waste time: VCS, build
 * artifacts, dependency trees, and jeo's own runtime dir. gjc's native search
 * respects ignore files; this is the pure-TS equivalent.
 */
export const IGNORED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".jeo",
  "vendor",
  ".cache",
];

/**
 * Read the repo-root `.gitignore` into basename dir + file-glob exclude lists, so
 * find/search match repository intent (build artifacts, logs, .env, …) on top of
 * IGNORED_DIRS. Conservative semantics: single-segment patterns only (entries with
 * an internal `/` are anchored/path patterns that basename excludes can't represent),
 * negations (`!`) and comments skipped. Absent/unreadable .gitignore → empty (no-op).
 */
export async function readGitignore(cwd: string): Promise<{ dirs: string[]; fileGlobs: string[] }> {
  let content = "";
  try {
    content = await fs.readFile(path.join(cwd, ".gitignore"), "utf-8");
  } catch {
    return { dirs: [], fileGlobs: [] };
  }
  const dirs = new Set<string>();
  const fileGlobs = new Set<string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    let p = line;
    const dirOnly = p.endsWith("/");
    if (dirOnly) p = p.slice(0, -1);
    if (p.startsWith("/")) p = p.slice(1);
    if (!p || p.includes("/")) continue; // skip anchored/multi-segment patterns
    dirs.add(p);
    if (!dirOnly) fileGlobs.add(p);
  }
  return { dirs: [...dirs], fileGlobs: [...fileGlobs] };
}

/**
 * Validates if codebase mutation tools are blocked due to an active Socratic interview.
 * Mutation is blocked only if deep-interview is active, not completed, and the file
 * is NOT under the `.jeo/` directory (planning/spec files are allowed).
 */
export async function assertMutationAllowed(
  filePath: string,
  cwd: string = process.cwd()
): Promise<void> {
  const deepInterviewState = await readMutationLock(cwd);
  if (deepInterviewState && deepInterviewState.active && deepInterviewState.current_phase !== "complete") {
    // Check if the target is NOT inside the local .jeo folder. Use a path-boundary
    // check (not bare startsWith) so siblings like ".jeo-backup" aren't mistaken for ".jeo/".
    const absPath = path.resolve(cwd, filePath);
    const jeoDir = path.resolve(cwd, ".jeo");
    const insideJeo = absPath === jeoDir || absPath.startsWith(jeoDir + path.sep);
    if (!insideJeo) {
      throw new Error(
        `[MutationGuard Blocked] Code mutation is blocked while a Socratic interview is active (the requirements seed is not yet frozen).\n` +
        `Current ambiguity: ${((deepInterviewState.current_ambiguity ?? 1) * 100).toFixed(0)}%. Finish the interview to freeze the seed and unlock writes — run 'jeo deep-interview'. Non-interactive '--auto' can continue clarification, but it does not bypass the ambiguity gate.\n` +
        `Only spec/planning writes under '.jeo/' are permitted until then.`
      );
    }
  }
}

export async function assertBashAllowed(
  cwd: string = process.cwd()
): Promise<void> {
  const deepInterviewState = await readMutationLock(cwd);
  if (deepInterviewState && deepInterviewState.active && deepInterviewState.current_phase !== "complete") {
    throw new Error(
      "[MutationGuard] bash is blocked while a Socratic interview is active (requirements seed not frozen). Finish 'jeo deep-interview' to continue; '--auto' does not bypass the ambiguity gate."
    );
  }
}

/**
 * Parse a read line selector into sorted, merged, inclusive [start,end] ranges.
 * Segments are comma-separated; each is one of: "a-b" (range), "a-" (a→EOF),
 * "a" (single line), or "a+n" (n lines starting at a). Out-of-range starts are
 * dropped; an explicit "a-b" with b<a is an error. Mirrors gjc's read selectors.
 */
export function parseLineSelector(spec: string | number, total: number): { ranges: [number, number][] } | { error: string } {
  // Field crash guard: models pass `lineRange: 10` (number) or other JSON junk —
  // `spec.split is not a function` killed the read instead of degrading politely.
  if (typeof spec !== "string") {
    if (typeof spec === "number" && Number.isFinite(spec)) spec = String(spec);
    else return { error: `selector must be a string like "10-20", got ${JSON.stringify(spec)}` };
  }
  const segs = spec.split(",").map(s => s.trim()).filter(Boolean);
  if (segs.length === 0) return { error: "empty selector" };
  const ranges: [number, number][] = [];
  for (const seg of segs) {
    let m: RegExpMatchArray | null;
    if ((m = seg.match(/^(\d+)\+(\d+)$/))) {
      const start = Math.max(1, parseInt(m[1]));
      const count = Math.max(1, parseInt(m[2]));
      if (start <= total) ranges.push([start, Math.min(total, start + count - 1)]);
    } else if ((m = seg.match(/^(\d+)-(\d+)$/))) {
      const start = Math.max(1, parseInt(m[1]));
      const end = parseInt(m[2]);
      if (end < start) return { error: `segment '${seg}': end < start (file has ${total} lines)` };
      if (start <= total) ranges.push([start, Math.min(total, end)]);
    } else if ((m = seg.match(/^(\d+)-$/))) {
      const start = Math.max(1, parseInt(m[1]));
      if (start <= total) ranges.push([start, total]);
    } else if ((m = seg.match(/^(\d+)$/))) {
      const start = Math.max(1, parseInt(m[1]));
      if (start <= total) ranges.push([start, start]);
    } else {
      return { error: `invalid segment '${seg}'. Use "a-b", "a-", "a", or "a+n".` };
    }
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return { ranges: merged };
}

// ── hashline-lite (plan/gjc-inheritance.md B2, gjc hashline 경량 계승) ──
// Every annotated read line carries a 2-char CONTENT anchor: `42ab|text`. The
// hash depends only on the line's content (trailing whitespace/CR ignored), so
// sibling edits that shift line numbers keep the anchor valid. The edit tool
// accepts the anchors on `≔` ranges (`≔12ab..15cd`) and verifies them before
// mutating — a mismatch means the model is editing content it has not seen.
// The anchor ALWAYS leads with a letter ([a-z]) so a directive like `≔1ab` is
// unambiguous: the `\d+` line number can never swallow the anchor. (A purely
// numeric anchor such as `68` would make `≔1`+`68` parse as line 168 with no
// anchor, silently skipping verification — exactly what hashline must prevent.)
const ANCHOR_FIRST = 26; // a-z
const ANCHOR_SECOND = 36; // 0-9a-z
export function lineAnchor(line: string): string {
  const normalized = line.replace(/\r$/, "").replace(/[ \t]+$/, "");
  const n = Number(BigInt(Bun.hash(normalized)) % BigInt(ANCHOR_FIRST * ANCHOR_SECOND));
  const first = String.fromCharCode(97 + Math.floor(n / ANCHOR_SECOND)); // a-z, never a digit
  return first + (n % ANCHOR_SECOND).toString(36); // second char 0-9a-z
}

/** A read-output anchor prefix at line start: `42ab|` (hashed) or legacy `42|`. */
const ANCHOR_PREFIX_RE = /^\d+(?:[a-z0-9]{2})?\|/;

/** Strip read-output anchor prefixes from a block IF every non-empty line carries
 *  one — the signature of content copy-pasted from read output into a SEARCH
 *  block (the dual-protocol trap: anchors are display chrome, not file bytes). */
function stripAnchorPrefixes(block: string): string | null {
  const lines = block.split("\n");
  if (!lines.some(l => l.trim() !== "")) return null;
  if (!lines.every(l => l.trim() === "" || ANCHOR_PREFIX_RE.test(l))) return null;
  return lines.map(l => l.replace(ANCHOR_PREFIX_RE, "")).join("\n");
}
// ── File-freshness guard (plan/gjc-inheritance.md B7, gjc edit/file-read-cache 계승) ──
// `read` records each file's stat fingerprint; `edit`/`write` verify it before
// mutating. A file changed by someone else (concurrent agent, user, formatter)
// between the read and the edit is REJECTED once — with the CURRENT content
// re-presented so the model can retry immediately (recovery, not just a guard).
const lastReadSnapshots = new Map<string, { mtimeMs: number; size: number }>();
const MAX_SNAPSHOT_ENTRIES = 64;

function recordReadSnapshot(absPath: string, st: { mtimeMs: number; size: number } | null): void {
  if (!st) return;
  if (lastReadSnapshots.size >= MAX_SNAPSHOT_ENTRIES && !lastReadSnapshots.has(absPath)) {
    const oldest = lastReadSnapshots.keys().next().value;
    if (oldest !== undefined) lastReadSnapshots.delete(oldest);
  }
  lastReadSnapshots.delete(absPath); // re-insert to refresh LRU order
  lastReadSnapshots.set(absPath, { mtimeMs: st.mtimeMs, size: st.size });
}

/** Annotated excerpt of the file's CURRENT content for recovery errors (read-format `N|`). */
function excerptForRecovery(content: string, centerLine?: number): string {
  const lines = content.split("\n");
  const SPAN = 60;
  let start = 1;
  let end = Math.min(lines.length, 2 * SPAN);
  if (centerLine && centerLine >= 1 && centerLine <= lines.length) {
    start = Math.max(1, centerLine - SPAN);
    end = Math.min(lines.length, centerLine + SPAN);
  }
  const body = lines.slice(start - 1, end).map((l, i) => `${start + i}${lineAnchor(l)}|${l}`).join("\n");
  const note = lines.length > end - start + 1 ? `\n…(showing lines ${start}-${end} of ${lines.length})` : "";
  return body + note;
}

/** Returns a recovery error when `absPath` changed since the agent last read it; null when fresh.
 *  Refreshes the snapshot to CURRENT so the immediate retry (model just saw fresh content) passes. */
async function staleReadError(absPath: string, filePath: string, verb: string): Promise<ToolResult | null> {
  const snap = lastReadSnapshots.get(absPath);
  if (!snap) return null; // never read → no guard (back-compat; read-first is advisory)
  const st = await fs.stat(absPath).catch(() => null);
  if (!st || !st.isFile()) return null; // deleted/replaced-by-dir: let the op surface its own error
  if (st.mtimeMs === snap.mtimeMs && st.size === snap.size) return null;
  const content = await fs.readFile(absPath, "utf-8").catch(() => null);
  recordReadSnapshot(absPath, st); // the model sees the fresh content below → retry passes
  const excerpt = content !== null ? `\nCurrent content:\n${excerptForRecovery(content)}` : "";
  return {
    success: false,
    output: "",
    error:
      `${verb} rejected: ${filePath} changed on disk since you last read it (another agent, the user, or a formatter touched it). ` +
      `Re-target your ${verb.toLowerCase()} against the CURRENT content below, then retry.${excerpt}`,
  };
}
export async function readTool(
  filePath: string,
  lineRange?: string | number,
  cwd: string = process.cwd(),
  raw: boolean = false
): Promise<ToolResult> {
  try {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return { success: false, output: "", error: 'read requires a non-empty "filePath".' };
    }
    const absPath = path.resolve(cwd, filePath);
    // gjc parity: reading a directory returns its listing instead of an EISDIR error.
    const st = await fs.stat(absPath).catch(() => null);
    if (st?.isDirectory()) {
      if (raw || lineRange) {
        return { success: false, output: "", error: `${filePath} is a directory — drop raw/lineRange; reading it lists entries.` };
      }
      return lsTool(filePath, cwd);
    }
    const content = await fs.readFile(absPath, "utf-8");
    if (st?.isFile()) recordReadSnapshot(absPath, st); // arm the edit/write freshness guard

    if (raw) {
      // Verbatim bytes, no "N|" line prefixes (gjc `:raw`), char-capped for context safety.
      const MAX_CHARS = 50_000;
      if (content.length > MAX_CHARS) {
        return { success: true, output: content.slice(0, MAX_CHARS) + `\n…(raw truncated at ${MAX_CHARS} of ${content.length} chars; drop raw and pass lineRange to read a slice)` };
      }
      return { success: true, output: content };
    }

    const lines = content.split("\n");

    if (lineRange !== undefined && lineRange !== null && lineRange !== "") {
      const parsed = parseLineSelector(lineRange, lines.length);
      if ("error" in parsed) {
        return { success: false, output: "", error: `Invalid lineRange '${lineRange}': ${parsed.error}` };
      }
      if (parsed.ranges.length === 0) {
        return { success: true, output: `(no lines in range; file has ${lines.length} lines)` };
      }
      const MAX_RANGE_LINES = 2000; // cap selected output so a huge `1-` can't materialize MBs
      const out: string[] = [];
      let emitted = 0;
      let capped = false;
      outer: for (const [i, [start, end]] of parsed.ranges.entries()) {
        if (emitted >= MAX_RANGE_LINES) { capped = true; break; }
        if (i > 0) out.push("…"); // gap marker between non-contiguous ranges
        for (let ln = start; ln <= end; ln++) {
          if (emitted >= MAX_RANGE_LINES) { capped = true; break outer; }
          out.push(`${ln}${lineAnchor(lines[ln - 1] ?? "")}|${lines[ln - 1] ?? ""}`);
          emitted++;
        }
      }
      if (capped) out.push(`…(range truncated at ${MAX_RANGE_LINES} lines; narrow the range)`);
      return { success: true, output: out.join("\n") };
    }

    // Default (no lineRange): fill the model-visible read budget with WHOLE lines
    // instead of a fixed 500-line cap that left half the 32k budget unused and forced
    // needless pagination (the read tool's biggest "reads too little per call" pain).
    // READ_OUTPUT_MAX is the real cap; a hard line ceiling (JEO_READ_MAX_LINES) guards
    // pathological files, and a small reserve keeps the pagination notice inside the
    // budget so it is never trimmed by the downstream head-only truncation.
    const HARD_LINE_CEILING = Math.max(500, Number(jeoEnv("READ_MAX_LINES") ?? "") || 5000);
    const charBudget = Math.max(1_000, READ_OUTPUT_MAX - 256);
    const shownLines: string[] = [];
    let usedChars = 0;
    for (let i = 0; i < lines.length && shownLines.length < HARD_LINE_CEILING; i++) {
      const annotatedLine = `${i + 1}${lineAnchor(lines[i]!)}|${lines[i]}`;
      const cost = annotatedLine.length + 1; // + newline
      if (shownLines.length > 0 && usedChars + cost > charBudget) break; // always emit ≥1 line
      shownLines.push(annotatedLine);
      usedChars += cost;
    }
    const annotated = shownLines.join("\n");
    if (shownLines.length < lines.length) {
      const shown = shownLines.length;
      const notice = `\n…(showing lines 1-${shown} of ${lines.length}; pass lineRange "${shown + 1}-" to read the rest)`;
      return { success: true, output: annotated + notice };
    }
    return { success: true, output: annotated };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}

export async function writeTool(
  filePath: string,
  content: string,
  cwd: string = process.cwd()
): Promise<ToolResult> {
  try {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return { success: false, output: "", error: 'write requires a non-empty "filePath".' };
    }
    await assertMutationAllowed(filePath, cwd);
    const absPath = path.resolve(cwd, filePath);
    const stale = await staleReadError(absPath, filePath, "Write");
    if (stale) return stale;
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, "utf-8");
    recordReadSnapshot(absPath, await fs.stat(absPath).catch(() => null)); // own change ≠ stale
    return { success: true, output: `Successfully wrote ${content.length} characters to ${filePath}` };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}

/** Strip a single leading and trailing newline (CRLF or LF) — the editBlock framing. */
function trimOneNewline(s: string): string {
  if (s.startsWith("\r\n")) s = s.slice(2);
  else if (s.startsWith("\n")) s = s.slice(1);
  if (s.endsWith("\r\n")) s = s.slice(0, -2);
  else if (s.endsWith("\n")) s = s.slice(0, -1);
  return s;
}

/**
 * Parse one or MORE `<<<<<<< SEARCH / ======= / >>>>>>>` hunks from an edit block.
 * Returns null when there are no SEARCH markers (so the ≔ path / format error stands).
 * Each hunk's search/replace has one framing newline trimmed (same as the legacy
 * single-hunk path). A marker present but malformed (no `=======`/`>>>>>>>`) → null.
 */
export function parseEditHunks(block: string): { search: string; replace: string }[] | null {
  if (!block.includes("<<<<<<< SEARCH")) return null;
  const hunks: { search: string; replace: string }[] = [];
  for (const seg of block.split("<<<<<<< SEARCH").slice(1)) {
    const eq = seg.indexOf("=======");
    if (eq === -1) return null;
    const gt = seg.indexOf(">>>>>>>", eq);
    if (gt === -1) return null;
    hunks.push({ search: trimOneNewline(seg.slice(0, eq)), replace: trimOneNewline(seg.slice(eq + 7, gt)) });
  }
  return hunks.length ? hunks : null;
}

export async function editTool(
  filePath: string,
  editBlock: string,
  cwd: string = process.cwd()
): Promise<ToolResult> {
  try {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return { success: false, output: "", error: 'edit requires a non-empty "filePath".' };
    }
    if (typeof editBlock !== "string" || editBlock === "") {
      return { success: false, output: "", error: 'edit requires a non-empty "editBlock" (≔ directive or <<<<<<< SEARCH block).' };
    }
    await assertMutationAllowed(filePath, cwd);
    const absPath = path.resolve(cwd, filePath);
    const stale = await staleReadError(absPath, filePath, "Edit");
    if (stale) return stale;
    let content = await fs.readFile(absPath, "utf-8");

    // Line-anchored edit parser. Modes (payload follows the directive's newline):
    //   ≔A..B   replace lines A..B          ≔A    replace line A
    //   ≔A+     insert AFTER line A (A=0 prepends)
    //   ≔$      append to end of file
    // Line numbers MAY carry the 2-char content anchors from read output
    // (`≔12ab..15cd`, `≔7xy+`) — hashline-lite verifies them against the CURRENT
    // content before mutating, so an edit aimed at moved/changed lines is
    // rejected with the fresh content instead of silently corrupting the file.
    // Falls back to <<<<<<< SEARCH / ======= / >>>>>>> substring replacement.
    const lines = content.split("\n");

    /** Verify a model-supplied anchor against the current line; null = ok. */
    const anchorMismatch = (lineNo: number, anchor: string | undefined): ToolResult | null => {
      if (!anchor) return null; // anchors are optional — plain ≔A..B stays valid
      const actual = lineAnchor(lines[lineNo - 1] ?? "");
      if (actual === anchor) return null;
      return {
        success: false,
        output: "",
        error:
          `Edit rejected: anchor mismatch at line ${lineNo} — you sent ${lineNo}${anchor} but the current line hashes to ${lineNo}${actual}. ` +
          `The content moved or changed since you read it. Re-target against the CURRENT content below and retry.\n` +
          `Current content:\n${excerptForRecovery(content, lineNo)}`,
      };
    };
    // hashline 3-way re-map (plan/gjc-inheritance.md cycle 9): content-only
    // hashes mean a line that sibling edits SHIFTED still carries its anchor.
    // When a supplied anchor no longer sits at its line number, look within a
    // ±window for the UNIQUE line carrying that anchor and relocate the edit
    // there. Ambiguous (>1 match) or absent → null, so the caller falls back to
    // the existing reject+re-present path rather than guessing.
    const ANCHOR_REMAP_WINDOW = 64;
    const locateAnchor = (anchor: string, near: number): number | null => {
      const lo = Math.max(1, near - ANCHOR_REMAP_WINDOW);
      const hi = Math.min(lines.length, near + ANCHOR_REMAP_WINDOW);
      let found = -1;
      for (let i = lo; i <= hi; i++) {
        if (lineAnchor(lines[i - 1] ?? "") === anchor) {
          if (found !== -1) return null; // ambiguous — refuse to guess
          found = i;
        }
      }
      return found === -1 ? null : found;
    };

    let updated = false;
    if (editBlock.startsWith("≔")) {
      const appendMatch = editBlock.match(/^≔\$\n?([\s\S]*)$/);
      const insertMatch = editBlock.match(/^≔(\d+)([a-z0-9]{2})?\+\n?([\s\S]*)$/);
      const replaceMatch = editBlock.match(/^≔(\d+)([a-z0-9]{2})?(?:\.\.(\d+)([a-z0-9]{2})?)?\n([\s\S]*)$/);
      if (appendMatch) {
        const payload = appendMatch[1];
        content = content === "" || content.endsWith("\n") ? content + payload : content + "\n" + payload;
        updated = true;
      } else if (insertMatch) {
        let at = parseInt(insertMatch[1]); // insert AFTER line `at`; 0 prepends
        const payload = insertMatch[3];
        if (at < 0 || at > lines.length) {
          return { success: false, output: "", error: `Invalid insert position ${at}: out of bounds (file has ${lines.length} lines)` };
        }
        const anchor = insertMatch[2];
        if (at >= 1 && anchor && lineAnchor(lines[at - 1] ?? "") !== anchor) {
          const moved = locateAnchor(anchor, at); // shifted line → re-map the insert point
          if (moved !== null) at = moved;
        }
        if (at >= 1) {
          const mismatch = anchorMismatch(at, anchor);
          if (mismatch) return mismatch;
        }
        lines.splice(at, 0, payload);
        content = lines.join("\n");
        updated = true;
      } else if (replaceMatch) {
        const startLine = parseInt(replaceMatch[1]);
        const endLine = replaceMatch[3] ? parseInt(replaceMatch[3]) : startLine;
        const payload = replaceMatch[5];
        const aStart = replaceMatch[2];
        const aEnd = replaceMatch[4];
        // 3-way re-map: when the anchors no longer match their line numbers,
        // relocate the WHOLE range by one uniform delta. Both ends must agree
        // (preserves range length + contiguity), else fall through to reject.
        let s = startLine;
        let e = endLine;
        const sBad = !!aStart && lineAnchor(lines[s - 1] ?? "") !== aStart;
        const eBad = !!aEnd && lineAnchor(lines[e - 1] ?? "") !== aEnd;
        if (sBad || eBad) {
          let delta: number | null = null;
          if (sBad) {
            const moved = locateAnchor(aStart!, s);
            if (moved !== null) delta = moved - s;
          }
          if (delta === null && eBad) {
            const moved = locateAnchor(aEnd!, e);
            if (moved !== null) delta = moved - e;
          }
          if (delta !== null && delta !== 0) {
            const ns = s + delta;
            const ne = e + delta;
            const okStart = !aStart || (ns >= 1 && ns <= lines.length && lineAnchor(lines[ns - 1] ?? "") === aStart);
            const okEnd = !aEnd || (ne >= 1 && ne <= lines.length && lineAnchor(lines[ne - 1] ?? "") === aEnd);
            if (okStart && okEnd && ns >= 1 && ne >= ns && ne <= lines.length) {
              s = ns;
              e = ne;
            }
          }
        }
        if (s < 1 || e < s || e > lines.length) {
          return {
            success: false,
            output: "",
            error: `Invalid edit range ${startLine}..${endLine}: out of bounds or reversed (file has ${lines.length} lines)`,
          };
        }
        const mismatch = anchorMismatch(s, aStart) ?? anchorMismatch(e, aEnd);
        if (mismatch) return mismatch;
        lines.splice(s - 1, e - s + 1, payload);
        content = lines.join("\n");
        updated = true;
      }
    }

    if (!updated) {
      // SEARCH/REPLACE hunks — one or MORE blocks applied in order to a working copy.
      // Atomic: if ANY hunk fails to match, nothing is written to disk.
      const hunks = parseEditHunks(editBlock);
      if (hunks) {
        let working = content;
        for (let [i, h] of hunks.entries()) {
          if (h.search === "") {
            return { success: false, output: "", error: `Failed to apply edit: hunk ${i + 1} has an empty SEARCH block.` };
          }
          // Anchor-strip fixup (B2 dual-protocol trap): a SEARCH block copied from
          // read output carries `42ab|` display prefixes that are not file bytes.
          // When the raw block misses but a fully-prefixed variant strips clean,
          // apply the stripped hunk (replace side stripped by the same rule).
          if (!working.includes(h.search)) {
            const strippedSearch = stripAnchorPrefixes(h.search);
            if (strippedSearch !== null && working.includes(strippedSearch)) {
              h = { search: strippedSearch, replace: stripAnchorPrefixes(h.replace) ?? h.replace };
            }
          }
          if (working.includes(h.search)) {
            // Function replacer: bypasses String.replace's `$`-pattern substitution
            // ($&, $`, $', $$) so a replacement containing literal `$` (Makefiles,
            // shell `$'…'`, regex literals) is inserted verbatim, not corrupted.
            working = working.replace(h.search, () => h.replace);
          } else {
            // Near-miss diagnostics so the model can self-correct instead of blindly retrying.
            const firstLine = h.search.split("\n")[0] ?? "";
            const trimmedHit = working.replace(/[ \t]+$/gm, "").includes(h.search.trim())
              ? " A whitespace-trimmed version DOES match — fix leading/trailing spaces or indentation."
              : "";
            const anchorHit = !trimmedHit && firstLine.trim() && working.includes(firstLine)
              ? " The first search line IS present, so the mismatch is below it."
              : "";
            const which = hunks.length > 1 ? ` (hunk ${i + 1}/${hunks.length})` : "";
            // gjc-style recovery (plan/gjc-inheritance.md B3.5): re-present the CURRENT
            // content around the best anchor so the failed edit costs ONE retry, not a
            // separate read round-trip — failed edits are the #1 step-budget waste.
            const anchorIdx = firstLine.trim() ? working.split("\n").findIndex(l => l.includes(firstLine.trim())) : -1;
            const excerpt = `\nCurrent content near the target:\n${excerptForRecovery(working, anchorIdx >= 0 ? anchorIdx + 1 : undefined)}`;
            return {
              success: false,
              output: "",
              error: `Failed to apply edit: Search block not found in file${which}.${trimmedHit}${anchorHit} Re-target against the content below and retry.${excerpt}`,
            };
          }
        }
        content = working;
        updated = true;
      }
    }

    if (!updated) {
      // A SEARCH marker present but unparsed means the divider/terminator is missing —
      // point the model at the marker rather than at the unrelated ≔ syntax.
      if (editBlock.includes("<<<<<<< SEARCH")) {
        return {
          success: false,
          output: "",
          error: "Failed to apply edit: unterminated SEARCH block — each hunk needs '<<<<<<< SEARCH', a '=======' divider, and a '>>>>>>>' terminator.",
        };
      }
      return {
        success: false,
        output: "",
        error: "Failed to apply edit: Invalid edit block format. Use line range replacement: ≔[line]..[line] format.",
      };
    }

    await fs.writeFile(absPath, content, "utf-8");
    recordReadSnapshot(absPath, await fs.stat(absPath).catch(() => null)); // own change ≠ stale
    return { success: true, output: `Successfully updated ${filePath}` };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}

export async function bashTool(
  command: string,
  cwd: string = process.cwd(),
  timeoutMs: number = 120_000,
  subdir?: string,
  env?: Record<string, string>,
  onProgress?: (partialOutput: string) => void,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (jeoEnv("BASH_FIXUPS") === "1") {
    const fx = applyBashFixups(command);
    command = fx.command;
  }
  try {
    // The mutation lock is keyed on the PROJECT cwd, not the run subdir.
    await assertBashAllowed(cwd);
    const runCwd = subdir ? path.resolve(cwd, subdir) : cwd;
    // Sanitize caller env: keep only string values (a model may send numbers/arrays),
    // so a bad value can't make Bun.spawn throw cryptically.
    const safeEnv = env && !Array.isArray(env)
      ? Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<string, string>
      : undefined;
    // Run the command using Bun's native spawn
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: runCwd,
      stdout: "pipe",
      stderr: "pipe",
      // Inherit the parent env; merge caller-supplied (sanitized) vars on top.
      ...(safeEnv && Object.keys(safeEnv).length ? { env: { ...process.env, ...safeEnv } } : {}),
    });

    let timedOut = false;
    let aborted = false;
    const TIMEOUT_MS = timeoutMs;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      // Graceful first (SIGTERM), then force-kill (SIGKILL) if it ignores it.
      try { proc.kill(); } catch {}
      killTimer = setTimeout(() => { try { proc.kill(9); } catch {} }, 3_000);
    }, TIMEOUT_MS);
    // Abort wiring: if the turn is cancelled, SIGKILL the child immediately AND cancel
    // both pipe readers so the drain loops below unwind at once. We own the readers
    // explicitly (rather than `for await` / `new Response`, whose hidden iterator locks
    // we cannot cancel): cancel() resolves the in-flight read({ done:true }) immediately,
    // unwinding each loop even when the killed child's pipe is slow to hit EOF. Cancelling
    // stderr also prevents a hang — after kill(9) its pipe never sees EOF, so awaiting an
    // uncancellable Response would block forever. Without all this the child is orphaned,
    // holding two pipe FDs (proven by scripts/subproc-probe.ts ABANDON mode: +1 fd & +1
    // child per call).
    let stdoutReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stderrReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const onAbort = () => {
      aborted = true;
      try { proc.kill(9); } catch {}
      try { stdoutReader?.cancel(); } catch {}
      try { stderrReader?.cancel(); } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    // Drain a pipe to a string, cancel-safe. An optional onChunk sink receives the
    // running output (throttled by the caller) to drive the live DIMMED bash view.
    const drainAll = async (
      r: ReadableStreamDefaultReader<Uint8Array>,
      onChunk?: (partial: string) => void,
    ): Promise<string> => {
      const dec = new TextDecoder();
      let out = "";
      try {
        for (;;) {
          if (aborted) break;
          const { done, value } = await r.read();
          if (done) break;
          out += dec.decode(value, { stream: true });
          onChunk?.(out);
        }
        out += dec.decode();
        onChunk?.(out);
      } catch { /* cancelled reader surfaces here; return what we have */ }
      return out;
    };
    stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const stderrPromise = drainAll(stderrReader).catch(() => "");
    let stdout = "";
    try {
      if (onProgress) {
        // Throttle the live sink to ~80ms; drainAll owns the cancel-safe read loop.
        let lastEmit = 0;
        stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader() as ReadableStreamDefaultReader<Uint8Array>;
        stdout = await drainAll(stdoutReader, (partial) => {
          const now = Date.now();
          if (now - lastEmit >= 80) { lastEmit = now; onProgress(partial); }
        });
        onProgress(stdout);
      } else if (!aborted) {
        stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader() as ReadableStreamDefaultReader<Uint8Array>;
        stdout = await drainAll(stdoutReader);
      }
      if (!aborted) await proc.exited;
    } catch (streamErr) {
      // A cancelled stdout reader (from onAbort) surfaces here; swallow it so we can
      // return a clean aborted result rather than a stream-internal error.
      if (!aborted) throw streamErr;
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      // Belt-and-suspenders: if we are leaving for ANY reason (normal exit, stdout-loop
      // throw, abort) and the child is somehow still alive, reap it so no orphaned
      // process or pipe FD survives the call.
      if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill(9); } catch {} }
      // Always settle the stderr reader to release its pipe FD.
      await stderrPromise;
    }
    const stderr = await stderrPromise;

    let output = [stdout, stderr].filter(Boolean).join("\n");
    const MAX_OUTPUT = 100_000;
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n…(output truncated at 100000 chars)";
    }

    if (aborted) {
      return { success: false, output, error: "Command aborted" };
    }
    if (timedOut) {
      return {
        success: false,
        output,
        error: `Command timed out after ${Math.round(TIMEOUT_MS / 1000)}s and was killed`,
      };
    }

    return {
      success: proc.exitCode === 0,
      output: output || "(no output)",
      error: proc.exitCode !== 0 ? `Exit code ${proc.exitCode}` : undefined,
    };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}

/** Spawn a command, capture output, and escalate SIGTERM→SIGKILL if it exceeds
 *  timeoutMs — so a runaway grep/find over a huge tree can't block the whole turn. */
async function spawnTextWithTimeout(
  cmd: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
    killTimer = setTimeout(() => { try { proc.kill(9); } catch {} }, 3_000);
  }, timeoutMs);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: proc.exitCode, timedOut };
}

export async function findTool(
  globPattern: string,
  cwd: string = process.cwd()
): Promise<ToolResult> {
  // Guard loose model input: a missing/empty pattern (model called find with no
  // globPattern) must be a soft tool error, not an uncaught `globPattern.includes`
  // crash that aborts the whole turn.
  if (typeof globPattern !== "string" || globPattern.trim() === "") {
    return { success: false, output: "", error: 'find requires a non-empty "globPattern", e.g. "src/**/*.ts" or "*.ts".' };
  }
  // Bare-name patterns (no path separator, no `**`) → recursive basename match via
  // `find -name`, preserving the "find files by name" contract and the expectation that
  // `*.ts` matches at any depth. Patterns with a `/` or `**` are real PATH globs
  // (`src/**/*.ts`, `src/agent/*.ts`, an exact relative path) which `find -name` can NEVER
  // match (it only sees basenames) — route those through Bun.Glob for correct semantics.
  if (globPattern.includes("/") || globPattern.includes("**")) {
    try {
      const gi = await readGitignore(cwd);
      const prunedDirs = new Set([...IGNORED_DIRS, ...gi.dirs]);
      const fileGlobs = gi.fileGlobs.map(g => new Bun.Glob(g));
      const matches: string[] = [];
      for await (const rel of new Bun.Glob(globPattern).scan({ cwd, onlyFiles: true })) {
        const segs = rel.split("/");
        if (segs.some(seg => prunedDirs.has(seg))) continue;
        const base = segs[segs.length - 1] ?? rel;
        if (fileGlobs.some(g => g.match(base))) continue;
        matches.push(`./${rel}`);
        if (matches.length >= 5000) break;
      }
      matches.sort();
      let output = matches.length ? matches.join("\n") : "No matching files found.";
      const MAX_OUTPUT = 100_000;
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + "\n…(output truncated at 100000 chars)";
      }
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  }
  try {
    const gi = await readGitignore(cwd);
    const pruneNames = [...IGNORED_DIRS, ...gi.dirs];
    const pruneGroup: string[] = [];
    for (let i = 0; i < pruneNames.length; i++) {
      if (i > 0) pruneGroup.push("-o");
      pruneGroup.push("-name", pruneNames[i]!);
    }
    const { stdout, timedOut } = await spawnTextWithTimeout(
      ["find", ".", "-type", "d", "(", ...pruneGroup, ")", "-prune", "-o", "-name", globPattern, "-print"],
      cwd,
    );
    if (timedOut) return { success: false, output: "", error: "find timed out (60s) — narrow the pattern." };
    const files = stdout.split("\n").filter(Boolean);
    let output = files.length > 0 ? files.join("\n") : "No matching files found.";
    const MAX_OUTPUT = 100_000;
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n…(output truncated at 100000 chars)";
    }
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}

export interface SearchOptions {
  /** Lines of context before/after each match (grep -B/-A). */
  before?: number;
  after?: number;
  /** Symmetric context (grep -C); overrides before/after when set. */
  context?: number;
  /** Stop after this many matches per file (grep -m). */
  maxMatches?: number;
}

export async function searchTool(
  pattern: string,
  globPattern: string = "*",
  cwd: string = process.cwd(),
  ignoreCase: boolean = false,
  opts: SearchOptions = {},
): Promise<ToolResult> {
  if (typeof pattern !== "string" || pattern === "") {
    return { success: false, output: "", error: 'search requires a non-empty "pattern" (a regex/string to grep for).' };
  }
  try {
    const flags = ignoreCase ? "-rnIi" : "-rnI";
    const gi = await readGitignore(cwd);
    // A gitignore glob like `.*` (or a bare `*`/`**`) is meant to skip dotfiles, but as a
    // grep --exclude/--exclude-dir it matches the `./`-prefixed traversal paths and silently
    // excludes EVERY file on BSD grep (the field bug: search returned "No matches found" for
    // text that existed). Drop these all-matching globs — IGNORED_DIRS still covers the key
    // dotdirs (.git/.jeo/.next/.cache), and find() is unaffected (it matches via -name).
    const safeGlob = (g: string) => !/^\.?\*+$/.test(g);
    const excludes = [
      ...[...IGNORED_DIRS, ...gi.dirs.filter(safeGlob)].map(d => `--exclude-dir=${d}`),
      ...gi.fileGlobs.filter(safeGlob).map(f => `--exclude=${f}`),
    ];
    const n = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
    const ctx: string[] = [];
    const C = n(opts.context), B = n(opts.before), A = n(opts.after), M = n(opts.maxMatches);
    if (C !== undefined) ctx.push("-C", String(C));
    else {
      if (B !== undefined) ctx.push("-B", String(B));
      if (A !== undefined) ctx.push("-A", String(A));
    }
    if (M !== undefined) ctx.push("-m", String(M));
    const { stdout, stderr, exitCode, timedOut } = await spawnTextWithTimeout(
      ["grep", flags, ...ctx, "--include", globPattern, ...excludes, "--", pattern, "."],
      cwd,
    );
    if (timedOut) return { success: false, output: "", error: "search timed out (60s) — narrow the pattern or glob." };
    // grep exit codes: 0 = match, 1 = no match (not an error), >=2 = a real error.
    if (exitCode !== null && exitCode >= 2) {
      return { success: false, output: stdout, error: stderr.trim() || `grep failed (exit ${exitCode})` };
    }
    let output = stdout || "No matches found.";
    const MAX_OUTPUT = 100_000;
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n…(output truncated at 100000 chars)";
    }
    return { success: true, output };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}
/**
 * List a single directory's entries (read-only): directories first (with a
 * trailing `/`), then files, alphabetically. Hidden entries are included. This
 * gives the model gjc-style directory inspection without shelling out to `ls`.
 */
export async function lsTool(
  dirPath: string = ".",
  cwd: string = process.cwd()
): Promise<ToolResult> {
  try {
    const abs = path.resolve(cwd, dirPath);
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      return { success: false, output: "", error: `Not a directory: ${dirPath} (use read for files).` };
    }
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return { success: true, output: "(empty directory)" };
    const sorted = entries.sort((a, b) =>
      a.isDirectory() !== b.isDirectory() ? (a.isDirectory() ? -1 : 1) : a.name.localeCompare(b.name),
    );
    const out = sorted.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
    return { success: true, output: out };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}

/**
 * Create a directory (and any missing parents). Idempotent: an already-existing
 * directory is a success, not an error — the model should not need to branch on
 * existence. Respects the deep-interview mutation lock like write/edit.
 */
export async function mkdirTool(
  dirPath: string,
  cwd: string = process.cwd()
): Promise<ToolResult> {
  try {
    if (typeof dirPath !== "string" || dirPath.trim() === "") {
      return { success: false, output: "", error: 'mkdir requires a non-empty "dirPath".' };
    }
    await assertMutationAllowed(dirPath, cwd);
    const abs = path.resolve(cwd, dirPath);
    const existing = await fs.stat(abs).catch(() => null);
    if (existing && !existing.isDirectory()) {
      return { success: false, output: "", error: `Path exists and is not a directory: ${dirPath}` };
    }
    await fs.mkdir(abs, { recursive: true });
    return { success: true, output: `Directory ready: ${dirPath}` };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}

/**
 * Delete a file or directory. A directory requires `recursive: true` so a stray
 * call cannot wipe a populated tree by accident. Missing paths are a soft error
 * (nothing to delete) rather than a crash. Respects the mutation lock like
 * write/edit; the file-freshness snapshot is cleared so a later write to the
 * same path is not rejected as stale.
 */
export async function deleteTool(
  targetPath: string,
  cwd: string = process.cwd(),
  recursive: boolean = false
): Promise<ToolResult> {
  try {
    if (typeof targetPath !== "string" || targetPath.trim() === "") {
      return { success: false, output: "", error: 'delete requires a non-empty "path".' };
    }
    await assertMutationAllowed(targetPath, cwd);
    const abs = path.resolve(cwd, targetPath);
    if (abs === path.resolve(cwd)) {
      return { success: false, output: "", error: "Refusing to delete the working directory itself." };
    }
    const st = await fs.stat(abs).catch(() => null);
    if (!st) {
      return { success: false, output: "", error: `Nothing to delete: ${targetPath} (does not exist).` };
    }
    if (st.isDirectory() && !recursive) {
      return { success: false, output: "", error: `${targetPath} is a directory — pass recursive:true to remove it and its contents.` };
    }
    await fs.rm(abs, { recursive, force: false });
    lastReadSnapshots.delete(abs); // a future write to this path must not be flagged stale
    return { success: true, output: `Deleted ${st.isDirectory() ? "directory" : "file"}: ${targetPath}` };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}
