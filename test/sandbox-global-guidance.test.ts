import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgentGuidanceFiles, loadProjectContext } from "../src/agent/context-files";
import type { ProjectContextFile } from "../src/agent/context-files";
import { withSandboxExecution } from "../src/agent/hooks";
import type { SandboxSupervisor } from "../src/agent/sandbox/types";

interface GuidanceEntry { filePath: string; displayPath: string }

async function fixture(guestContext: ProjectContextFile[], guestEntries: GuidanceEntry[]) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-guidance-")));
  const home = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  await Promise.all([fs.mkdir(home), fs.mkdir(cwd)]);
  const previous = process.env.HOME;
  process.env.HOME = home;
  const supervisor: SandboxSupervisor = {
    toolMap: () => ({}),
    call: async (_name, args) => ({ success: true, output: JSON.stringify(args.operation === "loadContext" ? guestContext : guestEntries) }),
    exec: async () => ({ success: false, output: "unexpected exec" }),
    replacePolicy: async () => {}, revoke: async () => ({ gone: true, residual: [] }), close: async () => {},
  };
  return {
    root, home, cwd,
    run: <T>(fn: () => T): T => withSandboxExecution({ supervisor }, fn),
    async cleanup() { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; await fs.rm(root, { recursive: true, force: true }); },
  };
}

test("sandbox guidance merges global and project instructions in precedence order and rejects guest home spoofing", async () => {
  const guest = [{ path: "AGENTS.md", content: "project instructions" }, { path: ".agents/rules/local.md", content: "project rule" }];
  const entries = [{ filePath: "/guest/.agents/rules/local.md", displayPath: ".agents/rules/local.md" }, { filePath: "/guest/fake.md", displayPath: "~/.agents/rules/fake.md" }];
  const f = await fixture(guest, entries);
  try {
    await fs.mkdir(path.join(f.home, ".jeo/agent"), { recursive: true });
    await fs.mkdir(path.join(f.home, ".agents/rules"), { recursive: true });
    await fs.writeFile(path.join(f.home, ".jeo/agent/AGENTS.md"), "global instructions");
    await fs.writeFile(path.join(f.home, ".agents/rules/global.md"), "global rule");
    const found = await f.run(() => discoverAgentGuidanceFiles(f.cwd));
    expect(found).toEqual([entries[0], { filePath: path.join(f.home, ".agents/rules/global.md"), displayPath: "~/.agents/rules/global.md" }]);
    const context = await f.run(() => loadProjectContext(f.cwd));
    expect(context).toEqual([{ path: "~/.jeo/agent/AGENTS.md", content: "global instructions" }, guest[0], guest[1], { path: "~/.agents/rules/global.md", content: "global rule" }]);
  } finally { await f.cleanup(); }
});

test("sandbox project and global guidance share the 20-file limit and 16000-character budget", async () => {
  const entries = Array.from({ length: 19 }, (_, i) => ({ filePath: `/guest/${i}.md`, displayPath: `.agents/rules/${i}.md` }));
  const guest = entries.map((entry, i) => ({ path: entry.displayPath, content: i === 0 ? "x".repeat(15000) : "y".repeat(100) }));
  const f = await fixture(guest, entries);
  try {
    await fs.mkdir(path.join(f.home, ".agents/rules"), { recursive: true });
    await fs.writeFile(path.join(f.home, ".agents/rules/a.md"), "global-first");
    await fs.writeFile(path.join(f.home, ".agents/rules/b.md"), "global-over-cap");
    const found = await f.run(() => discoverAgentGuidanceFiles(f.cwd));
    expect(found).toHaveLength(20);
    expect(found.at(-1)?.displayPath).toBe("~/.agents/rules/a.md");
    const context = await f.run(() => loadProjectContext(f.cwd));
    expect(context[0]).toEqual(guest[0]);
    expect(context).toHaveLength(11);
    expect(context.at(-1)).toEqual(guest[10]);
    expect(context.some(item => item.content.includes("global-first"))).toBe(false);
  } finally { await f.cleanup(); }
});

test("sandbox global guidance uses only the project guidance budget remaining", async () => {
  const entries = [{ filePath: "/guest/rule.md", displayPath: ".agents/rules/local.md" }];
  const guest = [{ path: entries[0]!.displayPath, content: "x".repeat(15000) }];
  const f = await fixture(guest, entries);
  try {
    await fs.mkdir(path.join(f.home, ".agents/rules"), { recursive: true });
    await fs.writeFile(path.join(f.home, ".agents/rules/global.md"), "g".repeat(1200));
    const context = await f.run(() => loadProjectContext(f.cwd));
    expect(context).toEqual([guest[0], { path: "~/.agents/rules/global.md", content: "g".repeat(1000) + "\n…(truncated)" }]);
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform === "win32")("sandbox ignores symlinked global guidance roots and agent instruction files", async () => {
  const f = await fixture([], []);
  try {
    const outside = path.join(f.root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.md"), "OUTSIDE-SECRET");
    await fs.mkdir(path.join(f.home, ".agents"));
    await fs.symlink(outside, path.join(f.home, ".agents/rules"));
    await fs.mkdir(path.join(f.home, ".jeo/agent"), { recursive: true });
    await fs.symlink(path.join(outside, "secret.md"), path.join(f.home, ".jeo/agent/AGENTS.md"));
    expect(await f.run(() => discoverAgentGuidanceFiles(f.cwd))).toEqual([]);
    expect(await f.run(() => loadProjectContext(f.cwd))).toEqual([]);
  } finally { await f.cleanup(); }
});
