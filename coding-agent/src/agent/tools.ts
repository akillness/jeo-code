import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkflowState } from "./state";

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
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
  const deepInterviewState = await readWorkflowState("deep-interview", cwd);
  if (deepInterviewState && deepInterviewState.active && deepInterviewState.current_phase !== "complete") {
    // Check if the target is NOT inside the local .joc folder
    const absPath = path.resolve(cwd, filePath);
    const jocDir = path.resolve(cwd, ".joc");
    if (!absPath.startsWith(jocDir)) {
      throw new Error(
        `[MutationGuard Blocked] Code mutation is strictly blocked during an active Socratic interview.\n` +
        `Current Ambiguity Score: ${((deepInterviewState.current_ambiguity ?? 1) * 100).toFixed(0)}% (must be <= 20% to unlock).\n` +
        `Only spec/planning writes under '.joc/' are permitted. Finish requirements with 'joc deep-interview' first.`
      );
    }
  }
}

export async function assertBashAllowed(
  cwd: string = process.cwd()
): Promise<void> {
  const deepInterviewState = await readWorkflowState("deep-interview", cwd);
  if (deepInterviewState && deepInterviewState.active && deepInterviewState.current_phase !== "complete") {
    throw new Error(
      "[MutationGuard] bash is disabled during an active Socratic interview (ambiguity must reach <=20% first). Finish 'joc deep-interview'."
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
      const match = lineRange.match(/^(\d+)-(\d+)$/);
      if (match) {
        const start = Math.max(1, parseInt(match[1]));
        const end = Math.min(lines.length, parseInt(match[2]));
        const sliced = lines.slice(start - 1, end).map((l, i) => `${start + i}|${l}`).join("\n");
        return { success: true, output: sliced };
      }
    }

    const annotated = lines.map((l, i) => `${i + 1}|${l}`).slice(0, 500).join("\n");
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

    // Simple line-anchored edit parser for our Joc agent.
    // Handles ≔A..B replace format or pure search-and-replace
    const lines = content.split("\n");
    const editLines = editBlock.split("\n");

    let updated = false;
    // Simple patch format parser
    if (editBlock.includes("≔")) {
      const match = editBlock.match(/≔(\d+)(?:\.\.(\d+))?\n([\s\S]*)/);
      if (match) {
        const startLine = parseInt(match[1]);
        const endLine = match[2] ? parseInt(match[2]) : startLine;
        const payload = match[3];

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
  cwd: string = process.cwd()
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
    const TIMEOUT_MS = 120_000;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {}
    }, TIMEOUT_MS);

    await proc.exited;
    clearTimeout(timer);

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
        error: "Command timed out after 120s and was killed",
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
  try {
    const proc = Bun.spawn(["find", ".", "-name", globPattern], {
      cwd,
      stdout: "pipe",
    });
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
    const proc = Bun.spawn(["grep", "-rn", "--include", globPattern, pattern, "."], {
      cwd,
      stdout: "pipe",
    });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
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
