import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  computeContractId,
  computeSourceBoundHash,
  buildRecoverySnapshot,
  writeWorkflowState,
} from "../src/agent/state";
import { approvePlan } from "../src/commands/approve";

test("computeContractId is deterministic and sensitive to seed/plan changes", () => {
  const id1 = computeContractId({ interviewId: "iv-1", slug: "auth-flow", seedContent: "goal: auth", planHash: "abc" });
  const id2 = computeContractId({ interviewId: "iv-1", slug: "auth-flow", seedContent: "goal: auth", planHash: "abc" });
  const id3 = computeContractId({ interviewId: "iv-1", slug: "auth-flow", seedContent: "goal: auth", planHash: "def" });
  expect(id1).toBe(id2);
  expect(id1).toStartWith("auth-flow:");
  expect(id3).not.toBe(id1);
});

test("computeSourceBoundHash hashes workspace-relative files deterministically and detects drift", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-source-bound-"));
  try {
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src/a.ts"), "export const a = 1;\n", "utf-8");
    await fs.writeFile(path.join(dir, "src/b.ts"), "export const b = 2;\n", "utf-8");

    const first = await computeSourceBoundHash(dir, ["src/b.ts", "src/a.ts", "../outside.ts"]);
    const second = await computeSourceBoundHash(dir, ["src/a.ts", "src/b.ts"]);
    expect(first.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(first.hash).toBe(second.hash);

    await fs.writeFile(path.join(dir, "src/a.ts"), "export const a = 99;\n", "utf-8");
    const afterEdit = await computeSourceBoundHash(dir, ["src/a.ts", "src/b.ts"]);
    expect(afterEdit.hash).not.toBe(first.hash);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildRecoverySnapshot preserves contract identity, scope, unresolved criteria, source drift, and unambiguous next_action across phases", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-recovery-snap-"));
  try {
    // 1. Fresh workspace -> unambiguous next_action is deep-interview
    const initial = await buildRecoverySnapshot(dir);
    expect(initial.contract_id).toBeNull();
    expect(initial.next_action).toContain("jeo deep-interview");

    // 2. Completed deep-interview with seed and topology -> next_action is jeo ralplan
    const seedDir = path.join(dir, ".jeo", "seeds");
    await fs.mkdir(seedDir, { recursive: true });
    const seedPath = path.join(seedDir, "seed-demo.yaml");
    const seedContent = [
      "# Frozen Specification Seed",
      "slug: demo",
      "interview_id: iv-123",
      'goal: "Build feature X"',
      "constraints:",
      '  - "Non-goal: do not add telemetry"',
      "",
      "acceptance_criteria:",
      '  - "Feature X returns 200 OK"',
      '  - "Unit tests pass"',
      "",
    ].join("\n");
    await fs.writeFile(seedPath, seedContent, "utf-8");

    const contractId = computeContractId({ interviewId: "iv-123", slug: "demo", seedContent });
    await writeWorkflowState(
      "deep-interview",
      {
        active: false,
        current_phase: "complete",
        skill: "deep-interview",
        interview_id: "iv-123",
        slug: "demo",
        seed_path: seedPath,
        contract_id: contractId,
        topology: {
          status: "confirmed",
          confirmed_at: new Date().toISOString(),
          components: [
            { id: "c1", name: "API", description: "Build REST handler", status: "active" },
            { id: "c2", name: "Metrics", description: "Prometheus exporter", status: "deferred" },
          ],
          deferrals: [{ component_id: "c2", reason: "Deferred to v2", confirmed_at: new Date().toISOString() }],
        },
      },
      dir,
    );

    const afterInterview = await buildRecoverySnapshot(dir);
    expect(afterInterview.contract_id).toBe(contractId);
    expect(afterInterview.accepted_scope).toContain("API: Build REST handler");
    expect(afterInterview.non_goals).toContain("Metrics: Prometheus exporter");
    expect(afterInterview.non_goals).toContain("Non-goal: do not add telemetry");
    expect(afterInterview.unresolved_criteria).toEqual(["Feature X returns 200 OK", "Unit tests pass"]);
    expect(afterInterview.next_action).toBe("jeo ralplan");

    // 3. Ralplan complete (unapproved) -> next_action is jeo approve "<planPath>"
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src/handler.ts"), "export const ok = true;\n", "utf-8");
    const planDir = path.join(dir, ".jeo", "plans");
    await fs.mkdir(planDir, { recursive: true });
    const planPath = path.join(planDir, "plan-demo.yaml");
    const planYaml = [
      'name: "Demo plan"',
      "steps:",
      '  - name: "Implement handler"',
      "    role: executor",
      '    target: "src/handler.ts"',
      '  - name: "Verify handler"',
      "    role: critic",
      '    target: "src/handler.ts"',
    ].join("\n");
    await fs.writeFile(planPath, planYaml, "utf-8");
    const { createHash } = await import("node:crypto");
    const planHash = createHash("sha256").update(planYaml).digest("hex");
    const bound = await computeSourceBoundHash(dir, ["src/handler.ts"]);

    await writeWorkflowState(
      "ralplan",
      {
        active: false,
        current_phase: "complete",
        skill: "ralplan",
        slug: "demo",
        seed_path: seedPath,
        plan_path: planPath,
        consensus: "okay",
        consensus_hash: planHash,
        approved: false,
        contract_id: contractId,
        source_hash: bound.hash,
        source_paths: bound.paths,
        accepted_scope: ["API: Build REST handler", "Implement handler", "Verify handler"],
        non_goals: afterInterview.non_goals,
        unresolved_criteria: afterInterview.unresolved_criteria,
      },
      dir,
    );

    const awaitingApprove = await buildRecoverySnapshot(dir);
    expect(awaitingApprove.next_action).toBe(`jeo approve "${planPath}"`);
    expect(awaitingApprove.source_drift).toBe(false);

    // 4. Approve plan -> next_action becomes jeo team; modifying src/handler.ts triggers source_drift
    const approval = await approvePlan(planPath, dir);
    expect(approval.ok).toBe(true);

    await fs.writeFile(path.join(dir, "src/handler.ts"), "export const ok = false; // mutated\n", "utf-8");
    const afterApproveAndMutate = await buildRecoverySnapshot(dir);
    expect(afterApproveAndMutate.next_action).toBe("jeo team");
    expect(afterApproveAndMutate.source_drift).toBe(true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
