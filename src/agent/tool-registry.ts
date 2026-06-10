import { readTool, writeTool, editTool, bashTool, findTool, searchTool, lsTool, type ToolResult } from "./tools";

export type ToolHandler = (args: Record<string, any>, cwd: string) => Promise<ToolResult>;

export const DEFAULT_TOOLS: Record<string, ToolHandler> = {
  read: (a, cwd) => readTool(a.filePath ?? a.path, a.lineRange ?? a.range, cwd, !!a.raw),
  write: (a, cwd) => writeTool(a.filePath ?? a.path, a.content ?? "", cwd),
  edit: (a, cwd) => editTool(a.filePath ?? a.path, a.editBlock ?? a.edit ?? "", cwd),
  bash: (a, cwd) => bashTool(a.command ?? a.cmd, cwd, typeof a.timeoutMs === "number" ? a.timeoutMs : undefined, typeof a.cwd === "string" ? a.cwd : (typeof a.subdir === "string" ? a.subdir : undefined), a.env && typeof a.env === "object" ? a.env : undefined),
  find: (a, cwd) => findTool(a.globPattern ?? a.pattern, cwd),
  search: (a, cwd) => searchTool(a.pattern, a.globPattern ?? "*", cwd, !!(a.ignoreCase ?? a.i), { before: a.before, after: a.after, context: a.context, maxMatches: a.maxMatches }),
  ls: (a, cwd) => lsTool(a.dirPath ?? a.path ?? a.dir ?? ".", cwd),
};

export const TOOL_PROTOCOL = [
  "You have these tools (call exactly ONE per step):",
  "1. read   {filePath, lineRange?, raw?} — read a file",
  "2. write  {filePath, content}         — create/overwrite a file",
  "3. edit   {filePath, editBlock}       — replace/insert lines",
  "4. bash   {command, timeoutMs?, cwd?, env?} — run a shell command",
  "5. find   {globPattern}               — find files by name",
  "6. search {pattern, globPattern?, ignoreCase?, context?, maxMatches?} — grep",
  "7. ls     {dirPath}                   — list a directory",
  "8. done   {reason?}                   — call when done",
  "",
  "Reply with STRICT JSON only:",
  '{ "tool": "<name>", "arguments": { ... } }',
].join("\n");

export const READONLY_TOOL_PROTOCOL = [
  "You have these READ-ONLY tools:",
  "1. read   {filePath, lineRange?}      — read a file",
  "2. find   {globPattern}               — find files by name",
  "3. search {pattern, globPattern?, ignoreCase?} — grep",
  "4. ls     {dirPath}                   — list a directory",
  "5. done   {reason?}                   — call when complete",
  "",
  "Reply with STRICT JSON only:",
  '{ "tool": "<name>", "arguments": { ... } }',
].join("\n");

export function nearestToolName(name: string, known: string[]): string | undefined {
  const want = name.trim().toLowerCase();
  if (!want) return undefined;
  let best: string | undefined;
  let bestD = Infinity;
  for (const k of known) {
    const kl = k.toLowerCase();
    if (kl === want) return k;
    const d = kl.startsWith(want) || want.startsWith(kl) ? 1 : 10;
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= 2 ? best : undefined;
}
