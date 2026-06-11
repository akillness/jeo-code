import chalk from "chalk";
import { BOX_ASCII, BOX_UNICODE, padLineTo, type BoxGlyphs } from "./layout";
import { stripAnsi, visibleWidth } from "./color";
import { truncateToWidth } from "./width";
import { type UiCategory } from "./category-index";

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
  /** Shaded-edge painter (bottom border + right edge). Defaults to a dimmed `paint`
   *  when color is on — the lit/shaded two-tone gives the card visible depth. */
  paintShadow?: (s: string) => string;
  index?: number;
  category?: UiCategory;
  color?: boolean;
}

const SECRET_VALUE_RE = /(api[_-]?key|authorization|bearer|password|secret|token)(\s*[:=]\s*)(["']?)[^"'\s,}]+/gi;
const SECRET_JSON_RE = /("(?:api[_-]?key|authorization|password|secret|token)"\s*:\s*")[^"]+(")/gi;
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  tsx: "typescript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  sh: "bash",
  py: "python",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  css: "css",
  html: "html",
  rs: "rust",
  go: "go",
};


export function redactSecrets(input: string): string {
  return input
    .replace(SECRET_VALUE_RE, (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}<redacted>`)
    .replace(SECRET_JSON_RE, "$1<redacted>$2");
}

/**
 * Sentinel for a labeled in-box divider (e.g. the gjc-style `Output` rule between a command
 * echo and its output body). It is `#`-prefixed so app-side helpers that scan summary lines for
 * the command (skipping `#` notes) never surface it; formatForgeBox rewrites it into a real
 * bordered divider row at render time, where the unicode/ASCII glyph set is known.
 */
const FORGE_DIVIDER_PREFIX = "#\u0000fdiv:";

/** Build a labeled-divider sentinel line for inclusion in a ForgeSummary's `lines`. */
export function forgeDivider(label: string): string {
  return FORGE_DIVIDER_PREFIX + label;
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

export function summarizeForgeInvocation(tool: string, rawArgs: unknown, opts: { unicode?: boolean } = {}): ForgeSummary {
  const args = asRecord(rawArgs);
  const safeTool = tool || "(no tool)";
  const normalized = safeTool.toLowerCase();
  if (normalized === "bash") {
    const command = stringArg(args, "command", "cmd") ?? "";
    const timeout = stringArg(args, "timeoutMs", "timeout");
    // gjc-style command echo: prefix the (redacted, capped) command with `$ `.
    const commandLines = previewLines(command, 8, 800);
    const lines = [`$ ${commandLines[0] ?? ""}`, ...commandLines.slice(1)];
    const cwdKey = Object.keys(args).find(k => /^(cwd|workingdir|workingdirectory|subdir|dir)$/i.test(k));
    if (cwdKey !== undefined) {
      const cwdVal = args[cwdKey];
      if (cwdVal !== undefined && cwdVal !== null && cwdVal !== "") {
        lines.push(`# cwd-relative: ${cwdVal}`);
      }
    }
    if (timeout) {
      const ms = Number(timeout);
      const secs = Number.isFinite(ms) ? (ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1)) : timeout;
      const open = opts.unicode === false ? "[" : "⟦";
      const close = opts.unicode === false ? "]" : "⟧";
      lines.push(`${open}Timeout: ${secs}s${close}`);
    }
    return { title: "Bash", language: "bash", lines };
  }

  if (normalized === "read") {
    const filePath = stringArg(args, "filePath", "path") ?? "<missing path>";
    const range = stringArg(args, "lineRange", "range");
    return {
      title: `Read ${filePath}${range ? `:${range}` : ""}`,
      language: "path",
      lines: [`path: ${filePath}`],
    };
  }

  if (normalized === "write") {
    const filePath = stringArg(args, "filePath", "path") ?? "<missing path>";
    const content = typeof args.content === "string" ? args.content : "";
    const lineCount = content.length === 0 ? 0 : content.split("\n").length;
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const lang = EXT_TO_LANG[ext];
    const langTag = lang ? ` · ${lang}` : "";
    return {
      title: `Write ${filePath}`,
      language: lang || "text",
      lines: [
        ...previewLines(content, 8, 800),
        FORGE_DIVIDER_PREFIX + "Summary",
        `wrote ${lineCount} lines, ${content.length} bytes${langTag}`
      ],
    };
  }

  if (normalized === "edit") {
    const filePath = stringArg(args, "filePath", "path") ?? "<missing path>";
    const editBlock = stringArg(args, "editBlock", "edit") ?? "";
    return {
      title: `Edit : ${filePath}`,
      language: "patch",
      lines: [...previewLines(editBlock, 8, 800)],
    };
  }
  if (normalized === "find") {
    const pattern = stringArg(args, "globPattern", "pattern") ?? "<missing glob>";
    return { title: `Find: ${pattern}`, language: "glob", lines: [`glob: ${pattern}`] };
  }

  if (normalized === "search") {
    const pattern = stringArg(args, "pattern") ?? "<missing pattern>";
    const glob = stringArg(args, "globPattern", "path") ?? "*";
    return { title: `Search: ${pattern}`, language: "regex", lines: [`glob: ${glob}`] };
  }

  if (normalized === "task") {
    const role = stringArg(args, "role") ?? "executor";
    const task = stringArg(args, "task", "prompt", "assignment") ?? "<missing task>";
    const context = stringArg(args, "context");
    return {
      title: `Task: ${role}`,
      language: "text",
      lines: [...previewLines(task, 4, 500), ...(context ? ["context:", ...previewLines(context, 3, 300)] : [])],
    };
  }

  return { title: `${safeTool} arguments`, language: "json", lines: jsonPreview(args) };
}

export function summarizeForgeResult(tool: string, success: boolean, output: string): ForgeSummary {
  const status = success ? "ok" : "failed";
  const safeTool = tool || "(no tool)";
  const normalized = safeTool.toLowerCase();
  let body = output || "<no output>";
  let exitNote: string | null = null;
  if (normalized === "bash") {
    // gjc-style: the engine prefixes failed bash output with `Exit code N` — surface it
    // as a trailing `Command exited with code N` line below the output body instead.
    const m = body.match(/^Exit code (-?\d+)\n?/);
    if (m) {
      exitNote = `Command exited with code ${m[1]}`;
      body = body.slice(m[0].length) || "<no output>";
    } else if (!success) {
      exitNote = "Command failed";
    }
  }
  const lines = previewLines(body, success ? 5 : 10, success ? 600 : 1200);
  if (normalized === "bash") {
    lines.unshift(forgeDivider("Output"));
    if (exitNote) lines.push("", exitNote);
  }
  return {
    title: `${safeTool} result ${status}`,
    language: "output",
    lines,
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

/**
 * Pick as many WHOLE forge boxes as fit `budget` rows. `lines` is the flat render of one or
 * more bordered boxes separated by a single blank line. Boxes are bordered, so a partial box
 * looks broken — this includes only complete boxes, preferring the MOST RECENT (last) ones,
 * and preserves display order. Returns [] when not even one box fits.
 */
export function fitForgeBoxes(lines: string[], budget: number): string[] {
  if (budget <= 0 || lines.length === 0) return [];
  if (lines.length <= budget) return lines;
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line === "") {
      if (cur.length) { groups.push(cur); cur = []; }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) groups.push(cur);
  const kept: string[][] = [];
  let used = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const cost = groups[i]!.length + (kept.length ? 1 : 0); // +1 blank separator between boxes
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(groups[i]!);
  }
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    if (i > 0) out.push("");
    out.push(...kept[i]!);
  }
  return out;
}

export function formatForgeBox(summary: ForgeSummary, opts: ForgeBoxOptions = {}): string[] {
  const innerWidth = opts.width ?? 80;
  const floor = Math.min(24, innerWidth);
  const width = Math.max(floor, Math.min(120, Math.trunc(innerWidth)));
  const maxLines = Math.max(1, Math.trunc(opts.maxLines ?? 10));
  const glyphs = borderGlyphs(opts.unicode);
  const paint = opts.paint ?? chalk.gray;
  const shadow = opts.paintShadow ?? (opts.color === false ? paint : (s: string) => chalk.dim(paint(s)));
  const inner = Math.max(1, width - 2);
  const top = paint(glyphs.tl + glyphs.h.repeat(inner) + glyphs.tr);
  const bottom = shadow(glyphs.bl + glyphs.h.repeat(inner) + glyphs.br);
  // gjc-style header: just the title (e.g. `✗ Bash`, `Write src/app.ts`) — no
  // category badge, no `· language` suffix; the box content speaks for itself.
  const label = summary.title;
  const title = `${opts.color === false ? label : chalk.bold(label)}`;
  // Truncate the title to the inner width BEFORE padding — padLineTo only pads, so a
  // long title/badge would otherwise overflow the right border (box wider than `width`).
  const rendered: string[] = [top, paint(glyphs.v) + padLineTo(truncateToWidth(title, inner), inner, "left") + shadow(glyphs.v)];
  const separator = paint(glyphs.v) + paint(glyphs.h.repeat(inner)) + shadow(glyphs.v);
  rendered.push(separator);

  // A labeled divider counts as a single content row; everything else word-wraps to the
  // inner width before clipping so the box framing stays column-correct.
  const content: string[] = [];
  for (const line of summary.lines) {
    if (line.startsWith(FORGE_DIVIDER_PREFIX)) { content.push(line); continue; }
    for (const wrapped of wrapPlainLine(line, inner)) content.push(wrapped);
  }
  const renderDivider = (rawLabel: string): string => {
    const text = rawLabel ? ` ${rawLabel} ` : "";
    const lead = glyphs.h.repeat(Math.min(2, inner));
    const rest = Math.max(0, inner - visibleWidth(lead) - visibleWidth(text));
    const bar = `${lead}${text}${glyphs.h.repeat(rest)}`;
    return paint(glyphs.v) + paint(padLineTo(bar, inner, "left")) + shadow(glyphs.v);
  };
  const clipped = content.slice(0, maxLines);
  for (const line of clipped) {
    if (line.startsWith(FORGE_DIVIDER_PREFIX)) {
      rendered.push(renderDivider(line.slice(FORGE_DIVIDER_PREFIX.length)));
    } else {
      rendered.push(paint(glyphs.v) + padLineTo(line, inner, "left") + shadow(glyphs.v));
    }
  }
  if (content.length > clipped.length) {
    rendered.push(paint(glyphs.v) + padLineTo(`… ${content.length - clipped.length} hidden line(s)`, inner, "left") + shadow(glyphs.v));
  }
  rendered.push(bottom);
  return rendered;
}
