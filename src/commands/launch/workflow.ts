import { runDeepInterviewEngine, type DeepInterviewEngineOptions } from "../deep-interview";
import { runRalplanEngine, type RalplanEngineOptions } from "../ralplan";
import { runTeamEngine, type TeamEngineOptions } from "../team";
import { runUltragoalEngine, type UltragoalEngineOptions } from "../ultragoal";

/** The bundled workflow skills that run through a dedicated engine (deep-interview /
 *  ralplan / team / ultragoal), not the ordinary agent loop. Single source of truth —
 *  the menu listing, the dispatch guards, and the engine switch all read from here. */
export const WORKFLOW_NAMES = ["deep-interview", "ralplan", "team", "ultragoal"] as const;

/** True when a skill name is one of the bundled workflow engines. */
export function isWorkflowSkill(name: string): boolean {
  return (WORKFLOW_NAMES as readonly string[]).includes(name);
}

/** Dispatch a bundled workflow by name to its engine. Keeps the name→engine mapping in
 *  ONE place so the one-shot and interactive skill runners can't drift apart. */
export function runWorkflowEngine(
  name: string,
  opts: DeepInterviewEngineOptions & RalplanEngineOptions & TeamEngineOptions & UltragoalEngineOptions,
): Promise<{ ok: boolean; reason?: string }> {
  if (name === "deep-interview") return runDeepInterviewEngine(opts);
  if (name === "ralplan") return runRalplanEngine(opts);
  if (name === "team") return runTeamEngine(opts);
  return runUltragoalEngine(opts);
}
