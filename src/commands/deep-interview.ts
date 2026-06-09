import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { callLlm, type Message } from "../agent/loop";
import { extractJsonObject } from "../agent/json";
import { meter } from "../tui/components/meter";
import {
  readWorkflowState,
  writeWorkflowState,
  clearWorkflowState,
  type WorkflowState,
  getLocalJocDir,
} from "../agent/state";

interface SocraticResponse {
  ambiguityScore: number;
  assessment: string;
  nextQuestion: string;
  goal?: string;
  constraints?: string[];
  acceptance_criteria?: string[];
}

const DEFAULT_THRESHOLD = 0.2;
const DEFAULT_THRESHOLD_SOURCE = "default";
const ACCEPTANCE_CRITERIA_FOLLOWUP =
  "What concrete, testable acceptance criteria would let us say this is done?";
const AUTO_DEFAULT_ANSWER =
  "Use sensible, conventional defaults and proceed. Optimize for a minimal correct implementation.";
const AUTO_CRITERIA_ANSWER =
  "Define explicit, testable acceptance criteria with clear success checks before freezing the seed.";

function normalizeList(values: string[] | undefined): string[] {
  return (values ?? []).map(v => v.trim()).filter(Boolean);
}

function yamlList(name: string, values: string[]): string {
  if (values.length === 0) return `${name}: []`;
  return `${name}:\n${values.map(value => `  - ${JSON.stringify(value)}`).join("\n")}`;
}

function freezeReadiness(parsed: SocraticResponse | undefined): { ok: boolean; reason?: string } {
  if (!parsed) return { ok: false, reason: "the interview never produced a structured assessment" };
  if (normalizeList(parsed.acceptance_criteria).length === 0) {
    return { ok: false, reason: "concrete acceptance criteria are still missing" };
  }
  return { ok: true };
}

export async function runDeepInterviewCommand(args: string[]): Promise<void> {
  const auto = args.includes("--auto") || !process.stdin.isTTY;
  const filteredArgs = args.filter(arg => arg !== "--auto");
  const cwd = process.cwd();
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    let state = await readWorkflowState("deep-interview", cwd);
    if (state && state.active && state.current_phase !== "complete") {
      if (auto) {
        await clearWorkflowState("deep-interview", cwd);
        state = null;
        console.log("Cleared previous state. Starting fresh.");
      } else {
        const resume = await rl.question(
          `\n[ALERT] An active requirements gathering session is already in progress (Ambiguity: ${((state.current_ambiguity ?? 1) * 100).toFixed(0)}%).\n` +
          `Would you like to resume it? [Y/n]: `
        );
        if (resume.trim().toLowerCase() === "n") {
          await clearWorkflowState("deep-interview", cwd);
          state = null;
          console.log("Cleared previous state. Starting fresh.");
        } else {
          console.log("Resuming active Socratic interview session...");
        }
      }
    }

    let initialIdea = "";
    if (state) {
      initialIdea = state.initial_idea ?? "";
    } else {
      initialIdea = filteredArgs.join(" ");
      if (!initialIdea.trim()) {
        if (auto) {
          console.log("Error: Initial project idea cannot be empty.");
          return;
        }
        initialIdea = await rl.question("\nEnter your initial project idea: ");
      }
    }

    if (!initialIdea.trim()) {
      console.log("Error: Initial project idea cannot be empty.");
      return;
    }

    const slug = state?.slug || initialIdea
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join("-");

    const interviewId = state?.interview_id || crypto.randomUUID();
    const threshold = state?.threshold ?? DEFAULT_THRESHOLD;
    const thresholdSource = state?.threshold_source ?? DEFAULT_THRESHOLD_SOURCE;

    if (!state) {
      state = {
        active: true,
        current_phase: "interviewing",
        skill: "deep-interview",
        interview_id: interviewId,
        slug,
        initial_idea: initialIdea,
        current_ambiguity: 1.0,
        threshold,
        threshold_source: thresholdSource,
      };
      await writeWorkflowState("deep-interview", state, cwd);
    } else if (!state.threshold_source) {
      state.threshold_source = thresholdSource;
      await writeWorkflowState("deep-interview", state, cwd);
    }

    const history: Message[] = [
      {
        role: "system",
        content:
          `You are the Socratic Interviewer, a veteran requirements engineer who helps software engineers refine their ideas before writing code.\n` +
          `Your absolute goal is to assess ambiguity across three key dimensions:\n` +
          `1. Goal Clarity\n` +
          `2. Constraint Completeness\n` +
          `3. Success/Acceptance Criteria Definition\n\n` +
          `Provide an output strictly in JSON format. Do not write any text outside of the JSON block.\n` +
          `Structure your output EXACTLY as follows:\n` +
          `{\n` +
          `  "ambiguityScore": 0.0 to 1.0,\n` +
          `  "assessment": "Assessment details here",\n` +
          `  "nextQuestion": "Your Socratic question here to target the weakest dimension",\n` +
          `  "goal": "Optional: qualitative goal definition once ambiguity is <= ${threshold}",\n` +
          `  "constraints": ["Optional list of constraints once ambiguity is <= ${threshold}"],\n` +
          `  "acceptance_criteria": ["Concrete, testable acceptance criteria required before the seed can freeze"]\n` +
          `}\n` +
          `Ensure ambiguityScore drops dynamically as more detail is gathered. Do not report ambiguityScore <= ${threshold} unless acceptance_criteria is populated with concrete, testable checks.`
      },
      {
        role: "user",
        content: `Here is my initial idea: ${JSON.stringify(initialIdea)}`
      }
    ];

    console.log(`\n=== Starting Socratic Interview: ${slug} ===`);
    console.log(`Initial Idea: ${JSON.stringify(initialIdea)}`);
    console.log(`Ambiguity Threshold: ${(threshold * 100).toFixed(0)}% (source: ${thresholdSource})\n`);

    let round = 1;
    let ambiguity = state.current_ambiguity ?? 1.0;
    let lastParsed: SocraticResponse | undefined;

    const freezeSeed = async (parsed: SocraticResponse): Promise<void> => {
      const readiness = freezeReadiness(parsed);
      if (!readiness.ok) throw new Error(`Refusing to freeze seed: ${readiness.reason}.`);

      const seedDir = path.join(getLocalJocDir(cwd), "seeds");
      await fs.mkdir(seedDir, { recursive: true });
      const seedPath = path.join(seedDir, `seed-${slug}.yaml`);
      const constraints = normalizeList(parsed.constraints);
      const criteria = normalizeList(parsed.acceptance_criteria);
      const goal = (parsed.goal?.trim() || initialIdea).trim();
      const seedContent =
        `# Frozen Specification Seed\n` +
        `slug: ${slug}\n` +
        `interview_id: ${interviewId}\n` +
        `goal: ${JSON.stringify(goal)}\n` +
        `${yamlList("constraints", constraints)}\n\n` +
        `${yamlList("acceptance_criteria", criteria)}\n`;
      await fs.writeFile(seedPath, seedContent, "utf-8");
      state!.current_phase = "complete";
      state!.seed_path = seedPath;
      state!.current_ambiguity = Math.min(state!.current_ambiguity ?? threshold, threshold);
      await writeWorkflowState("deep-interview", state!, cwd);
      console.log(`Saved frozen requirements spec seed to: ${seedPath}`);
    };

    while (round <= 10) {
      console.log(`\n[Round ${round}] Analyzing requirements...`);

      try {
        const responseText = await callLlm(history, { jsonMode: true });
        const parsed = extractJsonObject<SocraticResponse>(responseText);
        lastParsed = parsed;

        ambiguity = parsed.ambiguityScore;
        state.current_ambiguity = ambiguity;
        await writeWorkflowState("deep-interview", state, cwd);

        console.log(`Ambiguity ${meter(ambiguity)}  (Assessment: ${parsed.assessment})`);

        const readiness = freezeReadiness(parsed);
        if (ambiguity <= threshold && readiness.ok) {
          console.log(`\n[SUCCESS] Ambiguity is <= ${(threshold * 100).toFixed(0)}%! Concluding requirements gather.`);
          await freezeSeed(parsed);
          console.log("\n[Handoff Ready] Requirement is crystallized. Next, run 'joc ralplan' to build a plan.");
          break;
        }

        let nextQuestion = parsed.nextQuestion?.trim() || ACCEPTANCE_CRITERIA_FOLLOWUP;
        let answer = "";
        if (ambiguity <= threshold && !readiness.ok) {
          console.log(`\n[HOLD] Ambiguity is below the threshold, but ${readiness.reason}. Keeping the interview open.`);
          nextQuestion = ACCEPTANCE_CRITERIA_FOLLOWUP;
        }

        console.log(`\nQuestion: ${nextQuestion}`);
        if (auto) {
          answer = ambiguity <= threshold && !readiness.ok ? AUTO_CRITERIA_ANSWER : AUTO_DEFAULT_ANSWER;
        } else {
          answer = await rl.question("\nYour Answer: ");
        }

        history.push({ role: "assistant", content: responseText });
        history.push({ role: "user", content: answer });
        round++;
      } catch (error: any) {
        console.log(`\n[Error calling LLM]: ${error.message}`);
        break;
      }
    }

    if (state.current_phase !== "complete") {
      state.current_phase = "interviewing";
      await writeWorkflowState("deep-interview", state, cwd);
      if (auto) {
        const readiness = freezeReadiness(lastParsed);
        const why = !readiness.ok
          ? readiness.reason
          : `ambiguity stayed above ${(threshold * 100).toFixed(0)}%`;
        console.log(
          `\n[AUTO] Interview stopped after ${round - 1} rounds because ${why}. ` +
          `No seed was frozen; MutationGuard remains locked. Resume with 'joc deep-interview' to finish clarification.`
        );
      } else if (round > 10) {
        console.log(
          `\n[PAUSED] Interview stopped after ${round - 1} rounds without crystallizing concrete requirements. ` +
          `Resume with 'joc deep-interview' to continue.`
        );
      }
    }
  } finally {
    rl.close();
  }
}
