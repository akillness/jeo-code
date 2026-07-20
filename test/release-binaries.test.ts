import { test, expect } from "bun:test";
import {
  targets,
  parseRequestedTargets,
  selectTargets,
  hostDefaultTargets,
  buildCommand,
  type BinaryTarget,
} from "../scripts/ci-release-build-binaries.ts";

const releaseWorkflow = await Bun.file(
  new URL("../.github/workflows/npm-publish.yml", import.meta.url),
).text();

test("release matrix includes a Windows x64 .exe target with the modern bun triple", () => {
  const win = targets.find((t) => t.id === "win32-x64");
  expect(win).toBeDefined();
  expect(win!.platform).toBe("win32");
  expect(win!.arch).toBe("x64");
  expect(win!.target).toBe("bun-windows-x64-modern");
  expect(win!.outfile.endsWith(".exe")).toBe(true);
});

test("only the Windows binary carries the .exe suffix", () => {
  for (const t of targets) {
    const isWin = t.platform === "win32";
    expect(t.outfile.endsWith(".exe")).toBe(isWin);
  }
});

test("parseRequestedTargets reads --targets flag, --targets=, env, and 'all'", () => {
  expect(parseRequestedTargets(["--targets", "win32-x64"], undefined)).toEqual(new Set(["win32-x64"]));
  expect(parseRequestedTargets(["--targets=win32-x64,linux-x64"], undefined)).toEqual(
    new Set(["win32-x64", "linux-x64"]),
  );
  expect(parseRequestedTargets([], "linux-arm64")).toEqual(new Set(["linux-arm64"]));
  expect(parseRequestedTargets(["--targets", "all"], undefined)).toEqual(
    new Set(targets.map((t) => t.id)),
  );
  // No flag and no env → null (host-default mode).
  expect(parseRequestedTargets([], undefined)).toBeNull();
});

test("an explicit --targets flag overrides the RELEASE_TARGETS env value", () => {
  expect(parseRequestedTargets(["--targets", "win32-x64"], "linux-x64")).toEqual(new Set(["win32-x64"]));
});

test("selectTargets resolves ids and rejects unknown targets", () => {
  const selected = selectTargets(new Set(["win32-x64", "linux-x64"]));
  expect(selected.map((t) => t.id).sort()).toEqual(["linux-x64", "win32-x64"]);
  expect(() => selectTargets(new Set(["solaris-sparc"]))).toThrow(/Unknown release target/);
});

test("hostDefaultTargets matches exactly the current platform/arch slice", () => {
  expect(hostDefaultTargets("win32", "x64").map((t) => t.id)).toEqual(["win32-x64"]);
  expect(hostDefaultTargets("linux", "arm64").map((t) => t.id)).toEqual(["linux-arm64"]);
  // A host with no matching release target yields an empty slice (caller errors).
  expect(hostDefaultTargets("freebsd", "x64")).toEqual([]);
});

test("buildCommand emits a compile invocation with the per-target bun triple and outfile", () => {
  const win = targets.find((t) => t.id === "win32-x64") as BinaryTarget;
  const cmd = buildCommand(win);
  expect(cmd.slice(0, 3)).toEqual(["bun", "build", "--compile"]);
  expect(cmd).toContain("--target");
  expect(cmd[cmd.indexOf("--target") + 1]).toBe("bun-windows-x64-modern");
  expect(cmd[cmd.indexOf("--outfile") + 1]).toBe("dist/jeo-windows-x64.exe");
  expect(cmd).toContain("src/cli.ts");
  // Preserve symbol names for readable stack traces in the shipped binary.
  expect(cmd).toContain("--keep-names");
  // Never auto-load a `.env` from the user's cwd into the compiled binary.
  expect(cmd).toContain("--no-compile-autoload-dotenv");
  // playwright-core's bundled coreBundle.js has a lazy `require("chromium-bidi/...")`
  // reached only by its BiDi bridge (a path jeo never takes) — un-externalized, Bun's
  // compile-time bundler statically resolves every reachable require() (dead code or
  // not) and fails the whole build since chromium-bidi isn't a declared dependency.
  expect(cmd).toContain("--external");
  expect(cmd[cmd.indexOf("--external") + 1]).toBe("chromium-bidi");
});


test("package.json's plain `build` script matches buildCommand's compile-safety flags", async () => {
  const pkgText = await Bun.file(new URL("../package.json", import.meta.url)).text();
  const pkg = JSON.parse(pkgText) as { scripts: Record<string, string> };
  const buildScript = pkg.scripts.build;
  const win = targets.find((t) => t.id === "win32-x64") as BinaryTarget;
  const releaseFlags = buildCommand(win).filter((tok) => tok.startsWith("--")).filter((f) => f !== "--target" && f !== "--outfile");
  for (const flag of releaseFlags) {
    expect(buildScript).toContain(flag);
  }
  // The externalized module name itself (order-sensitive with --external) must
  // also survive in the plain script, not just the flag.
  expect(buildScript).toContain("chromium-bidi");
});

test("release workflow builds every target (incl. Windows) and uploads them", () => {
  // Cross-compiles all targets from one runner since jeo has no native addons.
  expect(releaseWorkflow).toContain("bun run build:binaries --targets all");
  // Windows binary must end up among the uploaded dist/jeo-* assets.
  expect(releaseWorkflow).toContain("dist/jeo-*");
  expect(releaseWorkflow).toMatch(/gh release upload/);
  // Uploading release assets needs contents: write permission.
  expect(releaseWorkflow).toContain("contents: write");
});
