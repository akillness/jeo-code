import { applyBashFixups } from "./bash-fixups";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkflowState, readWorkflowStateStrict, type WorkflowState } from "./state";
import { jeoEnv } from "../util/env";

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
  ".joc",
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
 * is NOT under the `.joc/` directory (planning/spec files are allowed).
 */
export async function assertMutationAllowed(
  filePath: string,
  cwd: string = process.cwd()
): Promise<void> {
  const deepInterviewState = await readMutationLock(cwd);
  if (deepInterviewState && deepInterviewState.active && deepInterviewState.current_phase !== "complete") {
    // Check if the target is NOT inside the local .joc folder. Use a path-boundary
    // check (not bare startsWith) so siblings like ".joc-backup" aren't mistaken for ".joc/".
    const absPath = path.resolve(cwd, filePath);
    const jocDir = path.resolve(cwd, ".joc");
    const insideJoc = absPath === jocDir || absPath.startsWith(jocDir + path.sep);
    if (!insideJoc) {
      throw new Error(
        `[MutationGuard Blocked] Code mutation is blocked while a Socratic interview is active (the requirements seed is not yet frozen).\n` +
        `Current ambiguity: ${((deepInterviewState.current_ambiguity ?? 1) * 100).toFixed(0)}%. Finish the interview to freeze the seed and unlock writes — run 'jeo deep-interview'. Non-interactive '--auto' can continue clarification, but it does not bypass the ambiguity gate.\n` +
        `Only spec/planning writes under '.joc/' are permitted until then.`
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
export function parseLineSelector(spec: string, total: number): { ranges: [number, number][] } | { error: string } {
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

export async function readTool(
  filePath: string,
  lineRange?: string,
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

    if (raw) {
      // Verbatim bytes, no "N|" line prefixes (gjc `:raw`), char-capped for context safety.
      const MAX_CHARS = 50_000;
      if (content.length > MAX_CHARS) {
        return { success: true, output: content.slice(0, MAX_CHARS) + `\n…(raw truncated at ${MAX_CHARS} of ${content.length} chars; drop raw and pass lineRange to read a slice)` };
      }
      return { success: true, output: content };
    }

    const lines = content.split("\n");

    if (lineRange) {
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
          out.push(`${ln}|${lines[ln - 1] ?? ""}`);
          emitted++;
        }
      }
      if (capped) out.push(`…(range truncated at ${MAX_RANGE_LINES} lines; narrow the range)`);
      return { success: true, output: out.join("\n") };
    }

    const MAX_LINES = 500;
    const annotated = lines.slice(0, MAX_LINES).map((l, i) => `${i + 1}|${l}`).join("\n");
    if (lines.length > MAX_LINES) {
      const notice = `\n…(showing lines 1-${MAX_LINES} of ${lines.length}; pass lineRange "${MAX_LINES + 1}-" to read the rest)`;
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
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, "utf-8");
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
    let content = await fs.readFile(absPath, "utf-8");

    // Line-anchored edit parser. Modes (payload follows the directive's newline):
    //   ≔A..B   replace lines A..B          ≔A    replace line A
    //   ≔A+     insert AFTER line A (A=0 prepends)
    //   ≔$      append to end of file
    // Falls back to <<<<<<< SEARCH / ======= / >>>>>>> substring replacement.
    const lines = content.split("\n");

    let updated = false;
    if (editBlock.startsWith("≔")) {
      const appendMatch = editBlock.match(/^≔\$\n?([\s\S]*)$/);
      const insertMatch = editBlock.match(/^≔(\d+)\+\n?([\s\S]*)$/);
      const replaceMatch = editBlock.match(/^≔(\d+)(?:\.\.(\d+))?\n([\s\S]*)$/);
      if (appendMatch) {
        const payload = appendMatch[1];
        content = content === "" || content.endsWith("\n") ? content + payload : content + "\n" + payload;
        updated = true;
      } else if (insertMatch) {
        const at = parseInt(insertMatch[1]); // insert AFTER line `at`; 0 prepends
        const payload = insertMatch[2];
        if (at < 0 || at > lines.length) {
          return { success: false, output: "", error: `Invalid insert position ${at}: out of bounds (file has ${lines.length} lines)` };
        }
        lines.splice(at, 0, payload);
        content = lines.join("\n");
        updated = true;
      } else if (replaceMatch) {
        const startLine = parseInt(replaceMatch[1]);
        const endLine = replaceMatch[2] ? parseInt(replaceMatch[2]) : startLine;
        const payload = replaceMatch[3];
        if (startLine < 1 || endLine < startLine || endLine > lines.length) {
          return {
            success: false,
            output: "",
            error: `Invalid edit range ${startLine}..${endLine}: out of bounds or reversed (file has ${lines.length} lines)`,
          };
        }
        lines.splice(startLine - 1, endLine - startLine + 1, payload);
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
        for (const [i, h] of hunks.entries()) {
          if (h.search === "") {
            return { success: false, output: "", error: `Failed to apply edit: hunk ${i + 1} has an empty SEARCH block.` };
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
              ? " The first search line IS present, so the mismatch is below it — re-read the exact bytes with read, then retry."
              : "";
            const which = hunks.length > 1 ? ` (hunk ${i + 1}/${hunks.length})` : "";
            return { success: false, output: "", error: `Failed to apply edit: Search block not found in file${which}.${trimmedHit}${anchorHit}` };
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
  env?: Record<string, string>
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
    const TIMEOUT_MS = timeoutMs;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      // Graceful first (SIGTERM), then force-kill (SIGKILL) if it ignores it.
      try { proc.kill(); } catch {}
      killTimer = setTimeout(() => { try { proc.kill(9); } catch {} }, 3_000);
    }, TIMEOUT_MS);

    await proc.exited;
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    let output = [stdout, stderr].filter(Boolean).join("\n");
    const MAX_OUTPUT = 100_000;
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n…(output truncated at 100000 chars)";
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
    const excludes = [
      ...[...IGNORED_DIRS, ...gi.dirs].map(d => `--exclude-dir=${d}`),
      ...gi.fileGlobs.map(f => `--exclude=${f}`),
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
