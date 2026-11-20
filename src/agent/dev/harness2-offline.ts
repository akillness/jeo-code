/**
 * Harness² Offline Self-Improvement Loop (Propose-Probe-Compose)
 *
 * Implements:
 *  - `.harness2/workspace.json` component map (`c1`–`c8`) loader
 *  - Always-on prompt + workspace rule budget enforcement (`checkAlwaysOnBudget`)
 *  - Dual-track contrastive candidate proposer (`invariant` + `domain`) under a strict
 *    information barrier (no scorer commands or hidden probe paths leaked)
 *  - Blind candidate selection (`blindSelectCandidate`) with anonymized IDs,
 *    `classifyProbeRegression` gating, simplicity tiebreaking, and fail-open `qev` tiebreak
 *  - Parallel (`agg`) and sequential (`seq`) offline evolution modes with structured
 *    library persistence (`.harness2/library/<domain>/entries.jsonl` + `INDEX.md`)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  checkDisciplinePromptBudget,
  type PromptBudgetReport,
} from "../engine";
import {
  classifyProbeRegression,
  type ProbeRegressionVerdict,
} from "../loop-guards";
import {
  DEFAULT_EVOLUTION_PROBES,
  appendDomainLibraryEntry,
  formatProbeSummary,
  measureProbeDefault,
  readDomainLibrary,
  type DomainLibraryEntry,
  type EvolutionProbeSpec,
  type ProbeMeasurement,
  type ProposeProbeComposeDeps,
} from "./evolution-bridge";
import {
  loadRecentTraces,
  summarizeTraces,
  type ExecutionTraceRecord,
  type FailureTag,
} from "./trace-collector";

export type Harness2ComponentId =
  | "c1_system_prompt"
  | "c2_guardrails"
  | "c3_memory"
  | "c4_tool_guidance"
  | "c5_subagents"
  | "c6_skills"
  | "c7_scripts"
  | "c8_plugins_hooks";

export type Harness2ComponentMap = Record<Harness2ComponentId, string[]>;

export interface Harness2WorkspaceConfig {
  version: number;
  mode: string;
  project?: string;
  components: Harness2ComponentMap;
}

const DEFAULT_COMPONENT_MAP: Harness2ComponentMap = {
  c1_system_prompt: ["AGENTS.md", "CLAUDE.md", "src/agent/engine.ts"],
  c2_guardrails: [".agents/rules", "src/agent/engine.ts"],
  c3_memory: [".mex", "src/agent/memory.ts", ".harness2/library"],
  c4_tool_guidance: [".agents/rules/jeo-workflows.md", "src/agent/tools.ts"],
  c5_subagents: ["src/agent/subagents.ts", "src/agent/task-tool.ts"],
  c6_skills: ["src/skills/catalog.ts", "src/agent/skill-router.ts"],
  c7_scripts: ["scripts", "src/agent/dev/evolution-bridge.ts"],
  c8_plugins_hooks: ["src/agent/loop-guards.ts", "src/agent/hooks.ts"],
};

export async function loadHarness2Workspace(cwd: string): Promise<Harness2WorkspaceConfig> {
  const wsPath = path.join(cwd, ".harness2", "workspace.json");
  try {
    const raw = JSON.parse(await fs.readFile(wsPath, "utf-8")) as Partial<Harness2WorkspaceConfig>;
    const merged: Harness2ComponentMap = { ...DEFAULT_COMPONENT_MAP };
    if (raw.components && typeof raw.components === "object") {
      for (const key of Object.keys(DEFAULT_COMPONENT_MAP) as Harness2ComponentId[]) {
        const list = raw.components[key];
        if (Array.isArray(list)) {
          merged[key] = list.filter((x): x is string => typeof x === "string");
        }
      }
    }
    return {
      version: typeof raw.version === "number" ? raw.version : 1,
      mode: typeof raw.mode === "string" ? raw.mode : "method",
      project: raw.project,
      components: merged,
    };
  } catch {
    return {
      version: 1,
      mode: "method",
      components: { ...DEFAULT_COMPONENT_MAP },
    };
  }
}

export interface AlwaysOnBudgetCheck {
  ok: boolean;
  discipline: PromptBudgetReport;
  ruleChars: number;
  maxRuleChars: number;
  exceeded: string[];
}

async function measureRuleDirChars(dirPath: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await measureRuleDirChars(full);
    } else if (entry.isFile() && /\.(md|json|yaml|yml|toml)$/i.test(entry.name)) {
      try {
        const content = await fs.readFile(full, "utf-8");
        total += content.length;
      } catch {
        // Ignore unreadable file
      }
    }
  }
  return total;
}

/**
 * Verifies both core always-on discipline prompt budgets (`c1`–`c4`) and workspace
 * `.agents/rules` + `.jeo/rules` character ceilings so evolved rules never bloat context.
 */
export async function checkAlwaysOnBudget(
  cwd: string,
  opts?: {
    maxRuleChars?: number;
    disciplineBlocks?: Parameters<typeof checkDisciplinePromptBudget>[0];
  },
): Promise<AlwaysOnBudgetCheck> {
  const maxRuleChars = opts?.maxRuleChars ?? 16_000;
  const discipline = checkDisciplinePromptBudget(opts?.disciplineBlocks);
  const [agentsRuleChars, jeoRuleChars] = await Promise.all([
    measureRuleDirChars(path.join(cwd, ".agents", "rules")),
    measureRuleDirChars(path.join(cwd, ".jeo", "rules")),
  ]);
  const ruleChars = agentsRuleChars + jeoRuleChars;
  const exceeded = [...discipline.exceeded];
  if (ruleChars > maxRuleChars) {
    exceeded.push("workspaceRules");
  }
  return {
    ok: exceeded.length === 0,
    discipline,
    ruleChars,
    maxRuleChars,
    exceeded,
  };
}

export type HarnessCandidateTrack = "invariant" | "domain";

export interface HarnessEvolutionCandidate {
  id: string;
  track: HarnessCandidateTrack;
  component: Harness2ComponentId;
  target: string;
  hypothesis: string;
  rationale: string;
  proposalPrompt: string;
  addressedTags: FailureTag[];
}

export interface ProposeCandidatesOptions {
  domain?: string;
  k?: number;
  workspace?: Harness2WorkspaceConfig;
  priorLessons?: readonly DomainLibraryEntry[];
}

/**
 * Contrastive dual-track proposer (`invariant` + `domain`) capped at `k`.
 * Enforces a strict information barrier: takes ONLY execution traces and prior
 * adopted/rejected lessons — NEVER probe commands, hidden test suites, or rubrics.
 */
export function proposeCandidatesFromTraces(
  traces: readonly ExecutionTraceRecord[],
  opts: ProposeCandidatesOptions = {},
): HarnessEvolutionCandidate[] {
  const k = Math.max(1, Math.min(8, opts.k ?? 4));
  const domain = opts.domain ?? "agent-engine";
  const summary = summarizeTraces(traces);
  const ws = opts.workspace?.components ?? DEFAULT_COMPONENT_MAP;
  const rejectedHypotheses = new Set(
    (opts.priorLessons ?? [])
      .filter((l) => !l.adopted)
      .map((l) => l.hypothesis.trim().toLowerCase()),
  );

  const lessonsContext =
    opts.priorLessons && opts.priorLessons.length > 0
      ? "\nPrior lessons (do NOT repeat rejected hypotheses):\n" +
        opts.priorLessons
          .map((l) => `- [${l.adopted ? "ADOPTED" : "REJECTED"}] ${l.hypothesis}: ${l.reason}`)
          .join("\n")
      : "";

  const candidates: HarnessEvolutionCandidate[] = [];
  const pushUnique = (cand: Omit<HarnessEvolutionCandidate, "id">) => {
    if (candidates.length >= k) return;
    if (rejectedHypotheses.has(cand.hypothesis.trim().toLowerCase())) return;
    if (candidates.some((c) => c.hypothesis === cand.hypothesis)) return;
    candidates.push({
      ...cand,
      id: `cand_${candidates.length + 1}`,
    });
  };

  const tagSet = new Set(summary.recurringTags.map((t) => t.tag));

  // Track 1: Invariant candidates (protocol, loop guards, tier fallback, verification)
  if (tagSet.has("parse_bounce") || tagSet.has("tier_demotion")) {
    const target = ws.c4_tool_guidance[0] ?? "src/agent/tools.ts";
    pushUnique({
      track: "invariant",
      component: "c4_tool_guidance",
      target,
      hypothesis: "Tighten canonical JSON tool envelope guidance for local models",
      rationale: `Observed parse_bounce/tier_demotion across ${summary.totalRuns} trace(s).`,
      addressedTags: ["parse_bounce", "tier_demotion"],
      proposalPrompt:
        `Domain: ${domain}\nTrack: invariant (c4_tool_guidance)\nTarget: ${target}\n` +
        `Observed failure pattern: models emitted non-JSON prose or required tool-tier demotion.\n` +
        `Apply a surgical, budget-neutral refinement so tool-call formatting stays deterministic without bloating c1–c4 prompts.${lessonsContext}`,
    });
  }

  if (tagSet.has("repeat_stop") || tagSet.has("cycle_stop") || tagSet.has("unverified_done")) {
    const target = ws.c8_plugins_hooks[0] ?? "src/agent/loop-guards.ts";
    pushUnique({
      track: "invariant",
      component: "c8_plugins_hooks",
      target,
      hypothesis: "Strengthen loop-guard recovery hint before repeat/unverified stop",
      rationale: `Observed loop stall or unverified completion in recent traces.`,
      addressedTags: ["repeat_stop", "cycle_stop", "unverified_done"],
      proposalPrompt:
        `Domain: ${domain}\nTrack: invariant (c8_plugins_hooks)\nTarget: ${target}\n` +
        `Observed failure pattern: turns stalled in repeat/cycle or attempted completion without fresh verification.\n` +
        `Improve guard feedback surgically while keeping always-on prompt budgets unchanged.${lessonsContext}`,
    });
  }

  // Track 2: Domain candidates (skills, subagent prompts, tool-specific error handling)
  const toolFailures = summary.recurringTags
    .map((t) => t.tag)
    .filter((t): t is `tool_failure:${string}` => t.startsWith("tool_failure:"));

  for (const tf of toolFailures) {
    const toolName = tf.slice("tool_failure:".length);
    const target = ws.c6_skills[0] ?? "src/skills/catalog.ts";
    pushUnique({
      track: "domain",
      component: "c6_skills",
      target,
      hypothesis: `Add domain skill recovery guidance for failing '${toolName}' calls`,
      rationale: `Tool '${toolName}' failed repeatedly (toolErrorRate=${(summary.toolErrorRate * 100).toFixed(1)}%).`,
      addressedTags: [tf],
      proposalPrompt:
        `Domain: ${domain}\nTrack: domain (c6_skills)\nTarget: ${target}\n` +
        `Observed failure pattern: recurring '${toolName}' tool errors in domain '${domain}'.\n` +
        `Encode a concise c6 skill/tool usage lesson without inflating always-on system prompts.${lessonsContext}`,
    });
  }

  // Ensure balanced dual-track coverage up to k even when traces are sparse
  const fallbackTemplates: Array<Omit<HarnessEvolutionCandidate, "id">> = [
    {
      track: "invariant",
      component: "c2_guardrails",
      target: ws.c2_guardrails[1] ?? "src/agent/engine.ts",
      hypothesis: "Preserve compact invariant guardrails while trimming redundant wording",
      rationale: "Baseline invariant hygiene candidate.",
      addressedTags: ["budget_exhausted"],
      proposalPrompt:
        `Domain: ${domain}\nTrack: invariant (c2_guardrails)\nTarget: ${ws.c2_guardrails[1] ?? "src/agent/engine.ts"}\n` +
        `Keep invariant instructions concise and high-signal without regressing behavior.${lessonsContext}`,
    },
    {
      track: "domain",
      component: "c5_subagents",
      target: ws.c5_subagents[0] ?? "src/agent/subagents.ts",
      hypothesis: `Refine domain subagent handoff contract for '${domain}'`,
      rationale: "Domain-track specialization candidate.",
      addressedTags: ["budget_exhausted"],
      proposalPrompt:
        `Domain: ${domain}\nTrack: domain (c5_subagents)\nTarget: ${ws.c5_subagents[0] ?? "src/agent/subagents.ts"}\n` +
        `Improve subagent task decomposition and verification clarity for domain '${domain}'.${lessonsContext}`,
    },
  ];

  for (const tmpl of fallbackTemplates) {
    if (candidates.length >= k) break;
    pushUnique(tmpl);
  }

  return candidates.slice(0, k);
}

export interface EvaluatedCandidateItem {
  candidate: HarnessEvolutionCandidate;
  measurement: ProbeMeasurement;
  alwaysOnBudgetOk?: boolean;
  patch: string;
  diffStat: string;
}

export interface BlindSelectionResult {
  winner: EvaluatedCandidateItem | null;
  verdicts: Record<string, ProbeRegressionVerdict>;
  anonymizedOrder: Array<{ anonId: string; candidateId: string }>;
  tieBrokenBy: "score" | "simplicity" | "qev" | "deterministic" | "none";
}

function shouldConsultLiveQev(opts?: { fetchImpl?: typeof fetch; qevUrl?: string }): boolean {
  if (opts?.fetchImpl || opts?.qevUrl) return true;
  if (process.env.JEO_QEV_ROUTER === "0") return false;
  if (process.env.NODE_ENV === "test" && !process.env.JEO_QEV_URL?.trim()) return false;
  return true;
}

/**
 * Blind candidate selector:
 * 1. Assigns anonymized labels (`anon_0`, `anon_1`, ...) so track/name bias cannot leak.
 * 2. Filters through `classifyProbeRegression` AND `alwaysOnBudgetOk`.
 * 3. Ranks by behavioral check improvement, then smaller `totalDisciplineChars` footprint,
 *    consulting local `qev` on exact behavioral+footprint ties (fail-open).
 */
export async function blindSelectCandidate(
  base: ProbeMeasurement,
  evaluated: readonly EvaluatedCandidateItem[],
  opts?: {
    qevUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<BlindSelectionResult> {
  const verdicts: Record<string, ProbeRegressionVerdict> = {};
  const anonymized = evaluated.map((item, idx) => ({
    anonId: `anon_${idx}`,
    item,
  }));
  const anonymizedOrder = anonymized.map((a) => ({
    anonId: a.anonId,
    candidateId: a.item.candidate.id,
  }));

  const eligible: Array<{ anonId: string; item: EvaluatedCandidateItem }> = [];

  for (const entry of anonymized) {
    const { item } = entry;
    const hasChanges = item.patch.trim().length > 0;
    const effectiveBudgetOk =
      item.measurement.budgetOk && (item.alwaysOnBudgetOk ?? true);
    const verdict = classifyProbeRegression(
      {
        passedChecks: base.passedChecks,
        totalChecks: base.totalChecks,
        checkStatuses: base.checkStatuses,
        budgetOk: base.budgetOk,
        hasChanges: true,
      },
      {
        passedChecks: item.measurement.passedChecks,
        totalChecks: item.measurement.totalChecks,
        checkStatuses: item.measurement.checkStatuses,
        budgetOk: effectiveBudgetOk,
        hasChanges,
      },
    );
    verdicts[item.candidate.id] = verdict;
    if (verdict.adopt) {
      eligible.push(entry);
    }
  }

  if (eligible.length === 0) {
    return {
      winner: null,
      verdicts,
      anonymizedOrder,
      tieBrokenBy: "none",
    };
  }

  if (eligible.length === 1) {
    return {
      winner: eligible[0]!.item,
      verdicts,
      anonymizedOrder,
      tieBrokenBy: "score",
    };
  }

  // Sort descending by passedChecks, then ascending by totalDisciplineChars
  const sorted = [...eligible].sort((a, b) => {
    const passDiff = b.item.measurement.passedChecks - a.item.measurement.passedChecks;
    if (passDiff !== 0) return passDiff;
    return (
      a.item.measurement.totalDisciplineChars - b.item.measurement.totalDisciplineChars
    );
  });

  const top = sorted[0]!;
  const second = sorted[1]!;
  const topPass = top.item.measurement.passedChecks;
  const secondPass = second.item.measurement.passedChecks;
  if (topPass > secondPass) {
    return {
      winner: top.item,
      verdicts,
      anonymizedOrder,
      tieBrokenBy: "score",
    };
  }

  const tied = sorted.filter(
    (e) =>
      e.item.measurement.passedChecks === topPass &&
      e.item.measurement.totalDisciplineChars ===
        top.item.measurement.totalDisciplineChars,
  );

  if (tied.length === 1) {
    return {
      winner: top.item,
      verdicts,
      anonymizedOrder,
      tieBrokenBy: "simplicity",
    };
  }

  if (shouldConsultLiveQev(opts)) {
    const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
    const endpoint =
      opts?.qevUrl || process.env.JEO_QEV_URL || "http://localhost:8017/v1/systemone";
    try {
      const options = tied.map(
        (t, idx) => `${idx}:${t.anonId} diff=${t.item.diffStat.slice(0, 80)}`,
      );
      const resp = await fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: {
            baselineChecks: `${base.passedChecks}/${base.totalChecks}`,
            candidateCount: String(tied.length),
          },
          model: "qev-0.8b-text-Q8_0",
          questions: {
            choice: {
              type: "choice",
              instructions: "Select the most surgical, minimal anonymized patch.",
              options,
            },
          },
        }),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 500),
      });
      if (resp.ok) {
        const payload = (await resp.json()) as {
          answers?: { choice?: { choice?: string } };
        };
        const rawChoice = payload.answers?.choice?.choice ?? "";
        const pickedIdx = Number.parseInt(rawChoice.split(":", 1)[0] ?? "", 10);
        if (Number.isFinite(pickedIdx) && tied[pickedIdx]) {
          return {
            winner: tied[pickedIdx]!.item,
            verdicts,
            anonymizedOrder,
            tieBrokenBy: "qev",
          };
        }
      }
    } catch {
      // Fail open cleanly to deterministic order
    }
  }

  return {
    winner: tied[0]!.item,
    verdicts,
    anonymizedOrder,
    tieBrokenBy: "deterministic",
  };
}

export type OfflineEvolutionMode = "parallel" | "sequential";

export interface StructuredLibraryRecord extends DomainLibraryEntry {
  candidateId: string;
  track: HarnessCandidateTrack;
  component: Harness2ComponentId;
  mode: OfflineEvolutionMode;
}

export function structuredDomainDir(cwd: string, domain: string): string {
  const safe = domain
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
  return path.join(cwd, ".harness2", "library", safe);
}

async function persistStructuredDomainLibrary(
  cwd: string,
  domain: string,
  record: StructuredLibraryRecord,
): Promise<{ entriesPath: string; indexPath: string }> {
  const dir = structuredDomainDir(cwd, domain);
  await fs.mkdir(dir, { recursive: true });
  const entriesPath = path.join(dir, "entries.jsonl");
  const indexPath = path.join(dir, "INDEX.md");

  await fs.appendFile(entriesPath, JSON.stringify(record) + "\n", "utf-8");
  await appendDomainLibraryEntry(cwd, record);

  const raw = await fs.readFile(entriesPath, "utf-8").catch(() => "");
  const all = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as StructuredLibraryRecord);

  const adopted = all.filter((r) => r.adopted);
  const rejected = all.filter((r) => !r.adopted);

  const mdLines = [
    `# Harness² Domain Library: ${domain}`,
    "",
    `- Total evaluations: ${all.length} (${adopted.length} adopted, ${rejected.length} rejected)`,
    `- Updated: ${record.timestamp}`,
    "",
    "## Adopted Improvements",
    ...(adopted.length > 0
      ? adopted.map(
          (r) =>
            `- **[${r.track}/${r.component}]** ${r.hypothesis} (\`${r.target}\`) — ${r.candidateSummary}`,
        )
      : ["- None yet."]),
    "",
    "## Rejected Attempts (Anti-Patterns)",
    ...(rejected.length > 0
      ? rejected.slice(-10).map(
          (r) => `- **[${r.track}]** ${r.hypothesis} — ${r.reason}`,
        )
      : ["- None."]),
    "",
  ];
  await fs.writeFile(indexPath, mdLines.join("\n"), "utf-8");
  return { entriesPath, indexPath };
}

export interface OfflineEvolutionOptions {
  domain?: string;
  mode?: OfflineEvolutionMode;
  k?: number;
  dryRun?: boolean;
  probeCommands?: string[];
  traces?: ExecutionTraceRecord[];
  qevUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface OfflineEvolutionDeps extends ProposeProbeComposeDeps {
  evaluateBudget?: (worktreeCwd: string) => Promise<boolean>;
  proposeCandidate?: (
    worktreeCwd: string,
    candidate: HarnessEvolutionCandidate,
  ) => Promise<void>;
}

export interface OfflineEvolutionResult {
  domain: string;
  mode: OfflineEvolutionMode;
  base: ProbeMeasurement;
  finalMeasurement: ProbeMeasurement;
  candidates: HarnessEvolutionCandidate[];
  adoptedCandidates: HarnessEvolutionCandidate[];
  entriesPath: string;
  indexPath: string;
}

/**
 * Orchestrates offline Harness² evolution in either:
 *  - `parallel` (`agg`): probes up to `k` candidates independently against `base`,
 *    blind-selects the top non-regressing candidate, and composes once.
 *  - `sequential` (`seq`): evaluates candidates one by one, composing each adopted
 *    patch immediately and advancing the baseline + lessons for subsequent candidates.
 */
export async function runHarness2OfflineEvolution(
  cwd: string,
  opts: OfflineEvolutionOptions = {},
  deps: OfflineEvolutionDeps = {},
): Promise<OfflineEvolutionResult> {
  const domain = opts.domain ?? "agent-engine";
  const mode: OfflineEvolutionMode = opts.mode ?? "parallel";
  const k = Math.max(1, Math.min(8, opts.k ?? 3));
  const probeCommands = opts.probeCommands ?? [...DEFAULT_EVOLUTION_PROBES];

  const workspace = await loadHarness2Workspace(cwd);
  const traces = opts.traces ?? (await loadRecentTraces(cwd, { limit: 50 }));
  let priorLessons = await readDomainLibrary(cwd, domain, 10);

  const candidates = proposeCandidatesFromTraces(traces, {
    domain,
    k,
    workspace,
    priorLessons,
  });

  const baseSpec: EvolutionProbeSpec = {
    domain,
    target: candidates[0]?.target ?? "src/agent/engine.ts",
    taskSpec: candidates[0]?.hypothesis ?? "Offline trace-driven evolution",
    probeCommands,
  };

  const runProbe =
    deps.runProbe ?? ((targetCwd, s) => measureProbeDefault(targetCwd, s, false));
  const evalBudget =
    deps.evaluateBudget ??
    (async (wtCwd: string) => (await checkAlwaysOnBudget(wtCwd)).ok);
  const now = deps.now ?? (() => new Date());

  const createWt =
    deps.createWorktree ??
    (async (repoCwd: string) => {
      const os = await import("node:os");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-h2-offline-"));
      await execFileAsync("git", ["worktree", "add", "--detach", dir, "HEAD"], {
        cwd: repoCwd,
      });
      return dir;
    });
  const removeWt =
    deps.removeWorktree ??
    (async (repoCwd: string, wtCwd: string) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("git", ["worktree", "remove", "--force", wtCwd], {
        cwd: repoCwd,
      }).catch(() => {});
      await fs.rm(wtCwd, { recursive: true, force: true }).catch(() => {});
    });
  const captureDiff =
    deps.captureDiff ??
    (async (wtCwd: string) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const [{ stdout: patch }, { stdout: diffStat }] = await Promise.all([
        execFileAsync("git", ["diff", "HEAD"], { cwd: wtCwd }),
        execFileAsync("git", ["diff", "--stat", "HEAD"], { cwd: wtCwd }),
      ]);
      return { patch, diffStat: diffStat.trim() };
    });
  const applyPatch =
    deps.applyPatch ??
    (async (repoCwd: string, patch: string) => {
      if (!patch.trim()) return;
      const os = await import("node:os");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const tmp = path.join(os.tmpdir(), `jeo-h2-${Date.now()}.patch`);
      await fs.writeFile(tmp, patch, "utf-8");
      try {
        await execFileAsync("git", ["apply", "--whitespace=nowarn", tmp], {
          cwd: repoCwd,
        });
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    });

  const runCandidateInWorktree = async (
    cand: HarnessEvolutionCandidate,
  ): Promise<EvaluatedCandidateItem> => {
    const wtCwd = await createWt(cwd);
    try {
      if (deps.proposeCandidate) {
        await deps.proposeCandidate(wtCwd, cand);
      } else if (deps.propose) {
        await deps.propose(wtCwd, cand.proposalPrompt);
      }
      const { patch, diffStat } = await captureDiff(wtCwd);
      const spec: EvolutionProbeSpec = {
        domain,
        target: cand.target,
        taskSpec: cand.hypothesis,
        probeCommands,
      };
      const [measurement, alwaysOnBudgetOk] = await Promise.all([
        runProbe(wtCwd, spec),
        evalBudget(wtCwd),
      ]);
      return { candidate: cand, measurement, alwaysOnBudgetOk, patch, diffStat };
    } finally {
      await removeWt(cwd, wtCwd);
    }
  };

  const base = await runProbe(cwd, baseSpec);
  let currentBase = base;
  const adoptedCandidates: HarnessEvolutionCandidate[] = [];
  let entriesPath = path.join(structuredDomainDir(cwd, domain), "entries.jsonl");
  let indexPath = path.join(structuredDomainDir(cwd, domain), "INDEX.md");

  if (mode === "parallel") {
    const evaluated = await Promise.all(candidates.map(runCandidateInWorktree));
    const selection = await blindSelectCandidate(currentBase, evaluated, {
      qevUrl: opts.qevUrl,
      fetchImpl: opts.fetchImpl,
    });

    if (selection.winner && !opts.dryRun) {
      await applyPatch(cwd, selection.winner.patch);
      currentBase = selection.winner.measurement;
      adoptedCandidates.push(selection.winner.candidate);
    } else if (selection.winner && opts.dryRun) {
      currentBase = selection.winner.measurement;
    }

    for (const item of evaluated) {
      const verdict = selection.verdicts[item.candidate.id];
      const isWinner = selection.winner?.candidate.id === item.candidate.id;
      const adopted = Boolean(isWinner && !opts.dryRun);
      const paths = await persistStructuredDomainLibrary(cwd, domain, {
        timestamp: now().toISOString(),
        domain,
        target: item.candidate.target,
        candidateId: item.candidate.id,
        track: item.candidate.track,
        component: item.candidate.component,
        mode,
        hypothesis: item.candidate.hypothesis,
        baseSummary: formatProbeSummary(base),
        candidateSummary: formatProbeSummary(item.measurement),
        adopted,
        reason: isWinner
          ? opts.dryRun
            ? `${verdict?.reason ?? "selected"} (dry-run)`
            : `${verdict?.reason ?? "selected"} (winner via ${selection.tieBrokenBy})`
          : verdict?.adopt
            ? "outperformed by higher-ranked sibling candidate"
            : (verdict?.reason ?? "rejected"),
        diffStat: item.diffStat || undefined,
      });
      entriesPath = paths.entriesPath;
      indexPath = paths.indexPath;
    }
  } else {
    // Sequential (`seq`) mode: compose each passing candidate forward and update baseline
    for (const cand of candidates) {
      const item = await runCandidateInWorktree(cand);
      const selection = await blindSelectCandidate(currentBase, [item], {
        qevUrl: opts.qevUrl,
        fetchImpl: opts.fetchImpl,
      });
      const verdict = selection.verdicts[cand.id]!;
      const adopted = Boolean(selection.winner && !opts.dryRun);

      if (selection.winner) {
        if (!opts.dryRun) {
          await applyPatch(cwd, item.patch);
          adoptedCandidates.push(cand);
        }
        currentBase = item.measurement;
      }

      const paths = await persistStructuredDomainLibrary(cwd, domain, {
        timestamp: now().toISOString(),
        domain,
        target: cand.target,
        candidateId: cand.id,
        track: cand.track,
        component: cand.component,
        mode,
        hypothesis: cand.hypothesis,
        baseSummary: formatProbeSummary(base),
        candidateSummary: formatProbeSummary(item.measurement),
        adopted,
        reason:
          opts.dryRun && selection.winner
            ? `${verdict.reason} (dry-run)`
            : verdict.reason,
        diffStat: item.diffStat || undefined,
      });
      entriesPath = paths.entriesPath;
      indexPath = paths.indexPath;
      priorLessons = await readDomainLibrary(cwd, domain, 10);
    }
  }

  return {
    domain,
    mode,
    base,
    finalMeasurement: currentBase,
    candidates,
    adoptedCandidates,
    entriesPath,
    indexPath,
  };
}
