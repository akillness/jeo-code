/**
 * In-app turn-history & session-resume formatter (`/history`, `/resume`, `jeo resume`).
 *
 * The engine history interleaves protocol traffic with the conversation:
 *   user        → real prompts, but ALSO tool-result feedback
 *                 (`Tool [name] result (ok|fail):\n…`) and parse-correction bounces
 *   assistant   → raw JSON tool calls, or plain prose / `done` replies
 *
 * Supports two presentation surfaces:
 *   - `"ledger"` (default): compact `user ▸` / `  ✔ ...` / `jeo ◂` scrollback format
 *   - `"tui"`: working-TUI layout matching live `LaunchTui` (`user` prompt cards,
 *     tool ledger / subagent boxes, dimmed `◇ thinking`, standalone `jeo` header
 *     with full width-fitted Markdown tables & syntax).
 */
import chalk from "chalk";
import type { Message } from "../../ai/types";
import { summarizeForgeInvocation } from "./forge";
import { tryExtractJsonObject } from "../../agent/json";
import { sanitizeForTerminal } from "./code-view";
import { visibleWidth, wrapTextWordAware } from "./width";
import { imageTag } from "../../util/file-attachment";
import { validatedInputDisplay } from "./input-box";
import { BOX_ASCII, BOX_UNICODE, padLineTo } from "./layout";
import { accentPaint, mutedPaint, type EvolutionTheme } from "./themes";
import { renderMarkdownBlock } from "./markdown-text";

export interface TranscriptOptions {
  color?: boolean;
  unicode?: boolean;
  /** Output surface: compact `"ledger"` (default) or live-parity `"tui"`. */
  surface?: "ledger" | "tui";
  /** Terminal column count used to size user cards, Markdown tables, and wrapping. */
  cols?: number;
  /** Theme used for accent, muted, and user-card colors. */
  theme?: EvolutionTheme;
  /** Keep only the LAST n prompt-anchored turns (Infinity/undefined = all). */
  maxTurns?: number;
  /** Cap body lines per prompt/reply block. */
  bodyLines?: number;
  /** Extra persisted activity before each message, in storage order. */
  beforeMessage?: (index: number) => string[];
  trailingLines?: string[];
}

export interface TuiUserCardOptions {
  cols?: number;
  unicode?: boolean;
  color?: boolean;
  theme?: EvolutionTheme;
  turnLabel?: string;
  imageTags?: readonly string[];
}

const TOOL_RESULT_RE = /^Tool \[([^\]]+)\] result \((ok|fail)\):/;
const BOUNCE_PREFIXES = [
  "Your last reply",
  "The budget for this turn is exhausted",
  "The step budget for this turn is exhausted",
  "You are cycling through the same",
];

function clipLines(
  rows: readonly string[],
  cap: number,
  indent: string,
): string[] {
  const trimmed = rows.length > cap ? rows.slice(0, cap) : rows;
  const out = trimmed.map(r => (indent ? `${indent}${r}` : r));
  if (rows.length > cap) out.push(`${indent}… (+${rows.length - cap} more lines)`);
  return out;
}

function clipBody(text: string, cap: number): string[] {
  const rows = sanitizeForTerminal(text).replace(/\r/g, "").split("\n");
  return clipLines(rows, cap, "  ");
}

function firstToolResultLine(text: string | undefined): string {
  if (!text) return "";
  return (
    sanitizeForTerminal(text)
      .replace(TOOL_RESULT_RE, "")
      .split("\n")
      .map(l => l.trim())
      .find(Boolean)
      ?.replace(/\s+/g, " ")
      .slice(0, 96) ?? ""
  );
}

const TOOL_RESULT_GLOBAL = /^Tool \[([^\]]+)\] result \((ok|fail)\):/gm;
/** Split a tool-result user message — which for a BATCH holds several
 *  `Tool [x] result (ok|fail):` blocks joined by blank lines — into per-call
 *  verdicts in the order the engine emitted them (= the batch's call order). */
function parseToolVerdicts(text: string | undefined): { tool: string; status: string; firstLine: string }[] {
  if (!text) return [];
  const matches = [...text.matchAll(TOOL_RESULT_GLOBAL)];
  return matches.map((mt, k) => {
    const start = mt.index ?? 0;
    const end = k + 1 < matches.length ? (matches[k + 1]!.index ?? text.length) : text.length;
    return { tool: mt[1]!, status: mt[2]!, firstLine: firstToolResultLine(text.slice(start, end)) };
  });
}

function parseAssistantReplyOrCalls(content: string): {
  toolCalls: { tool: string; arguments?: unknown }[];
  reply: string;
} {
  const stripped = content.trim().replace(/^```(?:json)?[ \t]*\r?\n?/i, "").trimStart();
  const looksLikeCall = stripped.startsWith("{");
  const parsed = looksLikeCall
    ? tryExtractJsonObject<{ tool?: unknown; tools?: unknown; arguments?: unknown }>(content, {
        preferKeys: ["tool", "tools"],
      })
    : null;
  const calls: { tool: string; arguments?: unknown }[] =
    parsed && typeof parsed.tool === "string"
      ? [{ tool: parsed.tool, arguments: parsed.arguments }]
      : parsed && Array.isArray(parsed.tools)
        ? (parsed.tools as { tool?: unknown; arguments?: unknown }[])
            .filter(c => c && typeof c.tool === "string")
            .map(c => ({ tool: c.tool as string, arguments: c.arguments }))
        : [];
  const toolCalls = calls.filter(c => c.tool !== "done");
  if (toolCalls.length > 0) return { toolCalls, reply: "" };
  const reply =
    parsed && parsed.tool === "done"
      ? String((parsed.arguments as { reason?: unknown } | undefined)?.reason ?? "")
      : looksLikeCall
        ? ""
        : content;
  return { toolCalls: [], reply };
}

/** Extract the final human-facing assistant reply from persisted history
 *  (handles both plain prose replies and `{ tool: "done", arguments: { reason } }`). */
export function extractLastAssistantReply(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.content) continue;
    const { toolCalls, reply } = parseAssistantReplyOrCalls(m.content);
    if (toolCalls.length === 0 && reply.trim()) return reply;
  }
  return "";
}

/** Render a `user` prompt card matching `LaunchTui.renderUserCard`'s bordered
 *  filled box geometry so resumed sessions mirror live TUI turns cleanly. */
export function renderTuiUserCard(rawText: string, opts: TuiUserCardOptions = {}): string[] {
  const cleanText = sanitizeForTerminal(rawText ?? "").trim();
  const hasImages = (opts.imageTags?.length ?? 0) > 0;
  if (!cleanText && !hasImages) return [];

  const unicode = opts.unicode !== false;
  const color = opts.color !== false;
  const cols = opts.cols ?? 80;
  const boxWidth = Math.max(24, cols - 1);
  const inner = Math.max(10, boxWidth - 2);
  const g = unicode ? BOX_UNICODE : BOX_ASCII;
  const uc = opts.theme?.userCard;
  const accent = color && uc ? chalk.hex(uc.accent).bold : color ? chalk.cyan.bold : (s: string) => s;
  const border = color && uc ? chalk.hex(uc.border) : (s: string) => s;
  const shadow = color && uc ? chalk.hex(uc.shadow) : border;
  const fill = color && uc ? (s: string) => chalk.bgHex(uc.fill)(s) : (s: string) => s;
  const dim = color ? (opts.theme ? mutedPaint(opts.theme) : chalk.dim) : (s: string) => s;

  const bodySource = cleanText || (opts.imageTags?.join(" ") ?? "");
  const body = bodySource
    .split("\n")
    .flatMap(line => wrapTextWordAware(line, Math.max(8, inner - 2)));
  const rows = body.length ? body : [""];
  const top = border(g.tl + g.h.repeat(inner) + g.tr);
  const bottom = shadow(g.bl + g.h.repeat(inner) + g.br);
  const mid = rows.map(line => {
    const content = fill(padLineTo(` ${line}`, inner, "left"));
    return border(g.v) + content + shadow(g.v);
  });

  const turnPart = opts.turnLabel ? dim(` · ${opts.turnLabel}`) : "";
  const imgPart = hasImages ? dim(` ⧉ ${opts.imageTags!.join(" ")}`) : "";
  return [`  ${accent("user")}${turnPart}${imgPart}`, top, ...mid, bottom];
}

/** Format engine history as a scrollback-friendly transcript (or working-TUI surface). */
export function formatTranscript(messages: readonly Message[], opts: TranscriptOptions = {}): string[] {
  const color = opts.color !== false;
  const unicode = opts.unicode !== false;
  const isTui = opts.surface === "tui";
  const bodyCap = Math.max(1, opts.bodyLines ?? (isTui ? 2000 : 8));
  const ok = unicode ? "✔" : "v";
  const bad = unicode ? "✗" : "x";
  const userMark = unicode ? "▸" : ">";
  const jeoMark = unicode ? "◂" : "<";

  const themeAccent = color && opts.theme ? accentPaint(opts.theme) : color ? chalk.cyan : (s: string) => s;
  const themeMuted = color && opts.theme ? mutedPaint(opts.theme) : color ? chalk.dim : (s: string) => s;
  const cyanBold = color ? chalk.cyan.bold : (s: string) => s;
  const magentaBold = color ? chalk.magenta.bold : (s: string) => s;
  const mdAccent = color
    ? (opts.theme ? (s: string) => chalk.bold(themeAccent(s)) : (s: string) => chalk.bold(s))
    : (s: string) => s;
  const mdMuted = color
    ? (opts.theme ? themeMuted : (s: string) => chalk.dim(s))
    : (s: string) => s;
  const dim = color ? chalk.dim : (s: string) => s;
  const green = color ? chalk.green : (s: string) => s;
  const red = color ? chalk.red : (s: string) => s;
  const replyMaxWidth = opts.cols !== undefined
    ? Math.max(20, isTui ? opts.cols - 1 : opts.cols - 3)
    : (isTui ? 79 : undefined);

  // Anchor turns on real user prompts so `maxTurns` slices whole exchanges.
  const promptIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "user") return;
    if (TOOL_RESULT_RE.test(m.content)) return;
    if (BOUNCE_PREFIXES.some(p => m.content.startsWith(p))) return;
    promptIdx.push(i);
  });
  const promptNumber = new Map(promptIdx.map((idx, i) => [idx, i + 1]));
  const totalTurns = promptIdx.length;
  if (totalTurns === 0 && !opts.beforeMessage) return [dim("(no worked history yet — ask something first)")];
  const keep = Math.min(totalTurns, Math.max(1, opts.maxTurns ?? totalTurns));
  const start = opts.beforeMessage && keep === totalTurns ? 0 : (promptIdx[totalTurns - keep] ?? 0);

  const lines: string[] = [];
  if (keep < totalTurns) lines.push(dim(`… ${totalTurns - keep} earlier turn(s) hidden — /history all shows everything`));
  for (let i = start; i < messages.length; i++) {
    if (opts.beforeMessage) {
      const extra = opts.beforeMessage(i);
      if (extra.length > 0 && isTui && lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(...extra);
    }
    const m = messages[i]!;
    if (m.role === "system") continue;
    if (m.role === "user") {
      const result = m.content.match(TOOL_RESULT_RE);
      if (result) continue; // outcome is folded into the assistant tool line below
      if (BOUNCE_PREFIXES.some(p => m.content.startsWith(p))) continue; // protocol noise
      if (lines.length) lines.push("");
      const turnNo = promptNumber.get(i) ?? 1;
      const imgTags = m.images?.map((_, index) => imageTag(index + 1)) ?? [];
      const display = validatedInputDisplay(m);
      let text = display?.text ?? m.content;
      if (!display && (text.length > 1000 || /[\r\n]/.test(text))) {
        const rows = text.split(/\r\n|\r|\n/);
        const columns = rows.reduce((max, row) => Math.max(max, visibleWidth(row)), 0);
        text = `[Paste #${turnNo}, ${rows.length} lines, ${columns} cols]`;
      }
      if (!display && m.images?.length) {
        text = text.replace(/\[image #(\d+)\]/g, (tag, index: string) => {
          const number = Number(index);
          return number > 0 && number <= m.images!.length ? imageTag(number) : tag;
        });
      }
      if (isTui) {
        lines.push(
          ...renderTuiUserCard(text, {
            cols: opts.cols ?? 80,
            unicode,
            color,
            theme: opts.theme,
            turnLabel: `turn ${turnNo}/${totalTurns}`,
            imageTags: imgTags,
          }),
        );
      } else {
        const imgs = imgTags.length ? dim(` ⧉ ${imgTags.join(" ")}`) : "";
        lines.push(dim(`${unicode ? "─" : "-"} turn ${turnNo}/${totalTurns}`));
        lines.push(`${cyanBold(`user ${userMark}`)}${imgs}`);
        lines.push(...clipBody(text, bodyCap));
      }
      continue;
    }
    // assistant: a JSON tool call (compact ledger lines) or a prose/done reply.
    const { toolCalls, reply: reason } = parseAssistantReplyOrCalls(m.content);
    if (toolCalls.length > 0) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      // The matching `Tool [x] result (ok|fail)` user message follows; for a batch it
      // is ONE message with several blocks. Parse verdicts in call order.
      const next = messages[i + 1];
      const verdicts = next?.role === "user" ? parseToolVerdicts(next.content) : [];
      toolCalls.forEach((c, ci) => {
        const v = verdicts[ci] ?? verdicts.find(x => x.tool === c.tool);
        const mark = !v ? dim(unicode ? "…" : "?") : v.status === "fail" ? red(bad) : green(ok);
        const title = sanitizeForTerminal(summarizeForgeInvocation(c.tool, c.arguments).title);
        const suffix = !v ? dim(" (no result recorded)") : v.firstLine ? dim(` — ${v.firstLine}`) : "";
        const entry = `${isTui ? "" : "  "}${mark} ${title}${suffix}`;
        if (isTui && replyMaxWidth) {
          lines.push(...wrapTextWordAware(entry, replyMaxWidth, { continuationIndent: "  " }));
        } else {
          lines.push(entry);
        }
      });
      continue;
    }
    if (!reason.trim()) continue;
    // Persisted thinking ("think → answer" order): show the turn's reasoning,
    // dimmed, above the reply so the durable record carries it across /resume + export.
    if (m.reasoning?.trim()) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(dim(`${unicode ? "◇" : "*"} thinking`));
      const cleanThought = sanitizeForTerminal(m.reasoning.trim());
      const thoughtRows = opts.cols !== undefined
        ? wrapTextWordAware(cleanThought, Math.max(12, (opts.cols ?? 80) - 3))
        : cleanThought.replace(/\r/g, "").split("\n");
      for (const l of clipLines(thoughtRows, bodyCap, "  ")) lines.push(dim(l));
    }
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    const cleanReply = sanitizeForTerminal(reason.trim()).replace(/\r/g, "");
    const renderedReply = renderMarkdownBlock(cleanReply, {
      color,
      unicode,
      maxWidth: replyMaxWidth,
      accent: mdAccent,
      muted: mdMuted,
    });
    const replyRows = renderedReply ? renderedReply.split("\n") : cleanReply.split("\n");
    if (isTui) {
      lines.push(color ? mdAccent("jeo") : "jeo");
      lines.push(...clipLines(replyRows, bodyCap, ""));
    } else {
      lines.push(`${magentaBold(`jeo ${jeoMark}`)}`);
      lines.push(...clipLines(replyRows, bodyCap, "  "));
    }
  }
  if (opts.trailingLines) {
    if (opts.trailingLines.length > 0 && isTui && lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(...opts.trailingLines);
  }
  return lines;
}
