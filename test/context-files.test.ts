import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadProjectContext,
  withProjectContext,
  CONTEXT_CANDIDATES
} from "../src/agent/context-files";

const savedHome = process.env.HOME;
beforeEach(() => {
  delete process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "joc-context-test-"));
}

test("loadProjectContext returns empty array and withProjectContext returns prompt unchanged when no files exist", async () => {
  const tmpDir = await createTempDir();
  try {
    const context = await loadProjectContext(tmpDir);
    expect(context).toEqual([]);

    const systemPrompt = "You are a helpful assistant.";
    const resultPrompt = withProjectContext(systemPrompt, context);
    expect(resultPrompt).toBe(systemPrompt);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext loads AGENTS.md with correct relative path and content", async () => {
  const tmpDir = await createTempDir();
  try {
    const agentsContent = "Agents guidelines";
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), agentsContent, "utf-8");

    const context = await loadProjectContext(tmpDir);
    expect(context).toHaveLength(1);
    expect(context[0]).toEqual({
      path: "AGENTS.md",
      content: agentsContent,
    });

    const systemPrompt = "System instructions";
    const resultPrompt = withProjectContext(systemPrompt, context);
    expect(resultPrompt).toContain("<project_context>");
    expect(resultPrompt).toContain("<project_instructions path=\"AGENTS.md\">");
    expect(resultPrompt).toContain(agentsContent);
    expect(resultPrompt).toContain("</project_instructions>");
    expect(resultPrompt).toContain("</project_context>");
    expect(resultPrompt.startsWith(systemPrompt)).toBe(true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext returns multiple files in priority order", async () => {
  const tmpDir = await createTempDir();
  try {
    const jeoContent = "JEO instructions";
    const agentsContent = "Agents instructions";
    const claudeContent = "Claude instructions";

    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), agentsContent, "utf-8");
    await fs.writeFile(path.join(tmpDir, "JEO.md"), jeoContent, "utf-8");
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), claudeContent, "utf-8");

    const context = await loadProjectContext(tmpDir);
    expect(context).toHaveLength(3);
    // Order should match CONTEXT_CANDIDATES priority: "JEO.md", "AGENTS.md", "CLAUDE.md"
    expect(context[0].path).toBe("JEO.md");
    expect(context[0].content).toBe(jeoContent);
    expect(context[1].path).toBe("AGENTS.md");
    expect(context[1].content).toBe(agentsContent);
    expect(context[2].path).toBe("CLAUDE.md");
    expect(context[2].content).toBe(claudeContent);

    // Test withProjectContext with multiple files
    const systemPrompt = "System instructions";
    const resultPrompt = withProjectContext(systemPrompt, context);
    const expectedBlock = 
      "System instructions\n\n" +
      "<project_context>\n\n" +
      "Project-specific instructions and guidelines:\n\n" +
      "<project_instructions path=\"JEO.md\">\n" +
      "JEO instructions\n" +
      "</project_instructions>\n\n" +
      "<project_instructions path=\"AGENTS.md\">\n" +
      "Agents instructions\n" +
      "</project_instructions>\n\n" +
      "<project_instructions path=\"CLAUDE.md\">\n" +
      "Claude instructions\n" +
      "</project_instructions>\n" +
      "</project_context>";
    expect(resultPrompt).toBe(expectedBlock);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext handles truncation of files larger than 16000 characters", async () => {
  const tmpDir = await createTempDir();
  try {
    const longContent = "A".repeat(20000);
    await fs.writeFile(path.join(tmpDir, "JEO.md"), longContent, "utf-8");

    const context = await loadProjectContext(tmpDir);
    expect(context).toHaveLength(1);
    expect(context[0].path).toBe("JEO.md");
    
    const expectedContent = "A".repeat(16000) + "\n…(truncated)";
    expect(context[0].content).toBe(expectedContent);
    expect(context[0].content.endsWith("\n…(truncated)")).toBe(true);
    expect(context[0].content.length).toBe(16000 + "\n…(truncated)".length);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext ignores directories and empty files", async () => {
  const tmpDir = await createTempDir();
  try {
    // Create a directory named "JEO.md" instead of a file
    await fs.mkdir(path.join(tmpDir, "JEO.md"));
    // Create an empty "AGENTS.md" file
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "", "utf-8");
    // Create a non-empty CLAUDE.md
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), "valid content", "utf-8");

    const context = await loadProjectContext(tmpDir);
    expect(context).toHaveLength(1);
    expect(context[0].path).toBe("CLAUDE.md");
    expect(context[0].content).toBe("valid content");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext loads bounded .agents rule and hook guidance after root context", async () => {
  const tmpDir = await createTempDir();
  try {
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "root rules", "utf-8");
    await fs.mkdir(path.join(tmpDir, ".agents", "rules"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".agents", "hooks", "core"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".agents", "rules", "frontend.md"), "frontend rule", "utf-8");
    await fs.writeFile(path.join(tmpDir, ".agents", "hooks", "core", "triggers.json"), "{\"slash\":\"/work\"}", "utf-8");

    const context = await loadProjectContext(tmpDir);

    expect(context.map(c => c.path)).toEqual([
      "AGENTS.md",
      ".agents/hooks/core/triggers.json",
      ".agents/rules/frontend.md",
    ]);
    expect(context[1].content).toContain("/work");
    expect(context[2].content).toBe("frontend rule");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext reserves guidance budget so large root files do not crowd out .agents rules", async () => {
  const tmpDir = await createTempDir();
  try {
    await fs.writeFile(path.join(tmpDir, "JEO.md"), "A".repeat(40_000), "utf-8");
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "B".repeat(40_000), "utf-8");
    await fs.mkdir(path.join(tmpDir, ".agents", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".agents", "rules", "huge.md"), "C".repeat(40_000), "utf-8");

    const context = await loadProjectContext(tmpDir);
    const total = context.reduce((sum, c) => sum + c.content.length, 0);

    expect(total).toBeLessThanOrEqual(64_000 + "\n…(truncated)".length * 4);
    expect(context.some(c => c.path === ".agents/rules/huge.md")).toBe(true);
    expect(context.some(c => c.content.includes("…(truncated)"))).toBe(true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext also scans global ~/.agents guidance files", async () => {
  const tmpDir = await createTempDir();
  const fakeHome = await createTempDir();
  process.env.HOME = fakeHome;
  try {
    await fs.mkdir(path.join(fakeHome, ".agents", "rules"), { recursive: true });
    await fs.mkdir(path.join(fakeHome, ".agents", "hooks", "core"), { recursive: true });
    await fs.writeFile(path.join(fakeHome, ".agents", "rules", "global.md"), "global rule", "utf-8");
    await fs.writeFile(path.join(fakeHome, ".agents", "hooks", "core", "trigger.json"), "{\"name\":\"global\"}", "utf-8");

    const context = await loadProjectContext(tmpDir);

    expect(context.map(c => c.path)).toContain("~/.agents/rules/global.md");
    expect(context.map(c => c.path)).toContain("~/.agents/hooks/core/trigger.json");
  } finally {
    await fs.rm(fakeHome, { recursive: true, force: true });
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext walks up to parent to find AGENTS.md, JEO.md, CLAUDE.md", async () => {
  const tmpDir = await createTempDir();
  const subDir = path.join(tmpDir, "level1", "level2");
  await fs.mkdir(subDir, { recursive: true });

  try {
    // Create AGENTS.md at tmpDir (parent of level1)
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "parent agents content", "utf-8");
    // Create JEO.md at level1
    await fs.writeFile(path.join(tmpDir, "level1", "JEO.md"), "level1 jeo content", "utf-8");
    // Create CLAUDE.md at level2 (CWD)
    await fs.writeFile(path.join(subDir, "CLAUDE.md"), "cwd claude content", "utf-8");

    const context = await loadProjectContext(subDir);
    expect(context.map(c => c.path)).toEqual([
      "CLAUDE.md",
      "../JEO.md",
      "../../AGENTS.md"
    ]);
    expect(context[0].content).toBe("cwd claude content");
    expect(context[1].content).toBe("level1 jeo content");
    expect(context[2].content).toBe("parent agents content");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext stops parent walk at git root", async () => {
  const tmpDir = await createTempDir();
  const gitRoot = path.join(tmpDir, "git-project");
  const subDir = path.join(gitRoot, "src", "sub");
  await fs.mkdir(subDir, { recursive: true });
  await fs.mkdir(path.join(gitRoot, ".git"), { recursive: true });

  try {
    // Write AGENTS.md outside git root
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "outside git content", "utf-8");
    // Write AGENTS.md at git root
    await fs.writeFile(path.join(gitRoot, "AGENTS.md"), "git root agents", "utf-8");
    // Write CLAUDE.md in CWD
    await fs.writeFile(path.join(subDir, "CLAUDE.md"), "cwd claude", "utf-8");

    const context = await loadProjectContext(subDir);
    expect(context.map(c => c.path)).toEqual([
      "CLAUDE.md",
      "../../AGENTS.md" // gitRoot/AGENTS.md
    ]);
    // The one outside git root should NOT be collected
    expect(context.some(c => c.content === "outside git content")).toBe(false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext stops parent walk at $HOME and excludes $HOME itself", async () => {
  const tmpDir = await createTempDir();
  const fakeHome = path.join(tmpDir, "fake-home");
  const subDir = path.join(fakeHome, "project", "src");
  await fs.mkdir(subDir, { recursive: true });
  
  process.env.HOME = fakeHome;

  try {
    // Write AGENTS.md at fakeHome ($HOME)
    await fs.writeFile(path.join(fakeHome, "AGENTS.md"), "home agents content", "utf-8");
    // Write AGENTS.md at project level
    await fs.writeFile(path.join(fakeHome, "project", "AGENTS.md"), "project agents content", "utf-8");
    // Write JEO.md in CWD
    await fs.writeFile(path.join(subDir, "JEO.md"), "cwd jeo content", "utf-8");

    const context = await loadProjectContext(subDir);
    expect(context.map(c => c.path)).toEqual([
      "JEO.md",
      "../AGENTS.md" // project/AGENTS.md
    ]);
    // The one in $HOME should NOT be collected
    expect(context.some(c => c.content === "home agents content")).toBe(false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext recursively scans down for nested AGENTS.md up to depth 3 and respects IGNORED_DIRS", async () => {
  const tmpDir = await createTempDir();
  const d1 = path.join(tmpDir, "d1");
  const d2 = path.join(d1, "d2");
  const d3 = path.join(d2, "d3");
  const d4 = path.join(d3, "d4");
  const ignored = path.join(tmpDir, "node_modules");

  await fs.mkdir(d4, { recursive: true });
  await fs.mkdir(ignored, { recursive: true });

  try {
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), "cwd content", "utf-8");
    await fs.writeFile(path.join(d1, "AGENTS.md"), "d1 content", "utf-8");
    await fs.writeFile(path.join(d2, "AGENTS.md"), "d2 content", "utf-8");
    await fs.writeFile(path.join(d3, "AGENTS.md"), "d3 content", "utf-8");
    await fs.writeFile(path.join(d4, "AGENTS.md"), "d4 content", "utf-8");
    await fs.writeFile(path.join(ignored, "AGENTS.md"), "ignored content", "utf-8");

    const context = await loadProjectContext(tmpDir);
    const paths = context.map(c => c.path);

    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("d1/AGENTS.md");
    expect(paths).toContain("d1/d2/AGENTS.md");
    expect(paths).toContain("d1/d2/d3/AGENTS.md");
    
    // depth 4 should NOT be loaded
    expect(paths).not.toContain("d1/d2/d3/d4/AGENTS.md");
    // node_modules should NOT be loaded
    expect(paths).not.toContain("node_modules/AGENTS.md");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadProjectContext prioritizes closer and deeper files when budget is exceeded", async () => {
  const tmpDir = await createTempDir();
  
  const grandparentDir = tmpDir;
  const parentDir = path.join(grandparentDir, "parent");
  const cwdDir = path.join(parentDir, "cwd");
  const d1 = path.join(cwdDir, "d1");
  const d2 = path.join(d1, "d2");
  const d3 = path.join(d2, "d3");

  await fs.mkdir(d3, { recursive: true });

  try {
    const content15k = "A".repeat(15000);
    await fs.writeFile(path.join(cwdDir, "CLAUDE.md"), content15k, "utf-8");
    await fs.writeFile(path.join(d3, "AGENTS.md"), content15k, "utf-8");
    await fs.writeFile(path.join(d2, "AGENTS.md"), content15k, "utf-8");
    await fs.writeFile(path.join(d1, "AGENTS.md"), content15k, "utf-8");
    await fs.writeFile(path.join(parentDir, "AGENTS.md"), content15k, "utf-8");
    await fs.writeFile(path.join(grandparentDir, "AGENTS.md"), content15k, "utf-8");

    const context = await loadProjectContext(cwdDir);
    
    expect(context.map(c => c.path)).toEqual([
      "CLAUDE.md",
      "d1/d2/d3/AGENTS.md",
      "d1/d2/AGENTS.md",
      "d1/AGENTS.md"
    ]);

    const clFile = context.find(c => c.path === "CLAUDE.md")!;
    expect(clFile.content).toBe(content15k);

    const d3File = context.find(c => c.path === "d1/d2/d3/AGENTS.md")!;
    expect(d3File.content).toBe(content15k);

    const d2File = context.find(c => c.path === "d1/d2/AGENTS.md")!;
    expect(d2File.content).toBe(content15k);

    const d1File = context.find(c => c.path === "d1/AGENTS.md")!;
    expect(d1File.content.length).toBe(3000 + "\n…(truncated)".length);
    expect(d1File.content.endsWith("\n…(truncated)")).toBe(true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
