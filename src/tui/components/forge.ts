import chalk from "chalk";
import { BOX_ASCII, BOX_UNICODE, padLineTo, type BoxGlyphs } from "./layout";
import { visibleWidth, animatedGradientText } from "./color";
import { truncateToWidth, wrapTextWithAnsi } from "./width";
import { lightHighlightLine, sanitizeForTerminal } from "./code-view";
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
  /** Width-1 mark prepended to the border title (e.g. the jeo prompt beat glyph). */
  titleMark?: string;
  /** Themed +/- painters for `language: "patch"` cards (edit diffs): applied to
   *  the FULL padded row so added/removed lines read as background-tinted
   *  stripes — block-level contrast inside the card. */
  diffPaint?: { add: (s: string) => string; del: (s: string) => string };
  /** Faint card background tint painter — applied to every WHOLE box row (borders
   *  + content) so the card reads as a panel. Interior coloring uses targeted close
   *  codes, so the fill spans each row. Identity/omitted = transparent card. Patch
   *  `diffPaint` rows set their own background and intentionally override it. */
  fill?: (s: string) => string;
  /** In-flight shading: render the card as a flat DIMMED block to indicate it is
   *  not done yet. Strips inner color and wraps every row in `chalk.dim`, so a live
   *  card reads as shaded until the result arrives and the normal formatted card
   *  replaces it. Overrides `fill`/`flow` coloring. */
  dim?: boolean;
}

const SECRET_WORD_HINT_RE = /(?:api|auth|bearer|pass|secret|token)/i;
const KEY_SEGMENT_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;
const SECRET_KEY_RE = /^(?:apikey|authorization|bearer|password|passwd|secret|token)$/;
const SECRET_METRIC_SUFFIX_RE = /^(?:count|size|limit|budget|usage|window|rate|len|length)$/;
const SECRET_JSON_KEY_RE = /"([A-Za-z0-9_.-]{1,128})"(\s*:\s*)"/g;
const SECRET_JSON_VAL_RE = /(?:[^"\r\n\\]|\\[^\r\n])+"/y;
const SECRET_UNCLOSED_VAL_RE = /[^\r\n]+/y;
const SECRET_KEY_SEP_RE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,128})(\s*[:=]\s*)/g;
const AUTH_SCHEME_RE = /((?:bearer|basic|token|digest)\s+)/iy;
const SECRET_DQ_VAL_RE = /"(?:\\[^\r\n]|[^"\\\r\n])*"/y;
const SECRET_SQ_VAL_RE = /'[^'\r\n]*'/y;
const SECRET_UNQUOTED_VAL_RE = /[^"'\s,}]+/y;
const BEARER_SPACE_RE = /((?:(?<![A-Za-z0-9_])[Bb][Ee][Aa][Rr][Ee][Rr]|(?<=[a-z0-9])Bearer)\s+)(["']?)([^\s"',})]+)/g;
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


function sliceSurrogateSafe(s: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (s.length <= maxLen) return s;
  let end = maxLen;
  const prev = s.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) {
    const next = s.charCodeAt(end);
    if (next >= 0xdc00 && next <= 0xdfff) end--;
  }
  return s.slice(0, end);
}

function looksLikeBearerToken(raw: string): boolean {
  if (!raw || raw === "<redacted>") return false;
  const core = raw.replace(/[.,;!?]+$/, "");
  if (core.length < 4) return false;
  if (/[0-9_+=]/.test(core)) return true;
  if (/[a-z][A-Z]/.test(core)) return true;
  if (/^(?:sk|pk|rk|ak|tk|ghp|gho|ghu|ghs|ghr|glpat|xox[a-z]|ya29|eyJ|AIza|AKIA)[-_]/i.test(core)) return true;
  if (/^[A-Za-z0-9]{16,}$/.test(core)) return true;
  if (/^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_.-]{4,}$/.test(core)) return true;
  if (/^[A-Za-z0-9_-]{4,}\/[A-Za-z0-9_/-]{4,}$/.test(core)) return true;
  return false;
}

function isSecretKey(key: string): boolean {
  if (!SECRET_WORD_HINT_RE.test(key)) return false;
  const rawSegs = key.match(KEY_SEGMENT_RE);
  if (!rawSegs || rawSegs.length === 0) return false;
  const segs = rawSegs.map(s => s.toLowerCase());
  const lastSeg = segs[segs.length - 1]!;
  if (SECRET_METRIC_SUFFIX_RE.test(lastSeg)) return false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (SECRET_KEY_RE.test(seg)) {
      const next = segs[i + 1];
      if (next && SECRET_METRIC_SUFFIX_RE.test(next)) continue;
      return true;
    }
    if (seg === "api" && segs[i + 1] === "key") {
      const next = segs[i + 2];
      if (next && SECRET_METRIC_SUFFIX_RE.test(next)) continue;
      return true;
    }
  }
  return false;
}

function redactSecretJson(input: string): string {
  SECRET_JSON_KEY_RE.lastIndex = 0;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = SECRET_JSON_KEY_RE.exec(input)) !== null) {
    if (!isSecretKey(m[1]!)) continue;
    const valStart = SECRET_JSON_KEY_RE.lastIndex;
    if (valStart >= input.length) break;
    if (input.charCodeAt(valStart) === 0x22) continue;
    SECRET_JSON_VAL_RE.lastIndex = valStart;
    const vm = SECRET_JSON_VAL_RE.exec(input);
    if (vm) {
      out += input.slice(last, valStart) + '<redacted>"';
      last = SECRET_JSON_VAL_RE.lastIndex;
      SECRET_JSON_KEY_RE.lastIndex = last;
      continue;
    }
    SECRET_UNCLOSED_VAL_RE.lastIndex = valStart;
    const um = SECRET_UNCLOSED_VAL_RE.exec(input);
    if (!um) continue;
    out += input.slice(last, valStart) + "<redacted>";
    last = SECRET_UNCLOSED_VAL_RE.lastIndex;
    SECRET_JSON_KEY_RE.lastIndex = last;
  }
  return last === 0 ? input : out + input.slice(last);
}

function redactSecretValues(input: string): string {
  SECRET_KEY_SEP_RE.lastIndex = 0;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = SECRET_KEY_SEP_RE.exec(input)) !== null) {
    const key = m[1]!;
    if (!isSecretKey(key)) continue;
    let valStart = SECRET_KEY_SEP_RE.lastIndex;
    let schemePrefix = "";
    if (/authorization/i.test(key)) {
      AUTH_SCHEME_RE.lastIndex = valStart;
      const sm = AUTH_SCHEME_RE.exec(input);
      if (sm) {
        schemePrefix = sm[1]!;
        valStart = AUTH_SCHEME_RE.lastIndex;
      }
    }
    if (valStart >= input.length) break;
    const ch = input.charCodeAt(valStart);
    let replacement: string;
    let valEnd: number;
    if (ch === 0x22) {
      SECRET_DQ_VAL_RE.lastIndex = valStart;
      const qm = SECRET_DQ_VAL_RE.exec(input);
      if (qm) {
        replacement = '"<redacted>"';
        valEnd = SECRET_DQ_VAL_RE.lastIndex;
      } else {
        SECRET_UNCLOSED_VAL_RE.lastIndex = valStart + 1;
        const um = SECRET_UNCLOSED_VAL_RE.exec(input);
        if (!um) continue;
        replacement = '"<redacted>';
        valEnd = SECRET_UNCLOSED_VAL_RE.lastIndex;
      }
    } else if (ch === 0x27) {
      SECRET_SQ_VAL_RE.lastIndex = valStart;
      const qm = SECRET_SQ_VAL_RE.exec(input);
      if (qm) {
        replacement = "'<redacted>'";
        valEnd = SECRET_SQ_VAL_RE.lastIndex;
      } else {
        SECRET_UNCLOSED_VAL_RE.lastIndex = valStart + 1;
        const um = SECRET_UNCLOSED_VAL_RE.exec(input);
        if (!um) continue;
        replacement = "'<redacted>";
        valEnd = SECRET_UNCLOSED_VAL_RE.lastIndex;
      }
    } else {
      SECRET_UNQUOTED_VAL_RE.lastIndex = valStart;
      const vm = SECRET_UNQUOTED_VAL_RE.exec(input);
      if (!vm) continue;
      replacement = "<redacted>";
      valEnd = SECRET_UNQUOTED_VAL_RE.lastIndex;
    }
    out += input.slice(last, m.index) + m[0] + schemePrefix + replacement;
    last = valEnd;
    SECRET_KEY_SEP_RE.lastIndex = last;
  }
  return last === 0 ? input : out + input.slice(last);
}

export function redactSecrets(input: string): string {
  return redactSecretValues(redactSecretJson(input)).replace(
    BEARER_SPACE_RE,
    (m, prefix: string, quote: string, token: string) =>
      looksLikeBearerToken(token) ? `${prefix}${quote}<redacted>` : m,
  );
}

/**
 * Sentinel for a labeled in-box divider (e.g. the `Output` rule between a command
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

function countTextLines(s: string): number {
  let lines = 1;
  let idx = s.indexOf("\n");
  while (idx !== -1) {
    lines++;
    idx = s.indexOf("\n", idx + 1);
  }
  return lines;
}

function preparePreview(text: string, maxChars: number): {
  lines: string[];
  totalLines: number;
  clippedRaw: boolean;
  cleanLen: number;
} {
  if (text.length === 0) {
    return { lines: [""], totalLines: 1, clippedRaw: false, cleanLen: 0 };
  }
  const rawBound = Math.max(8192, maxChars * 8);
  const clippedRaw = text.length > rawBound;
  const bounded = clippedRaw ? sliceSurrogateSafe(text, rawBound) : text;
  const clean = redactSecrets(sanitizeForTerminal(bounded.replace(/\r\n/g, "\n")));
  const lines = clean.split("\n");
  const totalLines = clippedRaw ? Math.max(lines.length, countTextLines(text)) : lines.length;
  return { lines, totalLines, clippedRaw, cleanLen: clean.length };
}

function previewLines(text: string, maxLines: number, maxChars: number): string[] {
  const { lines: raw, totalLines, clippedRaw, cleanLen } = preparePreview(text, maxChars);
  const out: string[] = [];
  let used = 0;
  for (const line of raw) {
    if (out.length >= maxLines || used >= maxChars) break;
    const remaining = Math.max(0, maxChars - used);
    const next = line.length > remaining ? `${sliceSurrogateSafe(line, Math.max(0, remaining - 1))}…` : line;
    out.push(next);
    used += next.length + 1;
  }
  if (totalLines > out.length || clippedRaw || cleanLen > used) {
    out.push(`… ${Math.max(0, totalLines - out.length)} more line(s)`);
  }
  return out.length > 0 ? out : [""];
}

/** jeo-ref file-content preview: a line-number gutter (` 1│ #…`) before each
 *  previewed row, closed by `… N more lines` when clipped. ANSI-free so cards
 *  stay byte-stable across color modes; `│` degrades to `|` without unicode. */
function numberedPreviewLines(text: string, maxLines: number, maxChars: number, unicode = true): string[] {
  const { lines: raw, totalLines } = preparePreview(text, maxChars);
  const gutter = unicode ? "│" : "|";
  const width = String(Math.min(totalLines, maxLines)).length;
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < raw.length; i++) {
    if (out.length >= maxLines || used >= maxChars) break;
    const remaining = Math.max(0, maxChars - used);
    const line = raw[i]!;
    const next = line.length > remaining ? `${sliceSurrogateSafe(line, Math.max(0, remaining - 1))}…` : line;
    out.push(`${String(i + 1).padStart(width)}${gutter} ${next}`);
    used += next.length + 1;
  }
  const hidden = totalLines - out.length;
  if (hidden > 0) out.push(`… ${hidden} more line${hidden === 1 ? "" : "s"}`);
  return out.length > 0 ? out : [""];
}

/**
 * Render an edit tool's `editBlock` as diff lines for the forge card:
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
      const redacted = redactSecrets(sanitizeForTerminal(text));
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
    const cleanDirective = redactSecrets(sanitizeForTerminal(directive));
    const payload = block.includes("\n") ? block.slice(block.indexOf("\n") + 1) : "";
    rows.push(cleanDirective);
    if (payload) for (const l of payload.split("\n")) push("+", l);
    const hidden = added - Math.max(0, rows.length - 1);
    if (hidden > 0) rows.push(`… ${hidden} more line(s)`);
    rows.push(FORGE_DIVIDER_PREFIX + "Summary");
    rows.push(`${sliceSurrogateSafe(cleanDirective, 24)} · +${added} line(s)`);
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

function cleanForgeField(raw: string, maxLen = 1024): string {
  return redactSecrets(sanitizeForTerminal(sliceSurrogateSafe(raw, maxLen))).replace(/\r?\n/g, " ");
}

export function summarizeForgeInvocation(tool: string, rawArgs: unknown, opts: { unicode?: boolean } = {}): ForgeSummary {
  const args = asRecord(rawArgs);
  const safeTool = (tool ? cleanForgeField(String(tool), 256) : "") || "(no tool)";
  const normalized = safeTool.toLowerCase();
  if (normalized === "bash") {
    const command = stringArg(args, "command", "cmd") ?? "";
    const timeout = stringArg(args, "timeoutMs", "timeout");
    // Command echo: prefix the (redacted, capped) command with `$ `.
    const commandLines = previewLines(command, 8, 800);
    const lines = [`$ ${commandLines[0] ?? ""}`, ...commandLines.slice(1)];
    const cwdKey = Object.keys(args).find(k => /^(cwd|workingdir|workingdirectory|subdir|dir)$/i.test(k));
    if (cwdKey !== undefined) {
      const cwdVal = args[cwdKey];
      if (cwdVal !== undefined && cwdVal !== null && cwdVal !== "") {
        const cleanCwd = cleanForgeField(String(cwdVal), 512);
        if (cleanCwd) lines.push(`# cwd-relative: ${cleanCwd}`);
      }
    }
    if (timeout) {
      const cleanTimeout = cleanForgeField(timeout, 128);
      if (cleanTimeout) {
        const ms = Number(cleanTimeout);
        const secs = Number.isFinite(ms) ? (ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1)) : cleanTimeout;
        const open = opts.unicode === false ? "[" : "⟦";
        const close = opts.unicode === false ? "]" : "⟧";
        lines.push(`${open}Timeout: ${secs}s${close}`);
      }
    }
    return { title: "Bash", language: "bash", lines };
  }

  if (normalized === "read") {
    const rawFilePath = stringArg(args, "filePath", "path");
    const filePath = (rawFilePath ? cleanForgeField(rawFilePath, 1024) : "") || "<missing path>";
    const rawRange = stringArg(args, "lineRange", "range");
    const range = rawRange ? cleanForgeField(rawRange, 256) : undefined;
    return {
      title: `Read ${filePath}${range ? `:${range}` : ""}`,
      language: "path",
      lines: [`path: ${filePath}`],
    };
  }

  if (normalized === "write") {
    const rawFilePath = stringArg(args, "filePath", "path");
    const filePath = (rawFilePath ? cleanForgeField(rawFilePath, 1024) : "") || "<missing path>";
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
    const rawFilePath = stringArg(args, "filePath", "path");
    const filePath = (rawFilePath ? cleanForgeField(rawFilePath, 1024) : "") || "<missing path>";
    const editBlock = stringArg(args, "editBlock", "edit") ?? "";
    // Diff view: SEARCH/REPLACE hunks render as -old/+new lines with a
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
    const rawPattern = stringArg(args, "globPattern", "pattern");
    const pattern = (rawPattern ? cleanForgeField(rawPattern, 1024) : "") || "<missing glob>";
    return { title: `Find: ${pattern}`, language: "glob", lines: [`glob: ${pattern}`] };
  }

  if (normalized === "search") {
    const rawPattern = stringArg(args, "pattern");
    const pattern = (rawPattern ? cleanForgeField(rawPattern, 1024) : "") || "<missing pattern>";
    const rawGlob = stringArg(args, "globPattern", "path");
    const glob = (rawGlob ? cleanForgeField(rawGlob, 1024) : "") || "*";
    return { title: `Search: ${pattern}`, language: "regex", lines: [`glob: ${glob}`] };
  }

  if (normalized === "task") {
    const rawRole = stringArg(args, "role") ?? "executor";
    const role = redactSecrets(sanitizeForTerminal(sliceSurrogateSafe(rawRole, 512))).replace(/\s+/g, " ").trim() || "executor";
    // Fan-out/batch form (`tasks: [...]`, task-tool.ts's concurrent MAX_FANOUT path) previously
    // fell through to the single-task branch below, which only reads `task`/`prompt`/`assignment`
    // — every batch call rendered as a bare "<missing task>" placeholder with zero visibility into
    // what was actually about to run concurrently, even on a well-formed call (live-reproduced: a
    // real 3-item fan-out showed nothing but "<missing task>" in the tool-call preview box).
    // A JSON-STRINGIFIED `tasks` (live-reproduced model mistake task-tool.ts's handler itself now
    // tolerates — see createTaskTool's `tasksArg` coercion) is accepted here too, for the same
    // reason: the preview must reflect what will actually run, not just the well-formed case.
    const tasksValue = typeof args.tasks === "string"
      ? (() => { try { const p = JSON.parse(args.tasks as string); return Array.isArray(p) ? p : args.tasks; } catch { return args.tasks; } })()
      : args.tasks;
    if (Array.isArray(tasksValue)) {
      const MAX_PREVIEW_TASKS = 6;
      const items: string[] = [];
      let totalCount = 0;
      for (const entry of tasksValue as unknown[]) {
        const raw = typeof entry === "string"
          ? entry
          : entry && typeof entry === "object"
            ? String((entry as Record<string, unknown>).task ?? (entry as Record<string, unknown>).assignment ?? (entry as Record<string, unknown>).prompt ?? "")
            : "";
        if (raw.trim().length === 0) continue;
        if (items.length < MAX_PREVIEW_TASKS) {
          const clean = redactSecrets(sanitizeForTerminal(sliceSurrogateSafe(raw, 4096))).trim();
          if (clean.length === 0) continue;
          items.push(clean);
        }
        totalCount++;
      }
      let lines: string[];
      if (items.length === 0) {
        lines = ["<missing tasks>"];
      } else {
        lines = items.map((t, i) => {
          const firstLine = t.split("\n")[0]!;
          const truncated = firstLine.length > 120 || t.includes("\n");
          return `${i + 1}. ${sliceSurrogateSafe(firstLine, 120)}${truncated ? "…" : ""}`;
        });
        const hidden = totalCount - items.length;
        if (hidden > 0) lines.push(`… ${hidden} more task${hidden === 1 ? "" : "s"}`);
      }
      return { title: `Task: ${role} ×${totalCount}`, language: "text", lines };
    }
    const rawTask = stringArg(args, "task", "prompt", "assignment") ?? "<missing task>";
    const task = redactSecrets(sanitizeForTerminal(sliceSurrogateSafe(rawTask, 4096)));
    const rawContext = stringArg(args, "context");
    const context = rawContext ? redactSecrets(sanitizeForTerminal(sliceSurrogateSafe(rawContext, 4096))) : undefined;
    return {
      title: `Task: ${role}`,
      language: "text",
      lines: [...previewLines(task, 4, 500), ...(context ? ["context:", ...previewLines(context, 3, 300)] : [])],
    };
  }

  if (normalized === "web_search") {
    const rawQuery = stringArg(args, "query");
    const query = (rawQuery ? cleanForgeField(rawQuery, 1024) : "") || "<missing query>";
    const rawRecency = stringArg(args, "recency");
    const recency = rawRecency ? cleanForgeField(rawRecency, 128) : undefined;
    const lines = [`query: ${query}`];
    if (recency) lines.push(`recency: ${recency}`);
    return {
      title: `Web Search: ${query.length > 60 ? `${sliceSurrogateSafe(query, 59)}…` : query}`,
      language: "text",
      lines,
    };
  }

  if (normalized === "jeox") {
    const rawAction = stringArg(args, "action") ?? "status";
    const action = cleanForgeField(rawAction, 64) || "status";
    const rawSubject = stringArg(args, "name", "target", "query", "q");
    const subject = rawSubject ? cleanForgeField(rawSubject, 128) : "";
    const lines = [`action: ${action}`];
    if (subject) lines.push(`target: ${subject}`);
    return {
      title: `Jeox: ${action}${subject ? ` ${subject}` : ""}`,
      language: "text",
      lines,
    };
  }

  return { title: `${safeTool} arguments`, language: "json", lines: jsonPreview(args) };
}

/** Parsed Web Search card pieces, reconstructed from the structured
 *  `web_search` tool output (see `formatWebSearchOutput` in agent/web-search.ts). */
export interface WebSearchCard {
  /** `Provider · N sources` header meta for the card title (e.g. `Anthropic · 18 sources`). */
  titleMeta: string;
  lines: string[];
}

/**
 * Build the Web Search card body from the tool's structured output:
 * `Query:` line, then `Answer` / `Sources` / `Metadata` divider sections with
 * tree-glyph (`├─`/`└─`) rows and `… N more` truncation.
 * Returns null when the output does not carry the
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

  // Answer: capped tree-glyph preview for the collapsed card.
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
  const safeTool = (tool ? cleanForgeField(String(tool), 256) : "") || "(no tool)";
  const normalized = safeTool.toLowerCase();
  let body = output || "<no output>";
  let exitNote: string | null = null;
  if (normalized === "bash") {
    // The engine prefixes failed bash output with `Exit code N` — surface it
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
  lines.unshift(forgeDivider("Output"));
  if (normalized === "bash") {
    if (exitNote) lines.push("", exitNote);
  }
  return {
    title: `${safeTool} result ${status}`,
    language: "output",
    lines,
  };
}

function wrapPlainLine(line: string, width: number): string[] {
  if (width <= 0) return [""];
  // Wrap by DISPLAY width (SGR-aware, wide-glyph-aware) so CJK/emoji content
  // breaks on column boundaries and never overflows the card border. The old
  // `slice(i, i+width)` counted code points, so a Hangul/CJK line (2 cols each)
  // rendered ~2× the intended width and tore the right edge.
  if (visibleWidth(line) <= width) return [line];
  return wrapTextWithAnsi(line, width);
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

/** Forge cards render at a reduced scale: the available width is divided by this
 *  factor so a box reads as a compact panel instead of spanning the full terminal. */
export const FORGE_SCALE = 1.2;

/** Scale a caller's available width down to the forge card's compact render width. */
export function scaleForgeWidth(available: number): number {
  return Math.max(24, Math.trunc(available / FORGE_SCALE));
}

export function formatForgeBox(summary: ForgeSummary, opts: ForgeBoxOptions = {}): string[] {
  const innerWidth = opts.width ?? 80;
  const floor = Math.min(24, innerWidth);
  const width = Math.max(floor, Math.trunc(innerWidth));
  const maxLines = Math.max(1, Math.trunc(opts.maxLines ?? 10));
  const glyphs = borderGlyphs(opts.unicode);
  const isDim = !!opts.dim;
  const effectiveColor = opts.color !== false && !isDim;
  const identity = (s: string) => s;
  const stripSgr = (s: string): string => (s.includes("\x1b") ? s.replace(/\x1b\[[0-9;]*m/g, "") : s);
  const paint = isDim ? identity : (opts.paint ?? chalk.gray);
  const shadow = isDim ? identity : (opts.paintShadow ?? (opts.color === false ? paint : (s: string) => chalk.dim(paint(s))));
  // DNA-flow border painters: a flowing gradient over the border glyph runs, the
  // bottom offset half a cycle so the helix appears to travel around the card.
  // Pure functions of (text, phase) — no per-frame state is retained — and below
  // TrueColor animatedGradientText returns the text unchanged, so the static
  // paint/shadow path takes over byte-identically.
  const flowOn = !!opts.flow && effectiveColor;
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
  // jeo-ref layout: the title rides ON the top border (`╭── ✗ Bash ──────╮`)
  // instead of occupying a title row + separator — two chrome rows become one,
  // and the card scans like the reference's labeled panel.
  const rawMark = opts.titleMark ? `${opts.titleMark} ` : "";
  const mark = isDim ? stripSgr(rawMark) : rawMark;
  const rawTitle = isDim ? stripSgr(summary.title) : summary.title;
  const label = truncateToWidth(rawTitle, Math.max(1, inner - 4 - visibleWidth(mark)));
  const titleText = ` ${mark}${!effectiveColor ? label : chalk.bold(label)} `;
  const lead = glyphs.h.repeat(Math.min(2, inner));
  const tail = Math.max(0, inner - visibleWidth(lead) - visibleWidth(titleText));
  const top = flowTop(glyphs.tl + lead) + titleText + flowTop(glyphs.h.repeat(tail) + glyphs.tr);
  const bottom = flowBottom(glyphs.bl + glyphs.h.repeat(inner) + glyphs.br);
  const rendered: string[] = [top];

  // jeo-ref readability: a one-column gutter between the left border and the
  // content (`│ $ cmd …`), so text never touches the frame. Content word-wraps
  // to the guttered width; a labeled divider still counts as one content row.
  const gutterWidth = Math.max(1, inner - 1);
  const content: string[] = [];
  for (const rawLine of summary.lines) {
    const line = isDim ? stripSgr(rawLine) : rawLine;
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
  const diffRows = summary.language === "patch" && effectiveColor ? opts.diffPaint : undefined;
  // Code cards (jeo-ref): conservative single-pass light highlight — comments,
  // string literals, keywords — applied AFTER wrapping so padding math stays
  // visible-width true. color:false stays byte-identical.
  const CODE_LANGS = new Set(["bash", "typescript", "javascript", "python", "json", "yaml", "rust", "go"]);
  const highlightLang = effectiveColor && summary.language && CODE_LANGS.has(summary.language) ? summary.language : undefined;
  const contentRow = (line: string): string => {
    const lit = highlightLang ? lightHighlightLine(line, highlightLang) : line;
    // Defense-in-depth truncation: ordinary content already arrives pre-wrapped to
    // `gutterWidth` (inner - 1) below, but the clip-hint rows (line ~605/609) append
    // the "N more lines ⟦Ctrl+O for more⟧" marker AFTER that wrap step, so on a narrow
    // box the marker text alone can exceed `inner` and poke the row past the right
    // border (the "screen breaks on resize" corruption). Cap every row here so no
    // content path — wrapped or not — can widen the box past its declared width.
    const padded = padLineTo(` ${truncateToWidth(lit, Math.max(1, inner - 1))}`, inner, "left");
    const body = diffRows && line.startsWith("+")
      ? diffRows.add(padded)
      : diffRows && line.startsWith("-")
        ? diffRows.del(padded)
        : padded;
    return paint(glyphs.v) + body + shadow(glyphs.v);
  };
  // Clip hint: the hidden remainder is reachable via Ctrl+O. Two clip
  // layers can produce an overflow marker — previewLines() at the SUMMARIZE
  // stage ("… N more line(s)") and the box's own maxLines cut below; both must
  // carry the hint, so summarize-stage markers are rewritten here where the
  // unicode capability is known.
  const hint = opts.unicode === false ? "[Ctrl+O for more]" : "⟦Ctrl+O for more⟧";
  const CLIP_MARKER_RE = /^… \d+ more line\(s\)$/;
  const clipped = content.slice(0, maxLines);
  for (const line of clipped) {
    if (line.startsWith(FORGE_DIVIDER_PREFIX)) {
      rendered.push(renderDivider(line.slice(FORGE_DIVIDER_PREFIX.length)));
    } else {
      rendered.push(contentRow(CLIP_MARKER_RE.test(line) ? `${line} ${hint}` : line));
    }
  }
  if (content.length > clipped.length) {
    rendered.push(contentRow(`… ${content.length - clipped.length} more lines ${hint}`));
  }
  rendered.push(bottom);
  // In-flight shading takes precedence: strip inner color and dim every row so a
  // live card reads as a flat shaded block until its formatted result replaces it.
  if (isDim) {
    return opts.color === false ? rendered : rendered.map(l => chalk.dim(l));
  }
  // Faint panel tint: wrap each whole, width-padded row so the card background spans
  // the full rectangle (borders + content). No-op when no fill painter is supplied.
  return opts.fill ? rendered.map(opts.fill) : rendered;
}
