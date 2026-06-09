import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkflowState, readWorkflowStateStrict, type WorkflowState } from "./state";

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
 * artifacts, dependency trees, and joc's own runtime dir. gjc's native search
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
        `Current ambiguity: ${((deepInterviewState.current_ambiguity ?? 1) * 100).toFixed(0)}%. Finish the interview to freeze the seed and unlock writes — run 'joc deep-interview' (or 'joc deep-interview --auto' for a best-effort freeze).\n` +
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
      "[MutationGuard] bash is blocked while a Socratic interview is active (requirements seed not frozen). Finish 'joc deep-interview' (or '--auto') to freeze the seed and unlock."
    );
  }
}

export async function readTool(
  filePath: string,
  lineRange?: string,
  cwd: string = process.cwd()
): Promise<ToolResult> {
  try {
    const absPath = path.resolve(cwd, filePath);
    const content = await fs.readFile(absPath, "utf-8");
    const lines = content.split("\n");

    if (lineRange) {
      // Accept "start-end", open-ended "start-", or a single "start".
      const match = lineRange.match(/^(\d+)(?:-(\d+)?)?$/);
      if (match) {
        const start = Math.max(1, parseInt(match[1]));
        const hasRange = lineRange.includes("-");
        const end = match[2]
          ? Math.min(lines.length, parseInt(match[2]))
          : hasRange
            ? lines.length            // "start-" → to EOF
            : Math.min(lines.length, start); // single line
        if (end < start) {
          return { success: false, output: "", error: `Invalid lineRange '${lineRange}': end < start (file has ${lines.length} lines)` };
        }
        const sliced = lines.slice(start - 1, end).map((l, i) => `${start + i}|${l}`).join("\n");
        return { success: true, output: sliced };
      }
      return { success: false, output: "", error: `Invalid lineRange '${lineRange}'. Use "start-end", "start-", or "start".` };
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
    await assertMutationAllowed(filePath, cwd);
    const absPath = path.resolve(cwd, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, "utf-8");
    return { success: true, output: `Successfully wrote ${content.length} characters to ${filePath}` };
  } catch (err: any) {
    return { success: false, output: "", error: err.message };
  }
}

export async function editTool(
  filePath: string,
  editBlock: string,
  cwd: string = process.cwd()
): Promise<ToolResult> {
  try {
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
      // Direct substring replacement fallback
      const searchMatch = editBlock.split("<<<<<<< SEARCH");
      if (searchMatch.length > 1) {
        const parts = searchMatch[1].split("=======");
        if (parts.length > 1) {
          let searchVal = parts[0];
          if (searchVal.startsWith("\r\n")) {
            searchVal = searchVal.slice(2);
          } else if (searchVal.startsWith("\n")) {
            searchVal = searchVal.slice(1);
          }
          if (searchVal.endsWith("\r\n")) {
            searchVal = searchVal.slice(0, -2);
          } else if (searchVal.endsWith("\n")) {
            searchVal = searchVal.slice(0, -1);
          }

          if (searchVal === "") {
            return {
              success: false,
              output: "",
              error: "Failed to apply edit: Search block is empty.",
            };
          }

          const replaceParts = parts[1].split(">>>>>>>");
          if (replaceParts.length > 0) {
            let replaceVal = replaceParts[0];
            if (replaceVal.startsWith("\r\n")) {
              replaceVal = replaceVal.slice(2);
            } else if (replaceVal.startsWith("\n")) {
              replaceVal = replaceVal.slice(1);
            }
            if (replaceVal.endsWith("\r\n")) {
              replaceVal = replaceVal.slice(0, -2);
            } else if (replaceVal.endsWith("\n")) {
              replaceVal = replaceVal.slice(0, -1);
            }

            if (content.includes(searchVal)) {
              content = content.replace(searchVal, replaceVal);
              updated = true;
            } else {
              return {
                success: false,
                output: "",
                error: "Failed to apply edit: Search block not found in file.",
              };
            }
          }
        }
      }
    }

    if (!updated) {
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
  timeoutMs: number = 120_000
): Promise<ToolResult> {
  try {
    await assertBashAllowed(cwd);
    // Run the command using Bun's native spawn
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
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

export async function findTool(
  globPattern: string,
  cwd: string = process.cwd()
): Promise<ToolResult> {
  // Bare-name patterns (no path separator, no `**`) → recursive basename match via
  // `find -name`, preserving the "find files by name" contract and the expectation that
  // `*.ts` matches at any depth. Patterns with a `/` or `**` are real PATH globs
  // (`src/**/*.ts`, `src/agent/*.ts`, an exact relative path) which `find -name` can NEVER
  // match (it only sees basenames) — route those through Bun.Glob for correct semantics.
  if (globPattern.includes("/") || globPattern.includes("**")) {
    try {
      const matches: string[] = [];
      for await (const rel of new Bun.Glob(globPattern).scan({ cwd, onlyFiles: true })) {
        if (rel.split("/").some(seg => IGNORED_DIRS.includes(seg))) continue;
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
    const pruneGroup: string[] = [];
    for (let i = 0; i < IGNORED_DIRS.length; i++) {
      if (i > 0) pruneGroup.push("-o");
      pruneGroup.push("-name", IGNORED_DIRS[i]);
    }
    const proc = Bun.spawn(
      ["find", ".", "-type", "d", "(", ...pruneGroup, ")", "-prune", "-o", "-name", globPattern, "-print"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
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

export async function searchTool(
  pattern: string,
  globPattern: string = "*",
  cwd: string = process.cwd()
): Promise<ToolResult> {
  try {
    const excludes = IGNORED_DIRS.map(d => `--exclude-dir=${d}`);
    const proc = Bun.spawn(
      ["grep", "-rnI", "--include", globPattern, ...excludes, "--", pattern, "."],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    // grep exit codes: 0 = match, 1 = no match (not an error), >=2 = a real error.
    if (proc.exitCode !== null && proc.exitCode >= 2) {
      return { success: false, output: stdout, error: stderr.trim() || `grep failed (exit ${proc.exitCode})` };
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
