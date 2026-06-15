import type { NativeToolSchema } from "../ai/types";

/**
 * Native function-calling schemas for jeo's tools, keyed by canonical tool name.
 *
 * The `properties` keys MUST match the argument names the DEFAULT_TOOLS handlers read
 * (engine.ts) EXACTLY — a renamed parameter would land in a key the handler ignores and
 * silently no-op the call. The model fills an API-validated schema, so this registry is
 * the single source of truth for argument names on the native path.
 */
const STRING = { type: "string" } as const;

const SCHEMAS: Record<string, NativeToolSchema> = {
  read: {
    name: "read",
    description: "Read a file. Optional lineRange ('a-b','a-','a','a+n','a-b,c-d'); raw=true skips line-number prefixes.",
    parameters: {
      type: "object",
      properties: { filePath: STRING, lineRange: STRING, raw: { type: "boolean" } },
      required: ["filePath"],
    },
  },
  write: {
    name: "write",
    description: "Create or overwrite a file with the given content.",
    parameters: { type: "object", properties: { filePath: STRING, content: STRING }, required: ["filePath", "content"] },
  },
  edit: {
    name: "edit",
    description: "Apply a line-anchored edit block to a file (≔A..B replace, ≔A+ insert after, ≔$ append).",
    parameters: { type: "object", properties: { filePath: STRING, editBlock: STRING }, required: ["filePath", "editBlock"] },
  },
  bash: {
    name: "bash",
    description: "Run a shell command. Optional timeoutMs, cwd (subdir), env (extra vars).",
    parameters: {
      type: "object",
      properties: { command: STRING, timeoutMs: { type: "number" }, cwd: STRING, env: { type: "object" } },
      required: ["command"],
    },
  },
  find: {
    name: "find",
    description: "Find files by glob pattern.",
    parameters: { type: "object", properties: { globPattern: STRING }, required: ["globPattern"] },
  },
  search: {
    name: "search",
    description: "Search file contents by regex (grep). Optional globPattern, ignoreCase, context, maxMatches.",
    parameters: {
      type: "object",
      properties: {
        pattern: STRING,
        globPattern: STRING,
        ignoreCase: { type: "boolean" },
        context: { type: "number" },
        maxMatches: { type: "number" },
      },
      required: ["pattern"],
    },
  },
  ls: {
    name: "ls",
    description: "List a directory's entries (directories first).",
    parameters: { type: "object", properties: { dirPath: STRING }, required: ["dirPath"] },
  },
  mkdir: {
    name: "mkdir",
    description: "Create a directory (parents included; idempotent).",
    parameters: { type: "object", properties: { dirPath: STRING }, required: ["dirPath"] },
  },
  delete: {
    name: "delete",
    description: "Remove a file, or a directory when recursive=true.",
    parameters: { type: "object", properties: { path: STRING, recursive: { type: "boolean" } }, required: ["path"] },
  },
  web_search: {
    name: "web_search",
    description: "Search the web (synthesized answer + sources + citations). Optional recency, limit.",
    parameters: { type: "object", properties: { query: STRING, recency: STRING, limit: { type: "number" } }, required: ["query"] },
  },
  done: {
    name: "done",
    description: "Call when the task is fully implemented AND verified. The reason is shown to the user as your message.",
    parameters: { type: "object", properties: { reason: STRING }, required: [] },
  },
};

/**
 * Build the native tool-schema list for the ACTIVE toolset. Pass the real tool names the
 * turn is allowed to use (Object.keys of the engine's toolset); `done` is always appended
 * so the model can signal completion natively. Read-only subagents therefore expose only
 * their non-mutating tools — never write/edit/bash — on the native channel.
 */
export function nativeToolSchemasFor(toolNames: Iterable<string>): NativeToolSchema[] {
  const out: NativeToolSchema[] = [];
  const seen = new Set<string>();
  for (const name of toolNames) {
    const schema = SCHEMAS[name];
    if (schema && !seen.has(name)) {
      out.push(schema);
      seen.add(name);
    }
  }
  if (!seen.has("done")) out.push(SCHEMAS.done!);
  return out;
}
