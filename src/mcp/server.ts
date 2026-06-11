import {
  fail,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  ok,
  PARSE_ERROR,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolDefinition,
} from "./protocol";
import { TOOLS } from "./tools";

const SERVER_INFO = { name: "joc-mcp", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

interface ServerOptions {
  tools?: ToolDefinition[];
  log?: (line: string) => void;
}

export async function runMcpServer(options: ServerOptions = {}): Promise<void> {
  const tools = options.tools ?? TOOLS;
  const log = options.log ?? (line => process.stderr.write(`${line}\n`));
  log(`joc-mcp v${SERVER_INFO.version} listening on stdio (${tools.length} tools)`);

  let buffer = "";
  const decoder = new TextDecoder();

  for await (const chunk of (process.stdin as unknown as AsyncIterable<Uint8Array>)) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let response: JsonRpcResponse | null = null;
      try {
        response = await handleLine(line, tools);
      } catch (err) {
        // A bad line must never kill the stdin read loop (the whole server).
        response = fail(null, INTERNAL_ERROR, (err as Error)?.message ?? "internal error");
      }
      if (response) writeResponse(response);
    }
  }
}

export async function handleLine(line: string, tools: ToolDefinition[]): Promise<JsonRpcResponse | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail(null, PARSE_ERROR, "invalid JSON");
  }
  // `null`, arrays, and primitives are valid JSON but not JSON-RPC requests — accessing
  // `req.jsonrpc` on them would throw and (without the loop guard) kill the server.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(null, INVALID_REQUEST, "malformed JSON-RPC request");
  }
  const req = parsed as JsonRpcRequest;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return fail(req.id ?? null, INVALID_REQUEST, "malformed JSON-RPC request");
  }

  try {
    switch (req.method) {
      case "initialize":
        return ok(req.id ?? null, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "initialized":
      case "notifications/initialized":
        return null;
      case "ping":
        return ok(req.id ?? null, {});
      case "tools/list":
        return ok(req.id ?? null, {
          tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call":
        return await handleToolCall(req, tools);
      default:
        return fail(req.id ?? null, METHOD_NOT_FOUND, `unknown method: ${req.method}`);
    }
  } catch (err) {
    return fail(req.id ?? null, INTERNAL_ERROR, (err as Error).message);
  }
}

async function handleToolCall(req: JsonRpcRequest, tools: ToolDefinition[]): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  if (!params.name) return fail(req.id ?? null, INVALID_PARAMS, "'name' is required");
  const tool = tools.find(t => t.name === params.name);
  if (!tool) return fail(req.id ?? null, METHOD_NOT_FOUND, `unknown tool: ${params.name}`);
  const result = await tool.handler(params.arguments ?? {});
  return ok(req.id ?? null, result);
}

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
