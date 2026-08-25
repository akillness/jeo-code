import { test, expect } from "bun:test";
import {
  checkPackage,
  importSpecifiers,
  resolvePackedImport,
  REQUIRED_PACKAGE_FILES,
} from "../scripts/check-package";

/** Minimal packed set that satisfies every presence rule, so each test can isolate one failure. */
function baseFiles(extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};
  for (const required of REQUIRED_PACKAGE_FILES) files[required] = "";
  files["src/cli.ts"] = `import { dispatch } from "./cli/runner";`;
  files["src/cli/runner.ts"] = `const m = await import("../commands/launch");`;
  files["src/commands/launch.ts"] = "";
  return { ...files, ...extra };
}

function run(files: Record<string, string>, opts: { tracked?: string[] } = {}): string[] {
  return checkPackage({
    packedFiles: Object.keys(files),
    trackedFiles: opts.tracked ?? Object.keys(files),
    readFile: file => {
      if (!(file in files)) throw new Error(`ENOENT ${file}`);
      return files[file]!;
    },
  });
}

test("importSpecifiers picks up static, dynamic, re-export, and attribute-suffixed relative imports", () => {
  const source = [
    `import a from "./a";`,
    `export { b } from "../b";`,
    `const c = await import("./deep/c");`,
    `const d = require("../d");`,
    `import skill from "../prompts/x/SKILL.md" with { type: "text" };`,
    `import pkg from "../../package.json";`,
    `import chalk from "chalk";`, // bare specifier: dependency, not packaged source
  ].join("\n");
  expect(importSpecifiers(source)).toEqual([
    "./a",
    "../b",
    "./deep/c",
    "../d",
    "../prompts/x/SKILL.md",
    "../../package.json",
  ]);
});

test("resolvePackedImport resolves extensionless, index, markdown, and json targets", () => {
  const packed = new Set([
    "src/agent/tools.ts",
    "src/mcp/index.ts",
    "src/prompts/agents/architect.md",
    "package.json",
  ]);
  expect(resolvePackedImport("src/commands/launch.ts", "../agent/tools", packed)).toBe("src/agent/tools.ts");
  expect(resolvePackedImport("src/commands/mcp.ts", "../mcp", packed)).toBe("src/mcp/index.ts");
  expect(resolvePackedImport("src/agent/subagents.ts", "../prompts/agents/architect.md", packed)).toBe("src/prompts/agents/architect.md");
  expect(resolvePackedImport("src/cli.ts", "../package.json", packed)).toBe("package.json");
  expect(resolvePackedImport("src/commands/launch.ts", "../agent/monitor-tool", packed)).toBeNull();
});

test("a self-consistent packed tree passes", () => {
  expect(run(baseFiles())).toEqual([]);
});

// The exact defect that shipped in 0.9.3-0.9.6: tracked source imported a module
// that was never committed, so `jeo` / `jeo --tmux` crashed at startup for every
// user who ran `jeo update`. A filename allow/deny list cannot see this.
test("packed source importing a module missing from the tarball is a failure", () => {
  const errors = run(baseFiles({
    "src/commands/launch.ts": `import { createMonitorTool } from "../agent/monitor-tool";`,
  }));
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("src/commands/launch.ts -> ../agent/monitor-tool");
  expect(errors[0]).toContain("missing from the npm package");
});

test("an untracked path that npm pack would ship is a failure", () => {
  const files = baseFiles({ "src/agent/scratch.ts": "" });
  const errors = run(files, { tracked: Object.keys(files).filter(f => f !== "src/agent/scratch.ts") });
  expect(errors).toEqual(["untracked path would ship in the npm package: src/agent/scratch.ts"]);
});

test("test and CI artifacts are rejected", () => {
  const errors = run(baseFiles({ "test/foo.test.ts": "", ".github/workflows/ci.yml": "" }));
  expect(errors.some(e => e.includes("test/foo.test.ts"))).toBe(true);
  expect(errors.some(e => e.includes(".github/workflows/ci.yml"))).toBe(true);
});

test("a missing required release file is a failure", () => {
  const files = baseFiles();
  delete files["src/commands/launch.ts"];
  // Drop the importer too, so only the presence rule (not import resolution) fires.
  files["src/cli/runner.ts"] = "";
  expect(run(files)).toEqual(["required release file missing from the npm package: src/commands/launch.ts"]);
});

test("the launch entrypoint is required, since a tarball without it cannot run `jeo` or `jeo --tmux`", () => {
  expect(REQUIRED_PACKAGE_FILES).toContain("src/commands/launch.ts");
  expect(REQUIRED_PACKAGE_FILES).toContain("src/cli/runner.ts");
  expect(REQUIRED_PACKAGE_FILES).toContain("src/cli.ts");
});
