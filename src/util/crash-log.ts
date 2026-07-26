/**
 * Best-effort, synchronous, owner-only crash log — gjc PR #3051 parity, scoped to
 * jeo-native persistence only (no daily-logger/archive infrastructure ported).
 *
 * Written directly from `src/cli.ts`'s process-level `uncaughtException`/
 * `unhandledRejection` handler, BEFORE the clean "error: …" line hits stderr, so a
 * fatal that tears the process down still leaves one bounded, redacted breadcrumb
 * under jeo's existing config dir for later triage — without depending on the TUI
 * being alive or the terminal being in a readable state.
 *
 * Every entry: (1) redacts common bearer/API-key/secret-shaped substrings, (2) is
 * capped and UTF-8-safely truncated so one huge error can't itself blow the file
 * past its ceiling in a single write, and (3) is appended to a single file that
 * gets RESET (not grown forever) once that ceiling is crossed — a crash loop can
 * never fill the disk. `writeCrashLog` NEVER throws: a broken log path/permission
 * issue must never mask the real fatal error it's trying to record.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jeoEnv } from "./env";

/** Total file size ceiling (bytes); once exceeded the log is RESET (overwritten
 *  with just the new entry) on the next write instead of appended to. */
export const CRASH_LOG_MAX_BYTES = 1_000_000;
/** Per-record cap (bytes), applied to the formatted message+stack body before it
 *  is written — independent of the file-level ceiling above. */
export const CRASH_LOG_MAX_ENTRY_BYTES = 8_000;

function crashLogDir(): string {
  return jeoEnv("CONFIG_DIR") || path.join(os.homedir(), ".jeo");
}

export function crashLogPath(): string {
  return path.join(crashLogDir(), "crash.log");
}

// Bearer tokens (e.g. `Authorization: Bearer sk-…`) carry the secret AFTER a
// space, so they need their own pattern — a generic `key: value` matcher stops
// at the first space and would leave the actual token unredacted.
const BEARER_RE = /\bBearer\s+[^\s"'`]+/gi;
// `key: value` / `key=value`, optionally quoted; value stops at the first
// delimiter (space, quote, comma, closing brace/bracket).
const KV_SECRET_RE =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd|token)\b(\s*[:=]\s*)("?)([^\s"'`,}\]]+)\3/gi;
// `"authorization": "value"` / `"apiKey": "value"` style JSON fields, including
// ones whose value legitimately contains spaces (e.g. an embedded auth header).
const JSON_SECRET_RE =
  /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|secret|password|passwd|token)"\s*:\s*")[^"]*(")/gi;

/** Redact common bearer/API-key/secret-shaped substrings. Conservative pattern
 *  match, not a secret scanner — best-effort only, applied before persistence. */
export function redactCrashText(input: string): string {
  return input
    .replace(BEARER_RE, "Bearer <redacted>")
    .replace(JSON_SECRET_RE, "$1<redacted>$2")
    .replace(KV_SECRET_RE, (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}<redacted>${quote}`);
}

/** Truncate to a byte budget without splitting a UTF-8 multi-byte sequence — a
 *  naive string/byte slice can cut mid-codepoint (or mid-surrogate-pair on the
 *  JS-string side), corrupting the tail into replacement characters on decode. */
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // A UTF-8 continuation byte is 10xxxxxx (0x80-0xBF); back off the boundary so
  // the cut never lands inside a multi-byte codepoint.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf-8")}…`;
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) {
    const header = `${reason.name || "Error"}: ${reason.message || ""}`;
    return reason.stack && reason.stack !== header ? `${header}\n${reason.stack}` : header;
  }
  if (typeof reason === "string") return reason;
  if (reason === undefined) return "undefined";
  if (reason === null) return "null";
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

function formatEntry(reason: unknown): string {
  const redacted = redactCrashText(describeReason(reason));
  const bounded = truncateUtf8(redacted, CRASH_LOG_MAX_ENTRY_BYTES);
  return `[${new Date().toISOString()}] ${bounded}\n`;
}

/** Append one crash record to the bounded, owner-only crash log (resetting the
 *  file first if it has crossed the size ceiling). Synchronous so it can run
 *  directly inside `uncaughtException`/`unhandledRejection` handlers before the
 *  process exits. NEVER throws. */
export function writeCrashLog(reason: unknown): void {
  try {
    const dir = crashLogDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = crashLogPath();
    const entry = formatEntry(reason);
    let reset = false;
    try {
      reset = fs.statSync(target).size > CRASH_LOG_MAX_BYTES;
    } catch {
      // No existing (or unreadable) file — nothing to reset, just create it.
    }
    if (reset) fs.writeFileSync(target, entry, { mode: 0o600 });
    else fs.appendFileSync(target, entry, { mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600); // owner-only even if the file pre-existed with looser perms
    } catch {
      // Best-effort permission tightening only.
    }
  } catch {
    // Crash logging is a diagnostic nicety, never a dependency of the fatal
    // path itself — a write failure here must never mask the real fatal error.
  }
}
