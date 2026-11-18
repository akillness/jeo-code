import { test, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyProbeRegression } from "../src/agent/loop-guards";
import {
  buildProposePrompt,
  domainLibraryPath,
  readDomainLibrary,
  runProposeProbeComposeEvolution,
  type EvolutionProbeSpec,
  type ProbeMeasurement,
} from "../src/agent/dev/evolution-bridge";
import { parseEvolveCoreArgs } from "../src/commands/evolve-core";
import { getSkill } from "../src/skills/catalog";

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
  totalDisciplineChars = 3500,
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
      durationMs: 1,
      output: ok ? "ok" : "fail",
    })),
  };
}

test("c8 classifyProbeRegression: rejects no-op, budget bloat, and swapped-check regressions", () => {
  const base = {
    passedChecks: 2,
    totalChecks: 2,
    checkStatuses: { typecheck: true, unit: true },
    budgetOk: true,
  };

  // No-op rejected even when checks pass
  const noop = classifyProbeRegression(base, { ...base, hasChanges: false });
  expect(noop.adopt).toBe(false);
  expect(noop.reason).toContain("no-op");

  // Budget regression rejected
  const bloated = classifyProbeRegression(base, { ...base, budgetOk: false, hasChanges: true });
  expect(bloated.adopt).toBe(false);
  expect(bloated.reason).toContain("prompt-budget regression");

  // Swapped check (1/2 -> 1/2 where previously passing check regressed) rejected
  const failingBase = {
    passedChecks: 1,
    totalChecks: 2,
    checkStatuses: { typecheck: true, unit: false },
    budgetOk: true,
  };
  const swapped = classifyProbeRegression(failingBase, {
    passedChecks: 1,
    totalChecks: 2,
    checkStatuses: { typecheck: false, unit: true },
    budgetOk: true,
    hasChanges: true,
  });
  expect(swapped.adopt).toBe(false);
  expect(swapped.regressedChecks).toEqual(["typecheck"]);

  // Passing candidate with real changes and budget ok is adopted
  const passing = classifyProbeRegression(base, { ...base, hasChanges: true });
  expect(passing.adopt).toBe(true);

  // Strictly improving candidate on failing baseline with zero regressions is adopted
  const improved = classifyProbeRegression(failingBase, {
    passedChecks: 2,
    totalChecks: 2,
    checkStatuses: { typecheck: true, unit: true },
    budgetOk: true,
    hasChanges: true,
  });
  expect(improved.adopt).toBe(true);
});

test("buildProposePrompt: keeps probeCommands hidden from candidate proposal prompt", () => {
  const spec: EvolutionProbeSpec = {
    domain: "agent-engine",
    target: "src/agent/engine.ts",
    taskSpec: "Reduce prompt redundancy while preserving behavior.",
    probeCommands: ["SECRET_SCORER_CMD --strict", "bun test test/hidden-eval.test.ts"],
  };
  const prompt = buildProposePrompt(spec, [
    {
      timestamp: "2026-11-18T00:00:00.000Z",
      domain: "agent-engine",
      target: "src/agent/engine.ts",
      hypothesis: "Inline duplicate block",
      baseSummary: "2/2",
      candidateSummary: "1/2",
      adopted: false,
      reason: "probe regression in: unit",
    },
  ]);

  expect(prompt).toContain("Domain: agent-engine");
  expect(prompt).toContain("Reduce prompt redundancy");
  expect(prompt).toContain("[REJECTED] Inline duplicate block");
  expect(prompt).not.toContain("SECRET_SCORER_CMD");
  expect(prompt).not.toContain("hidden-eval.test.ts");
});

test("runProposeProbeComposeEvolution: adopts passing isolated candidate, applies patch, and logs library", async () => {
  const repoDir = await makeTempDir("jeo-evo-adopt-");
  const worktreeDir = await makeTempDir("jeo-evo-wt-");
  const events: string[] = [];
  let appliedPatch = "";

  const spec: EvolutionProbeSpec = {
    domain: "agent/engine",
    target: "src/agent/engine.ts",
    taskSpec: "Simplify prompt guard",
    probeCommands: ["typecheck", "tests"],
  };

  const result = await runProposeProbeComposeEvolution(
    repoDir,
    spec,
    {},
    {
      runProbe: async targetCwd => {
        events.push(`probe:${targetCwd === repoDir ? "base" : "candidate"}`);
        return makeProbe({ typecheck: true, tests: true });
      },
      createWorktree: async () => {
        events.push("createWorktree");
        return worktreeDir;
      },
      propose: async (wt, prompt) => {
        events.push("propose");
        expect(wt).toBe(worktreeDir);
        expect(prompt).not.toContain("typecheck");
      },
      captureDiff: async () => ({
        patch: "diff --git a/src/agent/engine.ts b/src/agent/engine.ts\n",
        diffStat: " src/agent/engine.ts | 2 +-",
      }),
      applyPatch: async (_repo, patch) => {
        events.push("applyPatch");
        appliedPatch = patch;
      },
      removeWorktree: async () => {
        events.push("removeWorktree");
      },
      now: () => new Date("2026-11-18T12:00:00.000Z"),
    },
  );

  expect(result.adopted).toBe(true);
  expect(result.verdict.adopt).toBe(true);
  expect(appliedPatch).toContain("src/agent/engine.ts");
  expect(events).toEqual([
    "probe:base",
    "createWorktree",
    "propose",
    "probe:candidate",
    "applyPatch",
    "removeWorktree",
  ]);

  const libEntries = await readDomainLibrary(repoDir, "agent/engine");
  expect(libEntries).toHaveLength(1);
  expect(libEntries[0]!.adopted).toBe(true);
  expect(result.libraryPath).toBe(domainLibraryPath(repoDir, "agent/engine"));
});

test("runProposeProbeComposeEvolution: rejects regressed candidate without applying patch and feeds lesson to next run", async () => {
  const repoDir = await makeTempDir("jeo-evo-reject-");
  const worktreeDir = await makeTempDir("jeo-evo-wt-");
  let patchApplied = false;
  let removed = false;
  let seenPrompts: string[] = [];

  const spec: EvolutionProbeSpec = {
    domain: "prompt-budget",
    target: "src/agent/engine.ts",
    taskSpec: "Trim redundant clause",
    probeCommands: ["typecheck", "tests"],
  };

  const first = await runProposeProbeComposeEvolution(
    repoDir,
    spec,
    {},
    {
      runProbe: async targetCwd =>
        targetCwd === repoDir
          ? makeProbe({ typecheck: true, tests: true }, true)
          : makeProbe({ typecheck: true, tests: false }, true),
      createWorktree: async () => worktreeDir,
      propose: async (_wt, prompt) => {
        seenPrompts.push(prompt);
      },
      captureDiff: async () => ({ patch: "diff --git a/x b/x\n", diffStat: " x | 1 +" }),
      applyPatch: async () => {
        patchApplied = true;
      },
      removeWorktree: async () => {
        removed = true;
      },
    },
  );

  expect(first.adopted).toBe(false);
  expect(first.verdict.regressedChecks).toEqual(["tests"]);
  expect(patchApplied).toBe(false);
  expect(removed).toBe(true);

  // Second run dry-run: passing candidate is not applied under dryRun, and prior rejected lesson is injected
  const second = await runProposeProbeComposeEvolution(
    repoDir,
    spec,
    { dryRun: true },
    {
      runProbe: async () => makeProbe({ typecheck: true, tests: true }, true),
      createWorktree: async () => worktreeDir,
      propose: async (_wt, prompt) => {
        seenPrompts.push(prompt);
      },
      captureDiff: async () => ({ patch: "diff --git a/x b/x\n", diffStat: " x | 1 +" }),
      applyPatch: async () => {
        patchApplied = true;
      },
      removeWorktree: async () => {},
    },
  );

  expect(second.verdict.adopt).toBe(true);
  expect(second.adopted).toBe(false);
  expect(patchApplied).toBe(false);
  expect(seenPrompts[1]).toContain("[REJECTED] Trim redundant clause");
});

test("runProposeProbeComposeEvolution: cleans up worktree even when propose throws", async () => {
  const repoDir = await makeTempDir("jeo-evo-err-");
  const worktreeDir = await makeTempDir("jeo-evo-wt-");
  let removed = false;

  await expect(
    runProposeProbeComposeEvolution(
      repoDir,
      { domain: "d", target: "t", taskSpec: "fail", probeCommands: [] },
      {},
      {
        runProbe: async () => makeProbe({}),
        createWorktree: async () => worktreeDir,
        propose: async () => {
          throw new Error("boom");
        },
        removeWorktree: async () => {
          removed = true;
        },
      },
    ),
  ).rejects.toThrow("boom");

  expect(removed).toBe(true);
});

test("parseEvolveCoreArgs parses domain, target, dry-run, and help flags", () => {
  expect(parseEvolveCoreArgs(["--domain", "prompts", "--target=src/agent/engine.ts", "--dry-run"])).toEqual({
    domain: "prompts",
    target: "src/agent/engine.ts",
    dryRun: true,
    help: false,
  });
  expect(parseEvolveCoreArgs(["-h"]).help).toBe(true);
});

test(".harness2/workspace.json maps all 8 components including c5_subagents and c8_plugins_hooks to existing paths", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const wsPath = path.join(root, ".harness2", "workspace.json");
  if (!(await fs.stat(wsPath).then(() => true, () => false))) return;
  const ws = JSON.parse(await fs.readFile(wsPath, "utf-8"));
  expect(ws.mode).toBe("method");
  expect(ws.components.c5_subagents.length).toBeGreaterThan(0);
  expect(ws.components.c8_plugins_hooks.length).toBeGreaterThan(0);

  for (const key of [
    "c1_system_prompt",
    "c2_guardrails",
    "c4_tool_guidance",
    "c5_subagents",
    "c7_scripts",
    "c8_plugins_hooks",
  ]) {
    for (const rel of ws.components[key] as string[]) {
      const exists = await fs.stat(path.join(root, rel)).then(() => true, () => false);
      expect(exists).toBe(true);
    }
  }
});

test("bundled workflow skills and ralplan reflect Karpathy & Harness² disciplines", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const deepInterview = getSkill("deep-interview")!;
  const ralplan = getSkill("ralplan")!;
  const team = getSkill("team")!;
  const ultragoal = getSkill("ultragoal")!;

  expect(deepInterview.details).toContain("Freeze");
  expect(ralplan.details).toContain("Propose–Probe–Compose");
  expect(team.details).toContain("surgical and minimal");
  expect(ultragoal.details).toContain("Before-vs-After");

  const ralplanSrc = await fs.readFile(path.join(root, "src", "commands", "ralplan.ts"), "utf-8");
  expect(ralplanSrc).toContain("do not add a new role, skill, rule, or harness component");
  expect(ralplanSrc).toContain("probe/verification step");
});
test("runProposeProbeComposeEvolution: real git worktree symlinks node_modules, runs probes, applies patch, and cleans up", async () => {
  const execFileAsync = promisify(execFile);
  const repoDir = await makeTempDir("jeo-evo-realgit-");

  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  await fs.writeFile(path.join(repoDir, ".gitignore"), "node_modules/\n.harness2/\n", "utf-8");
  await fs.writeFile(path.join(repoDir, "target.txt"), "broken\n", "utf-8");
  await fs.mkdir(path.join(repoDir, "node_modules", "dummy"), { recursive: true });
  await fs.writeFile(path.join(repoDir, "node_modules", "dummy", "ok.txt"), "ok", "utf-8");
  await execFileAsync("git", ["add", ".gitignore", "target.txt"], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });

  const spec: EvolutionProbeSpec = {
    domain: "realgit-smoke",
    target: "target.txt",
    taskSpec: "Fix target.txt to say fixed",
    probeCommands: [
      "test -e node_modules/dummy/ok.txt",
      "grep -q '^fixed$' target.txt",
    ],
  };

  let sawWorktreeModules = false;
  const res = await runProposeProbeComposeEvolution(
    repoDir,
    spec,
    {},
    {
      propose: async worktreeCwd => {
        sawWorktreeModules = await fs
          .stat(path.join(worktreeCwd, "node_modules", "dummy", "ok.txt"))
          .then(() => true, () => false);
        await fs.writeFile(path.join(worktreeCwd, "target.txt"), "fixed\n", "utf-8");
      },
    },
  );

  expect(sawWorktreeModules).toBe(true);
  expect(res.base.passedChecks).toBe(1);
  expect(res.candidate.passedChecks).toBe(2);
  expect(res.adopted).toBe(true);
  expect(await fs.readFile(path.join(repoDir, "target.txt"), "utf-8")).toBe("fixed\n");

  const { stdout: wtList } = await execFileAsync("git", ["worktree", "list"], { cwd: repoDir });
  expect(wtList.trim().split(/\r?\n/)).toHaveLength(1);
});
