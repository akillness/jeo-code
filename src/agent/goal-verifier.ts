import { randomUUID } from "node:crypto";

import { callLlm, type Message } from "./loop";

export interface GoalVerdict {
  verdict: "MET" | "NOT_MET" | "IMPOSSIBLE";
  reason: string;
}

/**
 * Verify if the user's goal has been met by analyzing the conversation history.
 */
export async function verifyGoal(
  goal: string,
  history: Message[],
  model?: string
): Promise<GoalVerdict> {
  // Format the history messages into a readable transcript for the verifier
  const transcript = history
    .map((m) => {
      if (m.role === "system") return ""; // skip system prompt to avoid clutter
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${m.role.toUpperCase()}]:\n${content}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const systemPrompt = `You are an independent Goal Verifier. Your job is to analyze the conversation transcript and determine if the user's goal has been fully met.

The user's goal is:
"${goal}"

Analyze the transcript carefully. Pay attention to:
1. What the user requested.
2. What actions the agent took (tool calls, file modifications, tests run).
3. The final outcome and verification results.

Verdict discipline:
- Judge the goal exactly as written. Do NOT reframe, narrow, or reinterpret it to fit what the agent happened to build — if the goal as stated is not satisfied, that is NOT_MET, and name precisely what is missing.
- Require positive evidence per requirement: cite the concrete command, test, or file change that shows it was satisfied. The mere absence of an observed failure is NOT proof of success.
- Do not invent requirements beyond the stated goal. When every part of the goal as written has positive evidence, return MET — withholding MET to demand unrequested extras is itself an error.
- Reserve IMPOSSIBLE for goals that cannot be satisfied as specified (self-contradictory, or blocked by missing credentials/services), not for goals that are merely incomplete.

You must respond with a JSON object containing:
{
  "verdict": "MET" | "NOT_MET" | "IMPOSSIBLE",
  "reason": "A detailed explanation of your verdict. If the verdict is NOT_MET, specify exactly what is missing or what needs to be done next."
}

Do not include any other text, markdown formatting, or code blocks. Output raw JSON only.`;

  const userMessage = `Here is the conversation transcript:\n\n${transcript}\n\nAnalyze the transcript and provide your verdict.`;

  try {
    const response = await callLlm([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ], {
      model,
      jsonMode: true,
      maxTokens: 1000,
      reasoningEffort: "none",
    });

    const parsed = JSON.parse(response.trim());
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.verdict === "MET" || parsed.verdict === "NOT_MET" || parsed.verdict === "IMPOSSIBLE") &&
      typeof parsed.reason === "string"
    ) {
      return {
        verdict: parsed.verdict,
        reason: parsed.reason
      };
    }
    throw new Error("Invalid verdict format");
  } catch (err) {
    return {
      verdict: "NOT_MET",
      reason: `Goal verification failed to parse or execute: ${(err as Error).message}. Please verify the goal manually.`
    };

  }
}

/** Evidence the engine's own done-gate already computed this turn (see
 *  `classifyDoneGate`/`engine.ts`) — NOT re-derived here, just consumed, so this
 *  stays a pure function over already-verified signals rather than a second
 *  regex/text scan. */
export interface TurnEvidence {
  sawMutation: boolean;
  sawVerification: boolean;
  verificationStale: boolean;
  /** Mutation evidence persisted from an earlier user turn. */
  pendingMutation?: boolean;
}

/**
 * Deterministic downgrade gate: an LLM-judged MET verdict is trustworthy only when
 * no workspace mutation is pending, or a fresh verification signal follows the
 * most relevant mutation. NOT_MET/IMPOSSIBLE pass through unchanged; this only
 * ever tightens MET, never loosens a verdict the LLM itself already found lacking.
 */
export function applyEvidenceGate(verdict: GoalVerdict, evidence: TurnEvidence): GoalVerdict {
  if (verdict.verdict !== "MET") return verdict;
  const sawMutation = evidence.sawMutation || evidence.pendingMutation === true;
  if (!sawMutation) return verdict;
  if (evidence.sawVerification && !evidence.verificationStale) return verdict;

  const gap = !evidence.sawVerification
    ? "workspace changes are pending but no test/build/typecheck/lint run was observed"
    : "the only verification run predates the last workspace modification (stale evidence)";
  return {
    verdict: "NOT_MET",
    reason:
      `Goal verifier LLM judged MET, but this was overridden by deterministic evidence: ${gap}. ` +
      `Re-run the relevant verification AFTER the last file change, then call done again. ` +
      `(Original LLM reason: ${verdict.reason})`,
  };
}

 

export interface GoalState {
  condition: string;
  setAt: number;
  verdicts: Array<{
    at: number;
    verdict: "MET" | "NOT_MET" | "IMPOSSIBLE";
    gap?: string;
  }>;
  /** Backward-compatible persisted evidence that a mutation still needs verification. */
  pendingMutationVerification?: boolean;
}

export class GoalStateCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalStateCorruptError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isGoalVerdict(value: unknown): value is GoalState["verdicts"][number] {
  return (
    isRecord(value) &&
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    (value.verdict === "MET" || value.verdict === "NOT_MET" || value.verdict === "IMPOSSIBLE") &&
    (value.gap === undefined || typeof value.gap === "string")
  );
}


function parseGoalState(data: string, filePath: string): GoalState {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new GoalStateCorruptError(`Persisted goal state is malformed JSON: ${filePath}`);
  }

  if (
    !isRecord(value) ||
    typeof value.condition !== "string" ||
    value.condition.trim().length === 0 ||
    typeof value.setAt !== "number" ||
    !Number.isFinite(value.setAt) ||
    !Array.isArray(value.verdicts) ||
    (value.pendingMutationVerification !== undefined && typeof value.pendingMutationVerification !== "boolean")
  ) {
    throw new GoalStateCorruptError(`Persisted goal state has invalid required fields: ${filePath}`);
  }

  const verdicts: GoalState["verdicts"] = [];
  for (const verdict of value.verdicts) {
    if (!isGoalVerdict(verdict)) {
      throw new GoalStateCorruptError(`Persisted goal state has an invalid verdict entry: ${filePath}`);
    }
    verdicts.push(verdict);
  }

  return {
    condition: value.condition,
    setAt: value.setAt,
    verdicts,
    ...(value.pendingMutationVerification === undefined
      ? {}
      : { pendingMutationVerification: value.pendingMutationVerification }),
  };
}

/** Apply this turn's evidence to the persisted pending-mutation flag. */
export function applyPendingEvidence(state: GoalState, evidence: TurnEvidence): GoalState {
  const pendingMutationVerification = evidence.sawVerification && !evidence.verificationStale
    ? false
    : state.pendingMutationVerification === true || evidence.sawMutation;
  return { ...state, pendingMutationVerification };
}


import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getLocalJeoDir } from "./state";

export function getGoalPath(cwd: string = process.cwd()): string {
  return path.join(getLocalJeoDir(cwd), "state", "goal.json");
}

export async function readGoalState(cwd: string = process.cwd()): Promise<GoalState | null> {
  const p = getGoalPath(cwd);
  let data: string;
  try {
    data = await fs.readFile(p, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseGoalState(data, p);
}

export async function writeGoalState(state: GoalState, cwd: string = process.cwd()): Promise<void> {
  const p = getGoalPath(cwd);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tempPath = `${p}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), { encoding: "utf-8", flag: "wx" });
    await fs.rename(tempPath, p);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

export async function clearGoalState(cwd: string = process.cwd()): Promise<void> {
  const p = getGoalPath(cwd);
  await fs.unlink(p).catch(() => {});
}