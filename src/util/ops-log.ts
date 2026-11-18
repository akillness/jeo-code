/**
 * Bounded, owner-only operational & install logging under `<jeoHome>/logs/`.
 *
 * Complements `crash-log.ts` (uncaught process fatals) with structured JSONL
 * telemetry (`logs/jeo.jsonl`) and install/update transcripts (`logs/install.log`)
 * across CLI dispatch failures, stream-idle recovery, Jev/qev probes & calls,
 * hook vetoes/timeouts/errors, and isolated-install / self-update lifecycles.
 *
 * Every write redacts common secret patterns (`redactCrashText`), enforces UTF-8
 * per-entry size bounds, rotates `<file>` -> `<file>.1` at `OPS_LOG_MAX_BYTES`,
 * tightens permissions to `0o600`, and NEVER throws.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { crashLogPath, redactCrashText } from "./crash-log";
import { jeoEnv } from "./env";

export const OPS_LOG_MAX_BYTES = 2_000_000;
export const OPS_LOG_MAX_ENTRY_BYTES = 4_000;
const TAIL_READ_BYTES = 32_768;

export type OpsLogLevel = "info" | "warn" | "error";
export type OpsLogCategory =
  | "cli"
  | "stream"
  | "jev"
  | "hook"
  | "install"
  | "update"
  | "computer"
  | "doctor"
  | "runtime";

export interface OpsLogEntry {
  ts: string;
  level: OpsLogLevel;
  category: OpsLogCategory;
  event: string;
  message?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface OpsLogFileStat {
  path: string;
  exists: boolean;
  bytes: number;
  mtime?: string;
}

export interface OpsLogSummary {
  dir: string;
  opsLog: OpsLogFileStat;
  installLog: OpsLogFileStat;
  crashLog: OpsLogFileStat;
  recentErrors: number;
  recentWarnings: number;
  recentStreamIdles: number;
  recentJevEvents: number;
  lastError?: { ts: string; category: string; event: string; message?: string };
}

function jeoHomeDir(env?: NodeJS.ProcessEnv): string {
  return jeoEnv("CONFIG_DIR", env) || path.join(os.homedir(), ".jeo");
}

export function opsLogDir(env?: NodeJS.ProcessEnv): string {
  return path.join(jeoHomeDir(env), "logs");
}

export function opsLogPath(env?: NodeJS.ProcessEnv): string {
  return path.join(opsLogDir(env), "jeo.jsonl");
}

export function installLogPath(env?: NodeJS.ProcessEnv): string {
  return path.join(opsLogDir(env), "install.log");
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf-8")}…`;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return truncateUtf8(redactCrashText(value), 1_000);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return truncateUtf8(redactCrashText(`${value.name}: ${value.message}`), 1_000);
  }
  if (depth >= 3) return truncateUtf8(redactCrashText(String(value)), 400);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 25)) {
      if (/^(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|secret|password|passwd|token)$/i.test(k)) {
        out[k] = "<redacted>";
      } else {
        out[k] = sanitizeValue(v, depth + 1);
      }
    }
    return out;
  }
  return truncateUtf8(redactCrashText(String(value)), 400);
}

function appendBounded(targetPath: string, line: string): void {
  try {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const st = fs.statSync(targetPath);
      if (st.size + Buffer.byteLength(line, "utf-8") > OPS_LOG_MAX_BYTES) {
        const rotated = `${targetPath}.1`;
        try {
          fs.renameSync(targetPath, rotated);
          try { fs.chmodSync(rotated, 0o600); } catch {}
        } catch {
          fs.writeFileSync(targetPath, "", { mode: 0o600 });
        }
      }
    } catch {
      // File does not exist yet.
    }
    fs.appendFileSync(targetPath, line, { mode: 0o600 });
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {}
  } catch {
    // Diagnostic persistence must never throw into caller flows.
  }
}

export function logOpsEvent(
  entry: Omit<OpsLogEntry, "ts"> & { ts?: string },
  env?: NodeJS.ProcessEnv,
): void {
  try {
    if (jeoEnv("DISABLE_OPS_LOG", env) === "1") return;
    const record: OpsLogEntry = {
      ts: entry.ts ?? new Date().toISOString(),
      level: entry.level,
      category: entry.category,
      event: truncateUtf8(redactCrashText(entry.event), 160),
      ...(entry.message !== undefined
        ? { message: truncateUtf8(redactCrashText(entry.message), 1_500) }
        : {}),
      ...(typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
        ? { durationMs: Math.round(entry.durationMs * 100) / 100 }
        : {}),
      ...(entry.data ? { data: sanitizeValue(entry.data) as Record<string, unknown> } : {}),
    };
    let serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, "utf-8") > OPS_LOG_MAX_ENTRY_BYTES) {
      const slim: OpsLogEntry = {
        ts: record.ts,
        level: record.level,
        category: record.category,
        event: record.event,
        message: truncateUtf8(record.message ?? "", 1_000),
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      };
      serialized = JSON.stringify(slim);
    }
    appendBounded(opsLogPath(env), `${redactCrashText(serialized)}\n`);
  } catch {
    // Never throw.
  }
}

export function appendInstallLog(
  step: string,
  detail?: string | Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): void {
  try {
    if (jeoEnv("DISABLE_OPS_LOG", env) === "1") return;
    const ts = new Date().toISOString();
    const rawDetail =
      detail === undefined
        ? ""
        : typeof detail === "string"
          ? detail
          : JSON.stringify(sanitizeValue(detail));
    const cleanStep = truncateUtf8(redactCrashText(step.replace(/\s+/g, " ").trim()), 200);
    const cleanDetail = rawDetail
      ? ` ${truncateUtf8(redactCrashText(rawDetail.replace(/\r?\n/g, " \\n ")), OPS_LOG_MAX_ENTRY_BYTES - 300)}`
      : "";
    appendBounded(installLogPath(env), `[${ts}] ${cleanStep}${cleanDetail}\n`);
  } catch {
    // Never throw.
  }
}

function statLogFile(filePath: string): OpsLogFileStat {
  try {
    const st = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
    };
  } catch {
    return { path: filePath, exists: false, bytes: 0 };
  }
}

function readTailLines(filePath: string, maxBytes = TAIL_READ_BYTES): string[] {
  let fd: number | undefined;
  try {
    const st = fs.statSync(filePath);
    if (st.size <= 0) return [];
    const readLen = Math.min(st.size, maxBytes);
    const offset = Math.max(0, st.size - readLen);
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, offset);
    let text = buf.subarray(0, bytesRead).toString("utf-8");
    if (offset > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

export function readOpsLogSummary(opts?: {
  env?: NodeJS.ProcessEnv;
  tailEntries?: number;
}): OpsLogSummary {
  const env = opts?.env;
  const tailCap = opts?.tailEntries ?? 100;
  const dir = opsLogDir(env);
  const opsStat = statLogFile(opsLogPath(env));
  const instStat = statLogFile(installLogPath(env));
  const crashTarget = env
    ? path.join(jeoHomeDir(env), "crash.log")
    : crashLogPath();
  const crashStat = statLogFile(crashTarget);

  let recentErrors = 0;
  let recentWarnings = 0;
  let recentStreamIdles = 0;
  let recentJevEvents = 0;
  let lastError: OpsLogSummary["lastError"];

  if (opsStat.exists) {
    const lines = readTailLines(opsStat.path).slice(-tailCap);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Partial<OpsLogEntry>;
        if (parsed.level === "error") {
          recentErrors++;
          lastError = {
            ts: String(parsed.ts ?? ""),
            category: String(parsed.category ?? "runtime"),
            event: String(parsed.event ?? "error"),
            ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
          };
        } else if (parsed.level === "warn") {
          recentWarnings++;
        }
        if (parsed.category === "stream" && typeof parsed.event === "string" && parsed.event.includes("idle")) {
          recentStreamIdles++;
        }
        if (parsed.category === "jev") {
          recentJevEvents++;
        }
      } catch {
        // Ignore malformed tail lines.
      }
    }
  }

  return {
    dir,
    opsLog: opsStat,
    installLog: instStat,
    crashLog: crashStat,
    recentErrors,
    recentWarnings,
    recentStreamIdles,
    recentJevEvents,
    ...(lastError ? { lastError } : {}),
  };
}
