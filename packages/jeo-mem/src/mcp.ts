import type { Database } from "bun:sqlite";
import { indexDir } from "./indexer.ts";
import { impact, search, whatCalls, whereDefined, whoCalls } from "./query.ts";

export const MCP_TOOLS = [
  {
    name: "jeox_where_defined",
    description: "Look up where a symbol (function, class, interface, type, etc.) is defined.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name" },
        limit: { type: "integer", default: 5 },
      },
      required: ["name"],
    },
  },
  {
    name: "jeox_who_calls",
    description: "Look up functions, methods, or modules that call, import, or extend the given symbol.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name" },
        limit: { type: "integer", default: 5 },
        strict: { type: "boolean", default: false, description: "Filter out ambiguous name-only guesses" },
      },
      required: ["name"],
    },
  },
  {
    name: "jeox_what_calls",
    description: "Look up functions or symbols called by the given caller symbol.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Caller symbol name" },
        limit: { type: "integer", default: 5 },
        strict: { type: "boolean", default: false, description: "Filter out ambiguous name-only guesses" },
      },
      required: ["name"],
    },
  },
  {
    name: "jeox_impact",
    description: "Reverse dependency closure: find files, tests, and symbols affected by modifying target symbol or file.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Symbol name or relative file path" },
        depth: { type: "integer", default: 3 },
        limit: { type: "integer", default: 20 },
        strict: { type: "boolean", default: false },
      },
      required: ["target"],
    },
  },
  {
    name: "jeox_search",
    description: "BM25 full-text search across indexed symbols and markdown documentation chunks.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "integer", default: 5 },
      },
      required: ["query"],
    },
  },
  {
    name: "jeox_build",
    description: "Incremental build/reindex of the code graph and search database.",
    inputSchema: {
      type: "object",
      properties: {
        rebuild: { type: "boolean", default: false, description: "Full rebuild if true" },
      },
    },
  },
];

export async function runMcpServer(db: Database, root: string): Promise<void> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  const reply = (id: unknown, result?: unknown, error?: { code: number; message: string }) => {
    const payload = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result };
    process.stdout.write(JSON.stringify(payload) + "\n");
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: any;
    try {
      req = JSON.parse(trimmed);
    } catch {
      reply(null, undefined, { code: -32700, message: "Parse error" });
      continue;
    }

    const { id, method, params } = req;
    if (method === "initialize") {
      reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "jeo-mem", version: "0.1.0" },
      });
    } else if (method === "tools/list") {
      reply(id, { tools: MCP_TOOLS });
    } else if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      try {
        let content: unknown;
        switch (toolName) {
          case "jeox_where_defined":
          case "where_defined":
            content = whereDefined(db, args.name, args.limit ?? 5);
            break;
          case "jeox_who_calls":
          case "who_calls":
            content = whoCalls(db, args.name, { limit: args.limit ?? 5, strict: !!args.strict });
            break;
          case "jeox_what_calls":
          case "what_calls":
            content = whatCalls(db, args.name, { limit: args.limit ?? 5, strict: !!args.strict });
            break;
          case "jeox_impact":
          case "impact":
            content = impact(db, args.target ?? args.name, args.depth ?? 3, args.limit ?? 20, !!args.strict);
            break;
          case "jeox_search":
          case "search":
          case "query":
            content = search(db, args.query ?? args.q, args.limit ?? 5);
            break;
          case "jeox_build":
          case "build":
          case "index":
            content = indexDir(db, root, { rebuild: !!args.rebuild });
            break;
          default:
            reply(id, undefined, { code: -32601, message: `Unknown tool: ${toolName}` });
            continue;
        }
        reply(id, {
          content: [{ type: "text", text: JSON.stringify(content, null, 2) }],
        });
      } catch (err: any) {
        reply(id, undefined, { code: -32603, message: err?.message || String(err) });
      }
    } else if (method && method.startsWith("notifications/")) {
      // Ignore notifications
    } else {
      reply(id, undefined, { code: -32601, message: `Method not found: ${method}` });
    }
  }
}
