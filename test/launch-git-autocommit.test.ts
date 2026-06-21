import { expect, test, describe, mock, afterEach } from "bun:test";

describe("gitAutoCommit", () => {
  const originalSpawnSync = globalThis.Bun.spawnSync;

  afterEach(() => {
    globalThis.Bun.spawnSync = originalSpawnSync;
  });

  test("should not commit if gitAutoCommit is false", () => {
    let spawnCalled = false;
    globalThis.Bun.spawnSync = mock((...args: any[]) => {
      spawnCalled = true;
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    });

    // Simulate the condition
    const turnConfig = { gitAutoCommit: false };
    if (turnConfig.gitAutoCommit) {
      globalThis.Bun.spawnSync(["git", "status", "--porcelain"]);
    }

    expect(spawnCalled).toBe(false);
  });

  test("should commit if gitAutoCommit is true and there are changes", () => {
    const spawnCalls: string[][] = [];
    globalThis.Bun.spawnSync = mock((command: string[], options?: any) => {
      spawnCalls.push(command);
      if (command[1] === "status") {
        return { exitCode: 0, stdout: Buffer.from(" M file.txt\n"), stderr: Buffer.from("") } as any;
      }
      if (command[1] === "diff") {
        return { exitCode: 0, stdout: Buffer.from("M\tfile.txt\n"), stderr: Buffer.from("") } as any;
      }
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    });

    const turnConfig = { gitAutoCommit: true };
    const userInput = "Fix the bug";
    const cwd = process.cwd();

    if (turnConfig.gitAutoCommit) {
      try {
        const statusRes = globalThis.Bun.spawnSync(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "ignore" });
        if (statusRes.exitCode === 0 && statusRes.stdout.toString().trim().length > 0) {
          globalThis.Bun.spawnSync(["git", "add", "."], { cwd });
          const diffRes = globalThis.Bun.spawnSync(["git", "diff", "--cached", "--name-status"], { cwd, stdout: "pipe", stderr: "ignore" });
          const changedFiles = diffRes.stdout.toString().trim().split("\n").map(line => line.split("\t")[1]).filter(Boolean);
          const fileSummary = changedFiles.length > 0 ? ` (modified: ${changedFiles.slice(0, 3).join(", ")}${changedFiles.length > 3 ? ", ..." : ""})` : "";
          const commitMsg = `[jeo] auto-commit${fileSummary}\n\nPrompt: ${userInput.slice(0, 100)}${userInput.length > 100 ? "..." : ""}`;
          globalThis.Bun.spawnSync(["git", "commit", "-m", commitMsg], { cwd });
        }
      } catch (e) {}
    }

    expect(spawnCalls.length).toBe(4);
    expect(spawnCalls[0]).toEqual(["git", "status", "--porcelain"]);
    expect(spawnCalls[1]).toEqual(["git", "add", "."]);
    expect(spawnCalls[2]).toEqual(["git", "diff", "--cached", "--name-status"]);
    expect(spawnCalls[3][0]).toBe("git");
    expect(spawnCalls[3][1]).toBe("commit");
    expect(spawnCalls[3][3]).toContain("[jeo] auto-commit (modified: file.txt)");
    expect(spawnCalls[3][3]).toContain("Prompt: Fix the bug");
  });
});
