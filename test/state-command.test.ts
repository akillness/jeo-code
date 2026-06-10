import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runStateCommand } from "../src/commands/state";
import { readWorkflowState, writeWorkflowState } from "../src/agent/state";

test("state command: read, write, clear, handoff, error handling, help", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-state-test-"));
  const originalCwd = process.cwd();
  process.chdir(tempDir);

  const originalExitCode = process.exitCode;

  try {
    // 1. read missing state message
    {
      process.exitCode = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["ralplan", "read"]);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(0);
      expect(logs.join("\n")).toContain("No state found for skill: ralplan");
    }

    // 2. write creates file readable by readWorkflowState
    {
      process.exitCode = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["ralplan", "write", "--input", '{"active":true,"current_phase":"complete","plan_path":"some-plan.yaml"}']);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(0);
      expect(logs.join("\n")).toContain("State path:");

      const state = await readWorkflowState("ralplan", tempDir);
      expect(state).not.toBeNull();
      expect(state?.active).toBe(true);
      expect(state?.current_phase).toBe("complete");
      expect(state?.plan_path).toBe("some-plan.yaml");
      expect(state?.skill).toBe("ralplan");
    }

    // 2b. read works after writing state (with --json and pretty formatting)
    {
      // Pretty text read
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["ralplan", "read"]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      expect(output).toContain("Skill: ralplan");
      expect(output).toContain("Current Phase: complete");
      expect(output).toContain("plan_path: some-plan.yaml");
    }
    {
      // JSON read
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["ralplan", "read", "--json"]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.active).toBe(true);
      expect(parsed.current_phase).toBe("complete");
      expect(parsed.skill).toBe("ralplan");
    }

    // 3. write malformed JSON sets exitCode 1
    {
      process.exitCode = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["ralplan", "write", "--input", "{invalid-json}"]);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(1);
      expect(logs.join("\n")).toContain("[ERROR] Malformed JSON input");
    }
    {
      process.exitCode = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["ralplan", "write", "--input", "123"]);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(1);
      expect(logs.join("\n")).toContain("[ERROR] Input must be a valid JSON object");
    }

    // 4. clear removes state
    {
      process.exitCode = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["ralplan", "clear"]);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(0);
      expect(logs.join("\n")).toContain("Cleared state for skill: ralplan");

      const state = await readWorkflowState("ralplan", tempDir);
      expect(state).toBeNull();
    }

    // 5. handoff updates both skills
    {
      process.exitCode = 0;

      // Seed source state
      await writeWorkflowState("deep-interview", {
        active: true,
        current_phase: "interviewing",
        skill: "deep-interview",
      }, tempDir);

      // Seed target state (optional but let's test merge as well)
      await writeWorkflowState("ralplan", {
        active: false,
        current_phase: "idle",
        skill: "ralplan",
        plan_path: "existing-plan.yaml",
      }, tempDir);

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["deep-interview", "handoff", "--to", "ralplan"]);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(0);
      expect(logs.join("\n")).toContain("Handoff completed");

      const sourceState = await readWorkflowState("deep-interview", tempDir);
      expect(sourceState).not.toBeNull();
      expect(sourceState?.current_phase).toBe("handoff");

      const targetState = await readWorkflowState("ralplan", tempDir) as any;
      expect(targetState).not.toBeNull();
      expect(targetState?.active).toBe(true);
      expect(targetState?.handoff_from).toBe("deep-interview");
      expect(targetState?.plan_path).toBe("existing-plan.yaml"); // merged
    }

    // 5b. handoff with --json option
    {
      process.exitCode = 0;

      // Seed source state
      await writeWorkflowState("deep-interview", {
        active: true,
        current_phase: "interviewing",
        skill: "deep-interview",
      }, tempDir);

      // Seed target state
      await writeWorkflowState("ralplan", {
        active: false,
        current_phase: "idle",
        skill: "ralplan",
        plan_path: "existing-plan.yaml",
      }, tempDir);

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["deep-interview", "handoff", "--to", "ralplan", "--json"]);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(0);
      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.source.state.current_phase).toBe("handoff");
      expect(parsed.target.state.active).toBe(true);
      expect(parsed.target.state.handoff_from).toBe("deep-interview");
      expect(parsed.target.state.plan_path).toBe("existing-plan.yaml");
    }

    // 6. unknown verb usage
    {
      process.exitCode = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["ralplan", "invalidverb"]);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(1);
      expect(logs.join("\n")).toContain("Usage:");
    }

    // 7. unknown skill usage
    {
      process.exitCode = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["invalidskill", "read"]);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(1);
      expect(logs.join("\n")).toContain("Usage:");
    }

    // 8. Help output
    {
      process.exitCode = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runStateCommand(["--help"]);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(0);
      expect(logs.join("\n")).toContain("Usage:");
    }

  } finally {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
