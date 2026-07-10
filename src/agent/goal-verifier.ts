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
}

/**
 * Deterministic downgrade gate: an LLM-judged MET verdict is trustworthy only when
 * the turn either made no file changes, or made changes AND a fresh (non-stale)
 * verification signal (test/build/typecheck/lint) was observed. A turn that mutated
 * files with no verification at all, or whose only verification predates the last
 * mutation, cannot self-report MET on the transcript alone — that is exactly the
 * "gate theater" failure mode (an LLM asserting success without re-checked evidence).
 * NOT_MET/IMPOSSIBLE verdicts pass through unchanged: this only ever tightens MET,
 * never loosens a verdict the LLM itself already found lacking.
 */
export function applyEvidenceGate(verdict: GoalVerdict, evidence: TurnEvidence): GoalVerdict {
  if (verdict.verdict !== "MET") return verdict;
  if (!evidence.sawMutation) return verdict; // nothing changed — the transcript judgment stands
  if (evidence.sawVerification && !evidence.verificationStale) return verdict; // fresh verification backs the claim

  const gap = !evidence.sawVerification
    ? "the turn modified files but no test/build/typecheck/lint run was observed"
    : "the turn's only verification run predates its last file modification (stale evidence)";
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
}

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getLocalJeoDir } from "./state";

export function getGoalPath(cwd: string = process.cwd()): string {
  return path.join(getLocalJeoDir(cwd), "state", "goal.json");
}

export async function readGoalState(cwd: string = process.cwd()): Promise<GoalState | null> {
  const p = getGoalPath(cwd);
  try {
    const data = await fs.readFile(p, "utf-8");
    return JSON.parse(data) as GoalState;
  } catch {
    return null;
  }
}

export async function writeGoalState(state: GoalState, cwd: string = process.cwd()): Promise<void> {
  const p = getGoalPath(cwd);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(state, null, 2), "utf-8");
}

export async function clearGoalState(cwd: string = process.cwd()): Promise<void> {
  const p = getGoalPath(cwd);
  await fs.unlink(p).catch(() => {});
}