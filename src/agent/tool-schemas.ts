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
    description: "Read a file. Optional lineRange ('a-b','a-','a','a+n','a-b,c-d'); raw=true skips line-number prefixes; summary=true emits TS/JS AST declaration summaries with recovery line ranges.",
    parameters: {
      type: "object",
      properties: { filePath: STRING, lineRange: STRING, raw: { type: "boolean" }, summary: { type: "boolean" } },
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
      properties: { command: STRING, timeoutMs: { type: "number" }, cwd: STRING, env: { type: "object", properties: {} } },
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
  computer: {
    name: "computer",
    description: "Execute desktop automation actions (screenshot, click, double_click, move, drag, scroll, type, keypress, wait, batch).",
    parameters: {
      type: "object",
      properties: {
        action: STRING,
        x: { type: "number" },
        y: { type: "number" },
        text: STRING,
        key: STRING,
        deltaX: { type: "number" },
        deltaY: { type: "number" },
        duration: { type: "number" },
        actions: { type: "array", items: { type: "object", properties: { action: STRING } } },
      },
      required: ["action"],
    },
  },
  calc: {
    name: "calc",
    description: "Evaluate one or more arithmetic expressions (+ - * / % **, parens, hex/binary/octal literals, scientific notation). Each result is prefix+value+suffix.",
    parameters: {
      type: "object",
      properties: {
        calculations: {
          type: "array",
          items: {
            type: "object",
            properties: { expression: STRING, prefix: STRING, suffix: STRING },
            required: ["expression"],
          },
        },
      },
      required: ["calculations"],
    },
  },
  monitor: {
    name: "monitor",
    description: "Start or control a session-scoped background monitor; output lines arrive asynchronously as notices.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "list", "tail", "await", "cancel"] },
        command: STRING,
        cwd: STRING,
        persistent: { type: "boolean" },
        timeout: { type: "number", exclusiveMinimum: 0, description: "Optional monitor lifetime in seconds (finite and positive); distinct from the await timeoutMs." },
        ids: { type: "array", items: STRING },
        id: STRING,
        timeoutMs: { type: "number" },
      },
      required: ["action"],
    },
  },
  sandbox_request: {
    name: "sandbox_request",
    description: "Request an additional session sandbox mount with host and mode ro|rw, or inspect grants and their guest paths with action=status. This tool cannot approve, reject, or revoke access; only authenticated human /sandbox controls can do that.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["request", "status"] },
        host: STRING,
        mode: { type: "string", enum: ["ro", "rw"] },
      },
    },
  },
  done: {
    name: "done",
    description: "Call when the task is fully implemented AND verified. The reason is shown to the user as your message.",
    parameters: { type: "object", properties: { reason: STRING } },
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

/**
 * Re-serialize parsed native tool calls into the engine's canonical JSON string. Coalesces
 * a batched `done` to a single envelope (the engine rejects done-in-batch). Returns null
 * when there are no calls. Shared by capable provider adapters (antigravity/openai/…).
 */
export function serializeToolCalls(calls: { tool: string; arguments: Record<string, unknown> }[]): string | null {
  // Gemini (antigravity) intermittently namespaces native functions under `default_api`
  // (e.g. functionCall.name = "default_api.done" / "default_api:done") when handed raw
  // functionDeclarations, which the engine then rejects as an unknown tool. Strip that
  // namespace back to the bare tool name so the call dispatches normally.
  const valid = calls
    .map(c => ({ ...c, tool: normalizeNativeToolName(c.tool) }))
    .filter(c => c.tool);
  if (valid.length === 0) return null;
  const done = valid.find(c => c.tool === "done");
  if (done) return JSON.stringify(done);
  if (valid.length === 1) return JSON.stringify(valid[0]);
  return JSON.stringify({ tools: valid });
}

/** Strip the Gemini `default_api.` / `default_api:` namespace prefix from a tool name. */
export function normalizeNativeToolName(name: string): string {
  return (name ?? "").replace(/^default_api\s*[.:]\s*/, "").trim();
}

/**
 * Re-serialize a streamed native tool-call accumulator (name + raw-JSON-args string per
 * output index — the shape every streaming adapter builds) into the engine's canonical
 * JSON. Bad arg JSON degrades to `{}` rather than dropping the call. Returns null when empty.
 */
export function serializeAccumulatedToolCalls(acc: Map<number, { name: string; args: string }>): string | null {
  const calls = [...acc.values()].map(b => {
    let args: Record<string, unknown> = {};
    try { args = b.args ? JSON.parse(b.args) : {}; } catch { args = {}; }
    return { tool: b.name, arguments: args };
  });
  return serializeToolCalls(calls);
}

/**
 * Sanitize a JSON-schema parameters object for Google Gemini / Antigravity function declarations:
 * - Every `type: "object"` MUST specify a `properties` map (empty `{}` if absent)
 * - Empty `required: []` arrays are removed (Google schema validator rejects or misbehaves on them)
 * - Recursively walks nested objects, array items, and properties.
 */
export function sanitizeGeminiToolParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const copy: Record<string, unknown> = { ...schema };
  if (copy.type === "object") {
    if (!copy.properties || typeof copy.properties !== "object" || Array.isArray(copy.properties)) {
      copy.properties = {};
    } else {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(copy.properties as Record<string, unknown>)) {
        props[k] = sanitizeGeminiToolParameters(v as Record<string, unknown>);
      }
      copy.properties = props;
    }
  }
  if (copy.type === "array" && copy.items && typeof copy.items === "object" && !Array.isArray(copy.items)) {
    copy.items = sanitizeGeminiToolParameters(copy.items as Record<string, unknown>);
  }
  if (Array.isArray(copy.required) && copy.required.length === 0) {
    delete copy.required;
  }
  return copy;
}
