/**
 * In-app turn-history viewer (`/history`) — re-prints the worked session as a
 * readable transcript INTO normal scrollback, so past prompts, tool steps and
 * replies can be reviewed by scrolling up even when the terminal's own history
 * (tmux without mouse mode, cleared screens, resumed sessions) can't reach them.
 *
 * The engine history interleaves protocol traffic with the conversation:
 *   user        → real prompts, but ALSO tool-result feedback
 *                 (`Tool [name] result (ok|fail):\n…`) and parse-correction bounces
 *   assistant   → raw JSON tool calls, or plain prose (final/legacy replies)
 * This formatter folds that back into a gjc-style ledger: `user ▸` prompt blocks,
 * one compact `✔/✗ title` line per tool step, and `jeo ◂` reply blocks.
 */
import chalk from "chalk";
import type { Message } from "../../ai/types";
import { summarizeForgeInvocation } from "./forge";

export interface TranscriptOptions {
  color?: boolean;
  unicode?: boolean;
  /** Keep only the LAST n prompt-anchored turns (Infinity/undefined = all). */
  maxTurns?: number;
  /** Cap body lines per prompt/reply block. */
  bodyLines?: number;
}

const TOOL_RESULT_RE = /^Tool \[([^\]]+)\] result \((ok|fail)\):/;
const BOUNCE_PREFIXES = ["Your last reply", "The budget for this turn is exhausted", "The step budget for this turn is exhausted", "You are cycling through the same"];

function clipBody(text: string, cap: number): string[] {
  const rows = text.replace(/\r/g, "").split("\n");
  const trimmed = rows.length > cap ? rows.slice(0, cap) : rows;
  const out = trimmed.map(r => `  ${r}`);
  if (rows.length > cap) out.push(`  … (+${rows.length - cap} more lines)`);
  return out;
}

function firstToolResultLine(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(TOOL_RESULT_RE, "")
    .split("\n")
    .map(l => l.trim())
    .find(Boolean)
    ?.replace(/\s+/g, " ")
    .slice(0, 96) ?? "";
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

/** Format engine history as a scrollback-friendly transcript. */
export function formatTranscript(messages: readonly Message[], opts: TranscriptOptions = {}): string[] {
  const color = opts.color !== false;
  const unicode = opts.unicode !== false;
  const bodyCap = Math.max(1, opts.bodyLines ?? 8);
  const ok = unicode ? "✔" : "v";
  const bad = unicode ? "✗" : "x";
  const userMark = unicode ? "▸" : ">";
  const jeoMark = unicode ? "◂" : "<";
  const cyanBold = color ? chalk.cyan.bold : (s: string) => s;
  const magentaBold = color ? chalk.magenta.bold : (s: string) => s;
  const dim = color ? chalk.dim : (s: string) => s;
  const green = color ? chalk.green : (s: string) => s;
  const red = color ? chalk.red : (s: string) => s;

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
  if (totalTurns === 0) return [dim("(no worked history yet — ask something first)")];
  const keep = Math.max(1, Math.min(totalTurns, opts.maxTurns ?? totalTurns));
  const start = promptIdx[totalTurns - keep]!;

  const lines: string[] = [];
  if (keep < totalTurns) lines.push(dim(`… ${totalTurns - keep} earlier turn(s) hidden — /history all shows everything`));
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "system") continue;
    if (m.role === "user") {
      const result = m.content.match(TOOL_RESULT_RE);
      if (result) continue; // outcome is folded into the assistant tool line below
      if (BOUNCE_PREFIXES.some(p => m.content.startsWith(p))) continue; // protocol noise
      if (lines.length) lines.push("");
      const turnNo = promptNumber.get(i) ?? 1;
      lines.push(dim(`${unicode ? "─" : "-"} turn ${turnNo}/${totalTurns}`));
      const imgs = m.images?.length ? dim(` ⧉ ${m.images.length} image(s)`) : "";
      lines.push(`${cyanBold(`user ${userMark}`)}${imgs}`);
      lines.push(...clipBody(m.content, bodyCap));
      continue;
    }
    // assistant: one or more JSON tool calls (compact ledger lines) or a prose reply.
    // Handles BOTH the single `{tool,arguments}` form AND the batched `{tools:[...]}`
    // form — the batch case previously parsed to no `tool` field, fell through, and
    // dumped the raw JSON object into the transcript (the "/resume shows JSON" bug).
    let parsed: { tool?: unknown; tools?: unknown; arguments?: unknown } | null = null;
    try {
      const p: unknown = JSON.parse(m.content);
      if (p && typeof p === "object") parsed = p as { tool?: unknown; tools?: unknown; arguments?: unknown };
    } catch { /* prose reply */ }
    const calls: { tool: string; arguments?: unknown }[] =
      parsed && typeof parsed.tool === "string"
        ? [{ tool: parsed.tool, arguments: parsed.arguments }]
        : parsed && Array.isArray(parsed.tools)
          ? (parsed.tools as { tool?: unknown; arguments?: unknown }[])
              .filter(c => c && typeof c.tool === "string")
              .map(c => ({ tool: c.tool as string, arguments: c.arguments }))
          : [];
    const toolCalls = calls.filter(c => c.tool !== "done");
    if (toolCalls.length > 0) {
      // The matching `Tool [x] result (ok|fail)` user message follows; for a batch it
      // is ONE message with several blocks. Parse verdicts in call order.
      const next = messages[i + 1];
      const verdicts = next?.role === "user" ? parseToolVerdicts(next.content) : [];
      toolCalls.forEach((c, ci) => {
        const v = verdicts[ci] ?? verdicts.find(x => x.tool === c.tool);
        const mark = v?.status === "fail" ? red(bad) : green(ok);
        const title = summarizeForgeInvocation(c.tool, c.arguments).title;
        const suffix = v?.firstLine ? dim(` — ${v.firstLine}`) : "";
        lines.push(`  ${mark} ${title}${suffix}`);
      });
      continue;
    }
    // A lone `done` (show its reason) or a plain prose reply.
    const reason = parsed
      ? String((parsed.arguments as { reason?: unknown } | undefined)?.reason ?? "")
      : m.content;
    if (!reason.trim()) continue;
    lines.push(`${magentaBold(`jeo ${jeoMark}`)}`);
    lines.push(...clipBody(reason.trim(), bodyCap));
  }
  return lines;
}
