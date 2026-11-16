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
  task: {
    name: "task",
    description: "Delegate a single assignment or a bounded fan-out to subagents. Use detached=true only for a single assignment; manage detached runs with subagent.",
    parameters: {
      type: "object",
      properties: {
        role: STRING,
        task: STRING,
        context: STRING,
        detached: { type: "boolean" },
        tasks: {
          type: "array",
          items: { anyOf: [STRING, { type: "object", properties: { task: STRING, context: STRING }, required: ["task"] }] },
        },
        justification: STRING,
      },
    },
  },
  subagent: {
    name: "subagent",
    description: "List, inspect, await, cancel, steer, pause or resume detached subagents launched by task.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "inspect", "await", "cancel", "steer", "pause", "resume"] },
        id: STRING,
        ids: { type: "array", items: STRING },
        message: STRING,
        verbosity: { type: "string", enum: ["receipt", "preview", "full"] },
        limit: { type: "number" },
        timeoutMs: { type: "number" },
      },
      required: ["action"],
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
  jeox: {
    name: "jeox",
    description: "Code graph and BM25 search database. Actions: who-calls, what-calls, where-defined, impact, search, scope, build, status.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["who-calls", "what-calls", "where-defined", "impact", "search", "scope", "build", "status"],
        },
        name: STRING,
        target: STRING,
        query: STRING,
        limit: { type: "number" },
        strict: { type: "boolean" },
        depth: { type: "number" },
        rebuild: { type: "boolean" },
      },
      required: ["action"],
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
 * Fields permitted by Google's Gemini / Cloud Code Assist `Schema` proto.
 * Anything outside this allowlist (e.g. `exclusiveMinimum`, `exclusiveMaximum`,
 * `additionalProperties`, `$schema`, `$defs`, `default`, `examples`, `title`, `const`)
 * triggers HTTP 400 INVALID_ARGUMENT ("Unknown name ... Cannot find field").
 */
const GEMINI_SCHEMA_ALLOWED_FIELDS = new Set<string>([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "propertyOrdering",
  "items",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minProperties",
  "maxProperties",
  "anyOf",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Sanitize a JSON-schema parameters object for Google Gemini / Antigravity function declarations:
 * - Strips every JSON Schema keyword not in Google's `Schema` proto (`exclusiveMinimum`,
 *   `exclusiveMaximum`, `additionalProperties`, `$schema`, `$defs`, `default`, `const`, etc.)
 * - Normalizes `type: ["string", "null"]`, `const`, `oneOf` → `anyOf`, and nullable unions
 * - Ensures every `type: "object"` has a `properties` map (empty `{}` if absent)
 * - Removes empty `required: []` arrays
 * - Recursively sanitizes `properties`, `items`, and `anyOf` branches.
 */
export function sanitizeGeminiToolParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!isPlainObject(schema)) return { type: "object", properties: {} };

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (GEMINI_SCHEMA_ALLOWED_FIELDS.has(k) && v !== undefined) {
      out[k] = v;
    }
  }

  // Preserve numeric exclusiveMinimum/exclusiveMaximum bounds as inclusive minimum/maximum when absent.
  if (typeof schema.exclusiveMinimum === "number" && out.minimum === undefined) {
    out.minimum = schema.exclusiveMinimum;
  }
  if (typeof schema.exclusiveMaximum === "number" && out.maximum === undefined) {
    out.maximum = schema.exclusiveMaximum;
  }

  // Convert JSON Schema `const` to a 1-element string enum if no enum is present.
  if (schema.const !== undefined && out.enum === undefined) {
    out.enum = [String(schema.const)];
    if (out.type === undefined) out.type = "string";
  }

  // Normalize type arrays such as ["string", "null"].
  if (Array.isArray(out.type)) {
    const rawTypes = out.type.filter((t): t is string => typeof t === "string");
    const nonNull = rawTypes.filter(t => t !== "null");
    if (rawTypes.includes("null")) out.nullable = true;
    if (nonNull.length === 1) {
      out.type = nonNull[0];
    } else if (nonNull.length > 1) {
      delete out.type;
      if (!Array.isArray(out.anyOf)) {
        out.anyOf = nonNull.map(t => ({ type: t }));
      }
    } else {
      out.type = "string";
    }
  }

  // Google Schema.enum only accepts string values.
  if (Array.isArray(out.enum)) {
    out.enum = out.enum.map(v => String(v));
  }

  // Convert `oneOf` to `anyOf` (Google Schema supports `anyOf`, not `oneOf`).
  if (!Array.isArray(out.anyOf) && Array.isArray(schema.oneOf)) {
    out.anyOf = schema.oneOf;
  }

  // Recursively sanitize `anyOf` branches and collapse `[T, { type: "null" }]` into nullable T.
  if (Array.isArray(out.anyOf)) {
    const nonNullBranches: Record<string, unknown>[] = [];
    let sawNull = false;
    for (const branch of out.anyOf) {
      if (isPlainObject(branch) && branch.type === "null") {
        sawNull = true;
        continue;
      }
      nonNullBranches.push(sanitizeGeminiToolParameters(isPlainObject(branch) ? branch : undefined));
    }
    if (nonNullBranches.length === 1 && sawNull) {
      delete out.anyOf;
      for (const [bk, bv] of Object.entries(nonNullBranches[0])) {
        if (out[bk] === undefined) out[bk] = bv;
      }
      out.nullable = true;
    } else if (nonNullBranches.length > 0) {
      out.anyOf = nonNullBranches;
    } else {
      delete out.anyOf;
    }
  }

  // Recursively sanitize object properties.
  if (out.type === "object" || isPlainObject(out.properties)) {
    if (!isPlainObject(out.properties)) {
      out.properties = {};
    } else {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(out.properties)) {
        props[k] = sanitizeGeminiToolParameters(isPlainObject(v) ? v : undefined);
      }
      out.properties = props;
    }
  }

  // Recursively sanitize array items (whether `type: "array"` or `items` is present).
  if (isPlainObject(out.items)) {
    out.items = sanitizeGeminiToolParameters(out.items);
  } else if (Array.isArray(out.items)) {
    // Tuple-style items array is unsupported by Google Schema; collapse to first item schema.
    out.items = out.items.length > 0 && isPlainObject(out.items[0])
      ? sanitizeGeminiToolParameters(out.items[0])
      : { type: "string" };
  }

  // Remove empty required arrays (and filter to declared properties when present).
  if (Array.isArray(out.required)) {
    const declared = isPlainObject(out.properties) ? out.properties : undefined;
    const filtered = out.required.filter(
      (r): r is string => typeof r === "string" && (!declared || Object.keys(declared).length === 0 || r in declared),
    );
    if (filtered.length === 0) {
      delete out.required;
    } else {
      out.required = filtered;
    }
  }

  return out;
}
