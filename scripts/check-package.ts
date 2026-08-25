#!/usr/bin/env bun
/**
 * Release gate for the published npm tarball.
 *
 * `npm pack` ships whatever `package.json#files` matches in the CURRENT working
 * tree. A working tree also holds untracked files, so two opposite failures are
 * possible and both have happened:
 *   - untracked local scratch leaking INTO the tarball (0.9.2), and
 *   - tracked source importing a module that was never committed, so the tarball
 *     is missing it and every install crashes at import time (0.9.3-0.9.6:
 *     `Cannot find module '../agent/monitor-tool'` on `jeo` / `jeo --tmux`).
 *
 * A filename allow/deny list cannot catch the second class — only resolving the
 * package's own import graph against the packed file set can. `checkPackage`
 * does exactly that, plus the presence/tracking assertions, as a pure function
 * over an injectable file set so it is unit-testable without packing anything.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Files the published package is useless without. */
export const REQUIRED_PACKAGE_FILES = [
  "package.json",
  "src/cli.ts",
  "src/cli/runner.ts",
  "src/commands/launch.ts",
  "CHANGELOG.md",
  "README.md",
  "README.ko.md",
  "README.ja.md",
  "README.zh.md",
] as const;

/** Extension/index candidates a bare relative specifier may resolve through. */
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".json", ".md", "/index.ts", "/index.js"];

/** Source files whose import graph is checked (the runtime surface of the package). */
const SOURCE_FILE_RE = /\.(ts|tsx|mts|js|mjs)$/;

/** Test/CI artifacts that must never ship to consumers. */
const DISALLOWED_RE = [/(^|\/)(test|tests)\//, /\.test\.[cm]?tsx?$/, /^\.github\//];

/** Every relative specifier in `from "…"`, `import("…")`, and `require("…")`. */
const IMPORT_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.[^"']*)["']/g;

export interface PackageCheckInput {
  /** Package-relative paths `npm pack` would include. */
  packedFiles: string[];
  /** Package-relative paths git tracks; omit to skip the tracking assertion. */
  trackedFiles?: string[];
  /** Reads a packed source file so its imports can be resolved. */
  readFile: (packageRelativePath: string) => string;
}

/** Relative specifiers a packed source file imports. */
export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER_RE)].map(match => match[1]!);
}

/**
 * Resolve `specifier` (relative to `fromFile`) against the packed file set.
 * Returns the packed path, or null when nothing the runtime would load exists.
 */
export function resolvePackedImport(fromFile: string, specifier: string, packed: ReadonlySet<string>): string | null {
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = path.posix.normalize(base + suffix);
    if (packed.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Assert the packed set is publishable. Returns human-readable errors; an empty
 * array means the tarball is safe to publish.
 */
export function checkPackage(input: PackageCheckInput): string[] {
  const errors: string[] = [];
  const packed = new Set(input.packedFiles);
  const tracked = input.trackedFiles ? new Set(input.trackedFiles) : undefined;

  for (const file of input.packedFiles) {
    if (tracked && !tracked.has(file)) errors.push(`untracked path would ship in the npm package: ${file}`);
    if (DISALLOWED_RE.some(re => re.test(file))) errors.push(`test/CI artifact would ship in the npm package: ${file}`);
  }

  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!packed.has(required)) errors.push(`required release file missing from the npm package: ${required}`);
  }

  for (const file of input.packedFiles) {
    if (!SOURCE_FILE_RE.test(file)) continue;
    let source: string;
    try {
      source = input.readFile(file);
    } catch (err) {
      errors.push(`packed source unreadable: ${file} (${(err as Error).message})`);
      continue;
    }
    for (const specifier of importSpecifiers(source)) {
      if (resolvePackedImport(file, specifier, packed)) continue;
      errors.push(
        `packed source imports a module missing from the npm package: ${file} -> ${specifier}` +
          ` (commit the module, or drop the import — an install of this tarball crashes at startup)`,
      );
    }
  }

  return errors;
}

/** `npm pack --dry-run --json` file list for `dir`. */
function packedFilesOf(dir: string): string[] {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const manifest = JSON.parse(raw) as { files: { path: string }[] }[];
  return (manifest[0]?.files ?? []).map(entry => entry.path);
}

/** Git-tracked paths for `dir`, or undefined outside a checkout. */
function trackedFilesOf(dir: string): string[] | undefined {
  try {
    return execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const dir = path.resolve(process.argv[2] ?? process.cwd());
  const packedFiles = packedFilesOf(dir);
  const errors = checkPackage({
    packedFiles,
    trackedFiles: trackedFilesOf(dir),
    readFile: file => fs.readFileSync(path.join(dir, file), "utf8"),
  });
  if (errors.length > 0) {
    console.error(`npm package check FAILED (${errors.length} problem${errors.length === 1 ? "" : "s"}):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`npm package check passed: ${packedFiles.length} files, imports resolve, required files present.`);
}
