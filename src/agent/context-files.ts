import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ProjectContextFile {
  path: string;
  content: string;
}

export const CONTEXT_CANDIDATES = ["JEO.md", "AGENTS.md", ".joc/context.md", "CLAUDE.md"];

export async function loadProjectContext(cwd = process.cwd()): Promise<ProjectContextFile[]> {
  const result: ProjectContextFile[] = [];

  for (const candidate of CONTEXT_CANDIDATES) {
    const filePath = path.join(cwd, candidate);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.size > 0) {
        const content = await fs.readFile(filePath, "utf-8");
        if (content.length > 0) {
          let finalContent = content;
          if (content.length > 16000) {
            finalContent = content.slice(0, 16000) + "\n…(truncated)";
          }
          result.push({
            path: candidate,
            content: finalContent,
          });
        }
      }
    } catch (err) {
      // Skip missing, unreadable, or directories/empty files
    }
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
