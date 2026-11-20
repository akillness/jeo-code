import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  TraceCollector,
  loadRecentTraces,
  summarizeTraces,
} from "../src/agent/dev/trace-collector";
import {
  loadHarness2Workspace,
  checkAlwaysOnBudget,
  proposeCandidatesFromTraces,
  blindSelectCandidate,
  runHarness2OfflineEvolution,
} from "../src/agent/dev/harness2-offline";
import { runAdvancedAnalysis } from "../src/agent/dev/advanced-analyzer";
import { parseEvolveCoreArgs } from "../src/commands/evolve-core";
import type { ProbeMeasurement } from "../src/agent/dev/evolution-bridge";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeProbe(
  statuses: Record<string, boolean>,
  budgetOk = true,
  totalDisciplineChars = 3400,
): ProbeMeasurement {
  const passedChecks = Object.values(statuses).filter(Boolean).length;
  return {
    passedChecks,
    totalChecks: Object.keys(statuses).length,
    checkStatuses: statuses,
    budgetOk,
    totalDisciplineChars,
    commandResults: Object.entries(statuses).map(([command, ok]) => ({
      command,
      exitCode: ok ? 0 : 1,
      durationMs: 2,
      output: ok ? "ok" : "failed",
    })),
  };
}

describe("TraceCollector & Trace Analytics", () => {
  test("captures parse bounces, tool failures, verification signals, and tier demotions into dated JSONL", async () => {
    const cwd = await makeTempDir("jeo-h2-traces-");
    let clock = 1_700_000_000_000;
    const collector = new TraceCollector({
      cwd,
      model: "llama-cpp/qwen2.5-coder",
      domain: "local-coding",
      prompt: "Fix broken parser and run unit tests",
      now: () => new Date((clock += 25)),
    });

    const events = collector.attachToEvents();
    await events.onStep?.(1);
    events.onAssistant?.("Let me inspect first", null);
    await events.onStep?.(2);
    collector.recordTierDemotion();
    events.onAssistant?.('{"tool":"edit","arguments":{"filePath":"src/a.ts"}}', {
      tool: "edit",
      arguments: { filePath: "src/a.ts" },
    });
    await events.onBeforeTools?.("{}");
    events.onToolResult?.("edit", false, "Anchor mismatch");

    await events.onStep?.(3);
    events.onAssistant?.('{"tool":"bash","arguments":{"command":"bun test"}}', {
      tool: "bash",
      arguments: { command: "bun test" },
    });
    await events.onBeforeTools?.("{}");
    events.onToolResult?.("bash", true, "4 pass\n0 fail");

    const record = await collector.finalize({
      done: false,
      steps: 3,
      stopClass: "repeat",
      usage: { inputTokens: 1200, outputTokens: 350 },
    });

    expect(record.parseBounces).toBe(1);
    expect(record.verificationRuns).toBe(1);
    expect(record.verificationPassed).toBe(true);
    expect(record.tierDemotions).toBe(1);
    expect(record.failureTags).toContain("parse_bounce");
    expect(record.failureTags).toContain("tier_demotion");
    expect(record.failureTags).toContain("tool_failure:edit");
    expect(record.failureTags).toContain("repeat_stop");

    const loaded = await loadRecentTraces(cwd, { model: "llama-cpp/qwen2.5-coder" });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.traceId).toBe(record.traceId);

    const summary = summarizeTraces(loaded);
    expect(summary.totalRuns).toBe(1);
    expect(summary.completedRuns).toBe(0);
    expect(summary.toolErrorRate).toBe(0.5);
    expect(summary.byModel["llama-cpp/qwen2.5-coder"]!.runs).toBe(1);

    const report = await runAdvancedAnalysis(cwd, { allowNonDev: true });
    expect(report).toContain("Advanced Trace-Backed Analysis");
    expect(report).toContain("parse_bounce");
  });
});

describe("Harness² Offline Propose-Probe-Compose", () => {
  test("checkAlwaysOnBudget flags oversized workspace rules", async () => {
    const cwd = await makeTempDir("jeo-h2-budget-");
    const rulesDir = path.join(cwd, ".agents", "rules");
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, "bloated.md"), "x".repeat(20_000), "utf-8");

    const check = await checkAlwaysOnBudget(cwd, { maxRuleChars: 16_000 });
    expect(check.ok).toBe(false);
    expect(check.exceeded).toContain("workspaceRules");
  });

  test("proposeCandidatesFromTraces generates dual-track (invariant + domain) candidates without leaking scorer commands", async () => {
    const cwd = await makeTempDir("jeo-h2-propose-");
    const ws = await loadHarness2Workspace(cwd);

    const candidates = proposeCandidatesFromTraces(
      [
        {
          traceId: "t1",
          timestamp: "2026-11-20T00:00:00.000Z",
          cwd,
          model: "llama-cpp/qwen",
          promptPreview: "edit file",
          done: false,
          steps: 4,
          durationMs: 500,
          parseBounces: 2,
          verificationRuns: 0,
          verificationPassed: false,
          tierDemotions: 1,
          toolCalls: [{ tool: "edit", success: false, durationMs: 10, isVerification: false }],
          failureTags: ["parse_bounce", "tier_demotion", "tool_failure:edit"],
        },
      ],
      { domain: "local-agent", k: 3, workspace: ws },
    );

    expect(candidates).toHaveLength(3);
    const tracks = new Set(candidates.map((c) => c.track));
    expect(tracks.has("invariant")).toBe(true);
    expect(tracks.has("domain")).toBe(true);
    for (const c of candidates) {
      expect(c.proposalPrompt).not.toContain("bun test");
    }
  });

  test("blindSelectCandidate anonymizes candidates, rejects budget bloat, and consults qev on ties", async () => {
    const base = makeProbe({ typecheck: true, unit: false }, true, 3400);

    const candBloated = {
      candidate: {
        id: "c_bloat",
        track: "invariant" as const,
        component: "c1_system_prompt" as const,
        target: "src/agent/engine.ts",
        hypothesis: "Bloated prompt",
        rationale: "r",
        proposalPrompt: "p",
        addressedTags: [],
      },
      measurement: makeProbe({ typecheck: true, unit: true }, true, 4400),
      alwaysOnBudgetOk: false,
      patch: "diff --git a/a b/a\n+bloat",
      diffStat: " a | 50 +",
    };

    const candA = {
      candidate: {
        id: "c_a",
        track: "invariant" as const,
        component: "c4_tool_guidance" as const,
        target: "src/agent/tools.ts",
        hypothesis: "Surgical A",
        rationale: "r",
        proposalPrompt: "p",
        addressedTags: [],
      },
      measurement: makeProbe({ typecheck: true, unit: true }, true, 3350),
      alwaysOnBudgetOk: true,
      patch: "diff --git a/x b/x\n+a",
      diffStat: " x | 2 +-",
    };

    const candB = {
      candidate: {
        id: "c_b",
        track: "domain" as const,
        component: "c6_skills" as const,
        target: "src/skills/catalog.ts",
        hypothesis: "Surgical B",
        rationale: "r",
        proposalPrompt: "p",
        addressedTags: [],
      },
      measurement: makeProbe({ typecheck: true, unit: true }, true, 3350),
      alwaysOnBudgetOk: true,
      patch: "diff --git a/y b/y\n+b",
      diffStat: " y | 1 +",
    };

    const res = await blindSelectCandidate(base, [candBloated, candA, candB], {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ answers: { choice: { choice: "1:anon_2" } } }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });

    expect(res.verdicts.c_bloat!.adopt).toBe(false);
    expect(res.winner?.candidate.id).toBe("c_b");
    expect(res.tieBrokenBy).toBe("qev");
    expect(res.anonymizedOrder.map((a) => a.anonId)).toEqual(["anon_0", "anon_1", "anon_2"]);
  });

  test("runHarness2OfflineEvolution supports parallel and sequential modes and writes entries.jsonl + INDEX.md", async () => {
    const repoDir = await makeTempDir("jeo-h2-run-");
    const wtDir = await makeTempDir("jeo-h2-wt-");
    const appliedPatches: string[] = [];

    // 1. Parallel (`agg`) mode: adopts only the single best passing candidate
    const parallelRes = await runHarness2OfflineEvolution(
      repoDir,
      {
        domain: "local-loop",
        mode: "parallel",
        k: 2,
        probeCommands: ["typecheck", "unit"],
      },
      {
        createWorktree: async () => wtDir,
        removeWorktree: async () => {},
        proposeCandidate: async () => {},
        captureDiff: async () => ({
          patch: "diff --git a/f.ts b/f.ts\n+fix",
          diffStat: " f.ts | 1 +",
        }),
        runProbe: async (targetCwd) =>
          targetCwd === repoDir
            ? makeProbe({ typecheck: true, unit: false })
            : makeProbe({ typecheck: true, unit: true }),
        evaluateBudget: async () => true,
        applyPatch: async (_cwd, patch) => {
          appliedPatches.push(patch);
        },
      },
    );

    expect(parallelRes.adoptedCandidates).toHaveLength(1);
    expect(appliedPatches).toHaveLength(1);
    const indexMd = await fs.readFile(parallelRes.indexPath, "utf-8");
    expect(indexMd).toContain("# Harness² Domain Library: local-loop");
    expect(indexMd).toContain("Adopted Improvements");

    // 2. Sequential (`seq`) mode: composes incremental improvements step by step
    let stepNum = 0;
    const seqRes = await runHarness2OfflineEvolution(
      repoDir,
      {
        domain: "seq-loop",
        mode: "sequential",
        k: 2,
        probeCommands: ["c1", "c2", "c3"],
      },
      {
        createWorktree: async () => wtDir,
        removeWorktree: async () => {},
        proposeCandidate: async () => {},
        captureDiff: async () => ({
          patch: `diff --git a/s${++stepNum}.ts b/s${stepNum}.ts\n+ok`,
          diffStat: " s.ts | 1 +",
        }),
        runProbe: async (targetCwd) => {
          if (targetCwd === repoDir) {
            return makeProbe({ c1: true, c2: false, c3: false });
          }
          return stepNum === 1
            ? makeProbe({ c1: true, c2: true, c3: false })
            : makeProbe({ c1: true, c2: true, c3: true });
        },
        evaluateBudget: async () => true,
        applyPatch: async (_cwd, patch) => {
          appliedPatches.push(patch);
        },
      },
    );

    expect(seqRes.adoptedCandidates).toHaveLength(2);
    expect(seqRes.finalMeasurement.passedChecks).toBe(3);
  });

  test("parseEvolveCoreArgs parses --offline, --mode, and --k while keeping backward compatibility", () => {
    expect(parseEvolveCoreArgs(["--domain", "prompts", "--dry-run"])).toEqual({
      domain: "prompts",
      dryRun: true,
      help: false,
    });
    expect(
      parseEvolveCoreArgs(["--offline", "--mode", "sequential", "--k=4", "--domain=local"]),
    ).toEqual({
      domain: "local",
      offline: true,
      mode: "sequential",
      k: 4,
      dryRun: false,
      help: false,
    });
  });
});
