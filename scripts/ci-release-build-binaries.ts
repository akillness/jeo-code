#!/usr/bin/env bun
//
// Cross-target standalone-binary builder for `jeo`.
//
// Ported in spirit from gajae-code's release binary matrix (gjc #997-era release
// tooling). jeo is a single package with a single entrypoint (`src/cli.ts`) and
// no native addons / workers, so this is a stripped-down equivalent: it adds a
// first-class **Windows x64 (.exe)** release target alongside macOS/Linux,
// instead of the host-only `bun build --compile` the install script uses.
//
// Usage:
//   bun scripts/ci-release-build-binaries.ts                 # host target only
//   bun scripts/ci-release-build-binaries.ts --targets win32-x64
//   bun scripts/ci-release-build-binaries.ts --targets all
//   RELEASE_TARGETS=win32-x64,linux-x64 bun scripts/ci-release-build-binaries.ts
//   bun scripts/ci-release-build-binaries.ts --targets all --dry-run

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface BinaryTarget {
  id: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Bun `--target` triple. */
  target: string;
  /** Output path relative to the repo root. */
  outfile: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const distDir = path.join(repoRoot, "dist");
const entrypoint = "src/cli.ts";

export const targets: BinaryTarget[] = [
  {
    id: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    target: "bun-darwin-arm64",
    outfile: "dist/jeo-darwin-arm64",
  },
  {
    id: "darwin-x64",
    platform: "darwin",
    arch: "x64",
    target: "bun-darwin-x64-baseline",
    outfile: "dist/jeo-darwin-x64",
  },
  {
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    target: "bun-linux-x64-baseline",
    outfile: "dist/jeo-linux-x64",
  },
  {
    id: "linux-arm64",
    platform: "linux",
    arch: "arm64",
    target: "bun-linux-arm64",
    outfile: "dist/jeo-linux-arm64",
  },
  {
    id: "win32-x64",
    platform: "win32",
    arch: "x64",
    target: "bun-windows-x64-modern",
    outfile: "dist/jeo-windows-x64.exe",
  },
];

export function parseRequestedTargets(
  argv: string[] = process.argv,
  envValue: string | undefined = Bun.env.RELEASE_TARGETS,
): Set<string> | null {
  const flagIndex = argv.findIndex((arg) => arg === "--targets");
  const flagValue =
    flagIndex >= 0
      ? argv[flagIndex + 1]
      : (argv.find((arg) => arg.startsWith("--targets="))?.split("=", 2)[1] ?? envValue);

  if (!flagValue) return null;

  if (flagValue.trim() === "all") return new Set(targets.map((t) => t.id));

  return new Set(
    flagValue
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function hostDefaultTargets(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BinaryTarget[] {
  // A bare invocation is a single-host dogfood build, not a full release.
  return targets.filter((t) => t.platform === platform && t.arch === arch);
}

export function selectTargets(requested: Set<string> | null): BinaryTarget[] {
  if (!requested) return hostDefaultTargets();
  const unknown = [...requested].filter((id) => !targets.some((t) => t.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown release target(s): ${unknown.join(", ")}`);
  }
  return targets.filter((t) => requested.has(t.id));
}

function shouldAdhocSignDarwinBinary(target: BinaryTarget): boolean {
  return target.platform === "darwin" && process.platform === "darwin";
}

async function runCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
  const proc = Bun.spawn(command, { cwd, env, stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
  }
}

export function buildCommand(target: BinaryTarget): string[] {
  return [
    "bun",
    "build",
    "--compile",
    "--keep-names",
    // Don't let a `.env` in the user's cwd bleed into the compiled binary at
    // startup: jeo runs inside arbitrary user repos, so auto-loading their
    // project `.env` would silently inject (and potentially leak) their secrets
    // into the agent process. Env vars must come from the real environment only.
    "--no-compile-autoload-dotenv",
    "--target",
    target.target,
    entrypoint,
    "--outfile",
    target.outfile,
  ];
}

async function buildBinary(target: BinaryTarget, isDryRun: boolean): Promise<void> {
  const command = buildCommand(target);
  if (isDryRun) {
    console.log(`DRY RUN ${command.join(" ")}`);
    return;
  }
  console.log(`Building ${target.outfile} (${target.target})...`);
  // Bun 1.3.x can emit a truncated Mach-O signature on darwin compile builds;
  // suppress its built-in codesign and re-sign adhoc afterwards.
  const buildEnv = shouldAdhocSignDarwinBinary(target)
    ? { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" }
    : Bun.env;
  await runCommand(command, repoRoot, buildEnv);
  if (shouldAdhocSignDarwinBinary(target)) {
    await runCommand(["codesign", "--force", "--sign", "-", path.join(repoRoot, target.outfile)], repoRoot);
  }
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes("--dry-run");
  const requestedTargets = parseRequestedTargets();
  const selectedTargets = selectTargets(requestedTargets);

  if (selectedTargets.length === 0) {
    if (requestedTargets) throw new Error("No release targets selected.");
    throw new Error(
      `No release target matches this host (${process.platform}-${process.arch}). ` +
        `Pass --targets <id|all> or set RELEASE_TARGETS to build a specific target.`,
    );
  }

  if (!isDryRun) await fs.mkdir(distDir, { recursive: true });
  for (const target of selectedTargets) {
    await buildBinary(target, isDryRun);
  }
  console.log(`\nDone. Built ${selectedTargets.length} binary/binaries:`);
  for (const t of selectedTargets) console.log(`  ${t.id} → ${t.outfile}`);
}

if (import.meta.main) {
  await main();
}
