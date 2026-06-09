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

export async function runDeepInterviewCommand(args: string[]): Promise<void> {
  const auto = args.includes("--auto") || !process.stdin.isTTY;
  const filteredArgs = args.filter(arg => arg !== "--auto");
  const cwd = process.cwd();
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Check for active state
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

  // Determine initial idea
  let initialIdea = "";
  if (state) {
    initialIdea = state.initial_idea ?? "";
  } else {
    // If we have CLI args, use them. Otherwise, prompt the user.
    initialIdea = filteredArgs.join(" ");
    if (!initialIdea.trim()) {
      if (auto) {
        console.log("Error: Initial project idea cannot be empty.");
        rl.close();
        return;
      } else {
        initialIdea = await rl.question("\nEnter your initial project idea: ");
      }
    }
  }

  if (!initialIdea.trim()) {
    console.log("Error: Initial project idea cannot be empty.");
    rl.close();
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

  if (!state) {
    state = {
      active: true,
      current_phase: "interviewing",
      skill: "deep-interview",
      interview_id: interviewId,
      slug,
      initial_idea: initialIdea,
      current_ambiguity: 1.0,
      threshold: 0.2,
    };
    await writeWorkflowState("deep-interview", state, cwd);
  }

  // Setup initial message history
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
        `  "goal": "Optional: qualitative goal definition once ambiguity is <= 0.2",\n` +
        `  "constraints": ["Optional list of constraints once ambiguity is <= 0.2"],\n` +
        `  "acceptance_criteria": ["Optional list of acceptance criteria once ambiguity is <= 0.2"]\n` +
        `}\n` +
        `Ensure ambiguityScore drops dynamically as more detail is gathered. When details are sufficient, set ambiguityScore to <= 0.2.`
    },
    {
      role: "user",
      content: `Here is my initial idea: "${initialIdea}"`
    }
  ];

  console.log(`\n=== Starting Socratic Interview: ${slug} ===`);
  console.log(`Initial Idea: "${initialIdea}"`);
  console.log(`Ambiguity Threshold: 20% (interview finishes once ambiguity <= 20%)\n`);

  let round = 1;
  let ambiguity = 1.0;
  let lastParsed: SocraticResponse | undefined;

  const freezeSeed = async (parsed?: SocraticResponse): Promise<void> => {
    const seedDir = path.join(getLocalJocDir(cwd), "seeds");
    await fs.mkdir(seedDir, { recursive: true });
    const seedPath = path.join(seedDir, `seed-${slug}.yaml`);
    const constraints = parsed?.constraints?.length
      ? parsed.constraints.map(c => `  - "${c}"`).join("\n")
      : `  - "TypeScript / Bun runtime"`;
    const criteria = parsed?.acceptance_criteria?.length
      ? parsed.acceptance_criteria.map(a => `  - "${a}"`).join("\n")
      : `  - "Runs successfully in the terminal"`;
    const seedContent =
      `# Frozen Specification Seed\n` +
      `slug: ${slug}\n` +
      `interview_id: ${interviewId}\n` +
      `goal: "${parsed?.goal || initialIdea}"\n` +
      `constraints:\n${constraints}\n\n` +
      `acceptance_criteria:\n${criteria}\n`;
    await fs.writeFile(seedPath, seedContent, "utf-8");
    state!.current_phase = "complete";
    state!.seed_path = seedPath;
    await writeWorkflowState("deep-interview", state!, cwd);
    console.log(`Saved frozen requirements spec seed to: ${seedPath}`);
  };

  while (ambiguity > 0.2 && round <= 10) {
    console.log(`\n[Round ${round}] Analyzing requirements...`);
    
    try {
      const responseText = await callLlm(history, { jsonMode: true });
      const parsed = extractJsonObject<SocraticResponse>(responseText);
      lastParsed = parsed;

      ambiguity = parsed.ambiguityScore;
      state.current_ambiguity = ambiguity;
      await writeWorkflowState("deep-interview", state, cwd);

      console.log(`Ambiguity ${meter(ambiguity)}  (Assessment: ${parsed.assessment})`);

      if (ambiguity <= 0.2) {
        console.log(`\n[SUCCESS] Ambiguity is <= 20%! Concluding requirements gather.`);
        await freezeSeed(parsed);
        console.log("\n[Handoff Ready] Requirement is crystallized. Next, run 'joc ralplan' to build a plan.");
        break;
      }

      console.log(`\nQuestion: ${parsed.nextQuestion}`);
      let answer = "";
      if (auto) {
        answer = "Use sensible, conventional defaults and proceed. Optimize for a minimal correct implementation.";
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

  // --auto must always yield a seed: if the gate wasn't reached within the round
  // cap, freeze a best-effort seed from the last assessment so the pipeline proceeds.
  if (state.current_phase !== "complete" && auto) {
    const currentAmbiguity = state.current_ambiguity ?? 1.0;
    const threshold = state.threshold ?? 0.2;
    // --auto is the non-interactive pipeline entry: it must ALWAYS freeze a usable seed
    // (phase=complete) so ralplan can proceed AND the MutationGuard unlocks. Freezing a
    // best-effort seed even above the threshold is intentional here (logged honestly).
    if (currentAmbiguity > threshold) {
      console.log(`\n[AUTO] Ambiguity gate not reached in ${round - 1} rounds (${(currentAmbiguity * 100).toFixed(0)}% > ${(threshold * 100).toFixed(0)}%); freezing a BEST-EFFORT seed so the pipeline can proceed.`);
    } else {
      console.log(`\n[AUTO] Ambiguity gate reached in ${round - 1} rounds; freezing the seed.`);
    }
    await freezeSeed(lastParsed);
    console.log("[Handoff Ready] Seed frozen. Next, run 'joc ralplan'.");
  }

  rl.close();
}
