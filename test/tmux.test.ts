import { test, expect, spyOn, mock } from "bun:test";
import { runLaunchCommand, tmuxSessionName, allocateTmuxSession, parseFlags, shouldEnableCurrentTmuxMouse, tmuxProfileCommands, shouldSelfCloseTmuxSession, tmuxRemainOnExitChainArgs } from "../src/commands/launch";
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
    delete process.env.JEO_TMUX_LAUNCHED;

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

    // The launch flow must NEVER issue `resize-window`: tmux flips the window's
    // `window-size` option to `manual` as a side effect, which permanently
    // detaches the window from the attached client. The terminal then resizes
    // while the tmux window stays frozen at its launch geometry, so the pane is
    // shown cut and jeo never receives SIGWINCH to reflow.
    const resizeCall = spawnSyncCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "resize-window");
    expect(resizeCall).toBeUndefined();

    // …and the session profile must assert `window-size latest` so the window
    // tracks the client even if the user's tmux.conf defaults to manual.
    const windowSizeCall = spawnSyncCalls.find(
      c => c[0] === "/usr/local/bin/tmux" && c.includes("window-size"),
    );
    expect(windowSizeCall).toBeDefined();
    expect(windowSizeCall!.at(-1)).toBe("latest");
    // (The `-x/-y` sizing of the detached window is covered by tmuxNewSessionSizeArgs;
    // this harness has no TTY, so the caller size is legitimately unknown here.)

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
    delete process.env.JEO_TMUX_LAUNCHED;

    await runLaunchCommand(["--tmux", "--no-session", "--model", "gemini-2.5-flash", "--thinking", "high", "--max-steps=7", "it's ok"]);

    const newSessionCall = spawnSyncCalls.find(c => c[0] === "/usr/local/bin/tmux" && c[1] === "new-session");
    expect(newSessionCall).toBeDefined();
    const sessName = newSessionCall![newSessionCall!.indexOf("-s") + 1] as string;
    expect(sessName.startsWith("jeo-feature-branch-")).toBe(true);
    expect(sessName).toContain("model-gemini-2-5-flash-think-high-steps-7"); // runtime suffix preserved
    const innerCmd = String(newSessionCall.find((a: string) => a.includes("JEO_TMUX_LAUNCHED=1")));
    expect(innerCmd).toContain("'--model' 'gemini-2.5-flash'");
    expect(innerCmd).toContain("'--thinking' 'high'");
    expect(innerCmd).toContain("'--max-steps=7'");
    expect(innerCmd).toContain("'it'\\''s ok'");
    // The inner process gets its OWN final session name (matters on a collision
    // retry, where the allocated name differs from the base) so it can self-close
    // exactly the session it owns on a clean exit — see shouldSelfCloseTmuxSession.
    expect(innerCmd).toContain(`JEO_TMUX_SESSION_NAME='${sessName}'`);
    expect(innerCmd).toContain("JEO_TMUX_LAUNCHED=1");
    // remain-on-exit is CHAINED onto this very same new-session invocation
    // (via tmux's `;` command-separator token) rather than applied as a
    // separate later call — closes a live-verified race where a near-instant
    // startup crash beats a follow-up `set-option` and the session vanishes
    // anyway. Tail of the argv array, after the inner command.
    expect(newSessionCall!.slice(-6)).toEqual([";", "set-option", "-t", `=${sessName}:`, "remain-on-exit", "on"]);
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
    delete process.env.JEO_TMUX_LAUNCHED;

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
    delete process.env.JEO_TMUX_LAUNCHED;

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
    delete process.env.JEO_TMUX_LAUNCHED;

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

test("tmuxSessionName: truncated long basenames never produce a double dash", () => {
  const flags = parseFlags([]);
  // Basename whose 16-char truncation boundary lands right after a `-` used to
  // yield `jeo-tmux--<hash>` (double dash). The head dash must be trimmed.
  const name = tmuxSessionName("/tmp/jeo-tmux-verify.fOxasL", "verifybr", flags);
  expect(name.startsWith("jeo-verifybr-")).toBe(true);
  expect(name).not.toContain("--");
  // A clean basename (no truncation) is unaffected.
  expect(tmuxSessionName("/home/u/my-app", "main", flags)).not.toContain("--");
});

test("shouldEnableCurrentTmuxMouse: only inside a foreign tmux session, opt-out honored", () => {
  // Inside the user's own tmux (jeo created no session): enable wheel scrolling.
  expect(shouldEnableCurrentTmuxMouse({ TMUX: "/tmp/tmux-1/default,123,0" })).toBe(true);
  // Outside tmux there is nothing to configure.
  expect(shouldEnableCurrentTmuxMouse({})).toBe(false);
  // jeo-spawned sessions already had mouse mode set by the creator.
  expect(shouldEnableCurrentTmuxMouse({ TMUX: "/tmp/tmux-1/default,123,0", JEO_TMUX_LAUNCHED: "1" })).toBe(false);
  // Explicit opt-out wins.
  expect(shouldEnableCurrentTmuxMouse({ TMUX: "/tmp/tmux-1/default,123,0", JEO_TMUX_MOUSE: "0" })).toBe(false);
});

test("tmuxProfileCommands: remain-on-exit keeps a dead pane visible (forensic evidence), opt-out honored", () => {
  const cmds = tmuxProfileCommands("jeo-main-abc", {});
  const remain = cmds.find(c => c.args.includes("remain-on-exit"));
  expect(remain).toBeDefined();
  expect(remain!.args.slice(-2)).toEqual(["remain-on-exit", "on"]);
  expect(remain!.args[remain!.args.indexOf("-t") + 1]).toBe("=jeo-main-abc:");
  expect(remain!.args).not.toContain("-g");

  const optedOut = tmuxProfileCommands("jeo-main-abc", { JEO_TMUX_REMAIN_ON_EXIT: "0" });
  expect(optedOut.some(c => c.args.includes("remain-on-exit"))).toBe(false);
  // The rest of the profile is unaffected by the opt-out.
  expect(optedOut.some(c => c.args.includes("@jeo-profile"))).toBe(true);
});

test("shouldSelfCloseTmuxSession: only the intentional happy-path exit codes self-close, and only inside a named jeo-owned session", () => {
  const owned = { JEO_TMUX_LAUNCHED: "1", TMUX: "/tmp/tmux-1/default,123,0", JEO_TMUX_SESSION_NAME: "jeo-main-abc" };
  // Clean success and the deliberate Ctrl-C hard exit (130) both self-close.
  expect(shouldSelfCloseTmuxSession(0, owned)).toBe(true);
  expect(shouldSelfCloseTmuxSession(130, owned)).toBe(true);
  // Every other code (crash-net, unexpected top-level error) is left alone —
  // remain-on-exit then preserves the dead pane for forensics.
  expect(shouldSelfCloseTmuxSession(1, owned)).toBe(false);
  expect(shouldSelfCloseTmuxSession(2, owned)).toBe(false);
  // Not a jeo-owned tmux-launched process: never self-close (would target an
  // unrelated or nonexistent session).
  expect(shouldSelfCloseTmuxSession(0, { TMUX: "/tmp/tmux-1/default,123,0" })).toBe(false);
  expect(shouldSelfCloseTmuxSession(0, { JEO_TMUX_LAUNCHED: "1", TMUX: "/tmp/tmux-1/default,123,0" })).toBe(false); // no session name
  expect(shouldSelfCloseTmuxSession(0, { JEO_TMUX_LAUNCHED: "1", JEO_TMUX_SESSION_NAME: "jeo-main-abc" })).toBe(false); // not actually inside tmux
});
test("tmuxRemainOnExitChainArgs: chains a `;`-separated set-option onto the SAME new-session invocation, opt-out honored", () => {
  // Live-verified (real tmux 3.6a) that a SEPARATE later `set-option` call loses
  // a real race — an inner process that crashes near-instantly at startup can
  // already be gone ("no such window") before the follow-up call connects, so
  // the session vanishes anyway. Chaining onto the SAME new-session invocation
  // (a literal `;` argv token, tmux's own command separator — no shell involved)
  // closes that gap; live-verified this does not disturb allocateTmuxSession's
  // duplicate-session detection even if the chained command somehow failed.
  const args = tmuxRemainOnExitChainArgs("jeo-main-abc", {});
  expect(args).toEqual([";", "set-option", "-t", "=jeo-main-abc:", "remain-on-exit", "on"]);

  const optedOut = tmuxRemainOnExitChainArgs("jeo-main-abc", { JEO_TMUX_REMAIN_ON_EXIT: "0" });
  expect(optedOut).toEqual([]);
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
  // window-size latest comes first: a frozen (manual) window never follows the
  // terminal, so the pane would render cut at the launch geometry forever.
  expect(cmds[0]!.args.slice(-2)).toEqual(["window-size", "latest"]);
  expect(cmds[0]!.args[0]).toBe("set-window-option");
  // mouse on follows: the load-bearing wheel→copy-mode scrollback switch.
  expect(cmds[1]!.args.slice(-2)).toEqual(["mouse", "on"]);
  // Ownership + identity markers.
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

  // JEO_TMUX_MOUSE=0 drops only the mouse switch (legacy JEO_ name honored too).
  for (const env of [{ JEO_TMUX_MOUSE: "0" }, { JEO_TMUX_MOUSE: "0" }]) {
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
    delete process.env.JEO_TMUX_LAUNCHED;
    delete process.env.JEO_TMUX_LAUNCHED;
    delete process.env.JEO_TMUX_MOUSE;
    delete process.env.JEO_TMUX_MOUSE;
    delete process.env.JEO_TMUX_PROFILE;
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
test("runLaunchCommand (tmux-launched inner process): registers a self-close exit hook honoring shouldSelfCloseTmuxSession", async () => {
  const originalOn = process.on;
  const originalSpawnSync = Bun.spawnSync;
  const originalEnv = { ...process.env };
  const spawnSyncCalls: any[] = [];
  let exitHandler: ((code: number) => void) | undefined;

  try {
    (process as any).on = ((event: string, handler: any) => {
      if (event === "exit" && !exitHandler) exitHandler = handler;
      return process;
    }) as any;
    Bun.spawnSync = ((cmd: any) => {
      spawnSyncCalls.push(Array.isArray(cmd) ? cmd : [cmd]);
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    }) as any;

    process.env.JEO_TMUX_LAUNCHED = "1";
    process.env.JEO_TMUX_SESSION_NAME = "jeo-owned-session";
    process.env.TMUX = "/tmp/tmux-1/default,123,0";

    await runLaunchCommand(["--list"]);

    expect(exitHandler).toBeDefined();
    // Clean exit (0): self-closes the exact owned session — normal `/exit` UX unchanged.
    exitHandler!(0);
    expect(
      spawnSyncCalls.some(c => c[0] === "tmux" && c[1] === "kill-session" && c.includes("=jeo-owned-session")),
    ).toBe(true);

    // A crash-net exit (1) leaves the session alone — remain-on-exit preserves the
    // dead pane's final screen for forensic tmux attach/capture-pane instead of the
    // whole session silently vanishing.
    spawnSyncCalls.length = 0;
    exitHandler!(1);
    expect(spawnSyncCalls.some(c => c[0] === "tmux" && c[1] === "kill-session")).toBe(false);
  } finally {
    (process as any).on = originalOn;
    Bun.spawnSync = originalSpawnSync;
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

test("tmux attach failure is surfaced with a reattach hint when the session is still live", async () => {
  const originalWhich = Bun.which;
  const originalSpawnSync = Bun.spawnSync;
  const originalSpawn = Bun.spawn;
  const originalError = console.error;
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;
  const errors: string[] = [];
  let hasSessionProbed = false;

  try {
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    Bun.which = (bin: string) => (bin === "tmux" ? "/usr/local/bin/tmux" : originalWhich(bin));
    Bun.spawnSync = ((cmd: any) => {
      const command = Array.isArray(cmd) ? cmd : [cmd];
      if (command[0] === "git" && command[1] === "symbolic-ref") {
        return { exitCode: 0, stdout: Buffer.from("main\n"), stderr: Buffer.from("") } as any;
      }
      if (command[0] === "/usr/local/bin/tmux" && command[1] === "has-session") {
        hasSessionProbed = true;
        return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any; // still alive
      }
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    }) as any;
    // attach-session fails (e.g. not a real terminal).
    Bun.spawn = (() => ({ exited: Promise.resolve(1) })) as any;

    delete process.env.TMUX;
    delete process.env.JEO_TMUX_LAUNCHED;
    process.exitCode = undefined;

    await runLaunchCommand(["--tmux", "--no-session", "--no-tui", "hello"]);

    const joined = errors.join("\n");
    expect(joined).toContain("tmux attach failed (exit 1)");
    expect(joined).toMatch(/reattach with: tmux attach -t jeo-main-/);
    expect(hasSessionProbed).toBe(true);
    expect(process.exitCode).toBe(1);
  } finally {
    Bun.which = originalWhich;
    Bun.spawnSync = originalSpawnSync;
    Bun.spawn = originalSpawn;
    console.error = originalError;
    process.env = originalEnv;
    process.exitCode = originalExitCode ?? 0;
  }
});

test("tmux attach failure on a dead session reports the session ended (no misleading reattach)", async () => {
  const originalWhich = Bun.which;
  const originalSpawnSync = Bun.spawnSync;
  const originalSpawn = Bun.spawn;
  const originalError = console.error;
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;
  const errors: string[] = [];

  try {
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    Bun.which = (bin: string) => (bin === "tmux" ? "/usr/local/bin/tmux" : originalWhich(bin));
    Bun.spawnSync = ((cmd: any) => {
      const command = Array.isArray(cmd) ? cmd : [cmd];
      if (command[0] === "git" && command[1] === "symbolic-ref") {
        return { exitCode: 0, stdout: Buffer.from("main\n"), stderr: Buffer.from("") } as any;
      }
      if (command[0] === "/usr/local/bin/tmux" && command[1] === "has-session") {
        return { exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("") } as any; // gone
      }
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    }) as any;
    Bun.spawn = (() => ({ exited: Promise.resolve(1) })) as any;

    delete process.env.TMUX;
    delete process.env.JEO_TMUX_LAUNCHED;
    process.exitCode = undefined;

    await runLaunchCommand(["--tmux", "--no-session", "--no-tui", "hello"]);

    const joined = errors.join("\n");
    expect(joined).toMatch(/ended before it could be attached/);
    expect(joined).not.toContain("reattach with");
    expect(process.exitCode).toBe(1);
  } finally {
    Bun.which = originalWhich;
    Bun.spawnSync = originalSpawnSync;
    Bun.spawn = originalSpawn;
    console.error = originalError;
    process.env = originalEnv;
    process.exitCode = originalExitCode ?? 0;
  }
});

import { currentTmuxClipboardCommands } from "../src/commands/launch";

test("currentTmuxClipboardCommands: in-session clipboard repair targets the CURRENT session (no -t/-g)", () => {
  const which = (bin: string) => (bin === "pbcopy" ? "/usr/bin/pbcopy" : null);
  const cmds = currentTmuxClipboardCommands({}, { platform: "darwin", which });
  // Every command sets a session-local option for the CURRENT session — never a
  // targeted (-t) or global (-g) write, so the user's other sessions are untouched.
  for (const c of cmds) {
    expect(c.args[0]).toBe("set-option");
    expect(c.args).not.toContain("-t");
    expect(c.args).not.toContain("-g");
  }
  const byDesc = Object.fromEntries(cmds.map(c => [c.description, c.args]));
  expect(byDesc["enable tmux clipboard integration"]!.slice(-2)).toEqual(["set-clipboard", "on"]);
  // copy-command pipes the drag-select to the resolved local clipboard tool.
  const copy = byDesc["pipe copy-mode selection to the system clipboard"]!;
  expect(copy.slice(-1)[0]).toContain("pbcopy");

  // No clipboard tool on PATH → set-clipboard still set, but no copy-command.
  const noTool = currentTmuxClipboardCommands({}, { platform: "linux", which: () => null });
  expect(noTool.some(c => c.args.includes("set-clipboard"))).toBe(true);
  expect(noTool.some(c => c.args.includes("copy-command"))).toBe(false);

  // JEO_TMUX_PROFILE=0 opts out of the clipboard repair entirely.
  expect(currentTmuxClipboardCommands({ JEO_TMUX_PROFILE: "0" }, { platform: "darwin", which })).toEqual([]);
});

// A DETACHED new-session defaults to 80x24, so the
// inner jeo's first frames render mis-wrapped until attach. The launch path sizes the
// session to the caller terminal via -x/-y and re-asserts with resize-window pre-attach.
test("callerTmuxTerminalSize: TTY with known dimensions → size; non-TTY or bogus dims → undefined", async () => {
  const { callerTmuxTerminalSize } = await import("../src/commands/launch/tmux");
  expect(callerTmuxTerminalSize({ isTTY: true, columns: 178, rows: 35 })).toEqual({ columns: 178, rows: 35 });
  // Not a TTY → never size (matches the attach guard: attach would fail anyway).
  expect(callerTmuxTerminalSize({ isTTY: false, columns: 178, rows: 35 })).toBeUndefined();
  // Unknown / invalid dimensions → undefined (tmux falls back to its default).
  expect(callerTmuxTerminalSize({ isTTY: true })).toBeUndefined();
  expect(callerTmuxTerminalSize({ isTTY: true, columns: 0, rows: 35 })).toBeUndefined();
  expect(callerTmuxTerminalSize({ isTTY: true, columns: 178, rows: -1 })).toBeUndefined();
  expect(callerTmuxTerminalSize({ isTTY: true, columns: 120.5, rows: 30 })).toBeUndefined();
});

test("tmuxNewSessionSizeArgs: emits -x/-y for a known size and nothing when unknown", async () => {
  const { tmuxNewSessionSizeArgs } = await import("../src/commands/launch/tmux");
  expect(tmuxNewSessionSizeArgs({ columns: 178, rows: 35 })).toEqual(["-x", "178", "-y", "35"]);
  expect(tmuxNewSessionSizeArgs(undefined)).toEqual([]);
});
