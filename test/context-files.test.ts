import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadProjectContext,
  withProjectContext,
  CONTEXT_CANDIDATES
} from "../src/agent/context-files";

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

test("loadProjectContext caps total project guidance so hook/rule files cannot bloat the prompt", async () => {
  const tmpDir = await createTempDir();
  try {
    await fs.writeFile(path.join(tmpDir, "JEO.md"), "A".repeat(40_000), "utf-8");
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "B".repeat(40_000), "utf-8");
    await fs.mkdir(path.join(tmpDir, ".agents", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".agents", "rules", "huge.md"), "C".repeat(40_000), "utf-8");

    const context = await loadProjectContext(tmpDir);
    const total = context.reduce((sum, c) => sum + c.content.length, 0);

    expect(total).toBeLessThanOrEqual(64_000 + "\n…(truncated)".length);
    expect(context.some(c => c.content.includes("…(truncated)"))).toBe(true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
