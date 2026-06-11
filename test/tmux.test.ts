import { test, expect, spyOn, mock } from "bun:test";
import { runLaunchCommand, tmuxSessionName, allocateTmuxSession, parseFlags, shouldEnableCurrentTmuxMouse, tmuxProfileCommands } from "../src/commands/launch";
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
    expect(newName.startsWith("jeo-feature-branch-")).toBe(true); // branch + dir-scoped tag

    // Verify attach-session call
    const attachCall = spawnCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "attach-session");
    expect(attachCall).toBeDefined();
    expect(attachCall).toContain("-t");
    const attachTarget = attachCall![attachCall!.indexOf("-t") + 1] as string;
    expect(attachTarget.startsWith("=jeo-feature-branch-")).toBe(true);

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
    expect(sessName.startsWith("jeo-feature-branch-")).toBe(true);
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
    expect(createdName).toMatch(/^jeo-main-.*-2$/); // first free suffix

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
  expect(allocateTmuxSession("jeo-main-x", () => "ok")).toEqual({ name: "jeo-main-x" });
  // base + base-2 taken (lost the race) → base-3 wins
  let calls = 0;
  const r = allocateTmuxSession("jeo-main-x", () => (++calls <= 2 ? "taken" : "ok"));
  expect(r).toEqual({ name: "jeo-main-x-3" });
  // a real tmux failure aborts with the message
  expect(allocateTmuxSession("jeo-main-x", () => "error:server not found")).toEqual({ error: "server not found" });
});

test("tmuxSessionName: same branch + different dirs get INDEPENDENT sessions (no collision)", () => {
  const flags = parseFlags([]);
  const a = tmuxSessionName("/home/u/projA", "main", flags);
  const b = tmuxSessionName("/home/u/projB", "main", flags);
  expect(a).not.toBe(b); // different working dirs → independent sessions even on the same branch
  expect(a.startsWith("jeo-main-")).toBe(true);
  expect(b.startsWith("jeo-main-")).toBe(true);
  // Same dir + branch + flags yields a stable BASE; uniqueTmuxSessionName then makes each
  // concurrent invocation independent (base, base-2, …) at launch time.
  expect(tmuxSessionName("/home/u/projA", "main", flags)).toBe(a);
  // Same basename, different absolute path still diverges (hash of full cwd).
  expect(tmuxSessionName("/a/proj", "main", flags)).not.toBe(tmuxSessionName("/b/proj", "main", flags));
});

test("shouldEnableCurrentTmuxMouse: only inside a foreign tmux session, opt-out honored", () => {
  // Inside the user's own tmux (jeo created no session): enable wheel scrolling.
  expect(shouldEnableCurrentTmuxMouse({ TMUX: "/tmp/tmux-1/default,123,0" })).toBe(true);
  // Outside tmux there is nothing to configure.
  expect(shouldEnableCurrentTmuxMouse({})).toBe(false);
  // jeo-spawned sessions already had mouse mode set by the creator.
  expect(shouldEnableCurrentTmuxMouse({ TMUX: "/tmp/tmux-1/default,123,0", JOC_TMUX_LAUNCHED: "1" })).toBe(false);
  // Explicit opt-out wins.
  expect(shouldEnableCurrentTmuxMouse({ TMUX: "/tmp/tmux-1/default,123,0", JOC_TMUX_MOUSE: "0" })).toBe(false);
});

test("tmuxProfileCommands: gjc-parity profile — mouse, markers, clipboard, copy-mode style", () => {
  const cmds = tmuxProfileCommands("jeo-main-abc", {}, { branch: "main", project: "/home/u/proj" });
  const byDesc = Object.fromEntries(cmds.map(c => [c.description, c.args]));
  // Every command targets the exact session name in `=name:` form — exact-matched
  // (never prefix-matched), and accepted by tmux 3.6 set-option/set-window-option
  // (bare `=name` is rejected there with "no such session" while the session is live).
  for (const c of cmds) {
    expect(c.args).toContain("-t");
    expect(c.args[c.args.indexOf("-t") + 1]).toBe("=jeo-main-abc:");
    expect(c.args).not.toContain("-g");
  }
  // mouse on comes first: it is the load-bearing wheel→copy-mode scrollback switch.
  expect(cmds[0]!.args.slice(-2)).toEqual(["mouse", "on"]);
  // Ownership + identity markers (gjc @gjc-* parity).
  expect(byDesc["mark jeo tmux ownership"]!.slice(-2)).toEqual(["@jeo-profile", "1"]);
  expect(byDesc["record jeo branch identity"]!.slice(-2)).toEqual(["@jeo-branch", "main"]);
  expect(byDesc["record jeo project identity"]!.slice(-2)).toEqual(["@jeo-project", "/home/u/proj"]);
  // Clipboard + readable copy-mode selection.
  expect(byDesc["enable tmux clipboard integration"]!.slice(-2)).toEqual(["set-clipboard", "on"]);
  const modeStyle = cmds.find(c => c.args.includes("mode-style"))!;
  expect(modeStyle.args[0]).toBe("set-window-option");
  expect(modeStyle.args.at(-1)).toBe("fg=colour231,bg=colour60");

  // No branch/project → no identity markers, core profile intact.
  const bare = tmuxProfileCommands("s", {});
  expect(bare.some(c => c.args.includes("@jeo-branch"))).toBe(false);
  expect(bare.some(c => c.args.includes("@jeo-project"))).toBe(false);
  expect(bare.some(c => c.args.includes("@jeo-profile"))).toBe(true);

  // JEO_TMUX_MOUSE=0 drops only the mouse switch (legacy JOC_ name honored too).
  for (const env of [{ JEO_TMUX_MOUSE: "0" }, { JOC_TMUX_MOUSE: "0" }]) {
    const noMouse = tmuxProfileCommands("s", env);
    expect(noMouse.some(c => c.args.includes("mouse"))).toBe(false);
    expect(noMouse.some(c => c.args.includes("set-clipboard"))).toBe(true);
  }

  // JEO_TMUX_PROFILE=0 drops the cosmetic extras but keeps mouse + ownership marker.
  const noExtras = tmuxProfileCommands("s", { JEO_TMUX_PROFILE: "0" });
  expect(noExtras.some(c => c.args.includes("set-clipboard"))).toBe(false);
  expect(noExtras.some(c => c.args.includes("mode-style"))).toBe(false);
  expect(noExtras.some(c => c.args.includes("mouse"))).toBe(true);
  expect(noExtras.some(c => c.args.includes("@jeo-profile"))).toBe(true);
});

test("tmux launch applies the gjc-parity profile to the CREATED session before attach", async () => {
  const originalWhich = Bun.which;
  const originalSpawnSync = Bun.spawnSync;
  const originalSpawn = Bun.spawn;
  const originalEnv = { ...process.env };
  const spawnSyncCalls: any[] = [];
  const spawnCalls: any[] = [];

  try {
    Bun.which = (bin: string) => (bin === "tmux" ? "/usr/local/bin/tmux" : originalWhich(bin));
    Bun.spawnSync = (cmd: any) => {
      const command = Array.isArray(cmd) ? cmd : [cmd];
      spawnSyncCalls.push(command);
      if (command[0] === "git" && command[1] === "symbolic-ref") {
        return { exitCode: 0, stdout: Buffer.from("main\n"), stderr: Buffer.from("") } as any;
      }
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    };
    Bun.spawn = ((cmd: any) => {
      spawnCalls.push(Array.isArray(cmd) ? cmd : [cmd]);
      return { exited: Promise.resolve(0) };
    }) as any;

    delete process.env.TMUX;
    delete process.env.JOC_TMUX_LAUNCHED;
    delete process.env.JEO_TMUX_LAUNCHED;
    delete process.env.JOC_TMUX_MOUSE;
    delete process.env.JEO_TMUX_MOUSE;
    delete process.env.JOC_TMUX_PROFILE;
    delete process.env.JEO_TMUX_PROFILE;

    await runLaunchCommand(["--tmux", "--no-session", "--no-tui", "hello"]);

    const newSessionCall = spawnSyncCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "new-session");
    expect(newSessionCall).toBeDefined();
    const sessionName = newSessionCall![newSessionCall!.indexOf("-s") + 1] as string;

    // Profile applied to the exact created session: mouse, ownership/branch/project
    // markers, clipboard, copy-mode style — all -t =<name>: (tmux-3.6-safe exact
    // session form), never -g.
    const tmuxSets = spawnSyncCalls.filter(
      c => c[0] === "/usr/local/bin/tmux" && (c[1] === "set-option" || c[1] === "set-window-option"),
    );
    const targeted = tmuxSets.filter(c => c[c.indexOf("-t") + 1] === `=${sessionName}:`);
    const flat = targeted.map(c => c.join(" "));
    expect(flat.some(s => s.includes("mouse on"))).toBe(true);
    expect(flat.some(s => s.includes("@jeo-profile 1"))).toBe(true);
    expect(flat.some(s => s.includes("@jeo-branch main"))).toBe(true);
    expect(flat.some(s => s.includes("@jeo-project "))).toBe(true);
    expect(flat.some(s => s.includes("set-clipboard on"))).toBe(true);
    expect(flat.some(s => s.includes("mode-style fg=colour231,bg=colour60"))).toBe(true);
    for (const c of tmuxSets) expect(c).not.toContain("-g");

    // The wheel profile lands BEFORE attach so scrollback works from the first frame.
    const attachCall = spawnCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "attach-session");
    expect(attachCall).toBeDefined();
  } finally {
    Bun.which = originalWhich;
    Bun.spawnSync = originalSpawnSync;
    Bun.spawn = originalSpawn;
    process.env = originalEnv;
  }
});

import { tmuxLaunchCommand } from "../src/commands/launch";

test("tmuxLaunchCommand: compiled standalone binary runs ITSELF (bunfs virtual argv[1])", () => {
  // Field failure: `jeo --tmux` printed "can't find session" — the inner command
  // was the nonexistent /$bunfs virtual path, so the session died on spawn.
  expect(tmuxLaunchCommand("/$bunfs/root/cli", "/Users/me/dist/jeo", "/repo")).toEqual(["/Users/me/dist/jeo"]);
  expect(tmuxLaunchCommand(undefined, "/Users/me/dist/jeo", "/repo")).toEqual(["/Users/me/dist/jeo"]);
});

test("tmuxLaunchCommand: source runs re-enter through the runtime; shims run directly", () => {
  expect(tmuxLaunchCommand("/repo/src/cli.ts", "/usr/local/bin/bun", "/repo")).toEqual(["/usr/local/bin/bun", "/repo/src/cli.ts"]);
  expect(tmuxLaunchCommand("src/cli.ts", "/usr/local/bin/bun", "/repo")).toEqual(["/usr/local/bin/bun", "/repo/src/cli.ts"]);
  expect(tmuxLaunchCommand("/Users/me/.local/bin/jeo", "/usr/local/bin/bun", "/repo")).toEqual(["/Users/me/.local/bin/jeo"]);
});
