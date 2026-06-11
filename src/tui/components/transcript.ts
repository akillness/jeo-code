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
const BOUNCE_PREFIXES = ["Your last reply", "The step budget for this turn is exhausted"];

function clipBody(text: string, cap: number): string[] {
  const rows = text.replace(/\r/g, "").split("\n");
  const trimmed = rows.length > cap ? rows.slice(0, cap) : rows;
  const out = trimmed.map(r => `  ${r}`);
  if (rows.length > cap) out.push(`  … (+${rows.length - cap} more lines)`);
  return out;
}

/** Format engine history as a scrollback-friendly transcript. */
export function formatTranscript(messages: readonly Message[], opts: TranscriptOptions = {}): string[] {
  const color = opts.color !== false;
  const unicode = opts.unicode !== false;
  const bodyCap = Math.max(1, opts.bodyLines ?? 8);
  const ok = unicode ? "✔" : "v";
  const bad = unicode ? "✗" : "x";
  const userMark = unicode ? "▸" : ">";
  const jocMark = unicode ? "◂" : "<";
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
      const imgs = m.images?.length ? dim(` ⧉ ${m.images.length} image(s)`) : "";
      lines.push(`${cyanBold(`user ${userMark}`)}${imgs}`);
      lines.push(...clipBody(m.content, bodyCap));
      continue;
    }
    // assistant: a JSON tool call (one compact ledger line) or a prose reply.
    let invocation: { tool?: unknown; arguments?: unknown } | null = null;
    try {
      const parsed = JSON.parse(m.content) as { tool?: unknown; arguments?: unknown };
      if (parsed && typeof parsed === "object" && typeof parsed.tool === "string") invocation = parsed;
    } catch { /* prose reply */ }
    if (invocation && typeof invocation.tool === "string" && invocation.tool !== "done") {
      // The matching `Tool [x] result (ok|fail)` user message tells success/failure.
      const next = messages[i + 1];
      const verdict = next?.role === "user" ? next.content.match(TOOL_RESULT_RE) : null;
      const mark = verdict?.[2] === "fail" ? red(bad) : green(ok);
      const title = summarizeForgeInvocation(invocation.tool, invocation.arguments).title;
      lines.push(`  ${mark} ${title}`);
      continue;
    }
    const reason = invocation
      ? String((invocation.arguments as { reason?: unknown } | undefined)?.reason ?? "")
      : m.content;
    if (!reason.trim()) continue;
    lines.push(`${magentaBold(`jeo ${jocMark}`)}`);
    lines.push(...clipBody(reason.trim(), bodyCap));
  }
  return lines;
}
