import { test, expect } from "bun:test";
import { runSkillsCommand } from "../src/commands/skills";

test("skills command: list, read, legacy alias, json output, unknown skill handling", async () => {
  const originalExitCode = process.exitCode;

  try {
    // 1. list text output (joc skills or joc skills list)
    {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runSkillsCommand([]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      expect(output).toContain("=== joc skills ===");
      expect(output).toContain("deep-interview");
      expect(output).toContain("ralplan");
      expect(output).toContain("team");
      expect(output).toContain("ultragoal");
    }

    {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runSkillsCommand(["list"]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      expect(output).toContain("=== joc skills ===");
      expect(output).toContain("deep-interview");
      expect(output).toContain("ralplan");
    }

    // 2. list --json shape
    {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runSkillsCommand(["--json"]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(4);
      expect(parsed[0]).toHaveProperty("name");
      expect(parsed[0]).toHaveProperty("summary");
    }

    {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runSkillsCommand(["list", "--json"]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(4);
      expect(parsed[0]).toHaveProperty("name");
      expect(parsed[0]).toHaveProperty("summary");
    }

    // 3. read text output
    {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runSkillsCommand(["read", "deep-interview"]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      expect(output).toContain("Skill: deep-interview");
      expect(output).toContain("Summary:");
      expect(output).toContain("When to use:");
    }

    // 4. read --json shape
    {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runSkillsCommand(["read", "deep-interview", "--json"]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("name", "deep-interview");
      expect(parsed).toHaveProperty("content");
      expect(typeof parsed.content).toBe("string");
      expect(parsed.content).toContain("deep-interview");
    }

    // 5. legacy alias (joc skills <name>)
    {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runSkillsCommand(["deep-interview"]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      expect(output).toContain("Skill: deep-interview");
      expect(output).toContain("Summary:");
    }

    // 6. legacy alias with --json (joc skills <name> --json)
    {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runSkillsCommand(["deep-interview", "--json"]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("name", "deep-interview");
      expect(parsed).toHaveProperty("content");
      expect(typeof parsed.content).toBe("string");
    }

    // 7. unknown name exitCode 1 and suggestions
    {
      process.exitCode = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runSkillsCommand(["deep-interviw"]); // typo
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(1);
      const output = logs.join("\n");
      expect(output).toContain("Unknown skill: deep-interviw");
      expect(output).toContain("Did you mean: deep-interview");
    }

    // 8. unknown command/action with read (missing name)
    {
      process.exitCode = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        await runSkillsCommand(["read"]);
      } finally {
        console.log = origLog;
      }

      expect(process.exitCode).toBe(1);
      const output = logs.join("\n");
      expect(output).toContain("Missing skill name");
    }

  } finally {
    process.exitCode = originalExitCode ?? 0;
  }
});
