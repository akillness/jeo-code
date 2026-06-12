import chalk from "chalk";
import { BOX_ASCII, BOX_UNICODE, padLineTo, type BoxGlyphs } from "./layout";
import { stripAnsi, visibleWidth, animatedGradientText } from "./color";
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
  /** DNA-flow border animation: a flowing gradient painted over the top/bottom
   *  border glyphs (content rows untouched). Stateless — the caller drives
   *  `phase` per tick, so nothing is retained between frames. Below TrueColor
   *  (`colorLevel < 3`) this degrades to the static `paint`/`paintShadow`. */
  flow?: { palette: readonly string[]; phase: number; colorLevel: number };
  /** Width-1 mark prepended to the border title (e.g. the DNA claw beat glyph). */
  titleMark?: string;
  /** Themed +/- painters for `language: "patch"` cards (edit diffs): applied to
   *  the FULL padded row so added/removed lines read as background-tinted
   *  stripes — block-level contrast inside the card. */
  diffPaint?: { add: (s: string) => string; del: (s: string) => string };
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

/** joc-ref file-content preview: a line-number gutter (` 1│ #…`) before each
 *  previewed row, closed by `… N more lines` when clipped. ANSI-free so cards
 *  stay byte-stable across color modes; `│` degrades to `|` without unicode. */
function numberedPreviewLines(text: string, maxLines: number, maxChars: number, unicode = true): string[] {
  const clean = redactSecrets(text.replace(/\r\n/g, "\n"));
  const raw = clean.split("\n");
  const gutter = unicode ? "│" : "|";
  const width = String(Math.min(raw.length, maxLines)).length;
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < raw.length; i++) {
    if (out.length >= maxLines || used >= maxChars) break;
    const remaining = Math.max(0, maxChars - used);
    const line = raw[i]!;
    const next = line.length > remaining ? `${line.slice(0, Math.max(0, remaining - 1))}…` : line;
    out.push(`${String(i + 1).padStart(width)}${gutter} ${next}`);
    used += next.length + 1;
  }
  const hidden = raw.length - out.length;
  if (hidden > 0) out.push(`… ${hidden} more line${hidden === 1 ? "" : "s"}`);
  return out.length > 0 ? out : [""];
}

/**
 * Render an edit tool's `editBlock` as gjc-style diff lines for the forge card:
 *  - SEARCH/REPLACE hunks → `- old` / `+ new` rows per hunk (capped), closed by a
 *    `~N hunk(s) · +A −R line(s)` summary divider row.
 *  - `≔` line-directives → the payload as `+ added` rows with a `+A line(s)` summary.
 * Returns null for formats it does not recognize (caller falls back to a raw preview).
 * Mirrors agent/tools.ts' parse rules WITHOUT importing the agent layer (TUI stays
 * dependency-light); plain +/- prefixes keep the card ANSI-free in every color mode.
 */
export function editBlockDiffLines(editBlock: string, maxRows = 10): string[] | null {
  const block = editBlock.replace(/\r\n/g, "\n");
  const trimFrame = (s: string): string => {
    let t = s;
    if (t.startsWith("\n")) t = t.slice(1);
    if (t.endsWith("\n")) t = t.slice(0, -1);
    return t;
  };
  const rows: string[] = [];
  let added = 0;
  let removed = 0;
  const push = (prefix: "+" | "-", text: string): void => {
    if (prefix === "+") added++;
    else removed++;
    if (rows.length < maxRows) {
      const redacted = redactSecrets(text);
      const colored = prefix === "+" ? chalk.green(`+ ${redacted}`) : chalk.red(`- ${redacted}`);
      rows.push(colored);
    }
  };

  if (block.includes("<<<<<<< SEARCH")) {
    const segs = block.split("<<<<<<< SEARCH").slice(1);
    let hunks = 0;
    for (const seg of segs) {
      const eq = seg.indexOf("=======");
      if (eq === -1) return null; // malformed — let the raw preview show it
      const gt = seg.indexOf(">>>>>>>", eq);
      if (gt === -1) return null;
      hunks++;
      const search = trimFrame(seg.slice(0, eq));
      const replace = trimFrame(seg.slice(eq + 7, gt));
      if (search) for (const l of search.split("\n")) push("-", l);
      if (replace) for (const l of replace.split("\n")) push("+", l);
    }
    if (hunks === 0) return null;
    const hidden = added + removed - rows.length;
    if (hidden > 0) rows.push(`… ${hidden} more change line(s)`);
    rows.push(FORGE_DIVIDER_PREFIX + "Summary");
    rows.push(`~${hunks} hunk(s) · +${added} −${removed} line(s)`);
    return rows;
  }

  if (block.startsWith("≔")) {
    const directive = block.split("\n", 1)[0] ?? "≔";
    const payload = block.includes("\n") ? block.slice(block.indexOf("\n") + 1) : "";
    rows.push(redactSecrets(directive));
    if (payload) for (const l of payload.split("\n")) push("+", l);
    const hidden = added - Math.max(0, rows.length - 1);
    if (hidden > 0) rows.push(`… ${hidden} more line(s)`);
    rows.push(FORGE_DIVIDER_PREFIX + "Summary");
    rows.push(`${directive.slice(0, 24)} · +${added} line(s)`);
    return rows;
  }

  return null;
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
        ...numberedPreviewLines(content, 6, 700, opts.unicode !== false),
        FORGE_DIVIDER_PREFIX + "Summary",
        `wrote ${lineCount} lines, ${content.length} bytes${langTag}`
      ],
    };
  }
  if (normalized === "edit") {
    const filePath = stringArg(args, "filePath", "path") ?? "<missing path>";
    const editBlock = stringArg(args, "editBlock", "edit") ?? "";
    // gjc-style diff view: SEARCH/REPLACE hunks render as -old/+new lines with a
    // hunk/line summary; ≔ directives render their payload as +added lines. Raw
    // fallback keeps unknown formats visible. Plain +/- prefixes (no ANSI) keep
    // the card byte-stable across color modes.
    const diff = editBlockDiffLines(editBlock);
    return {
      title: `Edit : ${filePath}`,
      language: "patch",
      lines: diff ?? [...previewLines(editBlock, 8, 800)],
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

  if (normalized === "web_search") {
    const query = stringArg(args, "query") ?? "<missing query>";
    const recency = stringArg(args, "recency");
    const lines = [`query: ${query}`];
    if (recency) lines.push(`recency: ${recency}`);
    return {
      title: `Web Search: ${query.length > 60 ? `${query.slice(0, 59)}…` : query}`,
      language: "text",
      lines,
    };
  }

  return { title: `${safeTool} arguments`, language: "json", lines: jsonPreview(args) };
}

/** Parsed gjc-style Web Search card pieces, reconstructed from the structured
 *  `web_search` tool output (see `formatWebSearchOutput` in agent/web-search.ts). */
export interface WebSearchCard {
  /** `Provider · N sources` header meta for the card title (e.g. `Anthropic · 18 sources`). */
  titleMeta: string;
  lines: string[];
}

/**
 * Build the gjc-style Web Search card body from the tool's structured output:
 * `Query:` line, then `Answer` / `Sources` / `Metadata` divider sections with
 * tree-glyph (`├─`/`└─`) rows and `… N more` truncation — visually mirroring
 * gjc's web_search renderer. Returns null when the output does not carry the
 * structured shape (errors fall back to the generic result card).
 */
export function webSearchCardLines(output: string, opts: { unicode?: boolean } = {}): WebSearchCard | null {
  if (!output.startsWith("Query: ")) return null;
  const uni = opts.unicode !== false;
  const branch = uni ? "├─" : "|-";
  const last = uni ? "└─" : "`-";
  const cont = uni ? "│ " : "| ";
  const ellipsis = uni ? "…" : "...";

  // Section split on "## " heads; everything before the first head is the Query line(s).
  const sections = new Map<string, string[]>();
  let current = "__head__";
  sections.set(current, []);
  for (const line of output.split("\n")) {
    const m = /^## (\w+)/.exec(line);
    if (m) {
      current = m[1]!;
      sections.set(current, []);
      continue;
    }
    sections.get(current)!.push(line);
  }
  const answer = (sections.get("Answer") ?? []).filter(l => l.trim());
  const metadata = (sections.get("Metadata") ?? []).filter(l => l.trim());
  if (answer.length === 0 && metadata.length === 0) return null;

  const lines: string[] = [];
  const queryLine = (sections.get("__head__") ?? []).find(l => l.startsWith("Query: "));
  if (queryLine) lines.push(queryLine);

  // Answer: tree-glyph preview, capped like gjc's collapsed card.
  const MAX_ANSWER = 3;
  lines.push(forgeDivider("Answer"));
  const answerShown = answer.slice(0, MAX_ANSWER);
  answerShown.forEach((l, i) => {
    const glyph = i === answerShown.length - 1 && answer.length <= MAX_ANSWER ? last : branch;
    lines.push(`${glyph} ${l}`);
  });
  if (answer.length > MAX_ANSWER) lines.push(`${ellipsis} ${answer.length - MAX_ANSWER} more lines`);

  // Sources: `[n] title (domain) · age` + indented url, capped.
  const sourceRaw = (sections.get("Sources") ?? []).filter(l => l.trim());
  const entries: { title: string; url?: string }[] = [];
  for (const line of sourceRaw) {
    const head = /^\[\d+\] (.*)$/.exec(line);
    if (head) entries.push({ title: head[1]! });
    else if (entries.length > 0 && line.startsWith("    ") && !entries[entries.length - 1]!.url) {
      entries[entries.length - 1]!.url = line.trim();
    }
  }
  const MAX_SOURCES = 6;
  lines.push(forgeDivider("Sources"));
  if (entries.length === 0) lines.push(`${last} No sources returned`);
  const shown = entries.slice(0, MAX_SOURCES);
  shown.forEach((src, i) => {
    const isLast = i === shown.length - 1 && entries.length <= MAX_SOURCES;
    lines.push(`${isLast && !src.url ? last : branch} ${src.title}`);
    if (src.url) lines.push(`${isLast ? last : cont} ${src.url}`);
  });
  if (entries.length > MAX_SOURCES) lines.push(`${last} ${ellipsis} ${entries.length - MAX_SOURCES} more sources`);

  // Metadata: verbatim key/value lines.
  lines.push(forgeDivider("Metadata"));
  lines.push(...metadata);

  const sourceCount = entries.length;
  const provider = metadata.find(l => l.startsWith("Provider: "))?.slice("Provider: ".length) ?? "web";
  return { titleMeta: `${provider} · ${sourceCount} source${sourceCount === 1 ? "" : "s"}`, lines };
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
  // DNA-flow border painters: a flowing gradient over the border glyph runs, the
  // bottom offset half a cycle so the helix appears to travel around the card.
  // Pure functions of (text, phase) — no per-frame state is retained — and below
  // TrueColor animatedGradientText returns the text unchanged, so the static
  // paint/shadow path takes over byte-identically.
  const flowOn = !!opts.flow && opts.color !== false;
  const flowTop = (s: string): string => {
    if (!flowOn) return paint(s);
    const g = animatedGradientText(s, opts.flow!.palette, opts.flow!.phase, { colorLevel: opts.flow!.colorLevel });
    return g === s ? paint(s) : g;
  };
  const flowBottom = (s: string): string => {
    if (!flowOn) return shadow(s);
    const g = animatedGradientText(s, opts.flow!.palette, opts.flow!.phase + 0.5, { colorLevel: opts.flow!.colorLevel });
    return g === s ? shadow(s) : g;
  };
  const inner = Math.max(1, width - 2);
  // joc-ref layout: the title rides ON the top border (`╭── ✗ Bash ──────╮`)
  // instead of occupying a title row + separator — two chrome rows become one,
  // and the card scans like the reference's labeled panel.
  const mark = opts.titleMark ? `${opts.titleMark} ` : "";
  const label = truncateToWidth(summary.title, Math.max(1, inner - 4 - visibleWidth(mark)));
  const titleText = ` ${mark}${opts.color === false ? label : chalk.bold(label)} `;
  const lead = glyphs.h.repeat(Math.min(2, inner));
  const tail = Math.max(0, inner - visibleWidth(lead) - visibleWidth(titleText));
  const top = flowTop(glyphs.tl + lead) + titleText + flowTop(glyphs.h.repeat(tail) + glyphs.tr);
  const bottom = flowBottom(glyphs.bl + glyphs.h.repeat(inner) + glyphs.br);
  const rendered: string[] = [top];

  // joc-ref readability: a one-column gutter between the left border and the
  // content (`│ $ cmd …`), so text never touches the frame. Content word-wraps
  // to the guttered width; a labeled divider still counts as one content row.
  const gutterWidth = Math.max(1, inner - 1);
  const content: string[] = [];
  for (const line of summary.lines) {
    if (line.startsWith(FORGE_DIVIDER_PREFIX)) { content.push(line); continue; }
    for (const wrapped of wrapPlainLine(line, gutterWidth)) content.push(wrapped);
  }
  const renderDivider = (rawLabel: string): string => {
    const text = rawLabel ? ` ${rawLabel} ` : "";
    const rest = Math.max(0, inner - visibleWidth(lead) - visibleWidth(text));
    const bar = `${lead}${text}${glyphs.h.repeat(rest)}`;
    return paint(glyphs.v) + paint(padLineTo(bar, inner, "left")) + shadow(glyphs.v);
  };
  // Patch cards: +/- rows get the themed diff stripe painted over the FULL
  // padded row (background tint spans the card width), so added/removed lines
  // separate as blocks instead of relying on a colored sign alone.
  const diffRows = summary.language === "patch" && opts.color !== false ? opts.diffPaint : undefined;
  const contentRow = (line: string): string => {
    const padded = padLineTo(` ${line}`, inner, "left");
    const body = diffRows && line.startsWith("+")
      ? diffRows.add(padded)
      : diffRows && line.startsWith("-")
        ? diffRows.del(padded)
        : padded;
    return paint(glyphs.v) + body + shadow(glyphs.v);
  };
  const clipped = content.slice(0, maxLines);
  for (const line of clipped) {
    if (line.startsWith(FORGE_DIVIDER_PREFIX)) {
      rendered.push(renderDivider(line.slice(FORGE_DIVIDER_PREFIX.length)));
    } else {
      rendered.push(contentRow(line));
    }
  }
  if (content.length > clipped.length) {
    rendered.push(contentRow(`… ${content.length - clipped.length} hidden line(s)`));
  }
  rendered.push(bottom);
  return rendered;
}
