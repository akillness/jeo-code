export interface SkillDoc {
  name: string;          // e.g. "deep-interview"
  command: string;       // e.g. "joc deep-interview \"<idea>\""
  summary: string;       // one line
  whenToUse: string;     // one line
  details: string;       // 2-5 lines of guidance
}

export const SKILLS: SkillDoc[] = [
  {
    name: "deep-interview",
    command: 'joc deep-interview "<idea>"',
    summary: "Socratic ambiguity gate, freezes a seed at ambiguity ≤ 20%; --auto for non-interactive.",
    whenToUse: "When an idea is vague and needs requirement gathering and refinement before planning.",
    details: "Initiates a Socratic dialogue to ask clarifying questions about a vague idea.\nScores the ambiguity of the proposal and iterates until it is under 20%.\nSaves a structured requirements seed that can be used by subsequent workflows.\nSupports an --auto flag to skip interaction."
  },
  {
    name: "ralplan",
    command: "joc ralplan",
    summary: "Planner/Architect/Critic blueprint from the seed.",
    whenToUse: "When requirements are clear (e.g. from deep-interview) and you need a robust execution blueprint.",
    details: "Executes a multi-agent critique and planning process to generate a structured implementation plan.\nCombines views from a Planner, an Architect, and a Critic to identify risks, define tasks, and specify files.\nSaves the blueprint for execution."
  },
  {
    name: "team",
    command: "joc team",
    summary: "Per-task executor loop against the plan.",
    whenToUse: "When you have a blueprint/plan and need to execute the concrete implementation tasks.",
    details: "Coordinates execution of individual tasks defined in the blueprint.\nSpawns per-task executor subagents or loops to implement code changes.\nEnsures task-level isolation and tracks implementation status."
  },
  {
    name: "ultragoal",
    command: "joc ultragoal",
    summary: "Verify acceptance criteria, write report.",
    whenToUse: "When tasks are implemented and you need a final, high-level verification and summary report.",
    details: "Verifies the implementation against the acceptance criteria specified in the plan.\nRuns checks, tests, or validations to ensure correctness.\nGenerates a final completion report outlining the changes and verification evidence."
  }
];

export function getSkill(name: string): SkillDoc | undefined {
  return SKILLS.find(s => s.name.toLowerCase() === name.toLowerCase());
}

export function skillNames(): string[] {
  return SKILLS.map(s => s.name);
}

export function formatSkill(s: SkillDoc): string {
  return [
    `Skill: ${s.name}`,
    `Command: ${s.command}`,
    `Summary: ${s.summary}`,
    `When to use: ${s.whenToUse}`,
    `Details:`,
    s.details.split("\n").map(line => `  ${line}`).join("\n")
  ].join("\n");
}

export function skillsPromptSection(): string {
  return SKILLS.map(s => `- ${s.name} — ${s.summary}`).join("\n");
}
