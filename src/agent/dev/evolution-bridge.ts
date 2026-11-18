import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAgentLoop, executorSystemPrompt, DEFAULT_TOOLS, checkDisciplinePromptBudget } from "../engine";
import { readGlobalConfig } from "../state";
import { runPostImplementationHooks } from "../hooks";
import { classifyProbeRegression, type ProbeRegressionVerdict, type ProbeSummaryInput } from "../loop-guards";
import { runAdvancedAnalysis } from "./advanced-analyzer";
import { logEvolution } from "./evolution-logger";

const execFileAsync = promisify(execFile);

export const DEFAULT_EVOLUTION_PROBES = [
  "bun run typecheck",
  "bun test test/prompt-discipline.test.ts test/karpathy-skill-router.test.ts",
] as const;

export interface EvolutionProbeSpec {
  domain: string;
  target: string;
  taskSpec: string;
  probeCommands: string[];
}

export interface ProbeCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface ProbeMeasurement {
  passedChecks: number;
  totalChecks: number;
  checkStatuses: Record<string, boolean>;
  budgetOk: boolean;
  totalDisciplineChars: number;
  commandResults: ProbeCommandResult[];
}

export interface DomainLibraryEntry {
  timestamp: string;
  domain: string;
  target: string;
  hypothesis: string;
  baseSummary: string;
  candidateSummary: string;
  adopted: boolean;
  reason: string;
  diffStat?: string;
}

export interface ProposeProbeComposeOptions {
  dryRun?: boolean;
  includePostImplHooks?: boolean;
  maxSteps?: number;
}

export interface ProposeProbeComposeDeps {
  runProbe?: (targetCwd: string, spec: EvolutionProbeSpec) => Promise<ProbeMeasurement>;
  propose?: (worktreeCwd: string, prompt: string) => Promise<void>;
  createWorktree?: (repoCwd: string) => Promise<string>;
  captureDiff?: (worktreeCwd: string) => Promise<{ patch: string; diffStat: string }>;
  applyPatch?: (repoCwd: string, patch: string) => Promise<void>;
  removeWorktree?: (repoCwd: string, worktreeCwd: string) => Promise<void>;
  now?: () => Date;
}

export interface ProposeProbeComposeResult {
  spec: EvolutionProbeSpec;
  base: ProbeMeasurement;
  candidate: ProbeMeasurement;
  verdict: ProbeRegressionVerdict;
  adopted: boolean;
  patch: string;
  diffStat: string;
  libraryPath: string;
}

function safeDomainFilename(domain: string): string {
  const cleaned = domain.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${cleaned || "default"}.jsonl`;
}

export function domainLibraryPath(cwd: string, domain: string): string {
  return path.join(cwd, ".harness2", "library", safeDomainFilename(domain));
}

export async function readDomainLibrary(
  cwd: string,
  domain: string,
  limit = 5,
): Promise<DomainLibraryEntry[]> {
  const filePath = domainLibraryPath(cwd, domain);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const entries = raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as DomainLibraryEntry);
    return entries.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

export async function appendDomainLibraryEntry(
  cwd: string,
  entry: DomainLibraryEntry,
): Promise<string> {
  const filePath = domainLibraryPath(cwd, entry.domain);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
  return filePath;
}

/**
 * Builds the candidate proposal prompt strictly from the frozen taskSpec and
 * prior domain lessons — NEVER exposing probe commands or scoring thresholds.
 */
export function buildProposePrompt(
  spec: EvolutionProbeSpec,
  priorEntries: DomainLibraryEntry[] = [],
): string {
  const lessons = priorEntries.length
    ? "\nPrior domain attempts (learn from failures, do not repeat rejected approaches):\n" +
      priorEntries
        .map(e => `- [${e.adopted ? "ADOPTED" : "REJECTED"}] ${e.hypothesis}: ${e.reason}`)
        .join("\n")
    : "";
  return (
    `Domain: ${spec.domain}\n` +
    `Target: ${spec.target}\n` +
    `Task (frozen):\n${spec.taskSpec}\n` +
    `${lessons}\n\n` +
    "Propose the smallest, invariant-preserving, surgical change that addresses the task. " +
    "Do not add speculative abstractions, unasked features, or bloat always-on system prompts."
  );
}

export function formatProbeSummary(m: ProbeMeasurement): string {
  return `${m.passedChecks}/${m.totalChecks} checks ok, budgetOk=${m.budgetOk} (${m.totalDisciplineChars} chars)`;
}

async function runShellCommand(command: string, cwd: string, timeoutMs = 120_000): Promise<ProbeCommandResult> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      command,
      exitCode: 0,
      durationMs: Date.now() - started,
      output: `${stdout}${stderr}`.trim(),
    };
  } catch (err: any) {
    const out = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}\n${err?.message ?? ""}`.trim();
    return {
      command,
      exitCode: typeof err?.code === "number" ? err.code : 1,
      durationMs: Date.now() - started,
      output: out,
    };
  }
}

export async function measureProbeDefault(
  targetCwd: string,
  spec: EvolutionProbeSpec,
  includePostImplHooks = false,
): Promise<ProbeMeasurement> {
  const commandResults: ProbeCommandResult[] = [];
  const checkStatuses: Record<string, boolean> = {};

  for (const cmd of spec.probeCommands) {
    const res = await runShellCommand(cmd, targetCwd);
    commandResults.push(res);
    checkStatuses[cmd] = res.exitCode === 0;
  }

  if (includePostImplHooks) {
    const started = Date.now();
    const hookRes = await runPostImplementationHooks(targetCwd, spec.taskSpec);
    commandResults.push({
      command: "post-implementation-hooks",
      exitCode: hookRes.success ? 0 : 1,
      durationMs: Date.now() - started,
      output: hookRes.output,
    });
    checkStatuses["post-implementation-hooks"] = hookRes.success;
  }

  // Evaluate discipline prompt budget in targetCwd when available, else in-process fallback.
  let budgetOk = checkDisciplinePromptBudget().ok;
  let totalDisciplineChars = checkDisciplinePromptBudget().totalChars;
  const engineEntry = path.join(targetCwd, "src", "agent", "engine.ts");
  const engineCheck = await runShellCommand(
    `bun -e 'const m = await import(process.argv[1]); console.log(JSON.stringify(m.checkDisciplinePromptBudget()));' ${JSON.stringify(engineEntry)}`,
    targetCwd,
    30_000,
  );
  if (engineCheck.exitCode === 0 && engineCheck.output) {
    try {
      const parsed = JSON.parse(engineCheck.output.split(/\r?\n/).pop() || "{}");
      if (typeof parsed.ok === "boolean") budgetOk = parsed.ok;
      if (typeof parsed.totalChars === "number") totalDisciplineChars = parsed.totalChars;
    } catch {
      // Keep fallback check if targetCwd lacks engine module (e.g. partial fixture).
    }
  }

  const passedChecks = Object.values(checkStatuses).filter(Boolean).length;
  return {
    passedChecks,
    totalChecks: Object.keys(checkStatuses).length,
    checkStatuses,
    budgetOk,
    totalDisciplineChars,
    commandResults,
  };
}

async function createGitWorktree(repoCwd: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-evolve-probe-"));
  await execFileAsync("git", ["worktree", "add", "--detach", dir, "HEAD"], { cwd: repoCwd });
  return dir;
}

async function captureGitDiff(worktreeCwd: string): Promise<{ patch: string; diffStat: string }> {
  const [{ stdout: patch }, { stdout: diffStat }] = await Promise.all([
    execFileAsync("git", ["diff", "HEAD"], { cwd: worktreeCwd, maxBuffer: 8 * 1024 * 1024 }),
    execFileAsync("git", ["diff", "--stat", "HEAD"], { cwd: worktreeCwd }),
  ]);
  return { patch, diffStat: diffStat.trim() };
}

async function applyGitPatch(repoCwd: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  const tmpPatch = path.join(os.tmpdir(), `jeo-evolve-${Date.now()}.patch`);
  await fs.writeFile(tmpPatch, patch, "utf-8");
  try {
    await execFileAsync("git", ["apply", "--whitespace=nowarn", tmpPatch], { cwd: repoCwd });
  } finally {
    await fs.rm(tmpPatch, { force: true }).catch(() => {});
  }
}

async function removeGitWorktree(repoCwd: string, worktreeCwd: string): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", "--force", worktreeCwd], { cwd: repoCwd }).catch(() => {});
  await fs.rm(worktreeCwd, { recursive: true, force: true }).catch(() => {});
}

async function defaultProposeInWorktree(worktreeCwd: string, prompt: string, maxSteps = 35): Promise<void> {
  const config = await readGlobalConfig();
  const model = config.defaultModel || "fast";
  await runAgentLoop([{ role: "user", content: prompt }], {
    cwd: worktreeCwd,
    systemPrompt: executorSystemPrompt(),
    model,
    tools: DEFAULT_TOOLS,
    maxSteps,
  });
}

function toProbeInput(m: ProbeMeasurement, hasChanges?: boolean): ProbeSummaryInput {
  return {
    passedChecks: m.passedChecks,
    totalChecks: m.totalChecks,
    checkStatuses: m.checkStatuses,
    budgetOk: m.budgetOk,
    hasChanges,
  };
}

/**
 * Harness² Propose–Probe–Compose evolution loop:
 * 1. Freeze spec & hidden probe suite
 * 2. Measure Base Probe on repo
 * 3. Propose minimal candidate inside an isolated git worktree
 * 4. Run Candidate Probe inside the worktree
 * 5. Compose (apply patch) ONLY if classifyProbeRegression adopts it
 * 6. Record outcome into `.harness2/library/<domain>.jsonl`
 */
export async function runProposeProbeComposeEvolution(
  cwd: string,
  spec: EvolutionProbeSpec,
  options: ProposeProbeComposeOptions = {},
  deps: ProposeProbeComposeDeps = {},
): Promise<ProposeProbeComposeResult> {
  const runProbe =
    deps.runProbe ?? ((targetCwd, s) => measureProbeDefault(targetCwd, s, options.includePostImplHooks));
  const propose =
    deps.propose ?? ((worktreeCwd, prompt) => defaultProposeInWorktree(worktreeCwd, prompt, options.maxSteps));
  const createWorktree = deps.createWorktree ?? createGitWorktree;
  const captureDiff = deps.captureDiff ?? captureGitDiff;
  const applyPatch = deps.applyPatch ?? applyGitPatch;
  const removeWorktree = deps.removeWorktree ?? removeGitWorktree;
  const now = deps.now ?? (() => new Date());

  const prior = await readDomainLibrary(cwd, spec.domain);
  const base = await runProbe(cwd, spec);

  const worktreeCwd = await createWorktree(cwd);
  let candidate: ProbeMeasurement = base;
  let patch = "";
  let diffStat = "";
  let verdict: ProbeRegressionVerdict;

  try {
    const prompt = buildProposePrompt(spec, prior);
    await propose(worktreeCwd, prompt);
    const diff = await captureDiff(worktreeCwd);
    patch = diff.patch;
    diffStat = diff.diffStat;
    const hasChanges = patch.trim().length > 0;
    candidate = await runProbe(worktreeCwd, spec);
    verdict = classifyProbeRegression(toProbeInput(base, true), toProbeInput(candidate, hasChanges));
    if (verdict.adopt && !options.dryRun) {
      await applyPatch(cwd, patch);
    }
  } finally {
    await removeWorktree(cwd, worktreeCwd);
  }

  const adopted = verdict.adopt && !options.dryRun;
  const libraryPath = await appendDomainLibraryEntry(cwd, {
    timestamp: now().toISOString(),
    domain: spec.domain,
    target: spec.target,
    hypothesis: spec.taskSpec.split(/\r?\n/)[0]?.slice(0, 160) || spec.target,
    baseSummary: formatProbeSummary(base),
    candidateSummary: formatProbeSummary(candidate),
    adopted,
    reason: options.dryRun && verdict.adopt ? `${verdict.reason} (dry-run)` : verdict.reason,
    diffStat: diffStat || undefined,
  });

  return { spec, base, candidate, verdict, adopted, patch, diffStat, libraryPath };
}

export async function consultGjcForAdvancedEvolution(
  cwd: string,
  options: ProposeProbeComposeOptions = {},
  deps: ProposeProbeComposeDeps = {},
): Promise<ProposeProbeComposeResult> {
  const report = await runAdvancedAnalysis(cwd);
  const timestamp = new Date().toISOString();

  await logEvolution({
    timestamp,
    target: "src/ai/model-manager.ts",
    request: report,
    status: "in_progress",
  }, cwd);

  const request =
    `Address architectural coupling identified in src/ai/model-manager.ts:\n${report}\n` +
    `1. Keep the Provider Registry abstraction minimal and explicit.\n` +
    `2. Refactor src/ai/model-manager.ts cleanly without breaking its external API.`;

  try {
    const result = await runProposeProbeComposeEvolution(
      cwd,
      {
        domain: "model-manager",
        target: "src/ai/model-manager.ts",
        taskSpec: request,
        probeCommands: [...DEFAULT_EVOLUTION_PROBES],
      },
      options,
      deps,
    );

    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/ai/model-manager.ts",
      request,
      status: result.adopted ? "success" : "failed",
      verificationOutput: `${result.verdict.reason} | ${formatProbeSummary(result.candidate)}`,
    }, cwd);
    return result;
  } catch (err: any) {
    await logEvolution({
      timestamp: new Date().toISOString(),
      target: "src/ai/model-manager.ts",
      request,
      status: "failed",
      verificationOutput: err.message,
    }, cwd);
    throw err;
  }
}

export async function consultGjcForEvolution(
  cwd: string,
  options: ProposeProbeComposeOptions & { domain?: string; target?: string } = {},
  deps: ProposeProbeComposeDeps = {},
): Promise<ProposeProbeComposeResult> {
  const { runSelfAnalysis } = await import("./self-analysis");
  const report = await runSelfAnalysis(cwd);
  const target = options.target ?? "src/agent/engine.ts";
  const domain = options.domain ?? "agent-engine";

  await logEvolution({
    timestamp: new Date().toISOString(),
    target,
    request: report,
    status: "in_progress",
  }, cwd);

  try {
    const result = await runProposeProbeComposeEvolution(
      cwd,
      {
        domain,
        target,
        taskSpec: report,
        probeCommands: [...DEFAULT_EVOLUTION_PROBES],
      },
      options,
      deps,
    );

    await logEvolution({
      timestamp: new Date().toISOString(),
      target,
      request: report,
      status: result.adopted ? "success" : "failed",
      verificationOutput: `${result.verdict.reason} | ${formatProbeSummary(result.candidate)}`,
    }, cwd);
    return result;
  } catch (err: any) {
    await logEvolution({
      timestamp: new Date().toISOString(),
      target,
      request: report,
      status: "failed",
      verificationOutput: err.message,
    }, cwd);
    throw err;
  }
}
