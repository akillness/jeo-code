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
}

export interface SessionEntry {
  type: "message";
  timestamp: string;
  message: Message;
}

export interface SessionSummary {
  id: string;
  timestamp: string;
  cwd: string;
  messageCount: number;
  preview: string;
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
  const messages: Message[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry && typeof entry === "object") {
      if (entry.type === "session" && !header) {
        header = entry as SessionHeader;
      } else if (entry.type === "message") {
        messages.push(entry.message);
      }
    }
  }

  if (!header) {
    throw new Error(`Session header missing in session ${id}`);
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
      const content = await fs.readFile(filePath, "utf8");
      const lines = content.split("\n");
      let header: SessionHeader | undefined;
      let messageCount = 0;
      let firstUserMessageContent: string | undefined;

      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry && typeof entry === "object") {
          if (entry.type === "session" && !header) {
            header = entry as SessionHeader;
          } else if (entry.type === "message") {
            messageCount++;
            if (!firstUserMessageContent && entry.message?.role === "user") {
              firstUserMessageContent = entry.message.content;
            }
          }
        }
      }

      if (!header) {
        continue;
      }

      const preview = firstUserMessageContent ? firstUserMessageContent.slice(0, 60) : "";

      summaries.push({
        id: header.id,
        timestamp: header.timestamp,
        cwd: header.cwd,
        messageCount,
        preview,
      });
    } catch {
      // Tolerate malformed files (skip them)
      continue;
    }
  }

  summaries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return summaries;
}

export async function latestSessionId(cwd = process.cwd()): Promise<string | undefined> {
  const list = await listSessions(cwd);
  return list[0]?.id;
}
