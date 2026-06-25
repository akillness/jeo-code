/**
 * Tool-result output handling — the model-visible output budget, both-ends
 * truncation, recoverable artifact spilling, and the minimize→truncate→spill
 * orchestration the agent loop applies to every tool result.
 *
 * Extracted from `engine.ts` (single-responsibility: the loop drives steps; this
 * module owns how a tool's raw output is shaped before it re-enters context).
 * `engine.ts` re-exports the public surface for backward compatibility.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { jeoEnv } from "../util/env";
import { minimizeToolOutput } from "./output-minimizer";

/** Env-tunable output budget (plan/gjc-inheritance.md B10, gjc settings-driven
 *  output handling 계승): JEO_TOOL_OUTPUT_MAX caps the model-visible tool result;
 *  the spill threshold tracks it so anything truncated stays artifact-recoverable. */
function envOutputMax(): number {
  const raw = Number(jeoEnv("TOOL_OUTPUT_MAX") ?? "");
  return Number.isFinite(raw) && raw >= 500 && raw <= 200_000 ? Math.trunc(raw) : 4_000;
}
export const TOOL_OUTPUT_MAX = envOutputMax();

/** Read results are deliberate, contiguous file slices the model explicitly asked
 *  for (via lineRange), already line-capped by the read tool and recoverable via
 *  spill. They get a much larger model-visible budget than the generic
 *  noise-control cap, so a 500-line read is not silently re-shrunk to ~100 lines.
 *  JEO_READ_OUTPUT_MAX overrides (1k..200k). */
function envReadOutputMax(): number {
  const raw = Number(jeoEnv("READ_OUTPUT_MAX") ?? "");
  return Number.isFinite(raw) && raw >= 1_000 && raw <= 200_000 ? Math.trunc(raw) : 32_000;
}
export const READ_OUTPUT_MAX = envReadOutputMax();

/**
 * Cap a tool result fed back to the model. Default mode keeps both ends: the head
 * holds the start (e.g. a command's invocation) and the tail holds what's usually
 * decisive (test summaries, the final error). A pure head-cut loses that.
 *
 * `headOnly` truncates from the front only — for `read` results, which are a
 * contiguous file slice the model explicitly requested; head/tail splitting would
 * mangle the code into two non-adjacent fragments.
 */
export function truncateToolOutput(s: string, max = TOOL_OUTPUT_MAX, headOnly = false): string {
  if (s.length <= max) return s;
  if (headOnly) {
    return `${s.slice(0, max)}\n…(${s.length - max} chars truncated; narrow the lineRange or read the spilled artifact)…`;
  }
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${s.slice(0, head)}\n…(${s.length - max} chars truncated)…\n${s.slice(s.length - tail)}`;
}

/** Non-read tool output larger than this is spilled to a recoverable artifact file.
 *  Aligned with `truncateToolOutput`'s generic cap so that whenever the model-visible
 *  result drops content, the full output is recoverable via the artifact. (`read`
 *  spills against the larger READ_OUTPUT_MAX in the result loop.) */
export const TOOL_SPILL_THRESHOLD = TOOL_OUTPUT_MAX;

/** Most recent tool-result artifacts to keep; older ones are pruned on each spill. */
export const MAX_TOOL_ARTIFACTS = 50;

/** Best-effort retention: keep the newest `MAX_TOOL_ARTIFACTS` files in `dir`, delete the rest. */
async function pruneToolArtifacts(dir: string): Promise<void> {
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  if (files.length <= MAX_TOOL_ARTIFACTS) return;
  const stamped = await Promise.all(
    files.map(async f => ({ f, m: (await fs.stat(path.join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  stamped.sort((a, b) => b.m - a.m); // newest first
  for (const { f } of stamped.slice(MAX_TOOL_ARTIFACTS)) {
    await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
  }
}

/**
 * Write an oversized tool result verbatim under `.jeo/artifacts/tool-results/` and
 * return the workspace-relative path (for the model to `read`). Best-effort: throws
 * are caught by the caller, which simply omits the artifact note.
 */
export async function spillToolResult(tool: string, output: string, cwd: string): Promise<string> {
  const dir = path.join(cwd, ".jeo", "artifacts", "tool-results");
  await fs.mkdir(dir, { recursive: true });
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "tool";
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rel = `.jeo/artifacts/tool-results/${stamp}-${safeTool}.txt`;
  await fs.writeFile(path.join(cwd, rel), output, "utf-8");
  // Retention so a long session can't grow the artifact dir without bound.
  await pruneToolArtifacts(dir);
  return rel;
}

/**
 * Shape one tool's raw output into the model-visible result body: strip runner
 * noise (minimize), cap to the per-tool budget (`read` gets the larger read budget
 * and a head-only cut), and spill the full output to a recoverable artifact when it
 * exceeds the budget. Behavior-identical to the inline logic it replaces in
 * `runAgentLoop`.
 */
export async function formatToolResultBody(tool: string, rawOutput: string, cwd: string): Promise<string> {
  const visible = minimizeToolOutput(rawOutput, tool).text;
  // `read` is a deliberate, contiguous file slice: give it the larger read budget
  // and truncate head-only (head/tail splitting mangles code). Other tools keep the
  // generic noise-control cap + both-ends truncation.
  const isReadResult = tool === "read";
  const outputBudget = isReadResult ? READ_OUTPUT_MAX : TOOL_OUTPUT_MAX;
  let body = truncateToolOutput(visible, outputBudget, isReadResult);
  if (rawOutput.length > outputBudget) {
    const artifact = await spillToolResult(tool, rawOutput, cwd).catch(() => null);
    if (artifact) {
      body += `\n[full output (${rawOutput.length} chars) saved to ${artifact} — read it for the truncated remainder]`;
    }
  }
  return body;
}
