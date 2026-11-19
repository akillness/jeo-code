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

export const MAX_MCP_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_HEADER_BYTES = 16 * 1024; // 16 KiB
const MAX_BUFFER_BYTES = MAX_MCP_FRAME_BYTES + MAX_HEADER_BYTES + 4;
const CRLF_SEP = Buffer.from("\r\n\r\n", "ascii");
const LF_SEP = Buffer.from("\n\n", "ascii");

interface IncomingMessage {
  payload: string;
  framed: boolean;
}

export interface DrainError {
  message: string;
  framed: boolean;
}

export interface DrainBufferResult {
  messages: IncomingMessage[];
  remaining: Buffer;
  error?: DrainError;
}

export async function runMcpServer(options: ServerOptions = {}): Promise<void> {
  const tools = options.tools ?? TOOLS;
  const log = options.log ?? (line => process.stderr.write(`${line}\n`));
  log(`jeo-mcp v${SERVER_INFO.version} listening on stdio (${tools.length} tools)`);

  let buffer: Buffer = Buffer.alloc(0);

  for await (const chunk of (process.stdin as unknown as AsyncIterable<Uint8Array>)) {
    const chunkBuf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (chunkBuf.length === 0) continue;

    buffer = buffer.length === 0 ? Buffer.from(chunkBuf) : Buffer.concat([buffer, chunkBuf]);
    while (buffer.length > 0) {
      const drained = drainIncomingBuffer(buffer);
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

      if (drained.error) {
        writeResponse(fail(null, INVALID_REQUEST, drained.error.message), drained.error.framed);
        if (buffer.length > 0) continue;
      }
      break;
    }

    if (buffer.length > MAX_BUFFER_BYTES) {
      buffer = Buffer.alloc(0);
      writeResponse(fail(null, INVALID_REQUEST, `MCP frame buffer exceeded ${MAX_BUFFER_BYTES} bytes`), true);
    } else if (buffer.length === 0) {
      buffer = Buffer.alloc(0);
    } else if (buffer.buffer.byteLength > 64 * 1024 && buffer.length * 4 < buffer.buffer.byteLength) {
      // Release oversized backing ArrayBuffer slabs once drained.
      buffer = Buffer.from(buffer);
    }
  }
}

export function drainIncomingMessages(
  buffer: string,
  maxFrameBytes = MAX_MCP_FRAME_BYTES,
): { messages: IncomingMessage[]; remaining: string; error?: DrainError } {
  const result = drainIncomingBuffer(Buffer.from(buffer, "utf8"), maxFrameBytes);
  const remaining = result.remaining.toString("utf8");
  if (result.error) {
    return { messages: result.messages, remaining, error: result.error };
  }
  return { messages: result.messages, remaining };
}

export function drainIncomingBuffer(
  buffer: Buffer,
  maxFrameBytes = MAX_MCP_FRAME_BYTES,
): DrainBufferResult {
  const messages: IncomingMessage[] = [];
  let remaining = buffer;

  while (remaining.length > 0) {
    const frame = readContentLengthFrame(remaining, maxFrameBytes);
    if (frame === "incomplete") break;
    if (frame && "error" in frame) {
      return { messages, remaining: frame.remaining, error: { message: frame.error, framed: true } };
    }
    if (frame) {
      messages.push({ payload: frame.payload, framed: true });
      remaining = frame.remaining;
      continue;
    }

    const newlineIndex = remaining.indexOf(0x0a);
    if (newlineIndex === -1) {
      if (remaining.length > maxFrameBytes) {
        return {
          messages,
          remaining: Buffer.alloc(0),
          error: { message: `MCP message exceeded max frame size (${maxFrameBytes} bytes)`, framed: false },
        };
      }
      break;
    }
    if (newlineIndex > maxFrameBytes) {
      return {
        messages,
        remaining: remaining.subarray(newlineIndex + 1),
        error: { message: `MCP message exceeded max frame size (${maxFrameBytes} bytes)`, framed: false },
      };
    }
    const line = remaining.subarray(0, newlineIndex).toString("utf8").trim();
    remaining = remaining.subarray(newlineIndex + 1);
    if (line) messages.push({ payload: line, framed: false });
  }

  return { messages, remaining };
}

function readContentLengthFrame(
  buffer: Buffer,
  maxFrameBytes: number,
): { payload: string; remaining: Buffer } | { error: string; remaining: Buffer } | "incomplete" | null {
  const headerEnd = findHeaderEnd(buffer);
  if (headerEnd === null) {
    if (looksLikeHeaderPrefix(buffer)) {
      if (buffer.length > MAX_HEADER_BYTES) {
        return {
          error: `MCP header exceeded ${MAX_HEADER_BYTES} bytes without terminator`,
          remaining: Buffer.alloc(0),
        };
      }
      return "incomplete";
    }
    return null;
  }

  if (headerEnd.index > MAX_HEADER_BYTES) {
    return {
      error: `MCP header exceeded ${MAX_HEADER_BYTES} bytes`,
      remaining: Buffer.alloc(0),
    };
  }

  const header = buffer.subarray(0, headerEnd.index).toString("utf8");
  const contentLength = parseContentLength(header);
  if (contentLength === null) return null;

  const bodyStart = headerEnd.index + headerEnd.separatorLength;
  if (contentLength > maxFrameBytes) {
    const frameEnd = bodyStart + contentLength;
    const nextRemaining = frameEnd <= buffer.length ? buffer.subarray(frameEnd) : Buffer.alloc(0);
    return {
      error: `MCP Content-Length ${contentLength} exceeds max frame size (${maxFrameBytes} bytes)`,
      remaining: nextRemaining,
    };
  }

  if (buffer.length - bodyStart < contentLength) return "incomplete";

  const frameEnd = bodyStart + contentLength;
  return {
    payload: buffer.subarray(bodyStart, frameEnd).toString("utf8"),
    remaining: buffer.subarray(frameEnd),
  };
}

function findHeaderEnd(buffer: Buffer): { index: number; separatorLength: number } | null {
  const crlf = buffer.indexOf(CRLF_SEP);
  const lf = buffer.indexOf(LF_SEP);
  if (crlf === -1 && lf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, separatorLength: 4 };
  return { index: lf, separatorLength: 2 };
}

function looksLikeHeaderPrefix(buffer: Buffer): boolean {
  const head = buffer.subarray(0, Math.min(buffer.length, 256)).toString("utf8");
  return /^content-length\s*:/i.test(head) || /^[A-Za-z-]+\s*:/i.test(head);
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
