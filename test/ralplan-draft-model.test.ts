import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Regression for the ralplan latency lever: the Planner/Architect/Critic DRAFTING
// passes must route to their per-role configured model (resolveSubagentModel),
// not silently run every pass on the default/primary model. This lets a user point
// the draft roles at a faster/cheaper tier to cut planning latency, while the
// repo-grounded consensus gate (runConsensusCriticGate → runAgentLoop) resolves
// critic's model independently and stays untouched.

const origCwd = process.cwd();
let tmp = "";
let cfgDir = "";
const origConfigDir = process.env.JEO_CONFIG_DIR;

afterEach(async () => {
  process.chdir(origCwd);
  if (origConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = origConfigDir;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (cfgDir) await fs.rm(cfgDir, { recursive: true, force: true }).catch(() => {});
  tmp = "";
  cfgDir = "";
});

const VALID_PLAN = [
  'name: "demo"',
  "steps:",
  '  - name: "Implement thing in src/x.ts"',
  "    role: executor",
  '    target: "src/x.ts"',
  '  - name: "Review the change"',
  "    role: critic",
].join("\n");

test("ralplan drafting passes route to their per-role configured model; the consensus gate is independent", async () => {
  // Per-role model config on disk, pointed at via JEO_CONFIG_DIR.
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-ralplan-cfg-"));
  await fs.writeFile(
    path.join(cfgDir, "config.json"),
    JSON.stringify({
      defaultModel: "default-strong",
      subagents: {
        planner: { model: "plan-fast" },
        architect: { model: "arch-fast" },
        critic: { model: "crit-strong" },
      },
    }),
  );
  process.env.JEO_CONFIG_DIR = cfgDir;

  // Single mock of the LLM call. A DRAFTING pass arrives with options.systemPrompt
  // set (callRole) → return a valid plan and record the model. The consensus gate
  // runs through the real engine loop, which calls the SAME callLlm but with the
  // system message inside `messages` (no options.systemPrompt) → return a done
  // tool-call so the read-only critic converges to [OKAY]. This keeps the test to a
  // single loop-module mock (no engine mock that would leak into other suites).
  const draftModels: (string | undefined)[] = [];
  let gateCall = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_msgs: unknown, opts: { model?: string; systemPrompt?: string }) => {
      if (opts?.systemPrompt) {
        draftModels.push(opts.model);
        return VALID_PLAN;
      }
      gateCall++;
      if (gateCall === 1) return JSON.stringify({ tool: "read", arguments: { filePath: "seed.yaml" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "[OKAY]\nJustification: verified against the repo." } });
    },
  }));

  // cwd with a COMPLETE deep-interview state + seed so ralplan proceeds to drafting.
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-ralplan-"));
  const seedPath = path.join(tmp, "seed.yaml");
  await fs.writeFile(seedPath, "goal: build a thing\nacceptance_criteria:\n  - it works\n");
  const stateDir = path.join(tmp, ".jeo", "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "deep-interview-state.json"),
    JSON.stringify({ active: true, current_phase: "complete", skill: "deep-interview", slug: "demo", seed_path: seedPath }),
  );
  process.chdir(tmp);

  const { runRalplanEngine } = await import("../src/commands/ralplan");
  const out: string[] = [];
  const res = await runRalplanEngine({ cwd: tmp, io: { output: (l) => out.push(l) } });

  expect(res.ok).toBe(true);
  // Exactly the three drafting passes (no repair/iterate), each on its role model:
  // Planner and Architect on the faster draft tier, the Critic-final on the strong one.
  expect(draftModels).toEqual(["plan-fast", "arch-fast", "crit-strong"]);
});
