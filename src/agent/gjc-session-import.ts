import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import type { Dirent } from "node:fs";
import * as path from "node:path";

import {
  findImportedSessionByProvenance,
  newSessionId,
  sessionPath,
  type SessionHeader,
} from "./session";
import type { Message, ToolResultRecord, ToolUseRecord } from "../ai/types";

export interface GjcImportEnv {
  [key: string]: string | undefined;
}

export interface GjcSessionLeaf {
  rootPath: string;
  sourcePath: string;
  sessionId: string;
  leafId: string;
  cwd: string;
  selected: boolean;
}

export interface ListGjcSessionsOptions {
  /** Explicitly injected roots for tests; highest precedence. */
  roots?: string[];
  /** Include all source session leaves regardless of `cwd` filter. */
  anyCwd?: boolean;
  /** Working directory for `cwd` filtering. */
  cwd?: string;
  /** Environment override for tests. */
  env?: GjcImportEnv;
}

export interface ResolveGjcSessionOptions extends ListGjcSessionsOptions {}

export interface ImportGjcSessionOptions {
  sessionId: string;
  leafId?: string;
  roots?: string[];
  cwd?: string;
  anyCwd?: boolean;
  env?: GjcImportEnv;
}

export type GjcSessionRefResolution =
  | { kind: "ok"; match: GjcSessionLeaf }
  | { kind: "ambiguous-session"; matches: string[] }
  | { kind: "ambiguous-leaf"; matches: string[] }
  | { kind: "not-found" };

export interface ImportGjcSessionResult {
  sessionId: string;
  path: string;
  sourceSessionId: string;
  sourceLeafId: string;
  sourceSha256: string;
  reused: boolean;
  createdAt: string;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface ParsedSourceHeader {
  sessionId: string;
  version: number;
  cwd: string;
  title?: string;
  selectedLeafId?: string;
}

interface SourceNode {
  id: string;
  type: string;
  parentId?: string;
  raw: JsonRecord;
  sourceLine: number;
}

interface ParsedCompaction {
  firstKeptEntryId: string;
  summary?: string;
  sourceLine: number;
}

interface ParsedModelChange {
  role: "default" | "omitted";
  model?: string;
}

interface ParsedSourceSession {
  sourcePath: string;
  sourceBytes: Buffer;
  header: ParsedSourceHeader;
  nodes: Map<string, SourceNode>;
  leaves: string[];
  compactions: ParsedCompaction[];
}

interface ParsedEntryParts {
  sourceRole: string;
  content: string;
  reasoning: string;
  images: Array<{ mediaType: string; data: string }>;
  toolCalls: ToolUseRecord[];
  toolResults: Array<{ id: string; output: string; isError: boolean }>;
}

interface ImageAttachmentLike {
  mediaType: string;
  data: string;
}

const SUPPORTED_VERSIONS = [5] as const;

function isObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isLikelyBase64Payload(data: string): boolean {
  const compact = data.replace(/\s+/g, "");
  if (compact.length === 0) return false;
  if (compact.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(compact);
}

function exists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}


function normalizeRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

export function resolveGjcCodingAgentRoots(
  opts: Pick<ListGjcSessionsOptions, "roots" | "env"> = {},
): string[] {
  const env = opts.env ?? process.env;

  if (opts.roots && opts.roots.length > 0) {
    return normalizeRoots(opts.roots);
  }

  const agentDir = env.GJC_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR;
  if (agentDir) return [path.resolve(agentDir, "sessions")];

  const home = env.HOME;
  if (!home) return [];

  const configName = env.GJC_CONFIG_DIR || env.PI_CONFIG_DIR || ".gjc";
  const xdgDataHome = env.XDG_DATA_HOME;
  if (xdgDataHome && fsSync.existsSync(path.join(xdgDataHome, "gjc"))) {
    return [path.join(xdgDataHome, "gjc", "sessions")];
  }

  return [path.join(home, configName, "agent", "sessions")];
}

interface PatchOp {
  path: string;
  value: unknown;
}

function readPatchOperations(raw: unknown, sourceFile: string, sourceLine: number): PatchOp[] {
  if (isObject(raw) && "op" in raw && "path" in raw) {
    const op = asTrimmedString(raw.op);
    const patchPath = asTrimmedString(raw.path);
    if (!op || !patchPath) {
      throw new Error(
        `Unsupported patch operation in ${path.basename(sourceFile)}:${sourceLine}: missing op/path`,
      );
    }
    if (op !== "replace" && op !== "add") {
      throw new Error(
        `Unsupported patch operation '${op}' in ${path.basename(sourceFile)}:${sourceLine}.`,
      );
    }
    return [{ path: patchPath, value: (raw as JsonRecord).value }];
  }

  if (Array.isArray(raw)) {
    return raw.map((entry, index) => {
      if (!isObject(entry)) {
        throw new Error(
          `Malformed patch entry #${index} in ${path.basename(sourceFile)}:${sourceLine}: expected object`,
        );
      }
      const op = asTrimmedString(entry.op);
      const patchPath = asTrimmedString(entry.path);
      if (!op || !patchPath) {
        throw new Error(
          `Unsupported patch entry #${index} in ${path.basename(sourceFile)}:${sourceLine}: missing op/path`,
        );
      }
      if (op !== "replace" && op !== "add") {
        throw new Error(
          `Unsupported patch operation '${op}' in ${path.basename(sourceFile)}:${sourceLine}.`,
        );
      }
      return { path: patchPath, value: entry.value };
    });
  }

  if (isObject(raw) && "patch" in raw) {
    return readPatchOperations((raw as JsonRecord).patch, sourceFile, sourceLine);
  }

  if (isObject(raw)) {
    return Object.entries(raw).map(([key, value]) => ({ path: key.startsWith("/") ? key : `/${key}`, value }));
  }

  throw new Error(`Unsupported patch payload in ${path.basename(sourceFile)}:${sourceLine}.`);
}

function requireHeaderVersion(version: unknown, sourceFile: string): number {
  const numeric =
    typeof version === "number" ? version : typeof version === "string" ? Number(version) : Number.NaN;

  if (!Number.isInteger(numeric)) {
    throw new Error(`Malformed session header version in ${path.basename(sourceFile)}.`);
  }

  const parsed = numeric;
  const expected = SUPPORTED_VERSIONS[0];
  if (parsed !== expected) {
    if (parsed < expected) {
      throw new Error(
        `Unsupported GJC session version ${parsed} (too old) in ${path.basename(sourceFile)}.`,
      );
    }
    throw new Error(
      `Unsupported GJC session version ${parsed} (future) in ${path.basename(sourceFile)}.`,
    );
  }
  return parsed;
}

function applyHeaderPatch(
  header: ParsedSourceHeader,
  rawPatch: unknown,
  sourceFile: string,
  sourceLine: number,
): void {
  const ops = readPatchOperations(rawPatch, sourceFile, sourceLine);
  for (const op of ops) {
    if (!op.path.startsWith("/")) {
      throw new Error(`Unsupported header patch target '${op.path}' in ${path.basename(sourceFile)}:${sourceLine}.`);
    }

    if (op.path === "/selectedLeafId" || op.path === "/selected_leaf_id") {
      const next = asTrimmedString(op.value);
      if (!next) {
        throw new Error(`Unsupported header patch payload for ${op.path} in ${path.basename(sourceFile)}:${sourceLine}.`);
      }
      header.selectedLeafId = next;
      continue;
    }

    if (op.path === "/title") {
      if (op.value !== undefined && typeof op.value !== "string") {
        throw new Error(`Unsupported header patch payload for ${op.path} in ${path.basename(sourceFile)}:${sourceLine}.`);
      }
      header.title = asString(op.value)?.trim() || undefined;
      continue;
    }

    if (op.path === "/cwd") {
      const next = asTrimmedString(op.value);
      if (!next) {
        throw new Error(`Unsupported header patch payload for ${op.path} in ${path.basename(sourceFile)}:${sourceLine}.`);
      }
      header.cwd = next;
      continue;
    }

    throw new Error(`Unsupported header patch target '${op.path}' in ${path.basename(sourceFile)}:${sourceLine}.`);
  }
}

function applyEntryPatch(
  raw: JsonRecord,
  rawPatch: unknown,
  sourceFile: string,
  sourceLine: number,
): void {
  if (isObject(rawPatch) && "message" in rawPatch) {
    const message = rawPatch.message;
    if (!isObject(message) || typeof message.role !== "string" || !Object.prototype.hasOwnProperty.call(message, "content")) {
      throw new Error(`Unsupported entry patch message in ${path.basename(sourceFile)}:${sourceLine}.`);
    }
    raw.role = message.role;
    raw.content = message.content;
    delete raw.blocks;
    delete raw.reasoning;
    delete raw.images;
    for (const key of ["toolCallId", "toolName", "isError", "is_error", "output"]) {
      if (Object.prototype.hasOwnProperty.call(message, key)) raw[key] = message[key];
      else delete raw[key];
    }
    return;
  }
  const ops = readPatchOperations(rawPatch, sourceFile, sourceLine);
  for (const op of ops) {
    if (!op.path.startsWith("/")) {
      throw new Error(
        `Unsupported entry patch target '${op.path}' in ${path.basename(sourceFile)}:${sourceLine}.`,
      );
    }

    switch (op.path) {
      case "/content": {
        if (typeof op.value !== "string" && !Array.isArray(op.value)) {
          throw new Error(`Unsupported value for /content in ${path.basename(sourceFile)}:${sourceLine}.`);
        }
        raw.content = op.value;
        break;
      }
      case "/blocks": {
        if (!Array.isArray(op.value)) {
          throw new Error(`Unsupported value for /blocks in ${path.basename(sourceFile)}:${sourceLine}.`);
        }
        raw.blocks = op.value;
        break;
      }
      case "/role": {
        const next = asTrimmedString(op.value);
        if (!next) {
          throw new Error(`Unsupported value for /role in ${path.basename(sourceFile)}:${sourceLine}.`);
        }
        raw.role = next;
        break;
      }
      case "/text": {
        const next = asTrimmedString(op.value);
        if (!next) {
          throw new Error(`Unsupported value for /text in ${path.basename(sourceFile)}:${sourceLine}.`);
        }
        raw.content = [{ type: "text", text: next }];
        break;
      }
      case "/reasoning": {
        if (typeof op.value !== "string") {
          throw new Error(`Unsupported value for /reasoning in ${path.basename(sourceFile)}:${sourceLine}.`);
        }
        raw.reasoning = op.value;
        break;
      }
      case "/images": {
        if (!Array.isArray(op.value)) {
          throw new Error(`Unsupported value for /images in ${path.basename(sourceFile)}:${sourceLine}.`);
        }
        raw.images = op.value;
        break;
      }
      default:
        throw new Error(
          `Unsupported entry patch target '${op.path}' in ${path.basename(sourceFile)}:${sourceLine}.`,
        );
    }
  }
}

function parseModelChange(raw: JsonRecord, sourceFile: string, sourceLine: number): ParsedModelChange {
  const rawRole = asTrimmedString(raw.role)?.toLowerCase() ?? "default";
  if (rawRole !== "default" && rawRole !== "omitted") {
    throw new Error(
      `Unsupported model_change role '${rawRole}' in ${path.basename(sourceFile)}:${sourceLine}.`,
    );
  }

  if (rawRole === "omitted") {
    return { role: "omitted" };
  }

  const model = asTrimmedString(raw.model) ?? asTrimmedString(raw.value);
  if (!model) {
    throw new Error(
      `Missing model in model_change record in ${path.basename(sourceFile)}:${sourceLine}.`,
    );
  }

  return { role: "default", model };
}

function parseParentId(raw: JsonRecord): string | undefined {
  const parent = (raw as JsonRecord).parent ?? (raw as JsonRecord).parent_id ?? (raw as JsonRecord).parentId;
  if (parent == null) return undefined;

  const parentId = asTrimmedString(parent);
  if (!parentId) {
    if (parent === null) return undefined;
    throw new Error(`Malformed parent link ${String(parent)}.`);
  }
  return parentId;
}

function parseBlocks(raw: JsonRecord, sourceFile: string, sourceLine: number): unknown[] {
  if (Object.prototype.hasOwnProperty.call(raw, "blocks")) {
    const blocks = raw.blocks;
    if (blocks === undefined) return [];
    if (!Array.isArray(blocks)) {
      throw new Error(
        `Malformed blocks field in ${path.basename(sourceFile)}:${sourceLine}.`,
      );
    }
    return blocks;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "content")) {
    const content = raw.content;
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    if (Array.isArray(content)) {
      return content;
    }
    if (content === undefined) {
      return [];
    }
    throw new Error(
      `Malformed content field in ${path.basename(sourceFile)}:${sourceLine}.`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(raw, "text")) {
    if (typeof raw.text === "string") {
      return [{ type: "text", text: raw.text }];
    }
    if (raw.text === undefined) {
      return [];
    }
    throw new Error(
      `Malformed text field in ${path.basename(sourceFile)}:${sourceLine}.`,
    );
  }

  return [];
}

function parseImageBlock(
  block: JsonRecord,
  sourceFile: string,
  sourceLine: number,
): ImageAttachmentLike {
  const mediaType =
    asString(block.mediaType) ||
    asString(block.mime_type) ||
    asString(block.mimeType) ||
    asString((block as JsonRecord)["mime-type"]);

  if (!mediaType) {
    throw new Error(
      `Unsupported image block in ${path.basename(sourceFile)}:${sourceLine}: missing mediaType.`,
    );
  }

  const data =
    asTrimmedString(block.data) ||
    asTrimmedString(block.base64) ||
    asTrimmedString(block.base64_data);

  if (!data) {
    throw new Error(
      `Unsupported external image reference in ${path.basename(sourceFile)}:${sourceLine}.`,
    );
  }

  if (!isLikelyBase64Payload(data)) {
    throw new Error(
      `Unsupported external image reference in ${path.basename(sourceFile)}:${sourceLine}.`,
    );
  }

  if (!mediaType.startsWith("image/")) {
    throw new Error(
      `Unsupported non-image block type '${mediaType}' in ${path.basename(sourceFile)}:${sourceLine}.`,
    );
  }

  return { mediaType, data };
}

function parseToolCall(block: JsonRecord, sourceFile: string, sourceLine: number): ToolUseRecord {
  const id = asTrimmedString(block.id) || asTrimmedString(block.callId) || asTrimmedString(block.call_id);
  if (!id) {
    throw new Error(`toolCall block missing id in ${path.basename(sourceFile)}:${sourceLine}.`);
  }

  const tool = asTrimmedString(block.name) || asTrimmedString(block.tool);
  if (!tool) {
    throw new Error(`toolCall '${id}' missing name in ${path.basename(sourceFile)}:${sourceLine}.`);
  }

  const argsRaw = (block as JsonRecord).arguments ?? (block as JsonRecord).args;
  if (!isObject(argsRaw)) {
    throw new Error(
      `toolCall '${id}' arguments must be an object in ${path.basename(sourceFile)}:${sourceLine}.`,
    );
  }

  return {
    id,
    tool,
    arguments: argsRaw as Record<string, unknown>,
  };
}

function parseToolResultBlock(
  block: JsonRecord,
  sourceFile: string,
  sourceLine: number,
): { id: string; output: string; isError: boolean } {
  const id = asTrimmedString(block.id) || asTrimmedString(block.callId) || asTrimmedString(block.call_id);
  if (!id) {
    throw new Error(`toolResult block missing id in ${path.basename(sourceFile)}:${sourceLine}.`);
  }

  if (!Object.prototype.hasOwnProperty.call(block, "output")) {
    throw new Error(`toolResult '${id}' missing output in ${path.basename(sourceFile)}:${sourceLine}.`);
  }

  const output = asString((block as JsonRecord).output);
  if (output === undefined) {
    throw new Error(`toolResult '${id}' output must be a string in ${path.basename(sourceFile)}:${sourceLine}.`);
  }

  const isError = asBoolean((block as JsonRecord).isError ?? (block as JsonRecord).is_error) ?? false;
  return { id, output, isError };
}

function parseEntryParts(
  raw: JsonRecord,
  sourceLine: number,
  sourceFile: string,
): ParsedEntryParts {
  const sourceRole = asTrimmedString(raw.role)?.toLowerCase() ?? "user";
  const blocks = parseBlocks(raw, sourceFile, sourceLine);

  let content = "";
  const reasoningParts: string[] = [];
  const textParts: string[] = [];
  const toolCalls: ToolUseRecord[] = [];
  const toolResults: Array<{ id: string; output: string; isError: boolean }> = [];
  const images: ImageAttachmentLike[] = [];

  for (const block of blocks) {
    if (!isObject(block)) {
      throw new Error(`Unsupported block in ${path.basename(sourceFile)}:${sourceLine}.`);
    }

    const blockType = (asTrimmedString(block.type) || asTrimmedString(block.kind))?.toLowerCase();

    if (blockType === "text" || blockType === "content") {
      const text = asString(block.text) || asString(block.content);
      if (text === undefined) {
        throw new Error(
          `Malformed text block in ${path.basename(sourceFile)}:${sourceLine}.`,
        );
      }
      textParts.push(text);
      continue;
    }

    if (blockType === "thinking" || blockType === "reasoning") {
      const reason = asString(block.text) || asString(block.thinking) || asString(block.reasoning);
      if (reason === undefined) {
        throw new Error(
          `Malformed thinking block in ${path.basename(sourceFile)}:${sourceLine}.`,
        );
      }
      reasoningParts.push(reason);
      continue;
    }

    if (blockType === "toolcall" || blockType === "tool_call") {
      toolCalls.push(parseToolCall(block, sourceFile, sourceLine));
      continue;
    }

    if (blockType === "toolresult" || blockType === "tool_result") {
      toolResults.push(parseToolResultBlock(block, sourceFile, sourceLine));
      continue;
    }

    const mediaType = asString(block.mediaType) || asString(block.mime_type) || asString(block.mimeType);
    if (blockType === "image" || mediaType?.startsWith("image/")) {
      images.push(parseImageBlock(block, sourceFile, sourceLine));
      continue;
    }

    throw new Error(
      `Unsupported block type '${blockType ?? "(missing)"}' in ${path.basename(sourceFile)}:${sourceLine}.`,
    );
  }

  if (raw.reasoning !== undefined) {
    if (typeof raw.reasoning !== "string") {
      throw new Error(`Malformed reasoning in ${path.basename(sourceFile)}:${sourceLine}.`);
    }
    reasoningParts.push(raw.reasoning);
  }

  if (raw.images !== undefined) {
    if (!Array.isArray(raw.images)) {
      throw new Error(`Unsupported images payload in ${path.basename(sourceFile)}:${sourceLine}.`);
    }
    for (const image of raw.images) {
      if (!isObject(image)) {
        throw new Error(`Unsupported images payload in ${path.basename(sourceFile)}:${sourceLine}.`);
      }
      images.push(parseImageBlock(image, sourceFile, sourceLine));
    }
  }
  if (sourceRole === "toolresult" || sourceRole === "tool_result") {
    if (toolResults.length > 0) {
      if (raw.toolCallId !== undefined || raw.tool_call_id !== undefined) {
        throw new Error(`Malformed toolResult entry in ${path.basename(sourceFile)}:${sourceLine}: duplicate result payload.`);
      }
    } else {
      const id = asTrimmedString(raw.toolCallId) || asTrimmedString(raw.tool_call_id);
      if (!id) {
        throw new Error(`toolResult entry missing toolCallId in ${path.basename(sourceFile)}:${sourceLine}.`);
      }
      if (raw.isError !== undefined && typeof raw.isError !== "boolean" && typeof raw.is_error !== "boolean") {
        throw new Error(`Malformed toolResult isError in ${path.basename(sourceFile)}:${sourceLine}.`);
      }
      const directOutput = asString(raw.output);
      toolResults.push({
        id,
        output: directOutput ?? textParts.join("\n"),
        isError: asBoolean(raw.isError ?? raw.is_error) ?? false,
      });
    }
  }

  if (textParts.length > 0) {
    content = textParts.join("\n");
  }

  if (content === "" && asString(raw.content) !== undefined && blocks.length === 0) {
    content = raw.content as string;
  }

  const reasoning = reasoningParts.join("\n");

  return {
    sourceRole,
    content,
    reasoning,
    images,
    toolCalls,
    toolResults,
  };
}

function normalizeMessageRecord(record: JsonRecord, type: string): JsonRecord {
  if (type !== "message" || !isObject(record.message)) return record;
  return {
    ...record,
    ...record.message,
    type: "message",
    id: record.id,
    ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
    ...(record.parent_id !== undefined ? { parent_id: record.parent_id } : {}),
  };
}
function parseSourceSessionFromBytes(
  bytes: Buffer,
  sourcePath: string,
  strict: boolean,
): ParsedSourceSession {
  const lines = bytes.toString("utf8").split("\n");
  let header: ParsedSourceHeader | null = null;
  const nodes = new Map<string, SourceNode>();
  const children = new Map<string, number>();
  const pendingEntryPatches = new Map<string, unknown[]>();
  const seenIds = new Set<string>();
  const compactions: ParsedCompaction[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine.trim()) continue;

    const lineNo = i + 1;
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawLine);
    } catch {
      if (!strict) {
        continue;
      }
      throw new Error(`Malformed JSON in ${path.basename(sourcePath)}:${lineNo}.`);
    }

    if (!isObject(parsed)) {
      if (!strict) {
        continue;
      }
      throw new Error(`Malformed record in ${path.basename(sourcePath)}:${lineNo}.`);
    }

    const record = parsed as JsonRecord;
    const rawType = asTrimmedString(record.type) || asTrimmedString(record.record_type);
    const type = rawType ? rawType.toLowerCase() : "entry";

    if (type === "session") {
      if (header) {
        if (strict) {
          throw new Error(
            `Duplicate session header in ${path.basename(sourcePath)}:${lineNo}.`,
          );
        }
        continue;
      }

      const version = requireHeaderVersion(record.version, sourcePath);
      const sessionId = asTrimmedString(record.id) || asTrimmedString(record.session_id);
      if (!sessionId) {
        if (strict) {
          throw new Error(
            `Malformed session header: missing id in ${path.basename(sourcePath)}:${lineNo}.`,
          );
        }
        continue;
      }

      const cwd = asTrimmedString(record.cwd);
      if (!cwd) {
        if (strict) {
          throw new Error(
            `Malformed session header: missing cwd in ${path.basename(sourcePath)}:${lineNo}.`,
          );
        }
        continue;
      }

      const selectedLeafId = asTrimmedString(record.selectedLeafId) || asTrimmedString(record.selected_leaf_id);
      header = {
        sessionId,
        version,
        cwd,
        title: asTrimmedString(record.title),
        selectedLeafId: selectedLeafId ?? undefined,
      };
      continue;
    }

    if (type === "header_patch") {
      if (!header) {
        if (strict) {
          throw new Error(
            `header_patch before session header in ${path.basename(sourcePath)}:${lineNo}.`,
          );
        }
        continue;
      }
      applyHeaderPatch(header, (record as JsonRecord).patch ?? record, sourcePath, lineNo);
      continue;
    }

    if (type === "entry_patch") {
      if (!header) {
        if (strict) {
          throw new Error(
            `entry_patch before session header in ${path.basename(sourcePath)}:${lineNo}.`,
          );
        }
        continue;
      }

      const targetId =
        asTrimmedString(record.entryId) ||
        asTrimmedString(record.entry_id) ||
        asTrimmedString(record.entry) ||
        asTrimmedString(record.id);
      if (!targetId) {
        if (strict) {
          throw new Error(
            `entry_patch missing target id in ${path.basename(sourcePath)}:${lineNo}.`,
          );
        }
        continue;
      }

      const queued = pendingEntryPatches.get(targetId) ?? [];
      queued.push((record as JsonRecord).patch ?? record);
      pendingEntryPatches.set(targetId, queued);

      const target = nodes.get(targetId);
      if (!target) continue;

      try {
        const queue = pendingEntryPatches.get(targetId) ?? [];
        for (const patch of queue) {
          applyEntryPatch(target.raw, patch, sourcePath, lineNo);
        }
        pendingEntryPatches.delete(targetId);
      } catch (err) {
        if (strict) throw err;
      }
      continue;
    }

    if (type === "compaction") {
      if (!header) {
        if (strict) {
          throw new Error(`compaction before session header in ${path.basename(sourcePath)}:${lineNo}.`);
        }
        continue;
      }

      const firstKeptEntryId = asTrimmedString(record.firstKeptEntryId) || asTrimmedString(record.first_kept_entry_id);
      if (!firstKeptEntryId) {
        if (strict) {
          throw new Error(`Malformed compaction record in ${path.basename(sourcePath)}:${lineNo}.`);
        }
        continue;
      }

      compactions.push({
        firstKeptEntryId,
        summary: asTrimmedString(record.summary),
        sourceLine: lineNo,
      });
      continue;
    }

    const id = asTrimmedString(record.id);
    const normalizedRecord = normalizeMessageRecord(record, type);
    const looksLikeModelChange = type === "model_change";
    const looksLikeEntry =
      type === "entry" || type === "message" ||
      (looksLikeModelChange === false && asTrimmedString(normalizedRecord.role) !== undefined);

    if (!looksLikeEntry && !looksLikeModelChange) {
      if (strict) {
        throw new Error(`Unsupported record type '${type}' in ${path.basename(sourcePath)}:${lineNo}.`);
      }
      continue;
    }

    if (!id) {
      if (strict) {
        throw new Error(`Record missing id in ${path.basename(sourcePath)}:${lineNo}.`);
      }
      continue;
    }

    if (seenIds.has(id)) {
      if (strict) {
        throw new Error(`Duplicate record id '${id}' in ${path.basename(sourcePath)}:${lineNo}.`);
      }
      continue;
    }

    let parentId: string | undefined;
    try {
      parentId = parseParentId(record);
    } catch (err) {
      if (strict) throw err;
      continue;
    }

    const node: SourceNode = {
      id,
      type,
      parentId,
      raw: normalizedRecord,
      sourceLine: lineNo,
    };

    nodes.set(id, node);
    seenIds.add(id);

    if (parentId) {
      children.set(parentId, (children.get(parentId) ?? 0) + 1);
    }

    if (looksLikeModelChange) {
      try {
        parseModelChange(record, sourcePath, lineNo);
      } catch (err) {
        if (strict) throw err;
      }
    }

    if (pendingEntryPatches.has(id) && type !== "model_change") {
      try {
        const queue = pendingEntryPatches.get(id) ?? [];
        for (const patch of queue) {
          applyEntryPatch(node.raw, patch, sourcePath, lineNo);
        }
        pendingEntryPatches.delete(id);
      } catch (err) {
        if (strict) throw err;
      }
    }
  }

  if (!header) {
    throw new Error(`Missing session header in ${path.basename(sourcePath)}.`);
  }

  if (strict) {
    for (const [targetId] of pendingEntryPatches) {
      if (targetId) {
        throw new Error(
          `entry_patch targets unknown id '${targetId}' in ${path.basename(sourcePath)}.`,
        );
      }
    }
  }

  const leaves = [...nodes.keys()].filter(id => !children.has(id));
  return {
    sourcePath,
    sourceBytes: bytes,
    header,
    nodes,
    leaves,
    compactions,
  };
}

function startsWithFold(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

async function walkJsonlFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    const joined = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      out.push(...await walkJsonlFiles(joined));
      continue;
    }

    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".jsonl") {
      out.push(joined);
    }
  }

  return out;
}

interface DiscoverableSessionHeader {
  sessionId: string;
  cwd: string;
  selectedLeafId?: string;
}

function discoverSessionHeader(bytes: Buffer): DiscoverableSessionHeader | undefined {
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    const type = asTrimmedString(parsed.type)?.toLowerCase();
    if (type !== "session") continue;
    const sessionId = asTrimmedString(parsed.id) || asTrimmedString(parsed.session_id);
    const cwd = asTrimmedString(parsed.cwd);
    if (!sessionId || !cwd) return undefined;
    const selectedLeafId =
      asTrimmedString(parsed.selectedLeafId) ||
      asTrimmedString(parsed.selected_leaf_id);
    return { sessionId, cwd, selectedLeafId };
  }
  return undefined;
}

export async function listGjcSessions(
  options: ListGjcSessionsOptions = {},
): Promise<GjcSessionLeaf[]> {
  const roots = resolveGjcCodingAgentRoots(options);
  const includeAll = options.anyCwd ?? false;
  const cwd = path.resolve(options.cwd ?? process.cwd());

  const matches: GjcSessionLeaf[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const files = await walkJsonlFiles(root);

    for (const filePath of files) {
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(filePath);
      } catch {
        continue;
      }

      let parsed: ParsedSourceSession;
      try {
        parsed = parseSourceSessionFromBytes(bytes, filePath, false);
      } catch {
        const discovered = discoverSessionHeader(bytes);
        if (!discovered || (!includeAll && path.resolve(discovered.cwd) !== cwd)) {
          continue;
        }
        const key = `${filePath}\x00${discovered.selectedLeafId ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          rootPath: root,
          sourcePath: filePath,
          sessionId: discovered.sessionId,
          leafId: discovered.selectedLeafId ?? "",
          cwd: discovered.cwd,
          selected: discovered.selectedLeafId !== undefined,
        });
        continue;
      }

      if (!includeAll && path.resolve(parsed.header.cwd) !== cwd) {
        continue;
      }

      if (parsed.leaves.length === 0) {
        const discovered = discoverSessionHeader(bytes);
        if (!discovered) continue;
        const key = `${filePath}\x00${discovered.selectedLeafId ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          rootPath: root,
          sourcePath: filePath,
          sessionId: discovered.sessionId,
          leafId: discovered.selectedLeafId ?? "",
          cwd: discovered.cwd,
          selected: discovered.selectedLeafId !== undefined,
        });
        continue;
      }

      for (const leafId of parsed.leaves) {
        const key = `${filePath}\x00${leafId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        matches.push({
          rootPath: root,
          sourcePath: filePath,
          sessionId: parsed.header.sessionId,
          leafId,
          cwd: parsed.header.cwd,
          selected: leafId === (parsed.header.selectedLeafId ?? ""),
        });
      }
    }
  }

  matches.sort((a, b) => {
    if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
    return a.leafId.localeCompare(b.leafId);
  });

  return matches;
}

export async function resolveGjcSessionRef(
  sessionIdOrPrefix: string,
  leafIdOrPrefix: string | undefined,
  options: ResolveGjcSessionOptions = {},
): Promise<GjcSessionRefResolution> {
  const sessionPrefix = sessionIdOrPrefix.trim();
  if (!sessionPrefix) return { kind: "not-found" };

  const candidates = await listGjcSessions(options);
  const exactSessionMatches = candidates.filter(item => item.sessionId === sessionPrefix);
  const sessionMatches =
    exactSessionMatches.length > 0
      ? exactSessionMatches
      : candidates.filter(item => startsWithFold(item.sessionId, sessionPrefix));

  if (sessionMatches.length === 0) {
    return { kind: "not-found" };
  }

  const uniqueSessionIds = Array.from(new Set(sessionMatches.map(item => item.sessionId)));
  if (uniqueSessionIds.length !== 1) {
    return { kind: "ambiguous-session", matches: uniqueSessionIds };
  }

  const sessionOnly = sessionMatches.filter(item => item.sessionId === uniqueSessionIds[0]!);

  if (!leafIdOrPrefix || !leafIdOrPrefix.trim()) {
    const selected = sessionOnly.find(item => item.selected);
    if (selected) {
      return { kind: "ok", match: selected };
    }

    if (sessionOnly.length === 1) {
      return { kind: "ok", match: sessionOnly[0]! };
    }

    const uniqueLeafs = Array.from(new Set(sessionOnly.map(item => item.leafId)));
    return { kind: "ambiguous-leaf", matches: uniqueLeafs };
  }

  const leafPrefix = leafIdOrPrefix.trim();
  const exactLeafMatches = sessionOnly.filter(item => item.leafId === leafPrefix);
  if (exactLeafMatches.length > 1) {
    return { kind: "ambiguous-leaf", matches: exactLeafMatches.map(item => item.leafId) };
  }
  const leafMatches = exactLeafMatches.length === 1
    ? exactLeafMatches
    : sessionOnly.filter(item => startsWithFold(item.leafId, leafPrefix));

  if (leafMatches.length === 0) return { kind: "not-found" };
  if (leafMatches.length > 1) {
    return { kind: "ambiguous-leaf", matches: leafMatches.map(item => item.leafId) };
  }

  return { kind: "ok", match: leafMatches[0]! };
}

function resolveLeafFromSession(session: ParsedSourceSession, requestedLeafId: string | undefined): string {
  if (requestedLeafId) {
    const prefix = requestedLeafId.trim();
    const exact = session.leaves.find(leaf => leaf === prefix);
    if (exact) {
      return exact;
    }

    const matches = session.leaves.filter(leaf => startsWithFold(leaf, prefix));
    if (matches.length === 0) {
      throw new Error(`Leaf id '${requestedLeafId}' not found in source session ${session.header.sessionId}.`);
    }
    if (matches.length > 1) {
      throw new Error(`Leaf id '${requestedLeafId}' is ambiguous in source session ${session.header.sessionId}.`);
    }
    return matches[0]!;
  }

  if (session.header.selectedLeafId) {
    const selectedLeafId = session.header.selectedLeafId;
    const exactSelected = session.leaves.find(leaf => leaf === selectedLeafId);
    if (exactSelected) {
      return exactSelected;
    }

    const selectedMatches = session.leaves.filter(leaf => startsWithFold(leaf, selectedLeafId));
    if (selectedMatches.length === 0) {
      throw new Error(
        `Selected leaf '${selectedLeafId}' is not present in source session ${session.header.sessionId}.`,
      );
    }
    if (selectedMatches.length > 1) {
      throw new Error(
        `Selected leaf '${selectedLeafId}' is ambiguous in source session ${session.header.sessionId}.`,
      );
    }
    return selectedMatches[0]!;
  }

  if (session.leaves.length === 0) {
    throw new Error(`Source session ${session.header.sessionId} has no leaves.`);
  }
  if (session.leaves.length !== 1) {
    throw new Error(
      `Source session ${session.header.sessionId} has multiple leaves; a leaf id is required.`,
    );
  }

  return session.leaves[0]!;
}

function chainFromLeaf(session: ParsedSourceSession, leafId: string): SourceNode[] {
  const chain: SourceNode[] = [];
  const seen = new Set<string>();
  let current: string | undefined = leafId;

  while (current) {
    if (seen.has(current)) {
      throw new Error(`Detected parent cycle in source session ${session.header.sessionId}.`);
    }
    seen.add(current);

    const node = session.nodes.get(current);
    if (!node) {
      throw new Error(`Source chain references missing id '${current}' in ${path.basename(session.sourcePath)}.`);
    }

    chain.push(node);
    current = node.parentId;
  }

  chain.reverse();
  return chain;
}

function mapEntryToMessage(node: SourceNode, sourceFile: string): ParsedEntryParts {
  const entry = parseEntryParts(node.raw, node.sourceLine, sourceFile);

  const allowedRoles = ["user", "assistant", "developer", "toolresult", "tool_result"];
  if (!allowedRoles.includes(entry.sourceRole)) {
    throw new Error(
      `Unsupported source role '${entry.sourceRole}' in ${path.basename(sourceFile)}:${node.sourceLine}.`,
    );
  }

  return entry;
}

function messageFromUserOrDeveloper(
  role: "user" | "developer",
  entry: ParsedEntryParts,
): Message {
  if (role === "developer") {
    // NOTE: GJC `developer` role is normalized to a Jeo `system` message.
    return {
      role: "system",
      content: entry.content,
      ...(entry.images.length > 0 ? { images: entry.images } : {}),
    };
  }

  return {
    role: "user",
    content: entry.content,
    ...(entry.images.length > 0 ? { images: entry.images } : {}),
  };
}

function messageFromAssistant(entry: ParsedEntryParts): Message {
  if (entry.images.length > 0) {
    throw new Error("assistant entries cannot include image blocks.");
  }

  const message: Message = {
    role: "assistant",
    content: entry.content,
    ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
  };

  if (entry.toolCalls.length > 0) {
    message.toolUse = entry.toolCalls;
  }

  return message;
}

function messageFromToolResult(entry: ParsedEntryParts, sourceNodeId: string): Message {
  if (entry.toolResults.length === 0) {
    throw new Error(`toolResult entry '${sourceNodeId}' is missing tool result payload.`);
  }
  if (entry.toolResults.length !== 1) {
    throw new Error(
      `toolResult entry '${sourceNodeId}' has multiple tool results; expected exactly one.`,
    );
  }

  const toolResult = entry.toolResults[0]!;
  const toolResults: ToolResultRecord[] = [
    {
      id: toolResult.id,
      output: toolResult.output,
      isError: toolResult.isError,
    },
  ];

  return {
    role: "user",
    content: entry.content,
    ...(entry.images.length > 0 ? { images: entry.images } : {}),
    toolResults,
  };
}

function deriveModelFromChain(chain: SourceNode[], sourcePath: string): string | undefined {
  let selected: string | undefined;
  for (const node of chain) {
    if (node.type !== "model_change") continue;
    const change = parseModelChange(node.raw, sourcePath, node.sourceLine);
    if (change.role === "omitted") {
      selected = undefined;
    } else {
      selected = change.model;
    }
  }
  return selected;
}

function convertChainToMessages(
  chain: SourceNode[],
  sourcePath: string,
  compactions: ParsedCompaction[],
): { messages: Message[]; replacesThrough: number | undefined; compactionSummary: string | undefined } {
  const messages: Message[] = [];
  const nodeToMessageIndex = new Map<string, number>();
  const pendingCalls = new Map<string, ToolUseRecord>();
  const handledToolResults = new Set<string>();
  let firstSystemIndex = -1;

  const orderedCompactions = compactions.filter(Boolean);

  for (const node of chain) {
    if (node.type === "model_change" || node.type === "compaction") {
      if (node.type === "model_change") {
        parseModelChange(node.raw, sourcePath, node.sourceLine);
      }
      continue;
    }

    const parsed = mapEntryToMessage(node, sourcePath);

    if (parsed.sourceRole === "assistant") {
      if (pendingCalls.size > 0) {
        const remaining = [...pendingCalls.keys()];
        throw new Error(
          `Non-contiguous tool result: pending calls {${remaining.join(", ")}} before '${node.id}'.`,
        );
      }

      const message = messageFromAssistant(parsed);
      const index = messages.length;
      messages.push(message);
      nodeToMessageIndex.set(node.id, index);

      for (const call of parsed.toolCalls) {
        if (pendingCalls.has(call.id)) {
          throw new Error(
            `Duplicate tool call id '${call.id}' in assistant entry '${node.id}'.`,
          );
        }
        if (handledToolResults.has(call.id)) {
          throw new Error(
            `Duplicate tool call id '${call.id}' in assistant entry '${node.id}'.`,
          );
        }
        pendingCalls.set(call.id, call);
      }

      continue;
    }

    if (parsed.sourceRole === "toolresult" || parsed.sourceRole === "tool_result") {
      if (pendingCalls.size === 0) {
        throw new Error(`orphan toolResult entry '${node.id}' encountered without pending tool calls.`);
      }

      if (parsed.toolResults.length !== 1) {
        throw new Error(`toolResult entry '${node.id}' is malformed: expected a single tool result payload.`);
      }

      const toolResult = parsed.toolResults[0]!;
      if (!pendingCalls.has(toolResult.id)) {
        throw new Error(`Unknown toolResult id '${toolResult.id}' in entry '${node.id}'.`);
      }
      if (handledToolResults.has(toolResult.id)) {
        throw new Error(`Duplicate toolResult id '${toolResult.id}' in source chain.`);
      }

      const message = messageFromToolResult(parsed, node.id);
      const index = messages.length;
      messages.push(message);
      nodeToMessageIndex.set(node.id, index);

      pendingCalls.delete(toolResult.id);
      handledToolResults.add(toolResult.id);
      continue;
    }

    if (pendingCalls.size > 0) {
      const remaining = [...pendingCalls.keys()];
      throw new Error(
        `Missing toolResult entries for tool calls: ${remaining.join(", ")} before '${node.id}'.`,
      );
    }

    const message = messageFromUserOrDeveloper(parsed.sourceRole as "user" | "developer", parsed);
    const index = messages.length;
    messages.push(message);
    nodeToMessageIndex.set(node.id, index);
    if (message.role === "system") {
      if (firstSystemIndex === -1) {
        firstSystemIndex = index;
      } else {
        throw new Error("Source chain has a non-first system/developer message.");
      }
    }
  }

  if (pendingCalls.size > 0) {
    const remaining = [...pendingCalls.keys()];
    throw new Error(`Missing toolResult entries for tool calls: ${remaining.join(", ")}.`);
  }

  if (firstSystemIndex > 0) {
    throw new Error("Source chain has a non-first system/developer message.");
  }
  let replacesThrough: number | undefined;
  let compactionSummary: string | undefined;

  for (const marker of orderedCompactions) {
    const firstKeptMessageIndex = nodeToMessageIndex.get(marker.firstKeptEntryId);
    if (firstKeptMessageIndex === undefined) {
      continue;
    }

    replacesThrough = firstKeptMessageIndex - 1;
    compactionSummary = marker.summary;
  }

  // Jeo's loader retains the first system message when applying a compaction
  // marker, so the imported boundary may include its source index.

  return {
    messages,
    replacesThrough,
    compactionSummary,
  };
}

function buildImportHeader(
  source: ParsedSourceSession,
  sourceLeafId: string,
  sourceSha256: string,
  sourceTime: string,
  model: string | undefined,
  targetCwd: string,
): SessionHeader {
  const header: SessionHeader = {
    type: "session",
    version: 1,
    id: "",
    timestamp: sourceTime,
    cwd: targetCwd,
    ...(source.header.title === undefined ? {} : { title: source.header.title }),
    ...(model === undefined ? {} : { model }),
    sourceSystem: "gjc",
    sourceSessionId: source.header.sessionId,
    sourceLeafId,
    sourceSha256,
    importTimestamp: sourceTime,
  };
  return header;
}

function buildImportLines(
  header: SessionHeader,
  messages: Message[],
  replacesThrough: number | undefined,
  compactionSummary: string | undefined,
): string {
  const lines: string[] = [JSON.stringify(header)];
  const ts = header.timestamp;

  for (const message of messages) {
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: ts,
        message,
      } satisfies { type: "message"; timestamp: string; message: Message }),
    );
  }

  if (replacesThrough !== undefined) {
    lines.push(
      JSON.stringify({
        type: "compaction",
        timestamp: ts,
        seq: 1,
        summary: compactionSummary ?? "Imported from GJC source",
        replacesThrough,
      }),
    );
  }

  return `${lines.join("\n")}\n`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2);
}

async function writeSessionAtomically(cwd: string, sessionId: string, text: string): Promise<string> {
  const finalPath = sessionPath(sessionId, cwd);
  const tmpPath = `${finalPath}.${randomSuffix()}.tmp`;

  await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(tmpPath, text, "utf8");

    if (await exists(finalPath)) {
      throw new Error(`Refusing to overwrite existing session file ${finalPath}.`);
    }

    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  return finalPath;
}

export async function importGjcSession(
  options: ImportGjcSessionOptions,
): Promise<ImportGjcSessionResult> {
  const resolution = await resolveGjcSessionRef(options.sessionId, options.leafId, {
    roots: options.roots,
    cwd: options.cwd,
    // Explicit test roots represent a caller-selected source corpus; production
    // callers retain the current-working-directory guard unless --any-cwd is set.
    anyCwd: options.anyCwd ?? (options.roots !== undefined),
    env: options.env,
  });

  if (resolution.kind !== "ok") {
    if (resolution.kind === "ambiguous-session") {
      throw new Error(`Ambiguous session id '${options.sessionId}'.`);
    }
    if (resolution.kind === "ambiguous-leaf") {
      throw new Error(`Ambiguous leaf id '${options.leafId ?? ""}' for session '${options.sessionId}'.`);
    }
    throw new Error(`Source session '${options.sessionId}' not found.`);
  }

  const source = parseSourceSessionFromBytes(
    await fs.readFile(resolution.match.sourcePath),
    resolution.match.sourcePath,
    true,
  );

  const sourceLeafId = resolveLeafFromSession(source, options.leafId);
  const chain = chainFromLeaf(source, sourceLeafId);
  const model = deriveModelFromChain(chain, source.sourcePath);
  const conversion = convertChainToMessages(chain, source.sourcePath, source.compactions);

  const importTimestamp = new Date().toISOString();
  const sourceSha256 = createHash("sha256").update(source.sourceBytes).digest("hex");
  const targetCwd = path.resolve(options.cwd ?? process.cwd());

  const reuse = await findImportedSessionByProvenance(targetCwd, {
    sourceSystem: "gjc",
    sourceSessionId: source.header.sessionId,
    sourceLeafId,
    sourceSha256,
  });

  if (reuse) {
    return {
      sessionId: reuse.id,
      path: sessionPath(reuse.id, targetCwd),
      sourceSessionId: source.header.sessionId,
      sourceLeafId,
      sourceSha256,
      reused: true,
      createdAt: reuse.timestamp,
    };
  }

  const header = buildImportHeader(source, sourceLeafId, sourceSha256, importTimestamp, model, targetCwd);

  let sessionId = newSessionId();
  let finalPath: string | undefined;
  for (let attempts = 0; attempts < 32; attempts++) {
    const candidatePath = sessionPath(sessionId, targetCwd);
    if (!(await exists(candidatePath))) {
      header.id = sessionId;
      const payload = buildImportLines(header, conversion.messages, conversion.replacesThrough, conversion.compactionSummary);
      finalPath = await writeSessionAtomically(targetCwd, sessionId, payload);
      break;
    }
    sessionId = newSessionId();
  }

  if (!finalPath) {
    throw new Error("Could not allocate a unique import session id.");
  }

  return {
    sessionId,
    path: finalPath,
    sourceSessionId: source.header.sessionId,
    sourceLeafId,
    sourceSha256,
    reused: false,
    createdAt: importTimestamp,
  };
}
