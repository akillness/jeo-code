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
import { tryExtractJsonObject } from "../../agent/json";

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
    // assistant: a JSON tool call (compact ledger lines) or a prose/done reply.
    // A tool-call message is a JSON object that may be preceded by a ```json fence
    // AND/OR by model "think-aloud" prose — gpt/qwen-style replies narrate a sentence
    // and then append the JSON tool call in the SAME message. Extract the embedded
    // call from anywhere in the content (mirroring the engine's own extractJsonObject)
    // instead of gating on a leading `{`: that gate classified every prose-prefixed
    // call as plain prose and dumped the raw object — including escaped multi-line
    // edit/write payloads — verbatim into scrollback (the "/resume reads a wall of
    // broken escaped data" bug). The narration is kept (dimmed); the raw JSON never is.
    const parsed = tryExtractJsonObject<{ tool?: unknown; tools?: unknown; arguments?: unknown }>(
      m.content,
      { preferKeys: ["tool", "tools"] },
    );
    const isCall = !!parsed && (typeof parsed.tool === "string" || Array.isArray(parsed.tools));
    // The protocol allows a leading `"reasoning"` field on a tool call; surface that
    // narration (clipped) instead of losing it, and never re-dump it as raw JSON.
    const reasoningText = parsed && typeof (parsed as { reasoning?: unknown }).reasoning === "string"
      ? String((parsed as { reasoning?: unknown }).reasoning).trim()
      : "";
    // `looksLikeToolAttempt` flags a (possibly malformed/truncated) tool call so its
    // raw JSON is suppressed even when parsing fails — e.g. a bounced reply the model
    // later resent. Prose narrating a call is the text BEFORE the first `{` (the start
    // of the parsed object): a prose-prefixed call keeps its lead-in; a JSON-first or
    // reasoning-first call has none (its narration comes from `reasoningText`).
    const looksLikeToolAttempt = /\{\s*"tools?"\s*:/.test(m.content);
    const firstBrace = m.content.indexOf("{");
    const prosePrefix = firstBrace > 0
      ? m.content.slice(0, firstBrace).replace(/```(?:json)?[ \t]*\r?\n?/i, "").trim()
      : "";

    // A reply whose content (after an optional ```json fence) STARTS with `{` is a JSON
    // emission, not prose — even a giant malformed reasoning blob the model couldn't close.
    const startsWithJson = m.content.trimStart().replace(/^```(?:json)?[ \t]*\r?\n?/i, "").startsWith("{");
    // Any JSON object/tool-call emission — fenced, prose-prefixed, reasoning-prefixed,
    // or one we could not parse into a renderable call — must never reach scrollback as
    // raw escaped JSON (the "/resume reads a wall of broken data" report).
    const isJsonEmission = looksLikeToolAttempt || startsWithJson;
    const narration = prosePrefix || reasoningText;


    const calls: { tool: string; arguments?: unknown }[] =
      parsed && typeof parsed.tool === "string"
        ? [{ tool: parsed.tool, arguments: parsed.arguments }]
        : parsed && Array.isArray(parsed.tools)
          ? (parsed.tools as { tool?: unknown; arguments?: unknown }[])
              .filter(c => c && typeof c.tool === "string")
              .map(c => ({ tool: c.tool as string, arguments: c.arguments }))
          : [];
    const toolCalls = calls.filter(c => c.tool !== "done");
    // A genuine tool-call turn is FOLLOWED by its `Tool [x] result` user message and the
    // JSON is the final token; an illustrative JSON snippet quoted inside a prose reply is
    // not, and it carries meaningful prose AFTER the object. Use both signals so a real
    // prose-prefixed call renders as a ledger line while a sentence that merely shows
    // `{"tool":...}` as an example stays prose.
    const next = messages[i + 1];
    const hasResult = next?.role === "user" && TOOL_RESULT_RE.test(next.content);
    const lastBrace = m.content.lastIndexOf("}");
    const trailing = lastBrace >= 0 ? m.content.slice(lastBrace + 1).trim() : "";
    // A reply that STARTS with `{` is never illustrative prose — it is a (possibly
    // malformed) JSON emission whose raw body must stay out of scrollback.
    const looksIllustrative = !startsWithJson && !hasResult && trailing.length > 12 && /[A-Za-z]/.test(trailing);

    if (toolCalls.length > 0 && !looksIllustrative) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      // Pre-call narration (dimmed) keeps the "why" of each step without the raw JSON.
      if (narration) for (const l of clipBody(narration, bodyCap)) lines.push(dim(l));
      // For a batch the result is ONE user message with several blocks; parse verdicts
      // in call order.
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
    // No rendered tool call → a lone `done` call (reason + narration), a malformed/raw
    // JSON or tool-call emission (show narration only — never dump the raw object), or
    // genuine prose (which may merely quote a JSON snippet).
    const doneCall = calls.find(c => c.tool === "done");
    const doneReason = doneCall
      ? String((doneCall.arguments as { reason?: unknown } | undefined)?.reason ?? "")
      : "";
    const reason = doneCall
      ? [narration, doneReason].filter(s => s.trim()).join("\n\n")
      : isJsonEmission && !looksIllustrative
        ? narration // JSON/tool-call emission we couldn't render — keep narration, drop raw JSON
        : m.content;




    if (!reason.trim()) continue;
    // Persisted thinking (gjc "think → answer" order): show the turn's reasoning,
    // dimmed, above the reply so the durable record carries it across /resume + export.
    if (m.reasoning?.trim()) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(dim(`${unicode ? "◇" : "*"} thinking`));
      for (const l of clipBody(m.reasoning.trim(), bodyCap)) lines.push(dim(l));
    }
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(`${magentaBold(`jeo ${jeoMark}`)}`);
    lines.push(...clipBody(reason.trim(), bodyCap));
  }
  return lines;
}
