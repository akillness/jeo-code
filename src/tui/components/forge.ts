import chalk from "chalk";
import { BOX_ASCII, BOX_UNICODE, padLineTo, type BoxGlyphs } from "./layout";
import { stripAnsi, visibleWidth } from "./color";

export interface ForgeSummary {
  title: string;
  language?: string;
  lines: string[];
}

export interface ForgeBoxOptions {
  width?: number;
  maxLines?: number;
  unicode?: boolean;
  paint?: (s: string) => string;
}

const SECRET_VALUE_RE = /(api[_-]?key|authorization|bearer|password|secret|token)(\s*[:=]\s*)(["']?)[^"'\s,}]+/gi;
const SECRET_JSON_RE = /("(?:api[_-]?key|authorization|password|secret|token)"\s*:\s*")[^"]+(")/gi;

export function redactSecrets(input: string): string {
  return input
    .replace(SECRET_VALUE_RE, (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}<redacted>`)
    .replace(SECRET_JSON_RE, "$1<redacted>$2");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function previewLines(text: string, maxLines: number, maxChars: number): string[] {
  const clean = redactSecrets(text.replace(/\r\n/g, "\n"));
  const raw = clean.split("\n");
  const out: string[] = [];
  let used = 0;
  for (const line of raw) {
    if (out.length >= maxLines || used >= maxChars) break;
    const remaining = Math.max(0, maxChars - used);
    const next = line.length > remaining ? `${line.slice(0, Math.max(0, remaining - 1))}…` : line;
    out.push(next);
    used += next.length + 1;
  }
  if (raw.length > out.length || clean.length > used) out.push(`… ${Math.max(0, raw.length - out.length)} more line(s)`);
  return out.length > 0 ? out : [""];
}

function jsonPreview(args: Record<string, unknown>): string[] {
  try {
    return previewLines(JSON.stringify(args, null, 2), 6, 500);
  } catch {
    return ["<unrenderable arguments>"];
  }
}

export function summarizeForgeInvocation(tool: string, rawArgs: unknown): ForgeSummary {
  const args = asRecord(rawArgs);
  const normalized = tool.toLowerCase();
  if (normalized === "bash") {
    const command = stringArg(args, "command", "cmd") ?? "";
    const timeout = stringArg(args, "timeoutMs", "timeout");
    const lines = [...previewLines(command, 8, 800)];
    if (timeout) lines.unshift(`# timeoutMs: ${timeout}`);
    return { title: "bash command", language: "bash", lines };
  }

  if (normalized === "read") {
    const filePath = stringArg(args, "filePath", "path") ?? "<missing path>";
    const range = stringArg(args, "lineRange", "range");
    return {
      title: `read ${filePath}`,
      language: "path",
      lines: [`path: ${filePath}`, range ? `range: ${range}` : "range: full/default preview"],
    };
  }

  if (normalized === "write") {
    const filePath = stringArg(args, "filePath", "path") ?? "<missing path>";
    const content = typeof args.content === "string" ? args.content : "";
    const lineCount = content.length === 0 ? 0 : content.split("\n").length;
    return {
      title: `write ${filePath}`,
      language: "text",
      lines: [`# ${content.length} bytes · ${lineCount} line(s) -> ${filePath}`, ...previewLines(content, 8, 800)],
    };
  }

  if (normalized === "edit") {
    const filePath = stringArg(args, "filePath", "path") ?? "<missing path>";
    const editBlock = stringArg(args, "editBlock", "edit") ?? "";
    return {
      title: `edit ${filePath}`,
      language: "patch",
      lines: [`# patch -> ${filePath}`, ...previewLines(editBlock, 8, 800)],
    };
  }

  if (normalized === "find") {
    const pattern = stringArg(args, "globPattern", "pattern") ?? "<missing glob>";
    return { title: "find files", language: "glob", lines: [`glob: ${pattern}`] };
  }

  if (normalized === "search") {
    const pattern = stringArg(args, "pattern") ?? "<missing pattern>";
    const glob = stringArg(args, "globPattern", "path") ?? "*";
    return { title: "search content", language: "regex", lines: [`pattern: ${pattern}`, `glob: ${glob}`] };
  }

  return { title: `${tool} arguments`, language: "json", lines: jsonPreview(args) };
}

export function summarizeForgeResult(tool: string, success: boolean, output: string): ForgeSummary {
  const status = success ? "ok" : "failed";
  return {
    title: `${tool} result ${status}`,
    language: "output",
    lines: previewLines(output || "<no output>", success ? 5 : 10, success ? 600 : 1200),
  };
}

function wrapPlainLine(line: string, width: number): string[] {
  const plain = stripAnsi(line);
  if (width <= 0) return [""];
  if (visibleWidth(line) <= width) return [line];
  const out: string[] = [];
  for (let i = 0; i < plain.length; i += width) out.push(plain.slice(i, i + width));
  return out;
}

function borderGlyphs(unicode: boolean | undefined): BoxGlyphs {
  return unicode === false ? BOX_ASCII : BOX_UNICODE;
}

export function formatForgeBox(summary: ForgeSummary, opts: ForgeBoxOptions = {}): string[] {
  const width = Math.max(24, Math.min(120, Math.trunc(opts.width ?? 80)));
  const maxLines = Math.max(1, Math.trunc(opts.maxLines ?? 10));
  const glyphs = borderGlyphs(opts.unicode);
  const paint = opts.paint ?? chalk.gray;
  const inner = Math.max(1, width - 2);
  const top = paint(glyphs.tl + glyphs.h.repeat(inner) + glyphs.tr);
  const bottom = paint(glyphs.bl + glyphs.h.repeat(inner) + glyphs.br);
  const label = summary.language ? `${summary.title} · ${summary.language}` : summary.title;
  const title = `${chalk.bold(label)}`;
  const rendered: string[] = [top, paint(glyphs.v) + padLineTo(title, inner, "left") + paint(glyphs.v)];
  const separator = paint(glyphs.v) + paint(glyphs.h.repeat(inner)) + paint(glyphs.v);
  rendered.push(separator);

  const content: string[] = [];
  for (const line of summary.lines) {
    for (const wrapped of wrapPlainLine(line, inner)) content.push(wrapped);
  }
  const clipped = content.slice(0, maxLines);
  for (const line of clipped) rendered.push(paint(glyphs.v) + padLineTo(line, inner, "left") + paint(glyphs.v));
  if (content.length > clipped.length) {
    rendered.push(paint(glyphs.v) + padLineTo(`… ${content.length - clipped.length} hidden line(s)`, inner, "left") + paint(glyphs.v));
  }
  rendered.push(bottom);
  return rendered;
}
