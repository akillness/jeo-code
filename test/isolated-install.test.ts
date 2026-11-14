import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultDeps } from "../src/commands/update";
import {
  buildNpmCommand,
  isolatedGlobalDir,
  JEO_PACKAGE,
  jeoCommandAttempts,
  NPM_REGISTRY_URL,
  resolveBunBinDir,
  resolveBunExecutable,
  resolveHomeDir,
  runIsolatedBunUpdate,
  sweepStaleBinBackups,
  type EnvRecord,
  type SpawnOutcome,
} from "../src/util/isolated-install";

// Every fixture lives under this isolated temp directory; never touch real ~/.bun, ~/.jeo, or ~/.npmrc.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jeo-isolated-install-test-")));
let counter = 0;

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) {
    restores.pop()?.();
  }
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function mkDir(label: string): string {
  const dir = path.join(ROOT, `${label}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeText(file: string, content: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

function writeJson(file: string, value: unknown): string {
  return writeText(file, JSON.stringify(value, null, 2));
}

function hashTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = path.relative(dir, full);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        hash.update(`L:${rel}:${fs.readlinkSync(full)}\n`);
      } else if (st.isDirectory()) {
        hash.update(`D:${rel}\n`);
        walk(full);
      } else {
        hash.update(`F:${rel}:`);
        hash.update(fs.readFileSync(full));
        hash.update("\n");
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

/**
 * When simulating `platform: "win32"` on a POSIX host, `path.win32.resolve` / `path.win32.join`
 * turn POSIX temp paths into backslash-prefixed relative names that POSIX `fs.*` would create
 * inside `process.cwd()`. Redirecting `path.win32` path assembly to `path.posix` ONLY while
 * running real temp-dir filesystem tests keeps all mutations strictly under `ROOT`.
 */
function bridgeWin32PathsOnPosix(): void {
  if (process.platform === "win32") return;
  const resolveSpy = spyOn(path.win32, "resolve").mockImplementation((...parts: string[]) =>
    path.posix.resolve(...parts),
  );
  const joinSpy = spyOn(path.win32, "join").mockImplementation((...parts: string[]) =>
    path.posix.join(...parts),
  );
  restores.push(
    () => resolveSpy.mockRestore(),
    () => joinSpy.mockRestore(),
  );
}

describe("path & environment resolution (POSIX and win32)", () => {
  test("resolveHomeDir handles POSIX HOME and win32 USERPROFILE / HOMEDRIVE+HOMEPATH precedence", () => {
    expect(resolveHomeDir({ HOME: "/home/alice" }, "linux")).toBe("/home/alice");
    expect(resolveHomeDir({ HOME: "/Users/alice", USERPROFILE: "C:\\Users\\other" }, "darwin")).toBe("/Users/alice");

    // On POSIX, Windows-only variables are ignored and fallback reaches os.homedir().
    expect(resolveHomeDir({ HOME: "   ", USERPROFILE: "C:\\Users\\alice" }, "linux")).toBe(os.homedir());

    // On win32: HOME > USERPROFILE > HOMEDRIVE+HOMEPATH > os.homedir()
    expect(
      resolveHomeDir(
        {
          HOME: "C:\\msys\\home\\alice",
          USERPROFILE: "C:\\Users\\alice",
          HOMEDRIVE: "D:",
          HOMEPATH: "\\Users\\bob",
        },
        "win32",
      ),
    ).toBe("C:\\msys\\home\\alice");

    expect(
      resolveHomeDir(
        {
          HOME: "",
          USERPROFILE: "C:\\Users\\alice",
          HOMEDRIVE: "D:",
          HOMEPATH: "\\Users\\bob",
        },
        "win32",
      ),
    ).toBe("C:\\Users\\alice");

    expect(
      resolveHomeDir(
        {
          USERPROFILE: "   ",
          HOMEDRIVE: "D:",
          HOMEPATH: "\\Users\\bob",
        },
        "win32",
      ),
    ).toBe("D:\\Users\\bob");

    // Incomplete HOMEDRIVE/HOMEPATH falls back to os.homedir().
    expect(resolveHomeDir({ HOMEDRIVE: "D:" }, "win32")).toBe(os.homedir());
    expect(resolveHomeDir({ HOMEPATH: "\\Users\\bob" }, "win32")).toBe(os.homedir());
  });

  test("isolatedGlobalDir respects JEO_GLOBAL_DIR > JEO_CONFIG_DIR > home/.jeo/global for POSIX and win32", () => {
    const posixHome = "/home/alice";
    expect(isolatedGlobalDir({}, posixHome, "linux")).toBe("/home/alice/.jeo/global");
    expect(isolatedGlobalDir({ JEO_CONFIG_DIR: "/opt/jeo-cfg" }, posixHome, "darwin")).toBe("/opt/jeo-cfg/global");
    expect(
      isolatedGlobalDir(
        { JEO_CONFIG_DIR: "/opt/jeo-cfg", JEO_GLOBAL_DIR: "/var/jeo-global" },
        posixHome,
        "linux",
      ),
    ).toBe("/var/jeo-global");

    const winHome = "C:\\Users\\alice";
    expect(isolatedGlobalDir({}, winHome, "win32")).toBe("C:\\Users\\alice\\.jeo\\global");
    expect(isolatedGlobalDir({ JEO_CONFIG_DIR: "D:\\jeo-cfg" }, winHome, "win32")).toBe("D:\\jeo-cfg\\global");
    expect(
      isolatedGlobalDir(
        { JEO_CONFIG_DIR: "D:\\jeo-cfg", JEO_GLOBAL_DIR: "E:\\custom-global" },
        winHome,
        "win32",
      ),
    ).toBe("E:\\custom-global");
  });

  test("resolveBunBinDir respects BUN_INSTALL_BIN > BUN_INSTALL/bin > home/.bun/bin for POSIX and win32", () => {
    const posixHome = "/home/alice";
    expect(resolveBunBinDir({}, posixHome, "linux")).toBe("/home/alice/.bun/bin");
    expect(resolveBunBinDir({ BUN_INSTALL: "/opt/bun" }, posixHome, "darwin")).toBe("/opt/bun/bin");
    expect(
      resolveBunBinDir({ BUN_INSTALL: "/opt/bun", BUN_INSTALL_BIN: "/usr/local/bun-bin" }, posixHome, "linux"),
    ).toBe("/usr/local/bun-bin");

    const winHome = "C:\\Users\\alice";
    expect(resolveBunBinDir({}, winHome, "win32")).toBe("C:\\Users\\alice\\.bun\\bin");
    expect(resolveBunBinDir({ BUN_INSTALL: "D:\\bun" }, winHome, "win32")).toBe("D:\\bun\\bin");
    expect(
      resolveBunBinDir({ BUN_INSTALL: "D:\\bun", BUN_INSTALL_BIN: "E:\\shims" }, winHome, "win32"),
    ).toBe("E:\\shims");
  });
});

describe("executable & command resolution", () => {
  test("resolveBunExecutable checks existing bun/bun.exe execPath, which fallback, then bunBinDir fallback", () => {
    const dir = mkDir("resolve-bun");
    const posixBunExec = writeText(path.join(dir, "exec", "bun"), "#!/bin/sh\n", 0o755);
    const winBunExec = writeText(path.join(dir, "winexec", "BUN.EXE"), "mz", 0o755);
    const otherExec = writeText(path.join(dir, "other", "jeo"), "#!/bin/sh\n", 0o755);

    // 1. execPath named bun / bun.exe and existing on disk wins immediately.
    let whichCalled = 0;
    const neverWhich = (): string | null => {
      whichCalled++;
      return null;
    };
    expect(resolveBunExecutable({ HOME: dir }, "linux", posixBunExec, neverWhich)).toBe(posixBunExec);
    expect(resolveBunExecutable({ USERPROFILE: dir }, "win32", winBunExec, neverWhich)).toBe(winBunExec);
    expect(whichCalled).toBe(0);

    // Non-existent bun execPath falls through to whichFn.
    expect(
      resolveBunExecutable({ HOME: dir }, "darwin", path.join(dir, "missing", "bun"), cmd =>
        cmd === "bun" ? "/opt/homebrew/bin/bun" : null,
      ),
    ).toBe("/opt/homebrew/bin/bun");

    // 2. which fallback on win32 prefers bun.exe over bun, and falls back to bun when bun.exe is absent.
    const queried: string[] = [];
    expect(
      resolveBunExecutable({ USERPROFILE: "C:\\Users\\alice" }, "win32", otherExec, cmd => {
        queried.push(cmd);
        return cmd === "bun" ? "C:\\tools\\bun" : null;
      }),
    ).toBe("C:\\tools\\bun");
    expect(queried).toEqual(["bun.exe", "bun"]);

    expect(
      resolveBunExecutable({ USERPROFILE: "C:\\Users\\alice" }, "win32", otherExec, cmd =>
        cmd === "bun.exe" ? "C:\\Users\\alice\\.bun\\bin\\bun.exe" : "C:\\tools\\bun",
      ),
    ).toBe("C:\\Users\\alice\\.bun\\bin\\bun.exe");

    // 3. <bunBinDir>/bun fallback on POSIX when execPath & which miss.
    const customBin = path.join(dir, "bun-install", "bin");
    const binBun = writeText(path.join(customBin, "bun"), "#!/bin/sh\n", 0o755);
    expect(resolveBunExecutable({ BUN_INSTALL_BIN: customBin }, "linux", otherExec, () => null)).toBe(binBun);

    // 4. <bunBinDir>\bun.exe fallback on win32 when candidate exists.
    const winBinDir = "C:\\Users\\alice\\.bun\\bin";
    const winCandidate = "C:\\Users\\alice\\.bun\\bin\\bun.exe";
    const existsSpy = spyOn(fs, "existsSync").mockImplementation(p => String(p) === winCandidate);
    restores.push(() => existsSpy.mockRestore());
    expect(
      resolveBunExecutable({ USERPROFILE: "C:\\Users\\alice" }, "win32", "C:\\other\\jeo.exe", () => null),
    ).toBe(winCandidate);

    // 5. Final bare fallback when nothing exists anywhere.
    existsSpy.mockImplementation(() => false);
    expect(resolveBunExecutable({ HOME: dir }, "linux", otherExec, () => null)).toBe("bun");
    expect(resolveBunExecutable({ USERPROFILE: "C:\\Users\\alice" }, "win32", "C:\\other\\jeo.exe", () => null)).toBe(
      "bun.exe",
    );
  });

  test("buildNpmCommand handles POSIX vs win32 (.cmd quoting vs direct .exe)", () => {
    expect(buildNpmCommand("darwin", ["install", "-g", "jeo-code@1.2.3"])).toEqual([
      "npm",
      "install",
      "-g",
      "jeo-code@1.2.3",
    ]);
    expect(buildNpmCommand("linux", ["config", "get", "registry"])).toEqual(["npm", "config", "get", "registry"]);

    // win32 with npm.cmd (or missing npm): wraps in cmd /d /s /c and quotes spaces/metacharacters.
    const whichCmdSpy = spyOn(Bun, "which").mockImplementation(cmd =>
      cmd === "npm.cmd" ? "C:\\Program Files\\nodejs\\npm.cmd" : null,
    );
    restores.push(() => whichCmdSpy.mockRestore());
    expect(buildNpmCommand("win32", ["install", "-g", "jeo-code@1.2.3", "--comment", "hello world&more"])).toEqual([
      "cmd",
      "/d",
      "/s",
      "/c",
      'npm install -g jeo-code@1.2.3 --comment "hello world&more"',
    ]);

    // win32 when no npm is on PATH at all: also falls back to cmd /d /s /c.
    whichCmdSpy.mockImplementation(() => null);
    expect(buildNpmCommand("win32", ["install", "-g", "jeo-code@1.2.3"])).toEqual([
      "cmd",
      "/d",
      "/s",
      "/c",
      "npm install -g jeo-code@1.2.3",
    ]);

    // win32 when a non-.cmd binary (e.g. npm.exe) is resolved: invokes it directly.
    whichCmdSpy.mockImplementation(cmd => (cmd === "npm" ? "C:\\tools\\npm.exe" : null));
    expect(buildNpmCommand("win32", ["install", "-g", "jeo-code@1.2.3"])).toEqual([
      "C:\\tools\\npm.exe",
      "install",
      "-g",
      "jeo-code@1.2.3",
    ]);
  });

  test("jeoCommandAttempts builds platform-specific candidate lists with binDir priority", () => {
    const dir = mkDir("cmd-attempts");
    const posixBin = path.join(dir, "bin");
    const posixJeo = writeText(path.join(posixBin, "jeo"), "#!/bin/sh\n", 0o755);

    expect(jeoCommandAttempts("linux", ["--version"], posixBin)).toEqual([
      [posixJeo, "--version"],
      ["jeo", "--version"],
    ]);

    const emptyPosixBin = path.join(dir, "empty-bin");
    fs.mkdirSync(emptyPosixBin, { recursive: true });
    expect(jeoCommandAttempts("darwin", ["--version"], emptyPosixBin)).toEqual([["jeo", "--version"]]);
    expect(jeoCommandAttempts("linux", ["whats-new"])).toEqual([["jeo", "whats-new"]]);

    // win32 with existing <binDir>\jeo.exe: checks binDir\jeo.exe, jeo, jeo.exe, cmd /d /s /c.
    const winBin = "C:\\Users\\alice\\.bun\\bin";
    const winJeoExe = "C:\\Users\\alice\\.bun\\bin\\jeo.exe";
    const existsSpy = spyOn(fs, "existsSync").mockImplementation(p => String(p) === winJeoExe);
    restores.push(() => existsSpy.mockRestore());

    expect(jeoCommandAttempts("win32", ["--version", "a b"], winBin)).toEqual([
      [winJeoExe, "--version", "a b"],
      ["jeo", "--version", "a b"],
      ["jeo.exe", "--version", "a b"],
      ["cmd", "/d", "/s", "/c", 'jeo --version "a b"'],
    ]);

    // win32 when binDir\jeo.exe is absent: omits binDir\jeo.exe.
    existsSpy.mockImplementation(() => false);
    expect(jeoCommandAttempts("win32", ["messenger", "update"], winBin)).toEqual([
      ["jeo", "messenger", "update"],
      ["jeo.exe", "messenger", "update"],
      ["cmd", "/d", "/s", "/c", "jeo messenger update"],
    ]);
  });
});

describe("sweepStaleBinBackups", () => {
  test("removes *.jeo-bak.* files while leaving active shims and unrelated files intact", () => {
    const binDir = mkDir("sweep");
    const active = writeText(path.join(binDir, "jeo.exe"), "live-exe");
    const jeopi = writeText(path.join(binDir, "jeopi"), "jeopi-bin");
    const bak1 = writeText(path.join(binDir, "jeo.exe.jeo-bak.1001"), "old-exe");
    const bak2 = writeText(path.join(binDir, "joc.cmd.jeo-bak.9999"), "old-joc");

    sweepStaleBinBackups(binDir);

    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(jeopi)).toBe(true);
    expect(fs.existsSync(bak1)).toBe(false);
    expect(fs.existsSync(bak2)).toBe(false);

    // Non-existent directory is a silent no-op.
    expect(() => sweepStaleBinBackups(path.join(binDir, "does-not-exist"))).not.toThrow();
  });
});

describe("runIsolatedBunUpdate", () => {
  test("stages into isolatedGlobal/bin without touching sibling ~/.bun/install/global (jeopi-cli + bun.lock stay byte-identical)", () => {
    const home = mkDir("home-isolated");
    const sharedGlobal = path.join(home, ".bun", "install", "global");
    const sharedPkgJson = writeJson(path.join(sharedGlobal, "package.json"), {
      dependencies: { "jeopi-cli": "16.6.18" },
    });
    const sharedLockText = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "dependencies": { "jeopi-cli": "16.6.18" } } },
  "packages": {
    "jeopi-cli": ["jeopi-cli@16.6.18", "", {}, "sha512-test=="]
  }
}
`;
    const sharedLock = writeText(path.join(sharedGlobal, "bun.lock"), sharedLockText);
    writeJson(path.join(sharedGlobal, "node_modules", "jeopi-cli", "package.json"), {
      name: "jeopi-cli",
      version: "16.6.18",
    });

    const beforeSharedHash = hashTree(sharedGlobal);
    const beforePkgBytes = fs.readFileSync(sharedPkgJson);
    const beforeLockBytes = fs.readFileSync(sharedLock);

    const env: EnvRecord = { HOME: home };
    const seenCalls: Array<{ cmd: string[]; env: Record<string, string> }> = [];
    const expectedGlobal = path.join(home, ".jeo", "global");
    const expectedStagingBin = path.join(expectedGlobal, "bin");
    const expectedBinDir = path.join(home, ".bun", "bin");

    const res = runIsolatedBunUpdate("1.2.3", {
      env,
      platform: "darwin",
      execPath: "/usr/local/bin/bun",
      which: () => "/usr/local/bin/bun",
      activeVersion: () => "1.2.3",
      spawn: (cmd, childEnv) => {
        seenCalls.push({ cmd, env: childEnv });
        const globalDir = childEnv.BUN_INSTALL_GLOBAL_DIR!;
        writeJson(path.join(globalDir, "node_modules", JEO_PACKAGE, "package.json"), {
          name: JEO_PACKAGE,
          version: "1.2.3",
        });
        writeText(path.join(globalDir, "node_modules", JEO_PACKAGE, "src", "cli.ts"), "#!/usr/bin/env bun\n", 0o755);
        return { success: true, exitCode: 0 };
      },
    });

    expect(res.success).toBe(true);
    expect(res.globalDir).toBe(expectedGlobal);
    expect(res.binDir).toBe(expectedBinDir);

    expect(seenCalls.length).toBe(1);
    expect(seenCalls[0]!.cmd).toEqual([
      "/usr/local/bin/bun",
      "install",
      "-g",
      `${JEO_PACKAGE}@1.2.3`,
      "--no-cache",
      `--registry=${NPM_REGISTRY_URL}`,
    ]);
    expect(seenCalls[0]!.env.BUN_INSTALL_GLOBAL_DIR).toBe(expectedGlobal);
    expect(seenCalls[0]!.env.BUN_INSTALL_BIN).toBe(expectedStagingBin);

    // Sibling ~/.bun/install/global must be byte-for-byte untouched.
    expect(fs.readFileSync(sharedPkgJson).equals(beforePkgBytes)).toBe(true);
    expect(fs.readFileSync(sharedLock).equals(beforeLockBytes)).toBe(true);
    expect(hashTree(sharedGlobal)).toBe(beforeSharedHash);
  });

  test("atomically updates <bunBinDir>/jeo symlink on POSIX and removes stale joc", () => {
    const home = mkDir("home-posix-symlink");
    const binDir = path.join(home, ".bun", "bin");
    const globalDir = path.join(home, ".jeo", "global");

    const legacyTarget = writeText(path.join(home, "old-jeo", "cli.ts"), "old");
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(legacyTarget, path.join(binDir, "jeo"));
    fs.symlinkSync(legacyTarget, path.join(binDir, "joc"));

    const res = runIsolatedBunUpdate("2.0.0", {
      env: { HOME: home },
      platform: "linux",
      which: () => "bun",
      activeVersion: () => "2.0.0",
      spawn: (_cmd, childEnv) => {
        const g = childEnv.BUN_INSTALL_GLOBAL_DIR!;
        writeJson(path.join(g, "node_modules", JEO_PACKAGE, "package.json"), {
          name: JEO_PACKAGE,
          version: "2.0.0",
        });
        writeText(path.join(g, "node_modules", JEO_PACKAGE, "src", "cli.ts"), "#!/usr/bin/env bun\n", 0o755);
        return { success: true, exitCode: 0 };
      },
    });

    expect(res.success).toBe(true);
    const jeoLink = path.join(binDir, "jeo");
    expect(fs.lstatSync(jeoLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(jeoLink)).toBe(path.join(globalDir, "node_modules", JEO_PACKAGE, "src", "cli.ts"));
    expect(() => fs.lstatSync(path.join(binDir, "joc"))).toThrow();

    // No leftover atomic-rename temp symlinks in binDir.
    const leftoverTmp = fs.readdirSync(binDir).filter(name => name.includes(".tmp."));
    expect(leftoverTmp).toEqual([]);
  });

  test("handles undefined version (latest) and falls back to stagingBinDir/jeo symlink when src/cli.ts is absent", () => {
    const home = mkDir("home-latest-fallback");
    const binDir = path.join(home, ".bun", "bin");
    const globalDir = path.join(home, ".jeo", "global");
    const stagingBin = path.join(globalDir, "bin");

    let stagedTarget: string | undefined;
    const res = runIsolatedBunUpdate(undefined, {
      env: { HOME: home },
      platform: "darwin",
      which: () => "bun",
      activeVersion: () => "1.0.0",
      spawn: (cmd, childEnv) => {
        stagedTarget = cmd[3];
        writeText(path.join(childEnv.BUN_INSTALL_BIN!, "jeo"), "#!/bin/sh\n", 0o755);
        return { success: true, exitCode: 0 };
      },
    });

    expect(res.success).toBe(true);
    expect(stagedTarget).toBe(`${JEO_PACKAGE}@latest`);
    expect(fs.readlinkSync(path.join(binDir, "jeo"))).toBe(path.join(stagingBin, "jeo"));
  });

  test("leaves existing <bunBinDir>/jeo untouched if staging fails", () => {
    const home = mkDir("home-stage-fail");
    const binDir = path.join(home, ".bun", "bin");
    const existingTarget = writeText(path.join(home, "existing", "cli.ts"), "v1-working");
    fs.mkdirSync(binDir, { recursive: true });
    const jeoBin = path.join(binDir, "jeo");
    fs.symlinkSync(existingTarget, jeoBin);
    const staleJoc = writeText(path.join(binDir, "joc"), "legacy-joc");

    const attemptedCmds: string[][] = [];
    const res = runIsolatedBunUpdate("9.9.9", {
      env: { HOME: home },
      platform: "darwin",
      which: () => "bun",
      spawn: cmd => {
        attemptedCmds.push(cmd);
        return { success: false, exitCode: 1 };
      },
    });

    expect(res.success).toBe(false);
    expect(res.stderr).toContain("exited with code 1");
    expect(res.manual?.[0]).toContain(`BUN_INSTALL_GLOBAL_DIR="${path.join(home, ".jeo", "global")}"`);
    // Tried both --no-cache and --force --no-cache before giving up.
    expect(attemptedCmds.length).toBe(2);
    expect(attemptedCmds[1]).toContain("--force");

    // Existing jeo symlink (and even joc, since step 2 never ran) remain untouched.
    expect(fs.lstatSync(jeoBin).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(jeoBin)).toBe(existingTarget);
    expect(fs.existsSync(staleJoc)).toBe(true);
  });

  test("on win32: sweeps stale backups, rotates jeo.exe -> jeo.exe.jeo-bak.<pid>, cleans up on success, and restores on link failure", () => {
    bridgeWin32PathsOnPosix();
    const home = mkDir("home-win32");
    const binDir = path.join(home, ".bun", "bin");
    const env: EnvRecord = { USERPROFILE: home };

    // Case A: Successful link rotates jeo.exe to jeo.exe.jeo-bak.<pid> during link, sweeps stale backups, and removes backup after link.
    const liveExe = writeText(path.join(binDir, "jeo.exe"), "old-win-exe-v1");
    const staleBak = writeText(path.join(binDir, "jeo.exe.jeo-bak.4242"), "ancient-backup");
    let sawBackupDuringLink = false;
    let linkEnvSeen: Record<string, string> | undefined;

    const okRes = runIsolatedBunUpdate("1.5.0", {
      env,
      platform: "win32",
      which: () => "C:\\bun\\bun.exe",
      activeVersion: () => "1.5.0",
      spawn: (cmd, childEnv) => {
        const isStage = cmd.includes("--no-cache");
        if (isStage) {
          // Sweep already happened before staging.
          expect(fs.existsSync(staleBak)).toBe(false);
          writeJson(path.join(childEnv.BUN_INSTALL_GLOBAL_DIR!, "node_modules", JEO_PACKAGE, "package.json"), {
            name: JEO_PACKAGE,
            version: "1.5.0",
          });
          return { success: true, exitCode: 0 };
        }
        // During Step 2 link, existing jeo.exe must already be moved aside to .jeo-bak.<pid>.
        linkEnvSeen = childEnv;
        const bakName = `jeo.exe.jeo-bak.${process.pid}`;
        sawBackupDuringLink = fs.existsSync(path.join(binDir, bakName)) && !fs.existsSync(liveExe);
        writeText(liveExe, "new-win-exe-v1.5.0");
        return { success: true, exitCode: 0 };
      },
    });

    expect(okRes.success).toBe(true);
    expect(sawBackupDuringLink).toBe(true);
    expect(linkEnvSeen?.BUN_INSTALL_BIN).toBe(binDir);
    expect(linkEnvSeen?.BUN_INSTALL_GLOBAL_DIR).toBe(path.join(home, ".jeo", "global"));
    expect(fs.readFileSync(liveExe, "utf8")).toBe("new-win-exe-v1.5.0");
    expect(fs.existsSync(path.join(binDir, `jeo.exe.jeo-bak.${process.pid}`))).toBe(false);

    // Case B: Link failure restores jeo.exe.jeo-bak.<pid> back to jeo.exe.
    writeText(liveExe, "stable-win-exe-v1.5.0");
    const staleBeforeFail = writeText(path.join(binDir, "joc.exe.jeo-bak.777"), "stale-joc-bak");

    const failRes = runIsolatedBunUpdate("2.0.0", {
      env,
      platform: "win32",
      which: () => "C:\\bun\\bun.exe",
      spawn: (cmd, childEnv) => {
        if (cmd.includes("--no-cache")) {
          writeJson(path.join(childEnv.BUN_INSTALL_GLOBAL_DIR!, "node_modules", JEO_PACKAGE, "package.json"), {
            name: JEO_PACKAGE,
            version: "2.0.0",
          });
          return { success: true, exitCode: 0 };
        }
        // Simulate partial/failed link that failed to produce a working shim.
        return { success: false, exitCode: 1 };
      },
    });

    expect(failRes.success).toBe(false);
    expect(failRes.stderr).toContain("exited with code 1");
    expect(fs.existsSync(staleBeforeFail)).toBe(false);
    expect(fs.existsSync(liveExe)).toBe(true);
    expect(fs.readFileSync(liveExe, "utf8")).toBe("stable-win-exe-v1.5.0");
    expect(fs.existsSync(path.join(binDir, `jeo.exe.jeo-bak.${process.pid}`))).toBe(false);

    // Case C: Thrown error during link also restores jeo.exe from jeo.exe.jeo-bak.<pid>.
    const throwRes = runIsolatedBunUpdate("2.0.1", {
      env,
      platform: "win32",
      which: () => "C:\\bun\\bun.exe",
      spawn: (cmd, childEnv) => {
        if (cmd.includes("--no-cache")) {
          writeJson(path.join(childEnv.BUN_INSTALL_GLOBAL_DIR!, "node_modules", JEO_PACKAGE, "package.json"), {
            name: JEO_PACKAGE,
            version: "2.0.1",
          });
          return { success: true, exitCode: 0 };
        }
        throw new Error("spawn EBUSY");
      },
    });
    expect(throwRes.success).toBe(false);
    expect(throwRes.stderr).toContain("spawn EBUSY");
    expect(fs.readFileSync(liveExe, "utf8")).toBe("stable-win-exe-v1.5.0");
    expect(fs.existsSync(path.join(binDir, `jeo.exe.jeo-bak.${process.pid}`))).toBe(false);
  });

  test("fails cleanly when activeVersion() still reports an older version", () => {
    const home = mkDir("home-stale-active");
    const spawnOk = (_cmd: string[], childEnv: Record<string, string>): SpawnOutcome => {
      const g = childEnv.BUN_INSTALL_GLOBAL_DIR!;
      writeJson(path.join(g, "node_modules", JEO_PACKAGE, "package.json"), {
        name: JEO_PACKAGE,
        version: "2.0.0",
      });
      writeText(path.join(g, "node_modules", JEO_PACKAGE, "src", "cli.ts"), "#!/usr/bin/env bun\n", 0o755);
      return { success: true, exitCode: 0 };
    };

    const res = runIsolatedBunUpdate("2.0.0", {
      env: { HOME: home },
      platform: "darwin",
      which: () => "bun",
      spawn: spawnOk,
      activeVersion: () => "1.0.0",
    });

    expect(res.success).toBe(false);
    expect(res.stderr).toContain("active 'jeo' is still 1.0.0");
    expect(res.manual?.[0]).toContain(path.join(home, ".bun", "bin"));

    // activeVersion() returning null (e.g. unreadable shim) trusts the install exit 0.
    const nullActiveRes = runIsolatedBunUpdate("2.0.0", {
      env: { HOME: home },
      platform: "darwin",
      which: () => "bun",
      spawn: spawnOk,
      activeVersion: () => null,
    });
    expect(nullActiveRes.success).toBe(true);
  });

  test("real Bun.spawnSync bun add -g installs and upgrades v1.0.0 -> v2.0.0 in isolatedGlobal while sibling shared-global with jeopi-cli + bun.lock stays byte-identical", () => {
    const sandbox = mkDir("real-bun-sandbox");
    const bunInstallCache = path.join(sandbox, "bun-home");
    const sharedGlobal = path.join(sandbox, "shared-global");
    const sharedBin = path.join(sandbox, "shared-bin");
    const isolatedGlobal = path.join(sandbox, "isolated-global");
    const stagingBin = path.join(isolatedGlobal, "bin");
    const jeopiPkgDir = path.join(sandbox, "jeopi-pkg");
    const localPkgDir = path.join(sandbox, "jeo-local-pkg");

    fs.mkdirSync(bunInstallCache, { recursive: true });
    fs.mkdirSync(sharedGlobal, { recursive: true });
    fs.mkdirSync(sharedBin, { recursive: true });
    fs.mkdirSync(isolatedGlobal, { recursive: true });
    fs.mkdirSync(stagingBin, { recursive: true });

    // 1. Populate sibling shared-global with jeopi-cli + a real bun.lock generated by Bun.
    writeJson(path.join(jeopiPkgDir, "package.json"), {
      name: "jeopi-cli",
      version: "16.6.18",
      bin: { jeopi: "./bin.js" },
    });
    writeText(path.join(jeopiPkgDir, "bin.js"), "#!/usr/bin/env bun\nconsole.log('jeopi 16.6.18');\n", 0o755);

    const bunExe = resolveBunExecutable(process.env, process.platform);
    const seedShared = Bun.spawnSync([bunExe, "add", "-g", jeopiPkgDir], {
      env: {
        ...process.env,
        HOME: sandbox,
        BUN_INSTALL: bunInstallCache,
        BUN_INSTALL_GLOBAL_DIR: sharedGlobal,
        BUN_INSTALL_BIN: sharedBin,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(seedShared.success).toBe(true);

    const sharedPkgJsonPath = path.join(sharedGlobal, "package.json");
    const sharedLockPath = path.join(sharedGlobal, "bun.lock");
    expect(fs.existsSync(sharedPkgJsonPath)).toBe(true);
    expect(fs.existsSync(sharedLockPath)).toBe(true);

    const beforeSharedPkgBytes = fs.readFileSync(sharedPkgJsonPath);
    const beforeSharedLockBytes = fs.readFileSync(sharedLockPath);
    const beforeSharedHash = hashTree(sharedGlobal);
    const beforeSharedBinHash = hashTree(sharedBin);

    // 2. Install local jeo-code v1.0.0 into isolatedGlobal via real `bun add -g`.
    writeJson(path.join(localPkgDir, "package.json"), {
      name: JEO_PACKAGE,
      version: "1.0.0",
      bin: { jeo: "./src/cli.ts" },
    });
    writeText(path.join(localPkgDir, "src", "cli.ts"), "#!/usr/bin/env bun\nconsole.log('1.0.0');\n", 0o755);

    const installV1 = Bun.spawnSync([bunExe, "add", "-g", localPkgDir], {
      env: {
        ...process.env,
        HOME: sandbox,
        BUN_INSTALL: bunInstallCache,
        BUN_INSTALL_GLOBAL_DIR: isolatedGlobal,
        BUN_INSTALL_BIN: stagingBin,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(installV1.success).toBe(true);

    const installedPkgPath = path.join(isolatedGlobal, "node_modules", JEO_PACKAGE, "package.json");
    const v1Manifest = JSON.parse(fs.readFileSync(installedPkgPath, "utf8")) as { version: string };
    expect(v1Manifest.version).toBe("1.0.0");

    // 3. Upgrade local jeo-code to v2.0.0 in isolatedGlobal via real `bun add -g`.
    writeJson(path.join(localPkgDir, "package.json"), {
      name: JEO_PACKAGE,
      version: "2.0.0",
      bin: { jeo: "./src/cli.ts" },
    });
    writeText(path.join(localPkgDir, "src", "cli.ts"), "#!/usr/bin/env bun\nconsole.log('2.0.0');\n", 0o755);

    const installV2 = Bun.spawnSync([bunExe, "add", "-g", localPkgDir, "--force"], {
      env: {
        ...process.env,
        HOME: sandbox,
        BUN_INSTALL: bunInstallCache,
        BUN_INSTALL_GLOBAL_DIR: isolatedGlobal,
        BUN_INSTALL_BIN: stagingBin,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(installV2.success).toBe(true);

    const v2Manifest = JSON.parse(fs.readFileSync(installedPkgPath, "utf8")) as { version: string };
    expect(v2Manifest.version).toBe("2.0.0");

    // 4. Sibling shared-global (package.json, bun.lock, node_modules/jeopi-cli) & shared-bin remain byte-identical.
    expect(fs.readFileSync(sharedPkgJsonPath).equals(beforeSharedPkgBytes)).toBe(true);
    expect(fs.readFileSync(sharedLockPath).equals(beforeSharedLockBytes)).toBe(true);
    expect(hashTree(sharedGlobal)).toBe(beforeSharedHash);
    expect(hashTree(sharedBin)).toBe(beforeSharedBinHash);
  });
});

describe("update command & installer script integration", () => {
  test("defaultDeps.sharedGlobal in src/commands/update.ts is undefined", () => {
    expect(defaultDeps.sharedGlobal).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("scripts/install.sh --dry-run emits BUN_INSTALL_GLOBAL_DIR= pointing to .jeo/global", () => {
    const repoRoot = path.resolve(import.meta.dir, "..");
    const installSh = path.join(repoRoot, "scripts", "install.sh");
    const fakeHome = mkDir("sh-dry-run-home");

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    childEnv.HOME = fakeHome;
    delete childEnv.JEO_CONFIG_DIR;
    delete childEnv.JEO_GLOBAL_DIR;

    const proc = Bun.spawnSync(["sh", installSh, "--dry-run"], {
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);

    expect(proc.success).toBe(true);
    expect(stderr).toBe("");
    const expectedGlobal = path.join(fakeHome, ".jeo", "global");
    expect(stdout).toContain(`BUN_INSTALL_GLOBAL_DIR=${expectedGlobal}`);
    expect(stdout).toContain(`BUN_INSTALL_BIN=${path.join(expectedGlobal, "bin")}`);
  });

  test("scripts/install.ps1 and scripts/uninstall.ps1 exist with isolated install and .jeo-bak. shim rotation logic", () => {
    const repoRoot = path.resolve(import.meta.dir, "..");
    const installPs1Path = path.join(repoRoot, "scripts", "install.ps1");
    const uninstallPs1Path = path.join(repoRoot, "scripts", "uninstall.ps1");

    expect(fs.existsSync(installPs1Path)).toBe(true);
    expect(fs.existsSync(uninstallPs1Path)).toBe(true);

    const installPs1 = fs.readFileSync(installPs1Path, "utf8");
    const uninstallPs1 = fs.readFileSync(uninstallPs1Path, "utf8");

    expect(installPs1).toContain("Invoke-IsolatedBunAdd");
    expect(installPs1).toContain("BUN_INSTALL_GLOBAL_DIR");
    expect(installPs1).toContain("BUN_INSTALL_BIN");
    expect(installPs1).toContain(".jeo-bak.");
    expect(installPs1).toContain('Join-Path $JeoConfigDir "global"');

    expect(uninstallPs1).toContain("jeo.exe");
    expect(uninstallPs1).toContain("$JeoGlobalDir");
    expect(uninstallPs1).not.toContain("jeopi-cli");
  });
});
