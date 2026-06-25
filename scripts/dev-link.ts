/**
 * Dev linking & drift doctor (gjc `dev:link` / `dev:doctor` parity, adapted for
 * jeo's pure-TypeScript-on-Bun runtime — there are no native bindings to load).
 *
 *   bun scripts/dev-link.ts link      # symlink global `jeo` -> this checkout's src/cli.ts
 *   bun scripts/dev-link.ts doctor    # report whether global `jeo` runs from this source
 *
 * `link` makes the global `jeo` command run THIS checkout's TypeScript source (hot
 * to every edit). It targets `~/.local/bin` (override with JEO_DEV_LINK_DIR), refuses
 * to proceed if another `jeo` shadows it earlier on PATH, and runs a `--version`
 * smoke test. `doctor` classifies whatever `jeo` your PATH currently resolves to:
 * `linked` (this source), `drift` (a compiled binary or an npm-installed copy), or
 * `missing` (no `jeo` on PATH).
 *
 * Unlike gjc there is no `build:native` prerequisite: jeo has zero native deps, so a
 * bare symlink to `src/cli.ts` (shebang `#!/usr/bin/env bun`) is fully functional.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/** Absolute path to the repository root (this file lives in `<root>/scripts/`). */
export function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

/** The hot dev entrypoint a dev-link points at. */
export function devLinkTarget(root: string = repoRoot()): string {
  return path.join(root, "src", "cli.ts");
}

/** Destination bin dir for the managed `jeo` symlink (JEO_DEV_LINK_DIR overrides). */
export function defaultLinkDir(): string {
  const override = process.env.JEO_DEV_LINK_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(process.env.HOME || os.homedir(), ".local", "bin");
}

/** Split a PATH string into normalized, non-empty directory entries. */
export function splitPathEntries(pathVar: string | undefined): string[] {
  if (!pathVar) return [];
  return pathVar
    .split(path.delimiter)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => path.resolve(p));
}

/**
 * Pure: find a `jeo` that would shadow our managed symlink because it sits on an
 * earlier PATH entry than `linkDir`. Returns that shadowing path, or null when the
 * managed link wins (or no other `jeo` exists). `exists` is injected for testing.
 */
export function findShadowingJeo(opts: {
  linkDir: string;
  pathEntries: string[];
  exists: (p: string) => boolean;
}): string | null {
  const linkDir = path.resolve(opts.linkDir);
  for (const entry of opts.pathEntries) {
    const dir = path.resolve(entry);
    if (dir === linkDir) return null; // our managed dir wins from here on
    const candidate = path.join(dir, "jeo");
    if (opts.exists(candidate)) return candidate;
  }
  return null;
}

export type DevDoctorStatus = "linked" | "drift" | "missing";

/** Pure: classify the resolved `jeo` against the expected hot-source target. */
export function classifyDevDoctor(opts: {
  resolved: string | null;
  expectedTarget: string;
}): { status: DevDoctorStatus; detail: string } {
  if (!opts.resolved) {
    return { status: "missing", detail: "no `jeo` found on PATH" };
  }
  if (path.resolve(opts.resolved) === path.resolve(opts.expectedTarget)) {
    return { status: "linked", detail: `runs this checkout's source (${opts.resolved})` };
  }
  return {
    status: "drift",
    detail: `resolves to ${opts.resolved}, not ${opts.expectedTarget} (compiled binary or installed copy — run 'bun run dev:link')`,
  };
}

/** Resolve the first executable `jeo` on PATH, following symlinks. Null if none. */
export function resolveJeoOnPath(pathEntries: string[]): string | null {
  for (const dir of pathEntries) {
    const candidate = path.join(dir, "jeo");
    try {
      const st = fs.statSync(candidate); // follows symlinks
      if (st.isFile()) return fs.realpathSync(candidate);
    } catch {
      /* not here */
    }
  }
  return null;
}

async function runLink(): Promise<number> {
  const target = devLinkTarget();
  const linkDir = defaultLinkDir();
  const linkPath = path.join(linkDir, "jeo");

  if (!fs.existsSync(target)) {
    console.error(`✗ dev:link target missing: ${target}`);
    return 1;
  }

  const pathEntries = splitPathEntries(process.env.PATH);
  const shadow = findShadowingJeo({
    linkDir,
    pathEntries,
    exists: p => fs.existsSync(p) && path.resolve(p) !== path.resolve(linkPath),
  });
  if (shadow) {
    console.error(`✗ another 'jeo' shadows the managed link earlier on PATH: ${shadow}`);
    console.error(`  Remove it (or put ${linkDir} earlier on PATH) before linking.`);
    return 1;
  }

  await fsp.mkdir(linkDir, { recursive: true });
  // src/cli.ts carries the `#!/usr/bin/env bun` shebang; ensure it stays executable.
  await fsp.chmod(target, 0o755).catch(() => {});
  await fsp.rm(linkPath, { force: true });
  await fsp.symlink(target, linkPath);
  console.log(`✓ linked jeo -> ${target}`);
  console.log(`  via ${linkPath}`);

  // Smoke test: the linked command must actually start and report a version.
  const proc = Bun.spawnSync([linkPath, "--version"], { stdout: "pipe", stderr: "pipe" });
  const out = (proc.stdout?.toString() ?? "") + (proc.stderr?.toString() ?? "");
  if (proc.exitCode === 0 && /jeo v/i.test(out)) {
    console.log(`✓ smoke test: ${out.trim().split("\n")[0]}`);
    return 0;
  }
  console.error(`✗ smoke test failed (exit ${proc.exitCode}): ${out.trim()}`);
  return 1;
}

function runDoctor(): number {
  const expected = devLinkTarget();
  const pathEntries = splitPathEntries(process.env.PATH);
  const resolved = resolveJeoOnPath(pathEntries);
  const { status, detail } = classifyDevDoctor({ resolved, expectedTarget: expected });
  const mark = status === "linked" ? "✓" : status === "missing" ? "•" : "⚠";
  console.log(`${mark} dev:doctor [${status}] ${detail}`);
  console.log(`  expected hot source: ${expected}`);
  console.log(`  link dir: ${defaultLinkDir()} (override with JEO_DEV_LINK_DIR)`);
  return status === "linked" ? 0 : 1;
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "link") {
    process.exit(await runLink());
  } else if (sub === "doctor") {
    process.exit(runDoctor());
  } else {
    console.error("usage: bun scripts/dev-link.ts <link|doctor>");
    process.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
