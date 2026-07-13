import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runApproveCommand } from "../src/commands/approve";
import { readWorkflowState, writeWorkflowState } from "../src/agent/state";
import { findCommand } from "../src/cli/runner";

test("approve command: nonexistent plan rejection, validation, and idempotency", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-approve-test-"));
  const originalCwd = process.cwd;
  process.cwd = () => tempDir;

  const originalExitCode = process.exitCode;

  try {
    // 1. Nonexistent plan rejection (file not on disk)
    process.exitCode = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runApproveCommand(["nonexistent-plan.yaml"]);
    } finally {
      console.log = origLog;
    }

    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("[ERROR] Plan file not found");

    // Reset exitCode for next checks
    process.exitCode = 0;

    // 2. Plan exists on disk, but no workflow state exists
    const planPath = path.join(tempDir, "plan-test.yaml");
    await fs.writeFile(planPath, 'steps:\n  - name: "step 1"\n    role: executor\n  - name: "verify"\n    role: critic\n', "utf-8");

    logs.length = 0;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runApproveCommand([planPath]);
    } finally {
      console.log = origLog;
    }

    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("No ralplan workflow state found");

    // Reset exitCode
    process.exitCode = 0;

    // 3. Workflow state exists, but plan_path in state does not match the provided path
    await writeWorkflowState(
      "ralplan",
      {
        active: true,
        current_phase: "complete",
        skill: "ralplan",
        plan_path: path.join(tempDir, "different-plan.yaml"),
      },
      tempDir
    );

    logs.length = 0;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runApproveCommand([planPath]);
    } finally {
      console.log = origLog;
    }

    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Provided plan path does not match");

    // Reset exitCode
    process.exitCode = 0;

    // 4. Matching workflow state exists with approved: false -> updates to approved: true
    await writeWorkflowState(
      "ralplan",
      {
        active: true,
        current_phase: "complete",
        skill: "ralplan",
        plan_path: planPath,
        approved: false,
        consensus: "okay", // round-11: approval requires the persisted critic verdict
      },
      tempDir
    );

    logs.length = 0;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runApproveCommand([planPath]);
    } finally {
      console.log = origLog;
    }

    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Plan approved successfully");

    const stateAfterApprove = await readWorkflowState("ralplan", tempDir);
    expect(stateAfterApprove?.approved).toBe(true);

    // Reset exitCode
    process.exitCode = 0;

    // 5. Idempotency: run approve command again
    logs.length = 0;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runApproveCommand([planPath]);
    } finally {
      console.log = origLog;
    }

    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Plan is already approved");

    const stateAfterSecondApprove = await readWorkflowState("ralplan", tempDir);
    expect(stateAfterSecondApprove?.approved).toBe(true);

    // Reset exitCode
    process.exitCode = 0;

    // 6. Hash verification: refuses to approve if the plan file has been modified since consensus
    const planPathHash = path.join(tempDir, "plan-hash.yaml");
    const planContent = "steps:\n  - name: \"Build it\"\n    role: executor\n  - name: \"verify\"\n    role: critic\n";
    await fs.writeFile(planPathHash, planContent, "utf-8");

    const { createHash } = await import("node:crypto");
    const correctHash = createHash("sha256").update(planContent).digest("hex");

    await writeWorkflowState(
      "ralplan",
      {
        active: true,
        current_phase: "complete",
        skill: "ralplan",
        plan_path: planPathHash,
        approved: false,
        consensus: "okay",
        consensus_hash: correctHash,
      },
      tempDir
    );

    // Modify the plan file
    await fs.writeFile(planPathHash, planContent + "  - name: \"Extra step\"\n    role: critic\n", "utf-8");

    logs.length = 0;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runApproveCommand([planPathHash]);
    } finally {
      console.log = origLog;
    }

    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("modified since the consensus critic reviewed it");

    // Restore the plan file
    await fs.writeFile(planPathHash, planContent, "utf-8");
    process.exitCode = 0;
    logs.length = 0;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };

    try {
      await runApproveCommand([planPathHash]);
    } finally {
      console.log = origLog;
    }

    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Plan approved successfully");

  } finally {
    process.cwd = originalCwd;
    process.exitCode = originalExitCode;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("approve command is registered in CLI runner", () => {
  const cmd = findCommand("approve");
  expect(cmd).toBeDefined();
  expect(cmd?.name).toBe("approve");
  expect(cmd?.summary).toBe("Approve a planning blueprint.");
});
