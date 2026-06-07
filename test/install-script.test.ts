import { test, expect } from "bun:test";

async function runInstallHelp(): Promise<string> {
  const proc = Bun.spawn(["sh", "scripts/install.sh", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return stdout;
}

test("installer help documents GitHub URL and registry controls", async () => {
  const help = await runInstallHelp();
  expect(help).toContain("https://github.com/akillness/jeo-code.git");
  expect(help).toContain("--registry <url>");
  expect(help).toContain("--persist-registry");
  expect(help).toContain("npm config set registry <url>");
  expect(help).toContain("--project-npmrc");
  expect(help).toContain("--print-registry");
  expect(help).toContain("--delete-registry");
});

test("installer dry-run normalizes the Git URL and keeps registry one-shot", async () => {
  const proc = Bun.spawn([
    "sh",
    "scripts/install.sh",
    "--dry-run",
    "--registry",
    "https://registry.npmjs.org/",
    "--repo",
    "https://github.com/akillness/jeo-code.git",
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toContain("git+https://github.com/akillness/jeo-code.git");
  expect(stdout).toContain("NPM_CONFIG_REGISTRY=https://registry.npmjs.org/");
  expect(stdout).toContain("Dry run complete; no install changes were made.");
});
test("package metadata is npm-publication ready for bun install -g jeo-code", async () => {
  const pkg = JSON.parse(await Bun.file("package.json").text());
  expect(pkg.name).toBe("jeo-code");
  expect(pkg.bin).toEqual({ joc: "src/cli.ts" });
  expect(pkg.files).toContain("src");
  expect(pkg.publishConfig).toEqual({
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  expect(pkg.scripts["publish:npm"]).toBe("npm publish --access public --registry https://registry.npmjs.org/");
  const cli = await Bun.file("src/cli.ts").text();
  expect(cli.startsWith("#!/usr/bin/env bun")).toBe(true);
});

test("npm publish workflow is wired for NPM_TOKEN based publication", async () => {
  const workflow = await Bun.file(".github/workflows/npm-publish.yml").text();
  expect(workflow).toContain("Publish npm package");
  expect(workflow).toContain("secrets.NPM_TOKEN");
  expect(workflow).toContain("npm publish --access public --registry https://registry.npmjs.org/ --provenance");
  expect(workflow).toContain("npm publish --dry-run --access public");
});
