import { test, expect, spyOn, mock } from "bun:test";
import { runLaunchCommand, tmuxSessionName, allocateTmuxSession, parseFlags } from "../src/commands/launch";
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
    const newName = newSessionCall![newSessionCall!.indexOf("-s") + 1] as string;
    expect(newName.startsWith("joc-feature-branch-")).toBe(true); // branch + dir-scoped tag

    // Verify attach-session call
    const attachCall = spawnCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "attach-session");
    expect(attachCall).toBeDefined();
    expect(attachCall).toContain("-t");
    const attachTarget = attachCall![attachCall!.indexOf("-t") + 1] as string;
    expect(attachTarget.startsWith("=joc-feature-branch-")).toBe(true);

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
    const sessName = newSessionCall![newSessionCall!.indexOf("-s") + 1] as string;
    expect(sessName.startsWith("joc-feature-branch-")).toBe(true);
    expect(sessName).toContain("model-gemini-2-5-flash-think-high-steps-7"); // runtime suffix preserved
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

test("tmux long runtime model ids get hash-distinct session names", async () => {
  const originalWhich = Bun.which;
  const originalSpawnSync = Bun.spawnSync;
  const originalSpawn = Bun.spawn;
  const originalEnv = { ...process.env };
  const sessionNames: string[] = [];

  try {
    Bun.which = (bin: string) => (bin === "tmux" ? "/usr/local/bin/tmux" : originalWhich(bin));
    Bun.spawnSync = (cmd: any) => {
      const command = Array.isArray(cmd) ? cmd : [cmd];
      if (command[0] === "git" && command[1] === "symbolic-ref") {
        return { exitCode: 0, stdout: Buffer.from("feature-branch\n"), stderr: Buffer.from("") } as any;
      }
      if (command[0] === "/usr/local/bin/tmux" && command[1] === "new-session") {
        sessionNames.push(command[command.indexOf("-s") + 1]);
        return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
      }
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    };
    Bun.spawn = (() => ({ exited: Promise.resolve(0) })) as any;

    delete process.env.TMUX;
    delete process.env.JOC_TMUX_LAUNCHED;

    const prefix = "provider/same-very-long-model-name-that-shares-the-prefix-";
    await runLaunchCommand(["--tmux", "--no-session", "--model", `${prefix}alpha`]);
    await runLaunchCommand(["--tmux", "--no-session", "--model", `${prefix}bravo`]);

    expect(sessionNames.length).toBe(2);
    expect(sessionNames[0]).not.toBe(sessionNames[1]);
    expect(sessionNames[0]).toContain("model-provider-same-very-long");
    expect(sessionNames[1]).toContain("model-provider-same-very-long");
  } finally {
    Bun.which = originalWhich;
    Bun.spawnSync = originalSpawnSync;
    Bun.spawn = originalSpawn;
    process.env = originalEnv;
  }
});

test("tmux validates provider/model mismatch before attaching to existing session", async () => {
  const originalWhich = Bun.which;
  const originalSpawnSync = Bun.spawnSync;
  const originalSpawn = Bun.spawn;
  const originalLog = console.log;
  const originalEnv = { ...process.env };
  const logs: string[] = [];
  let tmuxTouched = false;

  try {
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    Bun.which = (bin: string) => {
      if (bin === "tmux") tmuxTouched = true;
      return bin === "tmux" ? "/usr/local/bin/tmux" : originalWhich(bin);
    };
    Bun.spawnSync = ((cmd: any) => {
      const command = Array.isArray(cmd) ? cmd : [cmd];
      if (command[0] === "/usr/local/bin/tmux") tmuxTouched = true;
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    }) as any;
    Bun.spawn = (() => {
      tmuxTouched = true;
      return { exited: Promise.resolve(0) };
    }) as any;

    delete process.env.TMUX;
    delete process.env.JOC_TMUX_LAUNCHED;

    await runLaunchCommand(["--tmux", "--provider", "openai", "--model", "sonnet", "hello"]);

    expect(logs.join("\n")).toContain("resolves to anthropic, not requested provider openai");
    expect(tmuxTouched).toBe(false);
  } finally {
    Bun.which = originalWhich;
    Bun.spawnSync = originalSpawnSync;
    Bun.spawn = originalSpawn;
    console.log = originalLog;
    process.env = originalEnv;
  }
});

test("tmux creates an INDEPENDENT session (base-2) when the base name is already live", async () => {
  const originalWhich = Bun.which;
  const originalSpawnSync = Bun.spawnSync;
  const originalSpawn = Bun.spawn;
  const originalEnv = { ...process.env };

  const spawnSyncCalls: any[] = [];
  const spawnCalls: any[] = [];
  let hasSessionProbes = 0;

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
      if (command[0] === "/usr/local/bin/tmux" && command[1] === "new-session") {
        // First create (base) loses the race / is taken; second create (base-2) succeeds.
        hasSessionProbes++;
        return hasSessionProbes === 1
          ? { exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("duplicate session: base") } as any
          : { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
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

    // The base was taken, so we must create a fresh independent session (base-2), not attach to base.
    const newSessionCalls = spawnSyncCalls.filter(c => c[0] === "/usr/local/bin/tmux" && c[1] === "new-session");
    expect(newSessionCalls.length).toBe(2); // base (duplicate) then base-2 (created)
    const createdName = newSessionCalls[1]![newSessionCalls[1]!.indexOf("-s") + 1] as string;
    expect(createdName).toMatch(/^joc-main-.*-2$/); // first free suffix

    const attachCall = spawnCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "attach-session");
    expect(attachCall).toBeDefined();
    const target = attachCall![attachCall!.indexOf("-t") + 1] as string;
    expect(target).toBe(`=${createdName}`); // attaches to the NEW session, not the existing base

  } finally {
    Bun.which = originalWhich;
    Bun.spawnSync = originalSpawnSync;
    Bun.spawn = originalSpawn;
    process.env = originalEnv;
  }
});

test("allocateTmuxSession: base when free, next free -N on collision, error passthrough", () => {
  // base is free → created on the first try
  expect(allocateTmuxSession("joc-main-x", () => "ok")).toEqual({ name: "joc-main-x" });
  // base + base-2 taken (lost the race) → base-3 wins
  let calls = 0;
  const r = allocateTmuxSession("joc-main-x", () => (++calls <= 2 ? "taken" : "ok"));
  expect(r).toEqual({ name: "joc-main-x-3" });
  // a real tmux failure aborts with the message
  expect(allocateTmuxSession("joc-main-x", () => "error:server not found")).toEqual({ error: "server not found" });
});

test("tmuxSessionName: same branch + different dirs get INDEPENDENT sessions (no collision)", () => {
  const flags = parseFlags([]);
  const a = tmuxSessionName("/home/u/projA", "main", flags);
  const b = tmuxSessionName("/home/u/projB", "main", flags);
  expect(a).not.toBe(b); // different working dirs → independent sessions even on the same branch
  expect(a.startsWith("joc-main-")).toBe(true);
  expect(b.startsWith("joc-main-")).toBe(true);
  // Same dir + branch + flags yields a stable BASE; uniqueTmuxSessionName then makes each
  // concurrent invocation independent (base, base-2, …) at launch time.
  expect(tmuxSessionName("/home/u/projA", "main", flags)).toBe(a);
  // Same basename, different absolute path still diverges (hash of full cwd).
  expect(tmuxSessionName("/a/proj", "main", flags)).not.toBe(tmuxSessionName("/b/proj", "main", flags));
});
