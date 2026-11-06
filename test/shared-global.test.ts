import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  candidateGlobalDir,
  checkLockCoverage,
  classifyActiveInstall,
  detectInstallOrigin,
  diffInstalled,
  formatChangeLine,
  formatRestoreCommands,
  formatUnchangedSummary,
  isUnder,
  listJeoOnPath,
  locateSharedGlobal,
  readManifestDeps,
  resolveNpmGlobalRoot,
  snapshotInstalled,
  type EnvLike,
  type ExternalChange,
  type InstalledSnapshot,
} from "../src/util/shared-global";

// Every fixture lives under this root; the real ~/.bun and ~/.npmrc are never read or written.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jeo-shared-global-test-")));
let counter = 0;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function mk(label: string): string {
  const dir = path.join(ROOT, `${label}-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeText(file: string, text: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

function writeJson(file: string, value: unknown): string {
  return writeText(file, JSON.stringify(value, null, 2));
}

function writeExec(file: string, text = "#!/bin/sh\nexit 0\n"): string {
  return writeText(file, text, 0o755);
}

function installPackage(globalDir: string, name: string, pkg: Record<string, unknown>): void {
  writeJson(path.join(globalDir, "node_modules", name, "package.json"), { name, ...pkg });
}

// A trimmed excerpt of a real ~/.bun/install/global/bun.lock: JSONC with trailing commas and blank lines,
// the root workspace under "" mirroring the manifest, scoped bare keys, `parent/name` nested copies and
// sha512 integrity strings containing slashes. Integrity strings and entry shapes are verbatim; only the
// metadata objects are shortened.
const REAL_LOCK_EXCERPT = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "dependencies": {
        "@gajae-code/coding-agent": "0.18.5",
        "gajae-code": "^0.6.1",
        "jeo-code": "0.12.21",
        "jeopi-cli": "16.6.18",
        "oh-my-hermes": "^3.0.2",
      },
    },
  },
  "packages": {
    "@ark/util": ["@ark/util@0.56.2", "", {}, "sha512-9kU2sUE38FZEGG7l3hamYMBieLYEJh2L1mrYD2eXpT+78EnQSV1bhjxJhnxGBMSTbtwpBSDNSK+K60WvaI/DTQ=="],

    "@gajae-code/coding-agent": ["@gajae-code/coding-agent@0.18.5", "", { "dependencies": { "@agentclientprotocol/sdk": "1.3.0", "chalk": "^5.6.2" }, "bin": { "gjc": "bin/gajaessi.js" } }, "sha512-PR/i1yunDfdhZbr/L0CJLDMBz/UqJkxE9dWNqJt9V05UoXfS/NqPoZCxA81BzrU0yAzAcLGrV1l9Ez7HbDODlQ=="],

    "gajae-code": ["gajae-code@0.6.1", "", { "dependencies": { "@gajae-code/coding-agent": "0.6.1" }, "bin": { "gjc": "bin/gjc.js" } }, "sha512-KqKLjraALMXHaP4xAmx7oQel4yB9aWH0CEl6S9ieJfqameJSVqJoamE6afRptICT9musY8+qWuVJqAX1opA6mw=="],

    "jeo-code": ["jeo-code@0.12.21", "", { "dependencies": { "chalk": "^5.3.0", "js-tiktoken": "^1.0.21", "playwright": "^1.61.0", "typescript": "^5.6.3", "zod": "^3.24.1" }, "bin": { "jeo": "src/cli.ts" } }, "sha512-Tu6NYGmHDIIJA1fu45ogbtmBvaNMgAjqD76nLPOIBzTBAD36whlxUcncYPLiusi72FhbxjCCTOkrvGDeqB7zVg=="],

    "jeopi-cli": ["jeopi-cli@16.6.18", "", { "dependencies": { "@agentclientprotocol/sdk": "0.25.0" }, "bin": { "jeopi": "dist/cli.js" } }, "sha512-ApjO1C16zmds4UmTjSfAOfr+rUqVQJleKilgqd8c8YSCKa0p/JcuW1W+idRcO/LDKBbDHKwplV90gvO3DCxzDw=="],

    "gajae-code/@gajae-code/coding-agent": ["@gajae-code/coding-agent@0.6.1", "", { "dependencies": { "@agentclientprotocol/sdk": "0.21.0" } }, "sha512-4GjtrJ7q5LsvX73rajtfZcg8sSw/8hVvmBssUvXEUgJC4iBoDelX9xMg8syX9u8omNstwUvgAXaa3c6icOHk2w=="],

    "jeo-code/zod": ["zod@3.25.76", "", {}, "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ=="],
  }
}
`;

function lockWith(packages: Record<string, unknown>): string {
  return JSON.stringify({ lockfileVersion: 1, workspaces: { "": { dependencies: {} } }, packages }, null, 2);
}

/** Parses a bun.lock (JSONC), lets `mutate` edit its `packages` map, and writes it back as plain JSON. */
function rewriteLock(lockPath: string, mutate: (packages: Record<string, unknown>) => void): void {
  const doc = Bun.JSONC.parse(fs.readFileSync(lockPath, "utf8"));
  if (doc === null || typeof doc !== "object" || !("packages" in doc) || doc.packages === null || typeof doc.packages !== "object") throw new Error(`no packages map in ${lockPath}`);
  const packages = Object.fromEntries(Object.entries(doc.packages));
  mutate(packages);
  writeText(lockPath, JSON.stringify({ ...doc, packages }, null, 2));
}

describe("checkLockCoverage", () => {
  test("a trimmed real-format bun.lock excerpt covers every dependency that has a bare own key", () => {
    const dir = mk("lock-real");
    writeText(path.join(dir, "bun.lock"), REAL_LOCK_EXCERPT);
    const result = checkLockCoverage(dir, ["@gajae-code/coding-agent", "gajae-code", "jeopi-cli"]);
    expect(result).toEqual({ status: "ok", uncovered: [], path: path.join(dir, "bun.lock") });
  });

  test("a name that only exists as a nested `parent/name` key is uncovered", () => {
    const dir = mk("lock-nested");
    writeText(path.join(dir, "bun.lock"), lockWith({ "gajae-code/@gajae-code/coding-agent": ["@gajae-code/coding-agent@0.6.1", "", {}, "sha512-x"] }));
    const result = checkLockCoverage(dir, ["@gajae-code/coding-agent"]);
    expect(result.status).toBe("incomplete");
    expect(result.uncovered).toEqual(["@gajae-code/coding-agent"]);
  });

  test("a name that only appears in workspaces or in another entry's dependencies is uncovered", () => {
    const dir = mk("lock-substring");
    // oh-my-hermes is in the root workspace of the excerpt but has no entry in `packages`.
    writeText(path.join(dir, "bun.lock"), REAL_LOCK_EXCERPT);
    expect(checkLockCoverage(dir, ["oh-my-hermes"]).uncovered).toEqual(["oh-my-hermes"]);
    // @agentclientprotocol/sdk appears inside other entries' dependency maps only.
    expect(checkLockCoverage(dir, ["@agentclientprotocol/sdk", "chalk"])).toMatchObject({ status: "incomplete", uncovered: ["@agentclientprotocol/sdk", "chalk"] });
  });

  test("uncovered keeps manifest order", () => {
    const dir = mk("lock-order");
    writeText(path.join(dir, "bun.lock"), lockWith({ "gajae-code": ["gajae-code@0.6.1", "", {}, "sha512-x"] }));
    const result = checkLockCoverage(dir, ["zeta", "gajae-code", "alpha"]);
    expect(result.status).toBe("incomplete");
    expect(result.uncovered).toEqual(["zeta", "alpha"]);
  });

  test("an entry must be a tuple whose first element is a non-empty string; tuple length is not gated", () => {
    const dir = mk("lock-tuple");
    writeText(
      path.join(dir, "bun.lock"),
      lockWith({
        twoTuple: ["twoTuple@file:twoTuple", {}],
        fourTuple: ["fourTuple@1.0.0", "", {}, "sha512-x"],
        alias: ["real-name@2.0.0", "", {}, "sha512-y"],
        emptyFirst: ["", "", {}, "sha512-z"],
        notAnArray: { resolved: "notAnArray@1.0.0" },
        nonStringFirst: [42, "", {}],
        emptyTuple: [],
      }),
    );
    const result = checkLockCoverage(dir, ["twoTuple", "fourTuple", "alias", "emptyFirst", "notAnArray", "nonStringFirst", "emptyTuple", "absent"]);
    expect(result.uncovered).toEqual(["emptyFirst", "notAnArray", "nonStringFirst", "emptyTuple", "absent"]);
  });

  test("only own keys count: names on Object.prototype are not covered by inheritance", () => {
    const dir = mk("lock-proto");
    writeText(path.join(dir, "bun.lock"), lockWith({ other: ["other@1.0.0", "", {}, "sha512-x"] }));
    expect(checkLockCoverage(dir, ["constructor", "toString", "__proto__", "other"]).uncovered).toEqual(["constructor", "toString", "__proto__"]);
  });

  test("a missing, unreadable, malformed, empty or packages-less lock is reported with its status", () => {
    const missing = mk("lock-missing");
    expect(checkLockCoverage(missing, ["a"])).toEqual({ status: "missing", uncovered: ["a"], path: path.join(missing, "bun.lock"), detail: undefined, legacyBinaryLock: false });

    const unreadable = mk("lock-eisdir");
    fs.mkdirSync(path.join(unreadable, "bun.lock"));
    const unreadableResult = checkLockCoverage(unreadable, ["a", "b"]);
    expect(unreadableResult.status).toBe("unreadable");
    expect(unreadableResult.uncovered).toEqual(["a", "b"]);
    expect(unreadableResult.detail).toContain("EISDIR");

    const corrupt = mk("lock-corrupt");
    writeText(path.join(corrupt, "bun.lock"), "{ this is not json");
    expect(checkLockCoverage(corrupt, ["a"]).status).toBe("unreadable");

    const notObject = mk("lock-packages-array");
    writeText(path.join(notObject, "bun.lock"), JSON.stringify({ lockfileVersion: 1, packages: [] }));
    expect(checkLockCoverage(notObject, ["a"])).toMatchObject({ status: "unreadable", detail: "no packages map", uncovered: ["a"] });

    const noPackages = mk("lock-no-packages");
    writeText(path.join(noPackages, "bun.lock"), JSON.stringify({ lockfileVersion: 1 }));
    expect(checkLockCoverage(noPackages, ["a"]).status).toBe("unreadable");

    const topLevelArray = mk("lock-top-array");
    writeText(path.join(topLevelArray, "bun.lock"), "[]");
    expect(checkLockCoverage(topLevelArray, ["a"]).status).toBe("unreadable");

    const nullDoc = mk("lock-null");
    writeText(path.join(nullDoc, "bun.lock"), "null");
    expect(checkLockCoverage(nullDoc, ["a"]).status).toBe("unreadable");

    const zeroByte = mk("lock-zero");
    writeText(path.join(zeroByte, "bun.lock"), "");
    expect(checkLockCoverage(zeroByte, ["a"])).toMatchObject({ status: "unreadable", uncovered: ["a"] });
  });

  test("a bun.lockb-only directory is missing and flags the legacy binary lock", () => {
    const dir = mk("lock-binary");
    writeText(path.join(dir, "bun.lockb"), "#!/usr/bin/env bun\n");
    const result = checkLockCoverage(dir, ["a"]);
    expect(result.status).toBe("missing");
    expect(result.legacyBinaryLock).toBe(true);
    expect(result.uncovered).toEqual(["a"]);
    // bun.lockb is never parsed: a text bun.lock next to it decides on its own.
    writeText(path.join(dir, "bun.lock"), lockWith({ a: ["a@1.0.0", "", {}, "sha512-x"] }));
    expect(checkLockCoverage(dir, ["a"]).status).toBe("ok");
  });

  test("a jeo-code-only manifest (no external names) is not-required with no, corrupt or unreadable lock", () => {
    const none = mk("lock-nr-none");
    expect(checkLockCoverage(none, [])).toEqual({ status: "not-required", uncovered: [], path: path.join(none, "bun.lock") });

    const corrupt = mk("lock-nr-corrupt");
    writeText(path.join(corrupt, "bun.lock"), "{{{");
    expect(checkLockCoverage(corrupt, []).status).toBe("not-required");

    const directory = mk("lock-nr-dir");
    fs.mkdirSync(path.join(directory, "bun.lock"));
    expect(checkLockCoverage(directory, []).status).toBe("not-required");
  });

  test("contract: a bun.lock written by the running bun is read as covered, and removing a key makes it incomplete", () => {
    const dir = mk("lock-contract");
    writeJson(path.join(dir, "a", "package.json"), { name: "a", version: "1.0.0" });
    writeJson(path.join(dir, "b", "package.json"), { name: "@s/b", version: "2.0.0", dependencies: { a: "file:../a" } });
    writeJson(path.join(dir, "package.json"), { name: "contract-root", version: "0.0.0", dependencies: { a: "file:./a", "@s/b": "file:./b" } });
    // Fresh HOME / BUN_INSTALL / cache: nothing from the real ~/.bun or its cache is read or written, and
    // file: dependencies never touch a registry, so this runs offline.
    const env = { ...process.env, HOME: mk("lock-contract-home"), BUN_INSTALL: mk("lock-contract-bun"), BUN_INSTALL_CACHE_DIR: mk("lock-contract-cache") };
    const run = Bun.spawnSync([process.execPath, "install", "--no-progress"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`bun install failed (${run.exitCode}): ${run.stderr.toString()}${run.stdout.toString()}`);

    const lockPath = path.join(dir, "bun.lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(checkLockCoverage(dir, ["a", "@s/b"])).toEqual({ status: "ok", uncovered: [], path: lockPath });

    rewriteLock(lockPath, packages => delete packages["@s/b"]);
    expect(checkLockCoverage(dir, ["a", "@s/b"])).toMatchObject({ status: "incomplete", uncovered: ["@s/b"] });

    // Removing the bare `a` key leaves any nested `parent/a` copy behind; whole-key matching must not count it.
    rewriteLock(lockPath, packages => {
      packages["@s/b"] = ["@s/b@file:b", { dependencies: { a: "file:../a" } }];
      delete packages.a;
    });
    expect(checkLockCoverage(dir, ["a", "@s/b"])).toMatchObject({ status: "incomplete", uncovered: ["a"] });
  });
});

describe("candidateGlobalDir", () => {
  test("resolves BUN_INSTALL_GLOBAL_DIR, then BUN_INSTALL, then $HOME/.bun", () => {
    expect(candidateGlobalDir({ BUN_INSTALL_GLOBAL_DIR: "/g", BUN_INSTALL: "/b" }, "/h", "linux")).toBe("/g");
    expect(candidateGlobalDir({ BUN_INSTALL: "/b" }, "/h", "darwin")).toBe("/b/install/global");
    expect(candidateGlobalDir({}, "/h", "linux")).toBe("/h/.bun/install/global");
  });

  test("empty overrides count as unset, a relative override resolves against the cwd, and no base gives null", () => {
    expect(candidateGlobalDir({ BUN_INSTALL_GLOBAL_DIR: "", BUN_INSTALL: "" }, "/h", "linux")).toBe("/h/.bun/install/global");
    expect(candidateGlobalDir({ BUN_INSTALL_GLOBAL_DIR: "rel/dir" }, undefined, "linux")).toBe(path.resolve("rel/dir"));
    expect(candidateGlobalDir({}, undefined, "linux")).toBeNull();
    expect(candidateGlobalDir({ BUN_INSTALL: "/b" }, undefined, "linux")).toBe("/b/install/global");
  });

  test("win32 is never inspected", () => {
    expect(candidateGlobalDir({ BUN_INSTALL: "C:\\bun" }, "C:\\Users\\me", "win32")).toBeNull();
  });
});

describe("locateSharedGlobal", () => {
  function bunHome(label: string): { home: string; globalDir: string } {
    const home = mk(label);
    const globalDir = path.join(home, ".bun", "install", "global");
    writeJson(path.join(globalDir, "package.json"), { dependencies: { "jeo-code": "0.1.0" } });
    return { home, globalDir };
  }

  test("finds the default global dir under $HOME/.bun and returns its realpath", () => {
    const { home, globalDir } = bunHome("locate-ok");
    expect(locateSharedGlobal({ env: { HOME: home } })).toEqual({ ok: true, dir: globalDir });
    // A symlinked home resolves to the real directory.
    const link = path.join(mk("locate-link"), "home-link");
    fs.symlinkSync(home, link);
    expect(locateSharedGlobal({ env: { HOME: link } })).toEqual({ ok: true, dir: globalDir });
  });

  test("honours BUN_INSTALL and BUN_INSTALL_GLOBAL_DIR over the home directory", () => {
    const { home } = bunHome("locate-env-home");
    const install = mk("locate-env-install");
    writeJson(path.join(install, "install", "global", "package.json"), { dependencies: {} });
    expect(locateSharedGlobal({ env: { HOME: home, BUN_INSTALL: install } })).toEqual({ ok: true, dir: path.join(install, "install", "global") });
    const explicit = mk("locate-env-explicit");
    writeJson(path.join(explicit, "package.json"), {});
    expect(locateSharedGlobal({ env: { HOME: home, BUN_INSTALL: install, BUN_INSTALL_GLOBAL_DIR: explicit } })).toEqual({ ok: true, dir: explicit });
  });

  test("an explicit home option overrides HOME", () => {
    const { home, globalDir } = bunHome("locate-home-option");
    expect(locateSharedGlobal({ env: { HOME: "/nonexistent-home" }, home })).toEqual({ ok: true, dir: globalDir });
  });

  test("windows is skipped before anything is read", () => {
    const { home } = bunHome("locate-win");
    expect(locateSharedGlobal({ env: { HOME: home }, platform: "win32" })).toEqual({ ok: false, reason: "windows" });
  });

  test("no home and no override is no-home", () => {
    expect(locateSharedGlobal({ env: {} })).toEqual({ ok: false, reason: "no-home" });
    expect(locateSharedGlobal({ env: { HOME: "" } })).toEqual({ ok: false, reason: "no-home" });
  });

  test("a directory without package.json is no-bun-global", () => {
    const home = mk("locate-none");
    expect(locateSharedGlobal({ env: { HOME: home } })).toMatchObject({ ok: false, reason: "no-bun-global" });
    // The global dir exists but holds no manifest.
    fs.mkdirSync(path.join(home, ".bun", "install", "global"), { recursive: true });
    expect(locateSharedGlobal({ env: { HOME: home } })).toMatchObject({ ok: false, reason: "no-bun-global" });
  });

  test("an unparsable, non-object or unreadable package.json is manifest-unreadable with a detail", () => {
    const garbage = mk("locate-garbage");
    writeText(path.join(garbage, ".bun", "install", "global", "package.json"), "{ not json");
    const result = locateSharedGlobal({ env: { HOME: garbage } });
    expect(result).toMatchObject({ ok: false, reason: "manifest-unreadable" });
    expect(result.ok === false && typeof result.detail === "string" && result.detail.length > 0).toBe(true);

    const array = mk("locate-array");
    writeText(path.join(array, ".bun", "install", "global", "package.json"), "[]");
    expect(locateSharedGlobal({ env: { HOME: array } })).toMatchObject({ ok: false, reason: "manifest-unreadable" });

    const directory = mk("locate-manifest-dir");
    fs.mkdirSync(path.join(directory, ".bun", "install", "global", "package.json"), { recursive: true });
    expect(locateSharedGlobal({ env: { HOME: directory } })).toMatchObject({ ok: false, reason: "manifest-unreadable" });
  });

  test("a globalDir key in ~/.bunfig.toml or $XDG_CONFIG_HOME/.bunfig.toml skips with bunfig-global-dir", () => {
    const { home } = bunHome("locate-bunfig");
    writeText(path.join(home, ".bunfig.toml"), '[install]\nglobalDir = "/somewhere/else"\n');
    expect(locateSharedGlobal({ env: { HOME: home } })).toEqual({ ok: false, reason: "bunfig-global-dir", detail: path.join(home, ".bunfig.toml") });

    const xdg = mk("locate-xdg");
    const { home: home2 } = bunHome("locate-bunfig-xdg");
    writeText(path.join(xdg, ".bunfig.toml"), "[install]\n  globalDir = '/x'\n");
    expect(locateSharedGlobal({ env: { HOME: home2, XDG_CONFIG_HOME: xdg } })).toEqual({ ok: false, reason: "bunfig-global-dir", detail: path.join(xdg, ".bunfig.toml") });
  });

  test("a bunfig without a live globalDir key does not skip", () => {
    const { home, globalDir } = bunHome("locate-bunfig-benign");
    writeText(path.join(home, ".bunfig.toml"), '[install]\nregistry = "https://registry.npmjs.org"\n# globalDir = "/commented/out"\nglobalDirectory = "not the key"\n');
    expect(locateSharedGlobal({ env: { HOME: home } })).toEqual({ ok: true, dir: globalDir });
  });

  test("bunfig globalDir wins even when BUN_INSTALL_GLOBAL_DIR is set (fail safe)", () => {
    const { home } = bunHome("locate-bunfig-wins");
    writeText(path.join(home, ".bunfig.toml"), 'globalDir = "/elsewhere"\n');
    expect(locateSharedGlobal({ env: { HOME: home, BUN_INSTALL_GLOBAL_DIR: path.join(home, ".bun", "install", "global") } })).toMatchObject({ ok: false, reason: "bunfig-global-dir" });
  });

  test("a compiled binary is not a skip reason: the directory is located exactly as for a bun install", () => {
    const { home, globalDir } = bunHome("locate-compiled");
    const exe = "/opt/jeo/jeo";
    expect(locateSharedGlobal({ env: { HOME: home }, entry: exe, execPath: exe })).toEqual({ ok: true, dir: globalDir });
    expect(locateSharedGlobal({ env: { HOME: home }, entry: "/$bunfs/root/jeo", execPath: exe })).toEqual({ ok: true, dir: globalDir });
  });

  test("locating never modifies the directory", () => {
    const { home } = bunHome("locate-readonly");
    const before = fs.readdirSync(path.join(home, ".bun", "install", "global")).sort();
    locateSharedGlobal({ env: { HOME: home } });
    expect(fs.readdirSync(path.join(home, ".bun", "install", "global")).sort()).toEqual(before);
  });
});

describe("readManifestDeps", () => {
  test("lists names in manifest order with specs, and external excludes jeo-code", () => {
    const dir = mk("manifest-ok");
    writeText(
      path.join(dir, "package.json"),
      '{\n  "dependencies": {\n    "@gajae-code/coding-agent": "0.18.5",\n    "gajae-code": "^0.6.1",\n    "jeo-code": "0.12.21",\n    "jeopi-cli": "16.6.18",\n  },\n}\n',
    );
    const result = readManifestDeps(dir);
    expect(result).toEqual({
      ok: true,
      deps: {
        names: ["@gajae-code/coding-agent", "gajae-code", "jeo-code", "jeopi-cli"],
        specs: { "@gajae-code/coding-agent": "0.18.5", "gajae-code": "^0.6.1", "jeo-code": "0.12.21", "jeopi-cli": "16.6.18" },
        external: ["@gajae-code/coding-agent", "gajae-code", "jeopi-cli"],
        ignored: [],
      },
    });
  });

  test("a jeo-code-only manifest has no external names", () => {
    const dir = mk("manifest-self");
    writeJson(path.join(dir, "package.json"), { dependencies: { "jeo-code": "0.1.0" } });
    const result = readManifestDeps(dir);
    expect(result.ok && result.deps.external).toEqual([]);
  });

  test("an absent or null dependencies field means zero dependencies", () => {
    const absent = mk("manifest-absent");
    writeJson(path.join(absent, "package.json"), { name: "x" });
    expect(readManifestDeps(absent)).toEqual({ ok: true, deps: { names: [], specs: {}, external: [], ignored: [] } });
    const nul = mk("manifest-null");
    writeText(path.join(nul, "package.json"), '{"dependencies": null}');
    expect(readManifestDeps(nul)).toEqual({ ok: true, deps: { names: [], specs: {}, external: [], ignored: [] } });
  });

  test("empty names and non-string specs are ignored, not treated as dependencies", () => {
    const dir = mk("manifest-ignored");
    // The "" -> "." shape was written by an older jeopi; no lockfile could ever cover a dependency named "".
    writeText(path.join(dir, "package.json"), '{"dependencies": {"": ".", "a": "1.0.0", "b": 2, "c": null, "d": {"x": 1}, "e": ["1"]}}');
    const result = readManifestDeps(dir);
    expect(result.ok && result.deps).toEqual({ names: ["a"], specs: { a: "1.0.0" }, external: ["a"], ignored: ["", "b", "c", "d", "e"] });
  });

  test("a __proto__ key survives as an own property", () => {
    const dir = mk("manifest-proto");
    writeText(path.join(dir, "package.json"), '{"dependencies": {"__proto__": "1.0.0", "a": "1.0.0"}}');
    const result = readManifestDeps(dir);
    expect(result.ok && Object.hasOwn(result.deps.specs, "__proto__")).toBe(true);
    expect(result.ok && result.deps.names).toEqual(["__proto__", "a"]);
  });

  test("a missing, unparsable or malformed manifest is an error with a message", () => {
    const missing = mk("manifest-missing");
    expect(readManifestDeps(missing)).toMatchObject({ ok: false });
    const garbage = mk("manifest-garbage");
    writeText(path.join(garbage, "package.json"), "{ nope");
    const garbageResult = readManifestDeps(garbage);
    expect(garbageResult.ok).toBe(false);
    expect(!garbageResult.ok && garbageResult.error.length > 0).toBe(true);
    const array = mk("manifest-array-deps");
    writeText(path.join(array, "package.json"), '{"dependencies": ["a"]}');
    expect(readManifestDeps(array)).toEqual({ ok: false, error: "dependencies is not an object" });
    const top = mk("manifest-top-array");
    writeText(path.join(top, "package.json"), "[]");
    expect(readManifestDeps(top).ok).toBe(false);
  });
});

describe("snapshotInstalled and diffInstalled", () => {
  test("reads the installed version of each name, null when absent, unreadable or versionless", () => {
    const dir = mk("snap");
    installPackage(dir, "jeopi-cli", { version: "16.6.18" });
    installPackage(dir, "@scope/pkg", { version: "1.2.3" });
    installPackage(dir, "versionless", { description: "no version" });
    installPackage(dir, "numeric", { version: 7 });
    writeText(path.join(dir, "node_modules", "broken", "package.json"), "{ nope");
    const snapshot = snapshotInstalled(dir, ["jeopi-cli", "@scope/pkg", "versionless", "numeric", "broken", "absent"]);
    expect(snapshot).toEqual({ "jeopi-cli": "16.6.18", "@scope/pkg": "1.2.3", versionless: null, numeric: null, broken: null, absent: null });
  });

  test("jeo-code is never read, and unsafe names are never joined into a path", () => {
    const dir = mk("snap-unsafe");
    installPackage(dir, "jeo-code", { version: "0.12.21" });
    // A package.json that a path-escaping name would reach if it were read.
    writeJson(path.join(dir, "outside", "package.json"), { version: "9.9.9" });
    writeJson(path.join(dir, "node_modules", "package.json"), { version: "8.8.8" });
    const snapshot = snapshotInstalled(dir, ["jeo-code", "../outside", "a/../../outside", path.join(dir, "outside"), ""]);
    expect(snapshot).toEqual({ "jeo-code": null, "../outside": null, "a/../../outside": null, [path.join(dir, "outside")]: null, "": null });
  });

  test("a name missing from `present` reads as null even when installed", () => {
    const dir = mk("snap-present");
    installPackage(dir, "a", { version: "1.0.0" });
    installPackage(dir, "b", { version: "2.0.0" });
    expect(snapshotInstalled(dir, ["a", "b"], new Set(["a"]))).toEqual({ a: "1.0.0", b: null });
  });

  test("a dangling symlink in node_modules reads as null instead of throwing", () => {
    const dir = mk("snap-dangling");
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.symlinkSync(path.join(dir, "does-not-exist"), path.join(dir, "node_modules", "dangling"));
    expect(snapshotInstalled(dir, ["dangling"])).toEqual({ dangling: null });
  });

  test("snapshotting never modifies the directory", () => {
    const dir = mk("snap-readonly");
    installPackage(dir, "a", { version: "1.0.0" });
    const listing = (): string[] => fs.readdirSync(dir, { recursive: true }).map(String).sort();
    const before = listing();
    snapshotInstalled(dir, ["a", "b"]);
    expect(listing()).toEqual(before);
  });

  test("diff reports changed, added and removed packages, never jeo-code, and skips unchanged ones", () => {
    const before: InstalledSnapshot = { "jeopi-cli": "16.6.18", "oh-my-agent": "10.23.2", gone: null, same: "1.0.0", "jeo-code": "0.12.20", "@scope/x": "1.0.0" };
    const after: InstalledSnapshot = { "jeopi-cli": "16.6.19", "oh-my-agent": null, gone: "2.0.0", same: "1.0.0", "jeo-code": "0.12.21", "@scope/x": "1.0.0", extra: "3.0.0", nothing: null };
    expect(diffInstalled(before, after)).toEqual([
      { name: "jeopi-cli", from: "16.6.18", to: "16.6.19" },
      { name: "oh-my-agent", from: "10.23.2", to: null },
      { name: "gone", from: null, to: "2.0.0" },
      { name: "extra", from: null, to: "3.0.0" },
    ]);
  });

  test("diff treats a missing key and a null value alike, and identical snapshots have no changes", () => {
    expect(diffInstalled({ a: null }, {})).toEqual([]);
    expect(diffInstalled({}, { a: null })).toEqual([]);
    expect(diffInstalled({ a: "1.0.0", "@s/b": "2.0.0" }, { a: "1.0.0", "@s/b": "2.0.0" })).toEqual([]);
    expect(diffInstalled({}, {})).toEqual([]);
  });

  test("diff handles scoped names and names that collide with Object.prototype", () => {
    expect(diffInstalled({ "@scope/pkg": "1.0.0" }, { "@scope/pkg": "1.0.1" })).toEqual([{ name: "@scope/pkg", from: "1.0.0", to: "1.0.1" }]);
    const after = Object.fromEntries([["constructor", "1.0.0"]]);
    expect(diffInstalled({}, after)).toEqual([{ name: "constructor", from: null, to: "1.0.0" }]);
    expect(diffInstalled({ constructor: "1.0.0" }, {})).toEqual([{ name: "constructor", from: "1.0.0", to: null }]);
  });
});

describe("formatting", () => {
  test("formatChangeLine prints old -> new with placeholders for absent sides", () => {
    expect(formatChangeLine({ name: "jeopi-cli", from: "16.6.18", to: "16.6.19" })).toBe("jeopi-cli 16.6.18 -> 16.6.19");
    expect(formatChangeLine({ name: "@scope/pkg", from: "1.0.0", to: "1.0.1" })).toBe("@scope/pkg 1.0.0 -> 1.0.1");
    expect(formatChangeLine({ name: "new-dep", from: null, to: "1.0.0" })).toBe("new-dep (not installed) -> 1.0.0");
    expect(formatChangeLine({ name: "oh-my-agent", from: "10.23.2", to: null })).toBe("oh-my-agent 10.23.2 -> (removed)");
  });

  test("formatRestoreCommands installs the old version, removes an added package, and never runs anything", () => {
    const changes: ExternalChange[] = [
      { name: "jeopi-cli", from: "16.6.18", to: "16.6.19" },
      { name: "@gajae-code/coding-agent", from: "0.18.5", to: "0.18.6" },
      { name: "pre-release", from: "1.0.0-beta.2+build.5", to: "1.0.0" },
      { name: "oh-my-agent", from: "10.23.2", to: null },
      { name: "added-dep", from: null, to: "1.0.0" },
    ];
    expect(formatRestoreCommands(changes)).toEqual([
      "bun install -g jeopi-cli@16.6.18",
      "bun install -g @gajae-code/coding-agent@0.18.5",
      "bun install -g pre-release@1.0.0-beta.2+build.5",
      "bun install -g oh-my-agent@10.23.2",
      "bun remove -g added-dep",
    ]);
    expect(formatRestoreCommands([])).toEqual([]);
  });

  test("an unsafe name or version becomes a comment instead of a shell command", () => {
    const lines = formatRestoreCommands([
      { name: "evil;rm -rf ~", from: "1.0.0", to: "1.0.1" },
      { name: "evil\nrm -rf ~", from: null, to: "1.0.1" },
      { name: "UpperCase", from: "1.0.0", to: "1.0.1" },
      { name: "fine", from: "1.0.0; touch /tmp/pwned", to: "1.0.1" },
      { name: "fine2", from: "^1.0.0", to: "1.0.1" },
      { name: "fine3", from: "$(whoami)", to: null },
      { name: "-rf", from: "1.0.0", to: "2.0.0" },
    ]);
    expect(lines).toHaveLength(7);
    for (const line of lines) {
      expect(line.startsWith("# restore ")).toBe(true);
      expect(line).not.toContain("\n");
      expect(line.endsWith(" manually")).toBe(true);
    }
    expect(lines[1]).toBe("# restore evil?rm -rf ~ manually");
    expect(lines[3]).toBe("# restore fine manually");
  });

  test("formatUnchangedSummary lists packages ascending by name, at most three", () => {
    const snapshot: InstalledSnapshot = { "oh-my-hermes": "3.0.2", "gajae-code": "0.6.1", "jeopi-cli": "16.6.18", "@gajae-code/coding-agent": "0.18.5", "oh-my-agent": "10.23.2" };
    expect(formatUnchangedSummary(snapshot)).toBe("shared global unchanged: 5 packages (@gajae-code/coding-agent 0.18.5, gajae-code 0.6.1, jeopi-cli 16.6.18, ...)");
  });

  test("formatUnchangedSummary: three packages have no ellipsis, one is singular, none has no parentheses", () => {
    expect(formatUnchangedSummary({ b: "2.0.0", a: "1.0.0", c: "3.0.0" })).toBe("shared global unchanged: 3 packages (a 1.0.0, b 2.0.0, c 3.0.0)");
    expect(formatUnchangedSummary({ "jeopi-cli": "16.6.18" })).toBe("shared global unchanged: 1 package (jeopi-cli 16.6.18)");
    expect(formatUnchangedSummary({})).toBe("shared global unchanged: 0 packages");
  });

  test("formatUnchangedSummary counts only installed packages and never jeo-code", () => {
    expect(formatUnchangedSummary({ "jeo-code": "0.12.21", absent: null, a: "1.0.0" })).toBe("shared global unchanged: 1 package (a 1.0.0)");
    expect(formatUnchangedSummary({ "jeo-code": null, absent: null })).toBe("shared global unchanged: 0 packages");
  });
});

describe("jeo on PATH", () => {
  test("lists executable jeo files in PATH order, deduplicated by realpath", () => {
    const base = mk("onpath");
    const target = writeExec(path.join(base, "pkg-a", "node_modules", "jeo-code", "src", "cli.ts"));
    const p1 = path.join(base, "p1");
    const p2 = path.join(base, "p2");
    const p3 = path.join(base, "p3");
    fs.mkdirSync(p1);
    fs.mkdirSync(p2);
    fs.mkdirSync(p3);
    fs.symlinkSync(target, path.join(p1, "jeo"));
    fs.symlinkSync(target, path.join(p2, "jeo")); // same realpath as p1
    const other = writeExec(path.join(base, "pkg-c", "cli.ts"));
    fs.symlinkSync(other, path.join(p3, "jeo"));
    const notExecutable = path.join(base, "p4");
    writeText(path.join(notExecutable, "jeo"), "#!/bin/sh\n", 0o644);
    const directory = path.join(base, "p5");
    fs.mkdirSync(path.join(directory, "jeo"), { recursive: true });
    const PATH = [p1, "", "relative/dir", path.join(base, "nonexistent"), notExecutable, directory, p2, p3].join(path.delimiter);
    expect(listJeoOnPath({ PATH }, "linux")).toEqual([
      { path: path.join(p1, "jeo"), realpath: fs.realpathSync(target) },
      { path: path.join(p3, "jeo"), realpath: fs.realpathSync(other) },
    ]);
  });

  test("win32 and an unset PATH list nothing", () => {
    const dir = mk("onpath-win");
    writeExec(path.join(dir, "jeo"));
    expect(listJeoOnPath({ PATH: dir }, "win32")).toEqual([]);
    expect(listJeoOnPath({}, "linux")).toEqual([]);
  });
});

describe("install origin", () => {
  test("isUnder is strict containment", () => {
    expect(isUnder("/a/b/c", "/a/b")).toBe(true);
    expect(isUnder("/a/b", "/a/b")).toBe(false);
    expect(isUnder("/a/bc", "/a/b")).toBe(false);
    expect(isUnder("/a", "/a/b")).toBe(false);
    expect(isUnder("/x/y", "/a/b")).toBe(false);
  });

  test("classifyActiveInstall checks the bun root first and treats unknown inputs as unknown", () => {
    const roots = { bunGlobalNodeModules: "/home/me/.bun/install/global/node_modules", npmGlobalRoot: "/usr/local/lib/node_modules" };
    expect(classifyActiveInstall("/home/me/.bun/install/global/node_modules/jeo-code/src/cli.ts", roots)).toBe("bun-global");
    expect(classifyActiveInstall("/usr/local/lib/node_modules/jeo-code/src/cli.ts", roots)).toBe("npm-global");
    expect(classifyActiveInstall("/opt/dev/jeo-code/src/cli.ts", roots)).toBe("unknown");
    expect(classifyActiveInstall(null, roots)).toBe("unknown");
    expect(classifyActiveInstall("/usr/local/lib/node_modules/jeo-code/src/cli.ts", { bunGlobalNodeModules: null, npmGlobalRoot: null })).toBe("unknown");
    const nested = { bunGlobalNodeModules: "/r/node_modules", npmGlobalRoot: "/r/node_modules" };
    expect(classifyActiveInstall("/r/node_modules/jeo-code/cli.ts", nested)).toBe("bun-global");
  });

  test("detectInstallOrigin classifies bun-global, npm-global, unknown and compiled-binary entries", () => {
    const base = mk("origin");
    const notCompiled = { entry: path.join(base, "script.ts"), execPath: "/opt/bun/bin/bun" };

    // bun global install: ~/.bun/install/global/node_modules/jeo-code, linked from ~/.bun/bin/jeo
    const home = path.join(base, "home");
    const bunGlobal = path.join(home, ".bun", "install", "global");
    writeJson(path.join(bunGlobal, "package.json"), { dependencies: { "jeo-code": "0.12.22" } });
    const bunCli = writeExec(path.join(bunGlobal, "node_modules", "jeo-code", "src", "cli.ts"));
    const bunBin = path.join(home, ".bun", "bin");
    fs.mkdirSync(bunBin, { recursive: true });
    fs.symlinkSync(bunCli, path.join(bunBin, "jeo"));

    // npm global install: <prefix>/lib/node_modules/jeo-code, linked from <prefix>/bin/jeo
    const prefix = path.join(base, "npm-prefix");
    const npmCli = writeExec(path.join(prefix, "lib", "node_modules", "jeo-code", "src", "cli.ts"));
    const npmBin = path.join(prefix, "bin");
    fs.mkdirSync(npmBin, { recursive: true });
    fs.symlinkSync(npmCli, path.join(npmBin, "jeo"));

    // a dev checkout linked onto PATH: outside both roots
    const devCli = writeExec(path.join(base, "dev", "jeo-code", "src", "cli.ts"));
    const devBin = path.join(base, "dev-bin");
    fs.mkdirSync(devBin, { recursive: true });
    fs.symlinkSync(devCli, path.join(devBin, "jeo"));

    const envFor = (...bins: string[]): EnvLike => ({ HOME: home, PATH: bins.join(path.delimiter), npm_config_prefix: prefix });

    const bun = detectInstallOrigin({ ...notCompiled, env: envFor(bunBin) });
    expect(bun.origin).toBe("bun-global");
    expect(bun.active).toBe(fs.realpathSync(bunCli));
    expect(bun.bunGlobalNodeModules).toBe(path.join(bunGlobal, "node_modules"));
    expect(bun.npmGlobalRoot).toBe(path.join(prefix, "lib", "node_modules"));

    const npm = detectInstallOrigin({ ...notCompiled, env: envFor(npmBin) });
    expect(npm.origin).toBe("npm-global");
    expect(npm.active).toBe(fs.realpathSync(npmCli));

    // The first jeo on PATH is the active one, whichever manager owns the others.
    expect(detectInstallOrigin({ ...notCompiled, env: envFor(npmBin, bunBin) }).origin).toBe("npm-global");
    expect(detectInstallOrigin({ ...notCompiled, env: envFor(bunBin, npmBin) }).origin).toBe("bun-global");

    // outside both roots, or nothing on PATH, or win32: unknown
    const dev = detectInstallOrigin({ ...notCompiled, env: envFor(devBin, bunBin) });
    expect(dev.origin).toBe("unknown");
    expect(dev.active).toBe(fs.realpathSync(devCli));
    const none = detectInstallOrigin({ ...notCompiled, env: envFor() });
    expect(none).toMatchObject({ origin: "unknown", active: null });
    expect(detectInstallOrigin({ ...notCompiled, env: envFor(bunBin), platform: "win32" })).toMatchObject({ origin: "unknown", active: null, bunGlobalNodeModules: null, npmGlobalRoot: null });

    // compiled binary: the running jeo has no package-manager install, so never bun-global or npm-global,
    // even though the jeo that is first on PATH really is under the bun root
    for (const compiled of [
      { entry: "/opt/jeo/jeo", execPath: "/opt/jeo/jeo" },
      { entry: "/$bunfs/root/jeo", execPath: "/opt/jeo/jeo" },
      { entry: "B:/~BUN/root/jeo.exe", execPath: "C:\\jeo\\jeo.exe" },
    ]) {
      const result = detectInstallOrigin({ ...compiled, env: envFor(bunBin) });
      expect(result.origin).toBe("unknown");
      expect(result.active).toBe(fs.realpathSync(bunCli));
    }
    expect(detectInstallOrigin({ entry: "/opt/jeo/jeo", execPath: "/opt/jeo/jeo", env: envFor(npmBin) }).origin).toBe("unknown");
  });

  test("detectInstallOrigin resolves a symlinked bun install root", () => {
    const base = mk("origin-symlink");
    const realHome = path.join(base, "real-home");
    const bunGlobal = path.join(realHome, ".bun", "install", "global");
    writeJson(path.join(bunGlobal, "package.json"), { dependencies: {} });
    const cli = writeExec(path.join(bunGlobal, "node_modules", "jeo-code", "src", "cli.ts"));
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(cli, path.join(bin, "jeo"));
    const linkedHome = path.join(base, "linked-home");
    fs.symlinkSync(realHome, linkedHome);
    const result = detectInstallOrigin({ env: { HOME: linkedHome, PATH: bin }, entry: "/x/script.ts", execPath: "/opt/bun" });
    expect(result.origin).toBe("bun-global");
    expect(result.bunGlobalNodeModules).toBe(path.join(bunGlobal, "node_modules"));
  });

  test("resolveNpmGlobalRoot honours npm_config_prefix, the ~/.npmrc prefix and the npm on PATH", () => {
    const base = mk("npm-root");
    const marker = path.join(base, "npm-was-executed");

    // (1) environment prefix wins over everything else; the lowercase variable is read first
    const home = path.join(base, "home");
    writeText(path.join(home, ".npmrc"), "prefix=/from/npmrc\n");
    const nvm = path.join(base, "nvm", "v22");
    writeExec(path.join(nvm, "bin", "npm"), `#!/bin/sh\ntouch '${marker}'\n`);
    writeJson(path.join(nvm, "lib", "node_modules", "npm", "package.json"), { name: "npm" });
    const PATH = path.join(nvm, "bin");
    expect(resolveNpmGlobalRoot({ HOME: home, PATH, npm_config_prefix: "/env/prefix" })).toBe("/env/prefix/lib/node_modules");
    expect(resolveNpmGlobalRoot({ HOME: home, PATH, NPM_CONFIG_PREFIX: "/env/upper" })).toBe("/env/upper/lib/node_modules");
    expect(resolveNpmGlobalRoot({ HOME: home, PATH, npm_config_prefix: "/lower", NPM_CONFIG_PREFIX: "/upper" })).toBe("/lower/lib/node_modules");
    // a relative environment prefix is not trusted and is not silently replaced by a later source
    expect(resolveNpmGlobalRoot({ HOME: home, PATH, npm_config_prefix: "relative/prefix" })).toBeNull();

    // (2) the last prefix line of ~/.npmrc, beating npm on PATH
    expect(resolveNpmGlobalRoot({ HOME: home, PATH })).toBe("/from/npmrc/lib/node_modules");
    const npmrc = (text: string): string => {
      const h = mk("npmrc-home");
      writeText(path.join(h, ".npmrc"), text);
      return h;
    };
    const rc = (text: string, extra: Partial<Record<string, string>> = {}): string | null => {
      const h = npmrc(text);
      return resolveNpmGlobalRoot({ HOME: h, PATH: "", ...extra }, h);
    };
    const quotedHome = npmrc("prefix='~/quoted'\n");
    expect(resolveNpmGlobalRoot({ HOME: quotedHome, PATH: "" })).toBe(path.join(quotedHome, "quoted", "lib", "node_modules"));
    const dollarHome = npmrc('prefix="$HOME/dollar"\n');
    expect(resolveNpmGlobalRoot({ HOME: dollarHome, PATH: "" })).toBe(path.join(dollarHome, "dollar", "lib", "node_modules"));
    const bracesHome = npmrc("prefix=${HOME}/braces\n");
    expect(resolveNpmGlobalRoot({ HOME: bracesHome, PATH: "" })).toBe(path.join(bracesHome, "braces", "lib", "node_modules"));
    expect(rc("registry=https://x\nprefix = /first\n; prefix=/commented\n# prefix=/hash\nprefix = /last  \n")).toBe("/last/lib/node_modules");
    expect(rc('prefix = "/with quotes"\n')).toBe("/with quotes/lib/node_modules");
    expect(rc("prefix=/trailing ; inline comment\n")).toBe("/trailing/lib/node_modules");
    expect(rc("prefix=/a\r\nprefix=/b\r\n")).toBe("/b/lib/node_modules");
    // a relative or empty prefix is unknown, not a fall-through to a different root
    expect(rc("prefix=relative/dir\n")).toBeNull();
    expect(rc("prefix=\n")).toBeNull();
    expect(rc("prefix=~someone/else\n")).toBeNull();
    // no prefix line: fall through to PATH
    const noPrefix = npmrc("registry=https://registry.npmjs.org\n");
    expect(resolveNpmGlobalRoot({ HOME: noPrefix, PATH })).toBe(path.join(nvm, "lib", "node_modules"));

    // (3) first executable npm on PATH, accepted only when its lib/node_modules really holds npm
    const emptyHome = mk("npm-root-empty-home");
    expect(resolveNpmGlobalRoot({ HOME: emptyHome, PATH })).toBe(path.join(nvm, "lib", "node_modules"));
    expect(fs.existsSync(marker)).toBe(false); // npm itself is never executed

    // Homebrew layout: bin/npm is a symlink into lib/node_modules/npm; the root derives from the PATH entry, not the link target
    const brew = path.join(base, "brew");
    writeExec(path.join(brew, "lib", "node_modules", "npm", "bin", "npm-cli.js"));
    writeJson(path.join(brew, "lib", "node_modules", "npm", "package.json"), { name: "npm" });
    fs.mkdirSync(path.join(brew, "bin"), { recursive: true });
    fs.symlinkSync(path.join(brew, "lib", "node_modules", "npm", "bin", "npm-cli.js"), path.join(brew, "bin", "npm"));
    expect(resolveNpmGlobalRoot({ HOME: emptyHome, PATH: path.join(brew, "bin") })).toBe(path.join(brew, "lib", "node_modules"));

    // a Volta/fnm-style shim (not in a `bin` directory) is rejected, and it is the first npm so it decides
    const shims = path.join(base, "volta", "shims");
    writeExec(path.join(shims, "npm"), `#!/bin/sh\ntouch '${marker}'\n`);
    expect(resolveNpmGlobalRoot({ HOME: emptyHome, PATH: shims })).toBeNull();
    expect(resolveNpmGlobalRoot({ HOME: emptyHome, PATH: [shims, path.join(nvm, "bin")].join(path.delimiter) })).toBeNull();
    // a bin/npm whose lib/node_modules lacks npm is rejected
    const bare = path.join(base, "bare");
    writeExec(path.join(bare, "bin", "npm"));
    expect(resolveNpmGlobalRoot({ HOME: emptyHome, PATH: path.join(bare, "bin") })).toBeNull();
    // a non-executable npm, a directory named npm and relative/empty PATH entries are skipped
    const plain = path.join(base, "plain");
    writeText(path.join(plain, "npm"), "#!/bin/sh\n", 0o644);
    const dirNamed = path.join(base, "dir-named");
    fs.mkdirSync(path.join(dirNamed, "npm"), { recursive: true });
    const skipPath = [plain, dirNamed, "", "relative/bin", path.join(nvm, "bin")].join(path.delimiter);
    expect(resolveNpmGlobalRoot({ HOME: emptyHome, PATH: skipPath })).toBe(path.join(nvm, "lib", "node_modules"));

    // (4) nothing known
    expect(resolveNpmGlobalRoot({ HOME: emptyHome, PATH: "" })).toBeNull();
    expect(resolveNpmGlobalRoot({})).toBeNull();
    expect(resolveNpmGlobalRoot({ HOME: home, PATH, npm_config_prefix: "/p" }, home, "win32")).toBeNull();
    expect(fs.existsSync(marker)).toBe(false); // still never executed
  });

  test("resolveNpmGlobalRoot reads the npmrc from the explicit home argument", () => {
    const home = mk("npm-root-home-arg");
    writeText(path.join(home, ".npmrc"), "prefix=/explicit-home\n");
    expect(resolveNpmGlobalRoot({ PATH: "" }, home)).toBe("/explicit-home/lib/node_modules");
    expect(resolveNpmGlobalRoot({ PATH: "" }, undefined)).toBeNull();
  });
});
