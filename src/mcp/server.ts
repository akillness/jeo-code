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

const SERVER_INFO = { name: "jeo-mcp", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

interface ServerOptions {
  tools?: ToolDefinition[];
  log?: (line: string) => void;
}

interface IncomingMessage {
  payload: string;
  framed: boolean;
}

export async function runMcpServer(options: ServerOptions = {}): Promise<void> {
  const tools = options.tools ?? TOOLS;
  const log = options.log ?? (line => process.stderr.write(`${line}\n`));
  log(`jeo-mcp v${SERVER_INFO.version} listening on stdio (${tools.length} tools)`);

  let buffer = "";
  const decoder = new TextDecoder();

  for await (const chunk of (process.stdin as unknown as AsyncIterable<Uint8Array>)) {
    buffer += decoder.decode(chunk, { stream: true });
    const drained = drainIncomingMessages(buffer);
    buffer = drained.remaining;
    for (const message of drained.messages) {
      let response: JsonRpcResponse | null = null;
      try {
        response = await handleLine(message.payload, tools);
      } catch (err) {
        // A bad request must never kill the stdin read loop (the whole server).
        response = fail(null, INTERNAL_ERROR, (err as Error)?.message ?? "internal error");
      }
      if (response) writeResponse(response, message.framed);
    }
  }
}

export function drainIncomingMessages(buffer: string): { messages: IncomingMessage[]; remaining: string } {
  const messages: IncomingMessage[] = [];
  let remaining = buffer;

  while (remaining.length > 0) {
    const frame = readContentLengthFrame(remaining);
    if (frame === "incomplete") break;
    if (frame) {
      messages.push({ payload: frame.payload, framed: true });
      remaining = frame.remaining;
      continue;
    }

    const newlineIndex = remaining.indexOf("\n");
    if (newlineIndex === -1) break;
    const line = remaining.slice(0, newlineIndex).trim();
    remaining = remaining.slice(newlineIndex + 1);
    if (line) messages.push({ payload: line, framed: false });
  }

  return { messages, remaining };
}

function readContentLengthFrame(buffer: string): { payload: string; remaining: string } | "incomplete" | null {
  const headerEnd = findHeaderEnd(buffer);
  if (headerEnd === null) return looksLikeHeaderPrefix(buffer) ? "incomplete" : null;

  const header = buffer.slice(0, headerEnd.index);
  const contentLength = parseContentLength(header);
  if (contentLength === null) return null;

  const bodyStart = headerEnd.index + headerEnd.separator.length;
  const body = buffer.slice(bodyStart);
  const bodyByteLength = Buffer.byteLength(body, "utf8");
  if (bodyByteLength < contentLength) return "incomplete";

  const split = splitAtUtf8ByteLength(body, contentLength);
  if (!split) return null;

  return {
    payload: split.prefix,
    remaining: split.suffix,
  };
}

function splitAtUtf8ByteLength(input: string, byteLength: number): { prefix: string; suffix: string } | null {
  if (byteLength === 0) return { prefix: "", suffix: input };

  let bytes = 0;
  let endIndex = 0;
  for (const char of input) {
    bytes += Buffer.byteLength(char, "utf8");
    endIndex += char.length;
    if (bytes === byteLength) return { prefix: input.slice(0, endIndex), suffix: input.slice(endIndex) };
    if (bytes > byteLength) return null;
  }
  return null;
}

function findHeaderEnd(buffer: string): { index: number; separator: "\r\n\r\n" | "\n\n" } | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, separator: "\r\n\r\n" };
  return { index: lf, separator: "\n\n" };
}

function looksLikeHeaderPrefix(buffer: string): boolean {
  return /^content-length\s*:/i.test(buffer) || /^[A-Za-z-]+\s*:/i.test(buffer);
}

function parseContentLength(header: string): number | null {
  for (const line of header.split(/\r?\n/)) {
    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line);
    if (!match) continue;
    const length = Number(match[1]);
    return Number.isSafeInteger(length) && length >= 0 ? length : null;
  }
  return null;
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

function writeResponse(response: JsonRpcResponse, framed: boolean): void {
  const json = JSON.stringify(response);
  if (framed) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
    return;
  }
  process.stdout.write(`${json}\n`);
}
