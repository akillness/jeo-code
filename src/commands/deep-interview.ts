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
  type WorkflowTopologyComponent,
  type WorkflowTopologyState,
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

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("-");
}

function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function inferProjectType(cwd: string, idea: string): Promise<"greenfield" | "brownfield"> {
  const mentionsExisting =
    /\b(fix|update|modify|extend|refactor|improve|support|repair|migrate|integrate)\b/i.test(idea) ||
    /(기존|수정|개선|확장|리팩터링|마이그레이션|통합)/.test(idea);
  if (!mentionsExisting) return "greenfield";
  for (const marker of [".git", "src", "package.json", "tsconfig.json", "README.md"]) {
    try {
      await fs.access(path.join(cwd, marker));
      return "brownfield";
    } catch {
      continue;
    }
  }
  return "greenfield";
}

function inferTopologyComponents(initialIdea: string): WorkflowTopologyComponent[] {
  const compact = initialIdea.replace(/\r?\n+/g, " ").trim();
  let parts = compact
    .split(/;+/)
    .flatMap(part => part.split(/,\s*(?:and\s+)?/i))
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    const andParts = compact
      .split(/\s+(?:and|및|그리고)\s+/i)
      .map(part => part.trim())
      .filter(Boolean);
    if (andParts.length > 1 && andParts.length <= 4) parts = andParts;
  }
  if (parts.length === 0) parts = [compact];
  if (parts.length > 6) parts = parts.slice(0, 6);

  return parts.map((part, index) => {
    const cleaned = part.replace(/^(build|create|implement|add|support|provide)\s+/i, "").trim() || part;
    const words = cleaned.split(/\s+/).slice(0, 4).join(" ");
    const label = titleCase(words || `Component ${index + 1}`);
    return {
      id: slugify(label || `component-${index + 1}`) || `component-${index + 1}`,
      name: label || `Component ${index + 1}`,
      description: part,
      status: "active",
      evidence: [part],
    };
  });
}

function formatTopology(topology: WorkflowTopologyState): string {
  return topology.components
    .filter(component => component.status === "active")
    .map((component, index) => `${index + 1}. ${component.name}: ${component.description}`)
    .join("\n");
}

const BROWNFIELD_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".json", ".yaml", ".yml", ".md"]);
const BROWNFIELD_DIR_HINTS = ["src", "app", "lib", "packages", "functions", "scripts", "tests"] as const;
const MAX_BROWNFIELD_FILES = 80;
const MAX_BROWNFIELD_DEPTH = 3;
const MAX_BROWNFIELD_MATCHES = 8;
const MAX_BROWNFIELD_CONTEXT_CHARS = 3_000;
const IDEA_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "build", "create", "make",
  "add", "support", "provide", "improve", "update", "modify", "extend", "existing", "flow", "system",
  "기존", "수정", "개선", "확장", "구현", "기능", "지원", "추가",
]);

function keywordTokens(idea: string): string[] {
  const seen = new Set<string>();
  const tokens = idea
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s_-]/g, " ")
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3 && !IDEA_STOP_WORDS.has(token));
  for (const token of tokens) seen.add(token);
  return [...seen];
}

async function collectCandidateFiles(root: string, relDir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0 || out.length >= MAX_BROWNFIELD_FILES) return;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_BROWNFIELD_FILES) return;
    const rel = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await collectCandidateFiles(root, rel, depth - 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (BROWNFIELD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(rel.replace(/\\/g, "/"));
  }
}

async function buildBrownfieldContext(cwd: string, idea: string): Promise<string> {
  const repoMarkers = [".git", "src", "package.json", "tsconfig.json", "README.md"];
  const presentMarkers: string[] = [];
  for (const marker of repoMarkers) {
    try {
      await fs.access(path.join(cwd, marker));
      presentMarkers.push(marker);
    } catch {
      continue;
    }
  }

  const candidateFiles: string[] = [];
  for (const dir of BROWNFIELD_DIR_HINTS) {
    await collectCandidateFiles(cwd, dir, MAX_BROWNFIELD_DEPTH, candidateFiles);
  }

  const keywords = keywordTokens(idea);
  const ranked = candidateFiles
    .map(file => {
      const lower = file.toLowerCase();
      const matches = keywords.filter(token => lower.includes(token));
      return { file, matches };
    })
    .filter(entry => entry.matches.length > 0)
    .sort((a, b) => b.matches.length - a.matches.length || a.file.localeCompare(b.file))
    .slice(0, MAX_BROWNFIELD_MATCHES);

  const lines = [
    `Repo markers: ${presentMarkers.join(", ") || "(none)"}`,
    `Relevant directories scanned: ${BROWNFIELD_DIR_HINTS.filter(dir => candidateFiles.some(file => file.startsWith(`${dir}/`) || file === dir)).join(", ") || "(none)"}`,
    ranked.length > 0
      ? "Path evidence:"
      : "Path evidence: no keyword-matching files found yet; ask the user which existing surface should change.",
    ...ranked.map(entry => `- ${entry.file} (matched: ${entry.matches.join(", ")})`),
  ];

  const summary = lines.join("\n");
  return summary.length > MAX_BROWNFIELD_CONTEXT_CHARS
    ? summary.slice(0, MAX_BROWNFIELD_CONTEXT_CHARS - 1) + "…"
    : summary;
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

    const slug = state?.slug || slugify(initialIdea);

    const interviewId = state?.interview_id || crypto.randomUUID();
    const threshold = state?.threshold ?? DEFAULT_THRESHOLD;
    const thresholdSource = state?.threshold_source ?? DEFAULT_THRESHOLD_SOURCE;
    const projectType = state?.type ?? await inferProjectType(cwd, initialIdea);
    const codebaseContext =
      projectType === "brownfield"
        ? (state?.codebase_context ?? await buildBrownfieldContext(cwd, initialIdea))
        : undefined;

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
        type: projectType,
        topology: { status: "pending", confirmed_at: null, components: [], deferrals: [], last_targeted_component_id: null },
        codebase_context: codebaseContext,
      };
      await writeWorkflowState("deep-interview", state, cwd);
    } else {
      let changed = false;
      if (!state.threshold_source) {
        state.threshold_source = thresholdSource;
        changed = true;
      }
      if (!state.type) {
        state.type = projectType;
        changed = true;
      }
      if (!state.topology) {
        state.topology = { status: "legacy_missing", confirmed_at: null, components: [], deferrals: [], last_targeted_component_id: null };
        changed = true;
      }
      if (projectType === "brownfield" && !state.codebase_context && codebaseContext) {
        state.codebase_context = codebaseContext;
        changed = true;
      }
      if (changed) await writeWorkflowState("deep-interview", state, cwd);
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

    if (state.topology?.status !== "confirmed" || state.topology.components.length === 0) {
      let components = inferTopologyComponents(initialIdea);
      console.log(`\nRound 0 | Topology confirmation | Ambiguity: not scored yet`);
      console.log(`\nI'm reading this as ${components.length} top-level component(s):`);
      for (const [index, component] of components.entries()) {
        console.log(`${index + 1}. ${component.name}: ${component.description}`);
      }

      if (!auto) {
        const reply = await rl.question(
          "\nPress Enter if this looks right, or type a revised comma-separated component list: "
        );
        if (reply.trim()) {
          components = inferTopologyComponents(reply);
          console.log("\nUpdated topology:");
          for (const [index, component] of components.entries()) {
            console.log(`${index + 1}. ${component.name}: ${component.description}`);
          }
        }
      }

      state.topology = {
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
        components,
        deferrals: [],
        last_targeted_component_id: components[0]?.id ?? null,
      };
      await writeWorkflowState("deep-interview", state, cwd);
    }

    history.push({
      role: "user",
      content:
        `Project type: ${projectType}\n` +
        `Confirmed topology:\n${formatTopology(state.topology!)}\n\n` +
        `Target questions so every active component reaches clear goals, constraints, and acceptance criteria.`,
    });

    if (projectType === "brownfield" && codebaseContext) {
      history.push({
        role: "user",
        content:
          `Brownfield repo evidence (cite these paths when relevant):\n${codebaseContext}\n\n` +
          `Ask questions that clarify how the requested change should fit this existing codebase.`,
      });
    }

    console.log(`\n=== Starting Socratic Interview: ${slug} ===`);
    console.log(`Initial Idea: ${JSON.stringify(initialIdea)}`);
    console.log(`Project Type: ${projectType}`);
    if (projectType === "brownfield" && codebaseContext) {
      console.log(`Brownfield Context:\n${codebaseContext}\n`);
    }
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
