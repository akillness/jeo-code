import { test, expect, spyOn, mock } from "bun:test";
import { runLaunchCommand } from "../src/commands/launch";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

test("tmux session launch behavior", async () => {
  const originalWhich = Bun.which;
  const originalSpawnSync = Bun.spawnSync;
  const originalSpawn = Bun.spawn;
  const originalExit = process.exit;
  const originalEnv = { ...process.env };

  let exitCode: number | null = null;
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };

  const spawnSyncCalls: any[] = [];
  const spawnCalls: any[] = [];

  try {
    // 1. Mock Bun.which to return a dummy tmux path
    Bun.which = (bin: string) => {
      if (bin === "tmux") return "/usr/local/bin/tmux";
      return originalWhich(bin);
    };

    // 2. Mock Bun.spawnSync to track calls and simulate git symbolic-ref & tmux has-session
    Bun.spawnSync = (cmd: any, ...args: any[]) => {
      const command = Array.isArray(cmd) ? cmd : [cmd, ...(args[0] ?? [])];
      spawnSyncCalls.push(command);

      if (command[0] === "git" && command[1] === "symbolic-ref") {
        return {
          exitCode: 0,
          stdout: Buffer.from("feature-branch\n"),
          stderr: Buffer.from(""),
        } as any;
      }
      if (command[0] === "/usr/local/bin/tmux" && command[1] === "has-session") {
        // First run: simulate session does not exist (exit code 1)
        return { exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
      }
      if (command[0] === "/usr/local/bin/tmux" && command[1] === "new-session") {
        return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
      }
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    };

    // 3. Mock Bun.spawn to track attach-session call
    Bun.spawn = (cmd: any, ...args: any[]) => {
      const command = Array.isArray(cmd) ? cmd : [cmd];
      spawnCalls.push(command);
      return {
        exited: Promise.resolve(0),
      } as any;
    };

    // Make sure we are not treated as already inside tmux
    delete process.env.TMUX;
    delete process.env.JOC_TMUX_LAUNCHED;

    // Run launch command with --tmux
    await runLaunchCommand(["--tmux", "--no-session", "--no-tui", "hello"]);

    // Verify git branch command was executed to name the session
    const gitCall = spawnSyncCalls.find(c => c[0] === "git");
    expect(gitCall).toBeDefined();
    expect(gitCall).toContain("symbolic-ref");

    // Verify tmux new-session args
    const newSessionCall = spawnSyncCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "new-session");
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall).toContain("-s");
    expect(newSessionCall).toContain("joc-feature-branch");

    // Verify attach-session call
    const attachCall = spawnCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "attach-session");
    expect(attachCall).toBeDefined();
    expect(attachCall).toContain("-t");
    expect(attachCall).toContain("=joc-feature-branch");

  } finally {
    Bun.which = originalWhich;
    Bun.spawnSync = originalSpawnSync;
    Bun.spawn = originalSpawn;
    process.exit = originalExit;
    process.env = originalEnv;
  }
});

test("tmux runtime model flags get a distinct session and propagate to inner launch", async () => {
  const originalWhich = Bun.which;
  const originalSpawnSync = Bun.spawnSync;
  const originalSpawn = Bun.spawn;
  const originalEnv = { ...process.env };
  const spawnSyncCalls: any[] = [];

  try {
    Bun.which = (bin: string) => (bin === "tmux" ? "/usr/local/bin/tmux" : originalWhich(bin));
    Bun.spawnSync = (cmd: any) => {
      const command = Array.isArray(cmd) ? cmd : [cmd];
      spawnSyncCalls.push(command);
      if (command[0] === "git" && command[1] === "symbolic-ref") {
        return { exitCode: 0, stdout: Buffer.from("feature-branch\n"), stderr: Buffer.from("") } as any;
      }
      if (command[0] === "/usr/local/bin/tmux" && command[1] === "has-session") {
        return { exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
      }
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    };
    Bun.spawn = (() => ({ exited: Promise.resolve(0) })) as any;

    delete process.env.TMUX;
    delete process.env.JOC_TMUX_LAUNCHED;

    await runLaunchCommand(["--tmux", "--no-session", "--model", "gemini-2.5-flash", "--thinking", "high", "--max-steps=7", "it's ok"]);

    const newSessionCall = spawnSyncCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "new-session");
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall).toContain("joc-feature-branch-model-gemini-2-5-flash-think-high-steps-7");
    const innerCmd = String(newSessionCall.at(-1));
    expect(innerCmd).toContain("'--model' 'gemini-2.5-flash'");
    expect(innerCmd).toContain("'--thinking' 'high'");
    expect(innerCmd).toContain("'--max-steps=7'");
    expect(innerCmd).toContain("'it'\\''s ok'");
  } finally {
    Bun.which = originalWhich;
    Bun.spawnSync = originalSpawnSync;
    Bun.spawn = originalSpawn;
    process.env = originalEnv;
  }
});

test("tmux attach to existing session behavior", async () => {
  const originalWhich = Bun.which;
  const originalSpawnSync = Bun.spawnSync;
  const originalSpawn = Bun.spawn;
  const originalEnv = { ...process.env };

  const spawnSyncCalls: any[] = [];
  const spawnCalls: any[] = [];

  try {
    Bun.which = (bin: string) => {
      if (bin === "tmux") return "/usr/local/bin/tmux";
      return originalWhich(bin);
    };

    Bun.spawnSync = (cmd: any) => {
      const command = Array.isArray(cmd) ? cmd : [cmd];
      spawnSyncCalls.push(command);

      if (command[0] === "git" && command[1] === "symbolic-ref") {
        return {
          exitCode: 0,
          stdout: Buffer.from("main\n"),
          stderr: Buffer.from(""),
        } as any;
      }
      if (command[0] === "/usr/local/bin/tmux" && command[1] === "has-session") {
        // Session already exists (exit code 0)
        return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
      }
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    };

    Bun.spawn = (cmd: any) => {
      const command = Array.isArray(cmd) ? cmd : [cmd];
      spawnCalls.push(command);
      return {
        exited: Promise.resolve(0),
      } as any;
    };

    delete process.env.TMUX;
    delete process.env.JOC_TMUX_LAUNCHED;

    await runLaunchCommand(["--tmux", "--no-session", "--no-tui", "hello"]);

    // Verify we only attached to the existing session and did not create a new one
    const newSessionCall = spawnSyncCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "new-session");
    expect(newSessionCall).toBeUndefined();

    const attachCall = spawnCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "attach-session");
    expect(attachCall).toBeDefined();
    expect(attachCall).toContain("-t");
    expect(attachCall).toContain("=joc-main");

  } finally {
    Bun.which = originalWhich;
    Bun.spawnSync = originalSpawnSync;
    Bun.spawn = originalSpawn;
    process.env = originalEnv;
  }
});
