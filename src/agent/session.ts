import type { Message } from "./loop";
import { getLocalJocDir } from "./state";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  title?: string;
}

export interface SessionEntry {
  type: "message";
  timestamp: string;
  message: Message;
}

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
  title?: string;
}

export const SESSION_VERSION = 1;

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function sessionsDir(cwd = process.cwd()): string {
  return path.join(getLocalJocDir(cwd), "sessions");
}

export function sessionPath(id: string, cwd = process.cwd()): string {
  return path.join(sessionsDir(cwd), `${id}.jsonl`);
}

export async function createSession(
  cwd = process.cwd(),
  id = newSessionId()
): Promise<{ id: string; path: string }> {
  const dir = sessionsDir(cwd);
  await fs.mkdir(dir, { recursive: true });

  const header: SessionHeader = {
    type: "session",
    version: SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
  };

  const file = sessionPath(id, cwd);
  await fs.writeFile(file, JSON.stringify(header) + "\n", "utf8");

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

  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

/** Append a batch of messages with ONE fs append (turn-end persistence: a long
 *  turn previously issued one sequential appendFile per intermediate message). */
export async function appendMessages(
  id: string,
  messages: readonly Message[],
  cwd = process.cwd()
): Promise<void> {
  if (messages.length === 0) return;
  const file = sessionPath(id, cwd);
  const timestamp = new Date().toISOString();
  const chunk = messages
    .map(message => JSON.stringify({ type: "message", timestamp, message } satisfies SessionEntry))
    .join("\n") + "\n";
  await fs.appendFile(file, chunk, "utf8");
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

  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

export async function loadSession(
  id: string,
  cwd = process.cwd()
): Promise<{ header: SessionHeader; messages: Message[] }> {
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

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object") {
        if (entry.type === "session" && !header) {
          header = entry as SessionHeader;
        } else if (entry.type === "message") {
          rawMessages.push(entry.message);
        } else if (entry.type === "compaction") {
          compactions.push(entry as CompactionEntry);
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

  return { header, messages };
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
        title: header.title,
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

/**
 * Rename a session by updating the title in its JSONL header.
 * Throws a clear Error if the session file does not exist.
 */
export async function renameSession(id: string, title: string, cwd = process.cwd()): Promise<void> {
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

  header.title = title;
  lines[headerIndex] = JSON.stringify(header);
  await fs.writeFile(file, lines.join("\n"), "utf8");
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
    `# joc session ${header.id}`,
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
    const longest = (m.content.match(/`+/g) ?? []).reduce((mx, r) => Math.max(mx, r.length), 0);
    const fence = "`".repeat(Math.max(3, longest + 1));
    lines.push(`## ${role}`, "", fence, m.content, fence, "");
  }
  return lines.join("\n");
}
