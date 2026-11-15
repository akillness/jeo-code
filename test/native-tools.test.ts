import { test, expect } from "bun:test";
import { nativeToolSchemasFor, serializeToolCalls, normalizeNativeToolName, sanitizeGeminiToolParameters } from "../src/agent/tool-schemas";

test("nativeToolSchemasFor: always appends `done` and mirrors handler arg keys", () => {
  const schemas = nativeToolSchemasFor(["read", "bash"]);
  const names = schemas.map(s => s.name);
  expect(names).toContain("read");
  expect(names).toContain("bash");
  expect(names).toContain("done"); // always available so the model can finish natively
  const read = schemas.find(s => s.name === "read")!;
  // Arg keys MUST match the DEFAULT_TOOLS handler readers exactly (filePath, not file_path).
  expect(Object.keys(read.parameters.properties)).toContain("filePath");
  expect(read.parameters.required).toContain("filePath");
});

test("nativeToolSchemasFor: a read-only toolset exposes NO write/edit/bash natively", () => {
  // Read-only subagents (planner/architect/critic) must never get mutating tools on the
  // native channel — the schema list is built from the ACTIVE toolset, not a static mirror.
  const names = nativeToolSchemasFor(["read", "find", "search", "ls"]).map(s => s.name);
  expect(names).not.toContain("write");
  expect(names).not.toContain("edit");
  expect(names).not.toContain("bash");
  expect(names).not.toContain("delete");
  expect(names).toContain("done");
});

test("nativeToolSchemasFor: deduplicates and ignores unknown tool names", () => {
  const names = nativeToolSchemasFor(["read", "read", "bogus-tool"]).map(s => s.name);
  expect(names.filter(n => n === "read")).toHaveLength(1);
  expect(names).not.toContain("bogus-tool");
});

test("native delegation schemas expose spawning and detached control only when allowed", () => {
  const schemas = nativeToolSchemasFor(["task", "subagent"]);
  const task = schemas.find(s => s.name === "task")!;
  const subagent = schemas.find(s => s.name === "subagent")!;
  expect(task.parameters.properties).toMatchObject({
    role: { type: "string" }, task: { type: "string" }, context: { type: "string" },
    detached: { type: "boolean" }, tasks: { type: "array" }, justification: { type: "string" },
  });
  expect(subagent.parameters.properties).toMatchObject({
    action: { type: "string" }, id: { type: "string" }, ids: { type: "array" },
    message: { type: "string" }, timeoutMs: { type: "number" },
    verbosity: { type: "string" }, limit: { type: "number" },
  });
  expect(subagent.parameters.required).toContain("action");
  const names = nativeToolSchemasFor(["read"]).map(s => s.name);
  expect(names).not.toContain("task");
  expect(names).not.toContain("subagent");
});

// Gemini (antigravity) intermittently namespaces native functions under `default_api`
// (observed live: functionCall.name = "default_api:done") → engine rejected it as an
// unknown tool. serializeToolCalls must strip the namespace back to the bare tool name.
test("normalizeNativeToolName: strips the Gemini default_api namespace (dot and colon)", () => {
  expect(normalizeNativeToolName("default_api:done")).toBe("done");
  expect(normalizeNativeToolName("default_api.read")).toBe("read");
  expect(normalizeNativeToolName("default_api: search")).toBe("search");
  expect(normalizeNativeToolName("done")).toBe("done"); // unaffected
  expect(normalizeNativeToolName("read")).toBe("read");
});

test("serializeToolCalls: a default_api-namespaced call dispatches as the bare tool", () => {
  // The exact screenshot case: model called done but the name came back namespaced.
  expect(serializeToolCalls([{ tool: "default_api:done", arguments: { reason: "안녕하세요" } }]))
    .toBe(JSON.stringify({ tool: "done", arguments: { reason: "안녕하세요" } }));
  // A namespaced read normalizes too, single-call envelope.
  expect(serializeToolCalls([{ tool: "default_api.read", arguments: { filePath: "x" } }]))
    .toBe(JSON.stringify({ tool: "read", arguments: { filePath: "x" } }));
});

test("sanitizeGeminiToolParameters: adds properties to bare object types and strips empty required", () => {
  const raw = {
    type: "object",
    properties: {
      cmd: { type: "string" },
      env: { type: "object" },
      items: { type: "array", items: { type: "object" } },
    },
    required: [],
  };
  const sanitized = sanitizeGeminiToolParameters(raw);
  expect(sanitized.required).toBeUndefined();
  const props = sanitized.properties as any;
  expect(props.env).toEqual({ type: "object", properties: {} });
  expect(props.items).toEqual({ type: "array", items: { type: "object", properties: {} } });
});

function collectKeysDeep(node: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectKeysDeep(item, keys);
  } else if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      keys.add(k);
      collectKeysDeep(v, keys);
    }
  }
  return keys;
}

test("sanitizeGeminiToolParameters: strips unsupported JSON Schema keywords recursively across properties, items, anyOf, and oneOf", () => {
  const raw = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { Helper: { type: "string" } },
    title: "ToolInput",
    description: "Root tool parameters",
    type: "object",
    additionalProperties: false,
    default: {},
    examples: [{ score: 50 }],
    required: ["score", "mode", "tags", "choice", "variant"],
    properties: {
      score: {
        type: "number",
        description: "Bounded score",
        exclusiveMinimum: 0,
        exclusiveMaximum: 100,
        default: 10,
        examples: [25, 75],
        title: "Score",
      },
      mode: {
        const: "strict",
        description: "Constant mode",
        title: "Mode",
      },
      tags: {
        type: "array",
        description: "Tag objects",
        minItems: 1,
        maxItems: 5,
        default: [],
        items: {
          type: "object",
          additionalProperties: false,
          title: "TagItem",
          required: ["name", "weight"],
          properties: {
            name: {
              type: "string",
              minLength: 1,
              maxLength: 32,
              pattern: "^[a-z]+$",
              examples: ["alpha"],
            },
            weight: {
              type: "integer",
              exclusiveMinimum: 0,
              exclusiveMaximum: 100,
              default: 1,
            },
            kind: {
              const: "label",
              default: "label",
            },
          },
        },
      },
      choice: {
        description: "Union via anyOf",
        anyOf: [
          {
            type: "string",
            enum: ["fast", "accurate"],
            default: "fast",
            title: "PresetChoice",
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              threshold: {
                type: "number",
                exclusiveMinimum: 0,
                exclusiveMaximum: 100,
                examples: [0.5],
              },
              fixed: {
                const: 42,
              },
            },
            required: ["threshold"],
          },
        ],
      },
      variant: {
        description: "Union via oneOf",
        oneOf: [
          {
            const: "v1",
            title: "V1",
          },
          {
            type: "object",
            additionalProperties: false,
            $defs: { Nested: { type: "string" } },
            properties: {
              limit: {
                type: "integer",
                exclusiveMinimum: 0,
                exclusiveMaximum: 100,
              },
            },
            required: ["limit"],
          },
        ],
      },
    },
  };

  const sanitized = sanitizeGeminiToolParameters(raw);

  const allKeys = collectKeysDeep(sanitized);
  for (const forbidden of [
    "exclusiveMinimum",
    "exclusiveMaximum",
    "additionalProperties",
    "$schema",
    "$defs",
    "default",
    "examples",
    "title",
    "const",
    "oneOf",
  ]) {
    expect(allKeys.has(forbidden)).toBe(false);
  }

  expect(sanitized).toEqual({
    type: "object",
    description: "Root tool parameters",
    required: ["score", "mode", "tags", "choice", "variant"],
    properties: {
      score: {
        type: "number",
        description: "Bounded score",
        minimum: 0,
        maximum: 100,
      },
      mode: {
        type: "string",
        description: "Constant mode",
        enum: ["strict"],
      },
      tags: {
        type: "array",
        description: "Tag objects",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          required: ["name", "weight"],
          properties: {
            name: {
              type: "string",
              minLength: 1,
              maxLength: 32,
              pattern: "^[a-z]+$",
            },
            weight: {
              type: "integer",
              minimum: 0,
              maximum: 100,
            },
            kind: {
              type: "string",
              enum: ["label"],
            },
          },
        },
      },
      choice: {
        description: "Union via anyOf",
        anyOf: [
          {
            type: "string",
            enum: ["fast", "accurate"],
          },
          {
            type: "object",
            required: ["threshold"],
            properties: {
              threshold: {
                type: "number",
                minimum: 0,
                maximum: 100,
              },
              fixed: {
                type: "string",
                enum: ["42"],
              },
            },
          },
        ],
      },
      variant: {
        description: "Union via oneOf",
        anyOf: [
          {
            type: "string",
            enum: ["v1"],
          },
          {
            type: "object",
            required: ["limit"],
            properties: {
              limit: {
                type: "integer",
                minimum: 0,
                maximum: 100,
              },
            },
          },
        ],
      },
    },
  });
});

test("sanitizeGeminiToolParameters: normalizes nullable type arrays and collapses nullable anyOf unions", () => {
  const sanitized = sanitizeGeminiToolParameters({
    type: "object",
    properties: {
      label: {
        type: ["string", "null"],
        description: "Optional label",
      },
      count: {
        anyOf: [
          { type: "integer", exclusiveMinimum: 1 },
          { type: "null" },
        ],
      },
    },
    required: ["label"],
  });

  expect(sanitized).toEqual({
    type: "object",
    required: ["label"],
    properties: {
      label: {
        type: "string",
        nullable: true,
        description: "Optional label",
      },
      count: {
        type: "integer",
        minimum: 1,
        nullable: true,
      },
    },
  });

  expect(sanitizeGeminiToolParameters({ type: ["string", "null"] })).toEqual({
    type: "string",
    nullable: true,
  });
  expect(
    sanitizeGeminiToolParameters({
      anyOf: [{ type: "integer", exclusiveMinimum: 1 }, { type: "null" }],
    }),
  ).toEqual({
    type: "integer",
    minimum: 1,
    nullable: true,
  });
});
