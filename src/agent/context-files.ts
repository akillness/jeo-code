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
const MAX_AGENT_GUIDANCE_FILES = 20;
const AGENT_GUIDANCE_EXTENSIONS = new Set([".md", ".json", ".jsonc", ".yaml", ".yml", ".toml"]);

async function readContextFile(cwd: string, relPath: string, remainingChars: number): Promise<ProjectContextFile | null> {
  if (remainingChars <= 0) return null;
  const filePath = path.join(cwd, relPath);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const content = await fs.readFile(filePath, "utf-8");
    if (content.length <= 0) return null;
    const cap = Math.min(PER_CONTEXT_FILE_CHARS, remainingChars);
    const finalContent = content.length > cap ? content.slice(0, cap) + "\n…(truncated)" : content;
    return { path: relPath.replace(/\\/g, "/"), content: finalContent };
  } catch {
    return null;
  }
}

async function collectTextFiles(cwd: string, relDir: string, maxDepth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_AGENT_GUIDANCE_FILES || maxDepth < 0) return;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fs.readdir(path.join(cwd, relDir), { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_AGENT_GUIDANCE_FILES) return;
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      await collectTextFiles(cwd, rel, maxDepth - 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (AGENT_GUIDANCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(rel);
  }
}

export async function discoverAgentGuidanceFiles(cwd = process.cwd()): Promise<string[]> {
  const out: string[] = [];
  for (const rel of [".agents/oma-config.yaml", ".agents/oma-config.yml", ".agents/hooks/core/triggers.json"]) {
    try {
      const st = await fs.stat(path.join(cwd, rel));
      if (st.isFile() && st.size > 0) out.push(rel);
    } catch { /* optional */ }
  }
  for (const dir of AGENT_GUIDANCE_DIRS) {
    await collectTextFiles(cwd, dir, dir.endsWith("/hooks") ? 2 : 0, out);
  }
  const seen = new Set<string>();
  return out.filter(rel => {
    const key = rel.replace(/\\/g, "/");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(rel => rel.replace(/\\/g, "/")).slice(0, MAX_AGENT_GUIDANCE_FILES);
}


export async function loadProjectContext(cwd = process.cwd()): Promise<ProjectContextFile[]> {
  const result: ProjectContextFile[] = [];
  let usedChars = 0;
  const addFile = async (relPath: string) => {
    const file = await readContextFile(cwd, relPath, TOTAL_CONTEXT_CHARS - usedChars);
    if (!file) return;
    result.push(file);
    usedChars += file.content.length;
  };

  for (const candidate of CONTEXT_CANDIDATES) {
    await addFile(candidate);
  }

  // GJC/OMA parity: skill docs are loaded by `skills/catalog.ts`; hook/rule guidance is
  // separate project policy. Load a small, bounded set so `.agents/rules/*.md` and
  // `.agents/hooks/**/{*.json,*.md}` influence the session without unbounded prompt bloat.
  for (const rel of await discoverAgentGuidanceFiles(cwd)) {
    await addFile(rel);
    if (usedChars >= TOTAL_CONTEXT_CHARS) break;
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
