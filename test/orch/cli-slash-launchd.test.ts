import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runOrchSlash } from "../../src/commands/launch/orch-slash";
import { executeOrchAction } from "../../src/commands/orch";
import {
  acquireInstanceLock,
  buildLaunchdPlist,
  currentJeoCommand,
  isDaemonRunning,
  loadOrchConfig,
  loadOrchState,
  ORCH_LAUNCHD_LABEL,
  resolveDiscordToken,
  runOrchDaemon,
  runOrchOnce,
  saveDiscordToken,
  saveOrchConfig,
  saveOrchState,
} from "../../src/orch/index";
import { complete, staticCompletionContext } from "../../src/tui/components/autocomplete";
import { SLASH_COMMANDS } from "../../src/tui/components/slash";

describe("orch CLI, /orch slash menu, autocomplete, and launchd", () => {
  let tmpHome = "";

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-orch-cli-"));
  });

  afterEach(async () => {
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("registers /orch in SLASH_COMMANDS and completes subcommands in autocomplete", () => {
    expect(SLASH_COMMANDS).toContain("/orch");
    const ctx = {
      ...staticCompletionContext(),
      liveModels: [],
      aliases: [],
      modelsForProvider: () => [],
    };
    const top = complete("/orch ", ctx);
    expect(top.kind).toBe("subcommand");
    expect(top.completions).toContain("init");
    expect(top.completions).toContain("link");
    expect(top.completions).toContain("unlink");
    expect(top.completions).toContain("assign");
    expect(top.completions).toContain("daemon");
    expect(top.completions).toContain("approve");

    const daemonSub = complete("/orch daemon ", ctx);
    expect(daemonSub.completions).toEqual(["status", "install", "uninstall"]);
  });

  it("handles /orch dashboard, init, assign, routes, unassign, and daemon safety guard", async () => {
    const dash = await runOrchSlash("/orch", { orchHome: tmpHome });
    expect(dash.lines.join("\n")).toContain("jeo Thread Orchestrator");
    expect(dash.lines.join("\n")).toContain("/orch init");

    const init = await runOrchSlash(
      "/orch init 111222333444555666 --dm 777888999000111222 --owner 444555666777888999 --poll 15000 --debounce 5000 --orca-bin /custom/bin/orca",
      { orchHome: tmpHome },
    );
    expect(init.lines.join("\n")).toContain("111222333444555666");
    const initCfg = await loadOrchConfig(tmpHome);
    expect(initCfg.guildId).toBe("111222333444555666");
    expect(initCfg.ownerDmChannelId).toBe("777888999000111222");
    expect(initCfg.ownerUserIds).toEqual(["444555666777888999"]);
    expect(initCfg.pollIntervalMs).toBe(15000);
    expect(initCfg.debounceMs).toBe(5000);
    expect(initCfg.orcaBin).toBe("/custom/bin/orca");

    const assigned = await runOrchSlash("/orch assign sample-app 999888777 /tmp/sample-repo alpha,beta", { orchHome: tmpHome });
    expect(assigned.lines.join("\n")).toContain("Assigned route 'sample-app'");

    const routes = await runOrchSlash("/orch routes", { orchHome: tmpHome });
    expect(routes.lines.join("\n")).toContain("sample-app");
    expect(routes.lines.join("\n")).toContain("999888777");

    const removed = await runOrchSlash("/orch unassign sample-app", { orchHome: tmpHome });
    expect(removed.lines.join("\n")).toContain("Removed route 'sample-app'");

    // Never allow foreground blocking daemon inside TUI
    const blocked = await runOrchSlash("/orch daemon", { orchHome: tmpHome });
    expect(blocked.lines.join("\n")).toContain("Foreground daemon cannot run inside the interactive TUI");
  });

  it("loads, links, live-reloads, and unlinks repo-local hidden .jeo/orch.json configs", async () => {
    const fakeRepo = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-orch-repo-"));
    try {
      const hiddenDir = path.join(fakeRepo, ".jeo");
      const hiddenCfgPath = path.join(hiddenDir, "orch.json");
      await fs.mkdir(hiddenDir, { recursive: true });
      await fs.writeFile(
        hiddenCfgPath,
        JSON.stringify(
          {
            guildId: "900100200300400500",
            ownerUserIds: ["500400300200100900"],
            ownerDmChannelId: "800700600500400300",
            route: {
              id: "demo-game",
              name: "Demo Game",
              parentChannelIds: ["700600500400300200"],
              titleKeywords: ["demo", "server"],
              repoPath: ".",
              maxIterations: 5,
              verificationGates: [{ name: "unit", command: "bun test" }],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      // Running `init` with no args inside a repo auto-links `.jeo/orch.json`
      const autoLinked = await executeOrchAction(["init"], { orchHome: tmpHome, cwd: fakeRepo });
      expect(autoLinked.exitCode ?? 0).toBe(0);
      expect(autoLinked.lines.join("\n")).toContain("Linked repo-local config");
      expect(autoLinked.lines.join("\n")).toContain("demo-game");

      const cfg1 = await loadOrchConfig(tmpHome);
      expect(cfg1.guildId).toBe("900100200300400500");
      expect(cfg1.ownerUserIds).toEqual(["500400300200100900"]);
      expect(cfg1.ownerDmChannelId).toBe("800700600500400300");
      expect(cfg1.configFiles).toEqual([path.resolve(hiddenCfgPath)]);
      expect(cfg1.routes).toHaveLength(1);
      expect(cfg1.routes[0]?.repoPath).toBe(path.resolve(fakeRepo));
      expect(cfg1.routes[0]?.maxIterations).toBe(5);

      // Editing `.jeo/orch.json` is picked up live on next loadOrchConfig without re-linking
      await fs.writeFile(
        hiddenCfgPath,
        JSON.stringify({
          guildId: "900100200300400500",
          route: {
            id: "demo-game",
            name: "Demo Game Updated",
            parentChannelIds: ["700600500400300200"],
            titleKeywords: ["demo", "updated"],
            maxIterations: 3,
          },
        }),
        "utf8",
      );
      const cfg2 = await loadOrchConfig(tmpHome);
      expect(cfg2.routes[0]?.name).toBe("Demo Game Updated");
      expect(cfg2.routes[0]?.maxIterations).toBe(3);
      expect(cfg2.routes[0]?.repoPath).toBe(path.resolve(fakeRepo));

      // `assign --local` writes to `<repo>/.jeo/orch.json` with 0600 mode and links it
      const assignedLocal = await executeOrchAction(
        [
          "assign",
          "--id",
          "demo-worker",
          "--parent",
          "700600500400300201",
          "--repo",
          fakeRepo,
          "--keywords",
          "worker,api",
          "--max-iter",
          "6",
          "--same-failure-limit",
          "3",
          "--no-spawn",
          "--local",
        ],
        { orchHome: tmpHome, cwd: fakeRepo },
      );
      expect(assignedLocal.exitCode ?? 0).toBe(0);
      const stat = await fs.stat(hiddenCfgPath);
      expect(stat.mode & 0o777).toBe(0o600);
      const cfg3 = await loadOrchConfig(tmpHome);
      expect(cfg3.routes.map(r => r.id).sort()).toEqual(["demo-game", "demo-worker"]);
      expect(cfg3.routes.find(r => r.id === "demo-worker")?.spawnIfBusy).toBe(false);

      // `unlink` removes the reference cleanly
      const unlinked = await executeOrchAction(["unlink"], { orchHome: tmpHome, cwd: fakeRepo });
      expect(unlinked.exitCode ?? 0).toBe(0);
      const cfg4 = await loadOrchConfig(tmpHome);
      expect(cfg4.routes).toHaveLength(0);
      expect(cfg4.configFiles).toBeUndefined();

      // `JEO_ORCH_CONFIG` env var overlays config without mutating routes.json
      const prevEnv = process.env.JEO_ORCH_CONFIG;
      process.env.JEO_ORCH_CONFIG = hiddenCfgPath;
      try {
        const cfgEnv = await loadOrchConfig(tmpHome);
        expect(cfgEnv.guildId).toBe("900100200300400500");
        expect(cfgEnv.routes.map(r => r.id).sort()).toEqual(["demo-game", "demo-worker"]);
      } finally {
        if (prevEnv === undefined) delete process.env.JEO_ORCH_CONFIG;
        else process.env.JEO_ORCH_CONFIG = prevEnv;
      }

      // `init --local` updates repo-local `.jeo/orch.json` and links it
      const initLocal = await executeOrchAction(
        ["init", "--local", "--guild", "911222333444555666", "--orca-bin", "/custom/bin/orca"],
        { orchHome: tmpHome, cwd: fakeRepo },
      );
      expect(initLocal.exitCode ?? 0).toBe(0);
      const cfg5 = await loadOrchConfig(tmpHome);
      expect(cfg5.guildId).toBe("911222333444555666");
      expect(cfg5.orcaBin).toBe("/custom/bin/orca");
    } finally {
      await fs.rm(fakeRepo, { recursive: true, force: true });
    }
  });

  it("controls thread lifecycle and pending approval gates via executeOrchAction", async () => {
    const nowIso = new Date().toISOString();
    await saveOrchState({
      version: 1,
      threads: {
        "t-1": {
          threadId: "t-1",
          parentId: "123456789012345678",
          name: "sample-app test thread",
          routeId: "sample-app",
          status: "PAUSED_NEEDS_HUMAN",
          iteration: 1,
          consecutiveSameFailures: 0,
          pendingMessages: [],
          pendingGate: {
            id: "gate_abc123",
            threadId: "t-1",
            routeId: "sample-app",
            reason: "Force git push",
            excerpt: "git push --force",
            createdAt: nowIso,
            status: "pending",
          },
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      },
      gates: {
        gate_abc123: {
          id: "gate_abc123",
          threadId: "t-1",
          routeId: "sample-app",
          reason: "Force git push",
          excerpt: "git push --force",
          createdAt: nowIso,
          status: "pending",
        },
      },
    }, tmpHome);

    // Resume must refuse while gate is pending
    const refused = await executeOrchAction(["resume", "t-1"], { orchHome: tmpHome });
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.join("\n")).toContain("gate_abc123");

    // Approve gate unblocks thread to QUEUED
    const approved = await executeOrchAction(["approve", "gate_abc123"], { orchHome: tmpHome });
    expect(approved.exitCode ?? 0).toBe(0);
    const afterApprove = await loadOrchState(tmpHome);
    expect(afterApprove.gates.gate_abc123?.status).toBe("approved");
    expect(afterApprove.threads["t-1"]?.status).toBe("QUEUED");

    // Pause and stop transitions
    await executeOrchAction(["pause", "t-1"], { orchHome: tmpHome });
    expect((await loadOrchState(tmpHome)).threads["t-1"]?.status).toBe("PAUSED");

    await executeOrchAction(["stop", "t-1"], { orchHome: tmpHome });
    expect((await loadOrchState(tmpHome)).threads["t-1"]?.status).toBe("STOPPED");
  });

  it("generates valid launchd plist without secrets and detects active instance lock", async () => {
    const tokenPath = await saveDiscordToken("super-secret-bot-token", tmpHome);
    const stat = await fs.stat(tokenPath);
    expect(stat.mode & 0o777).toBe(0o600);

    const jeoCmd = currentJeoCommand();
    expect(path.isAbsolute(jeoCmd[0]!)).toBe(true);
    expect(jeoCmd[1]!).toContain("cli.ts");
    expect(path.isAbsolute(jeoCmd[1]!)).toBe(true);

    const bundledCmd = currentJeoCommand("/usr/local/lib/node_modules/jeo-code/dist/jeo.js");
    expect(bundledCmd[1]).toBe("/usr/local/lib/node_modules/jeo-code/dist/jeo.js");

    const plist = buildLaunchdPlist({

      programArgs: jeoCmd,
      orchHome: tmpHome,
      homeDir: "/Users/tester",
    });
    expect(plist).toContain(`<string>${ORCH_LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>orch</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain(tmpHome);
    expect(plist).not.toContain("super-secret-bot-token");

    // Verify Orca app bin is at front of default PATH
    expect(plist).toContain("<string>/Applications/Orca.app/Contents/Resources/bin:/Users/tester/.bun/bin:");

    // Verify ProgramArguments[0] is an absolute path
    const progArgsMatch = plist.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
    expect(progArgsMatch).not.toBeNull();
    expect(path.isAbsolute(progArgsMatch![1]!)).toBe(true);

    // Verify custom pathEnv overrides default
    const customPlist = buildLaunchdPlist({
      programArgs: jeoCmd,
      orchHome: tmpHome,
      pathEnv: "/custom/bin:/another/bin",
    });
    expect(customPlist).toContain("<string>/custom/bin:/another/bin</string>");

    const beforeLock = await isDaemonRunning(tmpHome);
    expect(beforeLock.running).toBe(false);

    const lock = await acquireInstanceLock(tmpHome);
    try {
      const duringLock = await isDaemonRunning(tmpHome);
      expect(duringLock.running).toBe(true);
      expect(duringLock.lock?.pid).toBe(process.pid);
    } finally {
      await lock.release();
    }

    const afterLock = await isDaemonRunning(tmpHome);
    expect(afterLock.running).toBe(false);
  });

  it("refuses concurrent non-dry-run tick while daemon is active, allowing dry-run", async () => {
    const lock = await acquireInstanceLock(tmpHome);
    try {
      await expect(
        runOrchOnce({ dryRun: false, orchHome: tmpHome, token: "mock-token" }),
      ).rejects.toThrow(/daemon is active/);
    } finally {
      await lock.release();
    }
  });

  it("resolves token file with leading ~/ expansion", async () => {
    const testSubDir = path.join(os.homedir(), `.tmp-orch-token-${Date.now()}`);
    await fs.mkdir(testSubDir, { recursive: true });
    const fullTokenPath = path.join(testSubDir, "discord-bot.token");
    await fs.writeFile(fullTokenPath, "token-from-tilde-path", "utf8");
    try {
      const relTokenPath = `~/${path.relative(os.homedir(), fullTokenPath)}`;
      const cfg = await loadOrchConfig(tmpHome);
      cfg.tokenFile = relTokenPath;
      await saveOrchConfig(cfg, tmpHome);

      const resolved = await resolveDiscordToken(tmpHome, {});
      expect(resolved).toBe("token-from-tilde-path");
    } finally {
      await fs.rm(testSubDir, { recursive: true, force: true });
    }
  });

  it("exits early without acquiring lock when signal is pre-aborted", async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    await runOrchDaemon({ orchHome: tmpHome, token: "dummy-token", signal: abortCtrl.signal });
    expect((await isDaemonRunning(tmpHome)).running).toBe(false);
  });
});
