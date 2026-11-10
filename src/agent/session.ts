import type { Message } from "./loop";
import type { TaskSubEvent } from "./task-tool";
import { getLocalJeoDir } from "./state";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  title?: string;
  /** Model id pinned to this session; restored on resume so each session can carry
   *  its own model independent of the global default (per-session model selection). */
  model?: string;
  /** Latest CLI-owned conversation, folded from append-only metadata records. */
  agy?: { conversationId: string; messageCount: number };
  /** Unsent input-box draft at last save, restored into the prompt on `/resume`
   *  (gajae-code parity: an in-progress cursor survives a quit + resume instead
   *  of being silently lost). Absent/empty when there was nothing to restore. */
  draft?: string;
  /** Source system marker for imported sessions (read-only session importer layer). */
  sourceSystem?: "gjc";
  /** Source session id for imported sessions. */
  sourceSessionId?: string;
  /** Source leaf id for imported sessions. */
  sourceLeafId?: string;
  /** SHA-256 hex of the exact imported source bytes. */
  sourceSha256?: string;
  /** Import timestamp for imported sessions (ISO-8601 UTC string). */
  importTimestamp?: string;
}
export interface SessionEntry {
  type: "message";
  timestamp: string;
  message: Message;
  /** Links an early parent response to the final engine history record. */
  responseId?: string;
}
export interface SubagentMessage {
  runId: string;
  role: string;
  message: Message;
  /** The stored message was shortened and structured attachments were omitted. */
  truncated?: boolean;
}
export interface ParentResponseEntry {
  type: "parent_response";
  timestamp: string;
  id: string;
  message: Message;
  truncated?: boolean;
}
export type SessionTimelineEntry = SessionEntry | ParentResponseEntry
  | { type: "subagent_event"; timestamp: string; event: TaskSubEvent }
  | ({ type: "subagent_message"; timestamp: string } & SubagentMessage);

export interface CompactionEntry {
  type: "compaction";
  timestamp: string;
  seq: number;
  summary: string;
  replacesThrough: number;
}
export interface SessionSummary {
  id: string;
  timestamp: string;
  cwd: string;
  messageCount: number;
  preview: string;
  mtimeMs?: number;
  /** Session file size in bytes (for the resume picker's metadata line). */
  sizeBytes?: number;
  title?: string;
  /** Model id pinned to this session (header `model`), if any. */
  model?: string;
  /** GJC import provenance (present for imported sessions). */
  sourceSystem?: "gjc";
  sourceSessionId?: string;
  sourceLeafId?: string;
  sourceSha256?: string;
  importTimestamp?: string;
}

export interface ImportedSessionLookup {
  sourceSystem: "gjc";
  sourceSessionId: string;
  sourceLeafId: string;
  sourceSha256: string;
}

export const SESSION_VERSION = 1;

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function sessionsDir(cwd = process.cwd()): string {
  return process.env.JEO_SESSION_DIR || path.join(getLocalJeoDir(cwd), "sessions");
}

export function sessionPath(id: string, cwd = process.cwd()): string {
  return path.join(sessionsDir(cwd), `${id}.jsonl`);
}
const sessionWrites = new Map<string, Promise<void>>();

async function separateIncompleteTail(file: string): Promise<void> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r+");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return;
    const lastByte = Buffer.alloc(1);
    await handle.read(lastByte, 0, 1, size - 1);
    if (lastByte[0] !== 10) await handle.write("\n", size, "utf8");
  } finally {
    await handle.close();
  }
}

async function withSessionWrite<T>(file: string, write: () => Promise<T>): Promise<T> {
  const previous = sessionWrites.get(file) ?? Promise.resolve();
  const perform = async () => { await separateIncompleteTail(file); return write(); };
  const current = previous.then(perform, perform);
  const settled = current.then(() => {}, () => {});
  sessionWrites.set(file, settled);
  try {
    return await current;
  } finally {
    if (sessionWrites.get(file) === settled) sessionWrites.delete(file);
  }
}

export async function createSession(
  cwd = process.cwd(),
  id = newSessionId(),
  model?: string,
  directory = sessionsDir(cwd),
  exclusive = false,
): Promise<{ id: string; path: string }> {
  const dir = directory;
  await fs.mkdir(dir, { recursive: true });

  const header: SessionHeader = {
    type: "session",
    version: SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
    ...(model ? { model } : {}),
  };

  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, JSON.stringify(header) + "\n", { encoding: "utf8", mode: 0o600, ...(exclusive ? { flag: "wx" } : {}) });

  return { id, path: file };
}

export async function appendMessage(
  id: string,
  message: Message,
  cwd = process.cwd()
): Promise<void> {
  const file = sessionPath(id, cwd);
  const entry: SessionEntry = {
    type: "message",
    timestamp: new Date().toISOString(),
    message,
  };

  await withSessionWrite(file, () => fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8"));
}

/** Append a batch of messages with ONE fs append (turn-end persistence: a long
 *  turn previously issued one sequential appendFile per intermediate message). */
export async function appendMessages(
  id: string,
  messages: readonly Message[],
  cwd = process.cwd(),
  responseIds?: readonly (string | undefined)[]
): Promise<void> {
  if (messages.length === 0) return;
  const file = sessionPath(id, cwd);
  const timestamp = new Date().toISOString();
  const chunk = messages
    .map((message, index) => JSON.stringify({ type: "message", timestamp, message, ...(responseIds?.[index] ? { responseId: responseIds[index] } : {}) } satisfies SessionEntry))
    .join("\n") + "\n";
  await withSessionWrite(file, () => fs.appendFile(file, chunk, "utf8"));
}

/** Persist a model response before its tools run, without recreating deleted sessions. */
export async function appendParentResponse(id: string, responseId: string, message: Message, cwd = process.cwd()): Promise<void> {
  const file = sessionPath(id, cwd);
  let entry: ParentResponseEntry = { type: "parent_response", timestamp: new Date().toISOString(), id: responseId, message: { role: "assistant", content: message.content } };
  let serialized = JSON.stringify(entry);
  if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) {
    entry = { ...entry, truncated: true, message: { role: "assistant", content: message.content.slice(0, 65536) } };
    serialized = JSON.stringify(entry);
  }
  await withSessionWrite(file, async () => {
    const handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND);
    try {
      await handle.appendFile(serialized + "\n", "utf8");
    } finally {
      await handle.close();
    }
  });
}

/** Persist observed task activity, excluding transient reasoning previews. */
export async function appendSubagentEvent(id: string, event: TaskSubEvent, cwd = process.cwd()): Promise<void> {
  if (event.kind === "thinking") return;
  const path = sessionPath(id, cwd);
  await withSessionWrite(path, async () => {
    const file = await fs.open(path, constants.O_WRONLY | constants.O_APPEND);
    try {
      await file.appendFile(JSON.stringify({ type: "subagent_event", timestamp: new Date().toISOString(), event }) + "\n", "utf8");
    } finally {
      await file.close();
    }
  });
}

/** Append an actual nested conversation message without recreating a deleted session. */
export async function appendSubagentMessage(id: string, record: SubagentMessage, cwd = process.cwd()): Promise<void> {
  const file = sessionPath(id, cwd);
  const { reasoning: _reasoning, reasoningArtifacts: _reasoningArtifacts, ...visible } = record.message;
  let stored = { type: "subagent_message" as const, timestamp: new Date().toISOString(), ...record, message: visible };
  let serialized = JSON.stringify(stored);
  if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) {
    stored = { ...stored, truncated: true, message: { role: record.message.role, content: record.message.content.slice(0, 65536) } };
    serialized = JSON.stringify(stored);
  }
  await withSessionWrite(file, async () => {
    const handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND);
    try {
      await handle.appendFile(serialized + "\n", "utf8");
    } finally {
      await handle.close();
    }
  });
}

function isSubagentMessage(value: unknown): value is SubagentMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== "string" || !record.runId || typeof record.role !== "string" || !record.role) return false;
  if (record.truncated !== undefined && typeof record.truncated !== "boolean") return false;
  if (!record.message || typeof record.message !== "object") return false;
  const message = record.message as Record<string, unknown>;
  return (message.role === "system" || message.role === "user" || message.role === "assistant") && typeof message.content === "string";
}

function isSubagentEvent(value: unknown): value is TaskSubEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (typeof e.runId !== "string" || !e.runId || typeof e.role !== "string" || !e.role ||
      !["start", "step", "tool", "done", "error"].includes(String(e.kind))) return false;
  for (const key of ["detail", "summary", "model", "detachedId"]) {
    if (e[key] !== undefined && typeof e[key] !== "string") return false;
  }
  for (const key of ["step", "maxSteps", "index", "total"]) {
    if (e[key] !== undefined && (typeof e[key] !== "number" || !Number.isFinite(e[key]))) return false;
  }
  if (e.success !== undefined && typeof e.success !== "boolean") return false;
  if (e.tokens !== undefined) {
    if (!e.tokens || typeof e.tokens !== "object") return false;
    const tokens = e.tokens as Record<string, unknown>;
    if (typeof tokens.input !== "number" || !Number.isFinite(tokens.input) ||
        typeof tokens.output !== "number" || !Number.isFinite(tokens.output)) return false;
  }
  return true;
}

function isAgySessionState(value: unknown): value is NonNullable<SessionHeader["agy"]> {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return typeof state.conversationId === "string" && state.conversationId.length > 0
    && state.conversationId.length <= 1024 && !/[\s\u0000-\u001f\u007f]/.test(state.conversationId)
    && typeof state.messageCount === "number" && Number.isSafeInteger(state.messageCount) && state.messageCount >= 0;
}

/** Append metadata instead of rewriting a header while transcript messages arrive. */
export async function appendAgySession(
  id: string,
  state: NonNullable<SessionHeader["agy"]>,
  cwd = process.cwd(),
): Promise<void> {
  if (!isAgySessionState(state)) throw new Error("Invalid official CLI session metadata");
  const file = sessionPath(id, cwd);
  await withSessionWrite(file, () => fs.appendFile(file, JSON.stringify({
    type: "agy_session", timestamp: new Date().toISOString(), state,
  }) + "\n", "utf8"));
}

export async function appendCompaction(
  id: string,
  seq: number,
  summary: string,
  replacesThrough: number,
  cwd = process.cwd()
): Promise<void> {
  const file = sessionPath(id, cwd);
  const entry: CompactionEntry = {
    type: "compaction",
    timestamp: new Date().toISOString(),
    seq,
    summary,
    replacesThrough,
  };

  await withSessionWrite(file, () => fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8"));
}

export async function loadSession(
  id: string,
  cwd = process.cwd()
): Promise<{ header: SessionHeader; messages: Message[]; subagentEvents: TaskSubEvent[]; subagentMessages: SubagentMessage[]; timeline: SessionTimelineEntry[] }> {
  const file = sessionPath(id, cwd);
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(`Session ${id} not found: ${err.message}`);
    }
    throw err;
  }

  const lines = content.split("\n");
  let header: SessionHeader | undefined;
  const rawMessages: Message[] = [];
  const compactions: CompactionEntry[] = [];
  const subagentEvents: TaskSubEvent[] = [];
  const subagentMessages: SubagentMessage[] = [];
  const timeline: SessionTimelineEntry[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object") {
        if (entry.type === "session" && !header) {
          header = entry as SessionHeader;
        } else if (entry.type === "message") {
          rawMessages.push(entry.message);
          timeline.push(entry as SessionEntry);
        } else if (entry.type === "parent_response" && typeof entry.id === "string" && entry.id &&
                   entry.message && entry.message.role === "assistant" && typeof entry.message.content === "string") {
          timeline.push(entry as ParentResponseEntry);
        } else if (entry.type === "compaction") {
          compactions.push(entry as CompactionEntry);
        } else if (entry.type === "subagent_event" && isSubagentEvent(entry.event)) {
          subagentEvents.push(entry.event);
          timeline.push(entry as SessionTimelineEntry);
        } else if (entry.type === "subagent_message" && isSubagentMessage(entry)) {
          subagentMessages.push({ runId: entry.runId, role: entry.role, message: entry.message, ...(entry.truncated ? { truncated: true } : {}) });
          timeline.push(entry as SessionTimelineEntry);
        } else if (entry.type === "agy_session" && header) {
          if (isAgySessionState(entry.state)) header.agy = entry.state;
          else delete header.agy;
        }
      }
    } catch (err) {
      if (!header) {
        throw err;
      }
      continue;
    }
  }

  if (!header) {
    throw new Error(`Session header missing in session ${id}`);
  }

  let messages = rawMessages;
  if (compactions.length > 0) {
    const lastComp = compactions[compactions.length - 1];
    const { summary, replacesThrough } = lastComp;

    const hasSystem = rawMessages.length > 0 && rawMessages[0].role === "system";
    const systemPrompt = hasSystem ? [rawMessages[0]] : [];

    const summaryMessage: Message = {
      role: "user",
      content: `[Earlier conversation summary]\n${summary}`,
    };

    const remaining = rawMessages.slice(replacesThrough + 1);
    messages = [...systemPrompt, summaryMessage, ...remaining];
  }

  const parentResponses = new Map(timeline.flatMap(entry =>
    entry.type === "parent_response" ? [[entry.id, entry] as const] : []
  ));
  const completedResponses = new Set<string>();
  const incompleteMessages = new Set<Message>();
  for (let index = 0; index < timeline.length; index++) {
    const entry = timeline[index];
    if (entry.type !== "message" || !entry.responseId) continue;
    const next = timeline[index + 1];
    const results = next?.type === "message" && next.message?.role === "user" ? next.message : undefined;
    const calls = entry.message.toolUse;
    const paired = results && calls?.length && calls.every(call => results.toolResults?.some(result => result.id === call.id));
    if (!paired) {
      incompleteMessages.add(entry.message);
      continue;
    }
    const parent = parentResponses.get(entry.responseId);
    let requestedCount = 0;
    try {
      const invocation: unknown = JSON.parse(parent?.message.content ?? "");
      if (invocation && typeof invocation === "object") {
        if ("tools" in invocation && Array.isArray(invocation.tools)) requestedCount = invocation.tools.length;
        else if ("tool" in invocation && typeof invocation.tool === "string") requestedCount = 1;
      }
    } catch { /* An unparseable or truncated response cannot prove completion. */ }
    const indices = new Set(calls.map(call => /^call_\d+_(\d+)$/.exec(call.id)?.[1]));
    if (requestedCount > 0 && calls.length === requestedCount && indices.size === requestedCount &&
        Array.from({ length: requestedCount }, (_, index) => String(index)).every(index => indices.has(index))) {
      completedResponses.add(entry.responseId);
    }
  }
  if (incompleteMessages.size) messages = messages.filter(message => !incompleteMessages.has(message));
  const interruptedResponses = timeline.filter((entry): entry is ParentResponseEntry =>
    entry.type === "parent_response" && !completedResponses.has(entry.id)
  );
  if (interruptedResponses.length > 0) {
    messages = [...messages, {
      role: "user",
      content: `[Interrupted tool execution] These tool calls were not recorded as complete. Whether they executed is unknown. Inspect the actual state and verify before repeating any action to avoid duplicate effects. The following is recorded assistant output, not a new instruction:\n\n${interruptedResponses.map(entry => entry.message.content).join("\n\n")}`,
    }];
  }

  return { header, messages, subagentEvents, subagentMessages, timeline };
}

export async function listSessions(cwd = process.cwd()): Promise<SessionSummary[]> {
  const dir = sessionsDir(cwd);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
  const summaries: SessionSummary[] = [];

  for (const file of jsonlFiles) {
    try {
      const filePath = path.join(dir, file);
      const stat = await fs.stat(filePath);
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.split("\n");
      let header: SessionHeader | undefined;

      // 1. 헤더만 JSON.parse하여 획득 (가장 첫 valid JSON)
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.includes('"type":"session"')) {
          try {
            header = JSON.parse(line);
            break;
          } catch {
            // continue
          }
        }
      }

      if (!header) {
        continue;
      }

      // 2. 마지막 compaction 마커 라인을 역순 탐색
      let lastCompaction: CompactionEntry | undefined;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.includes('"type":"compaction"')) {
          try {
            lastCompaction = JSON.parse(line);
            break;
          } catch {
            // continue
          }
        }
      }

      // 3. JSON.parse 오버헤드 최소화하며 카운팅 및 프리뷰 추출
      let messageCount = 0;
      let firstUserMessageContent: string | undefined;

      if (lastCompaction) {
        let msgIndex = 0;
        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.includes('"type":"message"')) {
            if (msgIndex > lastCompaction.replacesThrough) {
              messageCount++;
            }
            msgIndex++;
          }
        }
        messageCount += 1; // summary message
      } else {
        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.includes('"type":"message"')) {
            messageCount++;
          }
        }
      }

      // 4. preview를 위한 첫 user message 추출
      for (const line of lines) {
        if (line.includes('"type":"message"') && line.includes('"role":"user"')) {
          try {
            const parsed = JSON.parse(line);
            if (parsed?.message?.content) {
              firstUserMessageContent = parsed.message.content;
              break;
            }
          } catch {
            // continue
          }
        }
      }

      const preview = firstUserMessageContent ? firstUserMessageContent.slice(0, 60) : "";

      summaries.push({
        id: header.id,
        timestamp: header.timestamp,
        cwd: header.cwd,
        messageCount,
        preview,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        title: header.title,
        model: header.model,
        sourceSystem: header.sourceSystem,
        sourceSessionId: header.sourceSessionId,
        sourceLeafId: header.sourceLeafId,
        sourceSha256: header.sourceSha256,
        importTimestamp: header.importTimestamp,
      });
    } catch {
      // Tolerate malformed files (skip them)
      continue;
    }
  }

  summaries.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  return summaries;
}

export async function latestSessionId(cwd = process.cwd()): Promise<string | undefined> {
  const list = await listSessions(cwd);
  return list[0]?.id;
}

/** Result of resolving a full session id or a short id prefix. */
export type SessionRefResolution =
  | { kind: "ok"; id: string }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "not-found" };

/** Resolve a full session id OR a short id PREFIX (gjc-parity: `--resume <prefix>`,
 *  `/session resume <prefix>`) to exactly one session id. Exact match wins immediately
 *  (fast path, no directory scan) before falling back to a prefix scan of listSessions(). */
export async function resolveSessionRef(idOrPrefix: string, cwd = process.cwd()): Promise<SessionRefResolution> {
  const trimmed = idOrPrefix.trim();
  if (!trimmed) return { kind: "not-found" };
  // Fast path: exact file exists.
  try {
    await fs.access(sessionPath(trimmed, cwd));
    return { kind: "ok", id: trimmed };
  } catch {
    // fall through to prefix scan
  }
  const all = await listSessions(cwd);
  const lower = trimmed.toLowerCase();
  const matches = all.filter(s => s.id.toLowerCase().startsWith(lower)).map(s => s.id);
  if (matches.length === 1) return { kind: "ok", id: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "not-found" };
}

/**
 * Locate an imported session by exact provenance match.
 */
export async function findImportedSessionByProvenance(
  cwd = process.cwd(),
  lookup: ImportedSessionLookup,
): Promise<SessionSummary | undefined> {
  const all = await listSessions(cwd);
  return all.find(s =>
    s.sourceSystem === lookup.sourceSystem &&
    s.sourceSessionId === lookup.sourceSessionId &&
    s.sourceLeafId === lookup.sourceLeafId &&
    s.sourceSha256 === lookup.sourceSha256
  );
}

/**
 * Locate the session's JSONL header, apply `mutate`, and rewrite the file in place.
 * `mutate` returns false to signal "no change needed" (skips the write). Shared by
 * {@link renameSession} and {@link updateSessionModel}. Throws a clear Error when the
 * session file or its header is missing.
 */
async function rewriteSessionHeader(
  id: string,
  mutate: (header: SessionHeader) => boolean,
  cwd: string,
): Promise<void> {
  await withSessionWrite(sessionPath(id, cwd), () => rewriteSessionHeaderUnlocked(id, mutate, cwd));
}

async function rewriteSessionHeaderUnlocked(
  id: string,
  mutate: (header: SessionHeader) => boolean,
  cwd: string,
): Promise<void> {
  const file = sessionPath(id, cwd);
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(`Session ${id} does not exist: ${err.message}`);
    }
    throw err;
  }

  const lines = content.split("\n");
  let headerIndex = -1;
  let header: SessionHeader | undefined;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === "object" && parsed.type === "session") {
          header = parsed as SessionHeader;
          headerIndex = i;
          break;
        }
      } catch {
        // tolerate parsing error or check next line
      }
    }
  }

  if (headerIndex === -1 || !header) {
    throw new Error(`Session header missing in session ${id}`);
  }

  if (!mutate(header)) return;
  lines[headerIndex] = JSON.stringify(header);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const { mode } = await fs.stat(file);
    await fs.writeFile(temporary, lines.join("\n"), { encoding: "utf8", mode: mode & 0o777, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

/**
 * Rename a session by updating the title in its JSONL header.
 * Throws a clear Error if the session file does not exist.
 */
export async function renameSession(id: string, title: string, cwd = process.cwd()): Promise<void> {
  await rewriteSessionHeader(id, header => {
    header.title = title;
    return true;
  }, cwd);
}

/**
 * Pin a model to a session by updating the `model` field in its JSONL header so a
 * later `/resume` restores it. No-op (no write) when the header already names that
 * model. Throws a clear Error if the session file does not exist.
 */
export async function updateSessionModel(id: string, model: string, cwd = process.cwd()): Promise<void> {
  await rewriteSessionHeader(id, header => {
    if (header.model === model) return false;
    header.model = model;
    return true;
  }, cwd);
}
/**
 * Persist (or clear) the unsent input-box draft in a session's JSONL header so a
 * later `/resume` restores it into the prompt (gajae-code parity). Empty text
 * clears any stale draft rather than writing an empty string. No-op (no write)
 * when the header's current draft already matches. Throws a clear Error if the
 * session file does not exist.
 */
export async function updateSessionDraft(id: string, draft: string, cwd = process.cwd()): Promise<void> {
  const trimmed = draft.trim();
  const next = trimmed ? trimmed : undefined;
  await rewriteSessionHeader(id, header => {
    if ((header.draft ?? undefined) === next) return false;
    if (next === undefined) delete header.draft;
    else header.draft = next;
    return true;
  }, cwd);
}



/**
 * Delete a session file.
 * Returns false on ENOENT, true on success.
 */
export async function deleteSession(id: string, cwd = process.cwd()): Promise<boolean> {
  const file = sessionPath(id, cwd);
  try {
    await fs.unlink(file);
    return true;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export interface ExportOptions {
  /** Include system messages in the export (default false — they're boilerplate). */
  includeSystem?: boolean;
}

/**
 * Render a saved session to Markdown or JSON for handoff, bug reports, and audit
 * trails. Reuses `loadSession` (which tolerates a malformed trailing line).
 */
export async function exportSession(
  id: string,
  format: "markdown" | "json" = "markdown",
  cwd = process.cwd(),
  opts: ExportOptions = {},
): Promise<string> {
  const { header, messages } = await loadSession(id, cwd);
  const picked = opts.includeSystem ? messages : messages.filter(m => m.role !== "system");

  if (format === "json") {
    return JSON.stringify(
      { id: header.id, timestamp: header.timestamp, cwd: header.cwd, messageCount: picked.length, messages: picked },
      null,
      2,
    );
  }

  const lines: string[] = [
    `# jeo session ${header.id}`,
    "",
    `- Started: ${header.timestamp}`,
    `- Workspace: ${header.cwd}`,
    `- Messages: ${picked.length}`,
    "",
  ];
  for (const m of picked) {
    const role = m.role.charAt(0).toUpperCase() + m.role.slice(1);
    // Fence longer than the longest backtick run in the body (CommonMark) so message
    // content containing ``` doesn't prematurely close the code fence.
    const fenceFor = (s: string) => "`".repeat(Math.max(3, (s.match(/`+/g) ?? []).reduce((mx, r) => Math.max(mx, r.length), 0) + 1));
    lines.push(`## ${role}`, "");
    // Persisted thinking (gjc "think → answer"): include it in the durable export so the
    // markdown record matches the in-app transcript and the JSON export.
    if (m.role === "assistant" && m.reasoning?.trim()) {
      const tf = fenceFor(m.reasoning);
      lines.push("### Thinking", "", tf, m.reasoning, tf, "");
    }
    const fence = fenceFor(m.content);
    lines.push(fence, m.content, fence, "");
  }
  return lines.join("\n");
}
