import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ProjectContextFile {
  path: string;
  content: string;
}

export const CONTEXT_CANDIDATES = ["JEO.md", "AGENTS.md", ".joc/context.md", "CLAUDE.md"];
export const AGENT_GUIDANCE_DIRS = [".agents/rules", ".joc/rules", ".agents/hooks"] as const;
const PER_CONTEXT_FILE_CHARS = 16_000;
const TOTAL_CONTEXT_CHARS = 64_000;
const BASE_CONTEXT_CHARS = 48_000;
const GUIDANCE_CONTEXT_CHARS = TOTAL_CONTEXT_CHARS - BASE_CONTEXT_CHARS;
const MAX_AGENT_GUIDANCE_FILES = 20;
const AGENT_GUIDANCE_EXTENSIONS = new Set([".md", ".json", ".jsonc", ".yaml", ".yml", ".toml"]);

async function readContextFile(filePath: string, displayPath: string, remainingChars: number): Promise<ProjectContextFile | null> {
  if (remainingChars <= 0) return null;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const content = await fs.readFile(filePath, "utf-8");
    if (content.length <= 0) return null;
    const cap = Math.min(PER_CONTEXT_FILE_CHARS, remainingChars);
    const finalContent = content.length > cap ? content.slice(0, cap) + "\n…(truncated)" : content;
    return { path: displayPath.replace(/\\/g, "/"), content: finalContent };
  } catch {
    return null;
  }
}

async function collectTextFiles(rootDir: string, displayPrefix: string, maxDepth: number, out: Array<{ filePath: string; displayPath: string }>): Promise<void> {
  if (out.length >= MAX_AGENT_GUIDANCE_FILES || maxDepth < 0) return;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fs.readdir(rootDir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_AGENT_GUIDANCE_FILES) return;
    const filePath = path.join(rootDir, entry.name);
    const displayPath = `${displayPrefix}/${entry.name}`.replace(/\\/g, "/");
    if (entry.isDirectory()) {
      await collectTextFiles(filePath, displayPath, maxDepth - 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (AGENT_GUIDANCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push({ filePath, displayPath });
  }
}

export async function discoverAgentGuidanceFiles(cwd = process.cwd()): Promise<Array<{ filePath: string; displayPath: string }>> {
  const out: Array<{ filePath: string; displayPath: string }> = [];
  const home = path.join(process.env.HOME || "", "");
  for (const rel of [".agents/oma-config.yaml", ".agents/oma-config.yml", ".agents/hooks/core/triggers.json"]) {
    const filePath = path.join(cwd, rel);
    try {
      const st = await fs.stat(filePath);
      if (st.isFile() && st.size > 0) out.push({ filePath, displayPath: rel.replace(/\\/g, "/") });
    } catch { /* optional */ }
  }
  const roots = [
    { rootDir: path.join(cwd, ".agents", "rules"), displayPrefix: ".agents/rules" },
    { rootDir: path.join(cwd, ".joc", "rules"), displayPrefix: ".joc/rules" },
    { rootDir: path.join(cwd, ".agents", "hooks"), displayPrefix: ".agents/hooks" },
    { rootDir: path.join(home, ".agents", "rules"), displayPrefix: "~/.agents/rules" },
    { rootDir: path.join(home, ".joc", "rules"), displayPrefix: "~/.joc/rules" },
    { rootDir: path.join(home, ".agents", "hooks"), displayPrefix: "~/.agents/hooks" },
  ];
  for (const root of roots) {
    await collectTextFiles(root.rootDir, root.displayPrefix, 2, out);
  }
  const seen = new Set<string>();
  return out.filter(entry => {
    const key = entry.displayPath.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_AGENT_GUIDANCE_FILES);
}


export async function loadProjectContext(cwd = process.cwd()): Promise<ProjectContextFile[]> {
  const result: ProjectContextFile[] = [];
  let baseChars = 0;
  let guidanceChars = 0;
  const addBaseFile = async (relPath: string) => {
    const file = await readContextFile(path.join(cwd, relPath), relPath, BASE_CONTEXT_CHARS - baseChars);
    if (!file) return;
    result.push(file);
    baseChars += file.content.length;
  };
  const addGuidanceFile = async (filePath: string, displayPath: string) => {
    const file = await readContextFile(filePath, displayPath, GUIDANCE_CONTEXT_CHARS - guidanceChars);
    if (!file) return;
    result.push(file);
    guidanceChars += file.content.length;
  };

  for (const candidate of CONTEXT_CANDIDATES) {
    await addBaseFile(candidate);
  }

  // GJC/OMA parity: skill docs are loaded by `skills/catalog.ts`; hook/rule guidance is
  // separate project policy. Keep a reserved guidance budget so large root context files do
  // not completely crowd out `.agents` / `.joc` rules and hooks.
  for (const entry of await discoverAgentGuidanceFiles(cwd)) {
    await addGuidanceFile(entry.filePath, entry.displayPath);
    if (guidanceChars >= GUIDANCE_CONTEXT_CHARS) break;
  }

  return result;
}

export function withProjectContext(systemPrompt: string, contextFiles: ProjectContextFile[]): string {
  if (!contextFiles || contextFiles.length === 0) {
    return systemPrompt;
  }

  let contextBlock = "<project_context>\n\nProject-specific instructions and guidelines:\n";
  for (const file of contextFiles) {
    contextBlock += `\n<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n`;
  }
  contextBlock += "</project_context>";

  return `${systemPrompt}\n\n${contextBlock}`;
}
