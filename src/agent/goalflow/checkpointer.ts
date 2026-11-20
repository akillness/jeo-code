/**
 * GoalFlow Checkpointers
 * MemoryCheckpointer (in-memory test mock) and FileCheckpointer (atomic durable file store).
 * Pure TypeScript, zero native dependencies.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { CheckpointRecord } from "./types";

export interface Checkpointer<S = Record<string, unknown>> {
  save(record: CheckpointRecord<S>): Promise<void>;
  load(runId: string): Promise<CheckpointRecord<S> | null>;
  findByThread(threadId: string): Promise<CheckpointRecord<S>[]>;
  list(): Promise<CheckpointRecord<S>[]>;
  delete(runId: string): Promise<boolean>;
}

/**
 * In-memory checkpointer for fast, hermetic unit tests.
 */
export class MemoryCheckpointer<S = Record<string, unknown>> implements Checkpointer<S> {
  private readonly storage = new Map<string, CheckpointRecord<S>>();

  async save(record: CheckpointRecord<S>): Promise<void> {
    // Deep clone to ensure immutability
    const clone = JSON.parse(JSON.stringify(record)) as CheckpointRecord<S>;
    this.storage.set(record.runId, clone);
  }

  async load(runId: string): Promise<CheckpointRecord<S> | null> {
    const item = this.storage.get(runId);
    if (!item) return null;
    return JSON.parse(JSON.stringify(item)) as CheckpointRecord<S>;
  }

  async findByThread(threadId: string): Promise<CheckpointRecord<S>[]> {
    const results: CheckpointRecord<S>[] = [];
    for (const record of this.storage.values()) {
      if (record.threadId === threadId) {
        results.push(JSON.parse(JSON.stringify(record)) as CheckpointRecord<S>);
      }
    }
    return results;
  }

  async list(): Promise<CheckpointRecord<S>[]> {
    return Array.from(this.storage.values()).map(
      (r) => JSON.parse(JSON.stringify(r)) as CheckpointRecord<S>,
    );
  }

  async delete(runId: string): Promise<boolean> {
    return this.storage.delete(runId);
  }
}

function sanitizeRunId(runId: string): string {
  if (!runId || typeof runId !== "string") {
    throw new Error("Invalid runId: must be a non-empty string");
  }
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    throw new Error(`Invalid runId with path traversal characters: ${runId}`);
  }
  const sanitized = runId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  if (!sanitized) {
    throw new Error(`Invalid runId after sanitization: ${runId}`);
  }
  return sanitized;
}

/**
 * Durable atomic file checkpointer persisting to:
 * <cwd>/.jeo/state/goalflow/runs/<runId>.json
 */
export class FileCheckpointer<S = Record<string, unknown>> implements Checkpointer<S> {
  readonly runsDir: string;

  constructor(opts?: { baseDir?: string; cwd?: string }) {
    if (opts?.baseDir) {
      this.runsDir = opts.baseDir;
    } else {
      const root = opts?.cwd ?? process.cwd();
      this.runsDir = path.join(root, ".jeo", "state", "goalflow", "runs");
    }
  }

  async save(record: CheckpointRecord<S>): Promise<void> {
    const cleanId = sanitizeRunId(record.runId);
    const targetPath = path.join(this.runsDir, `${cleanId}.json`);
    const tempPath = path.join(this.runsDir, `${cleanId}.${crypto.randomUUID()}.tmp`);

    await fs.mkdir(this.runsDir, { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(tempPath, targetPath);
  }

  async load(runId: string): Promise<CheckpointRecord<S> | null> {
    const cleanId = sanitizeRunId(runId);
    const targetPath = path.join(this.runsDir, `${cleanId}.json`);

    try {
      const raw = await fs.readFile(targetPath, "utf8");
      return JSON.parse(raw) as CheckpointRecord<S>;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async findByThread(threadId: string): Promise<CheckpointRecord<S>[]> {
    const all = await this.list();
    return all.filter((r) => r.threadId === threadId);
  }

  async list(): Promise<CheckpointRecord<S>[]> {
    try {
      const entries = await fs.readdir(this.runsDir, { withFileTypes: true });
      const records: CheckpointRecord<S>[] = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const filePath = path.join(this.runsDir, entry.name);
        try {
          const raw = await fs.readFile(filePath, "utf8");
          records.push(JSON.parse(raw) as CheckpointRecord<S>);
        } catch {
          // Skip corrupt or locked files
        }
      }

      return records;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async delete(runId: string): Promise<boolean> {
    const cleanId = sanitizeRunId(runId);
    const targetPath = path.join(this.runsDir, `${cleanId}.json`);

    try {
      await fs.unlink(targetPath);
      return true;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }
}
