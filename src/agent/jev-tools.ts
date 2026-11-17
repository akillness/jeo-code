import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";

export const JEV_DECIDE_TOOL_PROTOCOL_LINE =
  `jev_decide {goal, candidates, context?} — invoke local Jev (qev) bounded System 1 selector to pick the best candidate action/choice.`;

function qevEndpoint(): string {
  return process.env.JEO_QEV_URL?.trim() || "http://127.0.0.1:8017/v1/systemone";
}

function allowQevCalls(): boolean {
  if (process.env.JEO_QEV_ROUTER === "0") return false;
  if (process.env.NODE_ENV === "test" && !process.env.JEO_QEV_URL?.trim()) return false;
  return true;
}

export function createJevDecideTool(): ToolHandler {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    const rawCandidates = Array.isArray(args.candidates) ? args.candidates : [];
    const candidates = rawCandidates
      .map((c) => (typeof c === "string" ? c.trim() : JSON.stringify(c)))
      .filter(Boolean)
      .slice(0, 12);
    if (!goal || candidates.length === 0) {
      return {
        success: false,
        output: "",
        error: `jev_decide requires a non-empty "goal" and a non-empty "candidates" array.`,
      };
    }
    if (!allowQevCalls()) {
      return {
        success: true,
        output: JSON.stringify({ chosen: candidates[0], source: "fallback", reason: "qev disabled in test" }, null, 2),
      };
    }
    const state: Record<string, string> = {
      goal: goal.slice(0, 800),
      ...(typeof args.context === "string" && args.context.trim() ? { context: args.context.trim().slice(0, 1000) } : {}),
    };
    const indexed = candidates.map((label, idx) => `${idx}:${label.slice(0, 140)}`);
    try {
      const resp = await fetch(qevEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state,
          model: "qev-0.8b-text-Q8_0",
          questions: {
            choice: {
              type: "choice",
              instructions: "Select the safest and highest-value candidate action for this goal.",
              options: indexed,
            },
          },
        }),
        signal: AbortSignal.timeout(500),
      });
      if (!resp.ok) {
        return {
          success: true,
          output: JSON.stringify({ chosen: candidates[0], source: "fallback", status: resp.status }, null, 2),
        };
      }
      const payload = (await resp.json()) as {
        answers?: { choice?: { choice?: string; probabilities?: Record<string, number> } };
      };
      const picked = payload?.answers?.choice?.choice;
      const idx = typeof picked === "string" ? Number.parseInt(picked.split(":", 1)[0] ?? "0", 10) : 0;
      const chosen = Number.isFinite(idx) && candidates[idx] ? candidates[idx]! : candidates[0]!;
      return {
        success: true,
        output: JSON.stringify(
          {
            chosen,
            index: Number.isFinite(idx) && candidates[idx] ? idx : 0,
            probabilities: payload?.answers?.choice?.probabilities ?? null,
            source: "qev",
          },
          null,
          2,
        ),
      };
    } catch {
      return {
        success: true,
        output: JSON.stringify({ chosen: candidates[0], source: "fallback" }, null, 2),
      };
    }
  };
}

export async function evaluateSubagentWithQev(
  taskText: string,
  summary: string,
): Promise<{ pass: boolean; score: number } | null> {
  if (process.env.JEO_SUBAGENT_EVAL !== "1" || !allowQevCalls()) return null;
  if (!taskText.trim() || !summary.trim()) return null;
  try {
    const resp = await fetch(qevEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: { task: taskText.slice(0, 800), summary: summary.slice(0, 1400) },
        model: "qev-0.8b-text-Q8_0",
        questions: {
          completed: {
            type: "noul",
            instructions: "Did the subagent output fully and accurately satisfy the requested task with verified evidence?",
          },
        },
      }),
      signal: AbortSignal.timeout(500),
    });
    if (!resp.ok) return null;
    const payload = (await resp.json()) as { answers?: { completed?: { noul?: number } } };
    const score = payload?.answers?.completed?.noul;
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    return { pass: score >= 0.35, score };
  } catch {
    return null;
  }
}
