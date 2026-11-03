import type { SandboxExecResult } from "./types";

// Match the existing messenger worker transport bound, measured before UTF-8 decoding.
export const MAX_FRAME_BYTES = 1_000_000;

export type HandsRequest =
  | { id: string; type: "tool"; tool: string; args: Record<string, unknown>; cwd?: string }
  | { id: string; type: "exec"; argv: string[]; cwd?: string; env?: Record<string, string>; stdin?: string };
export type HandsResponse =
  | { id: string; type: "progress"; text: string }
  | { id: string; type: "result"; result: SandboxExecResult };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeHandsFrame(value: unknown): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) throw new Error("SANDBOX_PROTOCOL: frame size limit exceeded");
  return `${text}\n`;
}

export async function* readHandsFrames(input: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = input.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pieces: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      let start = 0;
      for (let index = 0; index <= chunk.value.byteLength; index++) {
        const complete = index < chunk.value.byteLength && chunk.value[index] === 10;
        if (!complete && index !== chunk.value.byteLength) continue;
        const part = chunk.value.subarray(start, index);
        size += part.byteLength;
        if (size > MAX_FRAME_BYTES) throw new Error("SANDBOX_PROTOCOL: frame size limit exceeded");
        if (part.byteLength) pieces.push(part);
        if (complete) {
          try { yield JSON.parse(decoder.decode(Buffer.concat(pieces, size))); }
          catch (error) { throw new Error("SANDBOX_PROTOCOL: malformed JSON frame", { cause: error }); }
          pieces = [];
          size = 0;
          start = index + 1;
        }
      }
    }
    if (size) throw new Error("SANDBOX_PROTOCOL: incomplete frame at EOF");
  } finally { reader.releaseLock(); }
}

export function parseHandsRequest(value: unknown): HandsRequest {
  if (!record(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value.id)) {
    throw new Error("SANDBOX_PROTOCOL: invalid request identity");
  }
  if (value.type === "tool" && typeof value.tool === "string" && record(value.args) &&
      (value.cwd === undefined || (typeof value.cwd === "string" && !value.cwd.includes("\0"))) &&
      Object.keys(value).every(key => ["id", "type", "tool", "args", "cwd"].includes(key))) {
    return { id: value.id, type: "tool", tool: value.tool, args: value.args, ...(value.cwd !== undefined ? { cwd: value.cwd } : {}) };
  }
  if (value.type === "exec" && Array.isArray(value.argv) && value.argv.length > 0 &&
      value.argv.every(arg => typeof arg === "string" && !arg.includes("\0")) &&
      (value.cwd === undefined || typeof value.cwd === "string") &&
      (value.stdin === undefined || typeof value.stdin === "string") &&
      (value.env === undefined || (record(value.env) && Object.values(value.env).every(item => typeof item === "string" && !item.includes("\0")))) &&
      Object.keys(value).every(key => ["id", "type", "argv", "cwd", "env", "stdin"].includes(key))) {
    return { id: value.id, type: "exec", argv: value.argv, ...(value.cwd !== undefined ? { cwd: value.cwd } : {}), ...(value.stdin !== undefined ? { stdin: value.stdin } : {}), ...(value.env !== undefined ? { env: value.env as Record<string, string> } : {}) };
  }
  throw new Error("SANDBOX_PROTOCOL: invalid request frame");
}

export function parseHandsResponse(value: unknown): HandsResponse {
  if (!record(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value.id)) throw new Error("SANDBOX_PROTOCOL: invalid response identity");
  if (value.type === "progress" && typeof value.text === "string" && Object.keys(value).every(key => ["id", "type", "text"].includes(key))) {
    return { id: value.id, type: "progress", text: value.text };
  }
  const result = value.result;
  if (value.type === "result" && record(result) && typeof result.success === "boolean" && typeof result.output === "string" &&
      (result.error === undefined || typeof result.error === "string") &&
      (result.mutationMayHaveOccurred === undefined || typeof result.mutationMayHaveOccurred === "boolean") &&
      (result.images === undefined || (Array.isArray(result.images) && result.images.every(image => record(image) && typeof image.mediaType === "string" && /^image\/[a-zA-Z0-9.+-]+$/.test(image.mediaType) && typeof image.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)))) &&
      ["stdout", "stderr"].every(key => result[key] === undefined || typeof result[key] === "string") &&
      (result.exitCode === undefined || result.exitCode === null || Number.isInteger(result.exitCode)) &&
      ["timedOut", "aborted"].every(key => result[key] === undefined || typeof result[key] === "boolean") &&
      Object.keys(value).every(key => ["id", "type", "result"].includes(key))) {
    return { id: value.id, type: "result", result: result as unknown as SandboxExecResult };
  }
  throw new Error("SANDBOX_PROTOCOL: invalid response frame");
}
