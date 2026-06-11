import { callLlm, type Message } from "./loop";
import { countTokensAccurate } from "./tokenizer";

export interface CompactionOptions {
  maxMessages?: number;
  /** Compact even a short history when pasted/tool content exceeds this many tokens. */
  maxTokens?: number;
  /** Char-based backward compatible fallback option */
  maxChars?: number;
  contextTokens?: number;
  keepRecent?: number;
  model?: string;
  /** Cap the summarizer prompt so compaction itself cannot balloon context. */
  maxSummaryInputTokens?: number;
  maxSummaryInputChars?: number;
  /** User-initiated `/compact`: lower the trigger floor so it actually compacts a small history. */
  force?: boolean;

  /** When set, the summary `callLlm` is aborted/short-circuited and retries stop. */
  signal?: AbortSignal;
}

export interface CompactionResult {
  compacted: boolean;
  removed: number;
  summary?: string;
  /** True when the LLM summary persistently failed; recent messages were kept
   *  (token-bounded) and older ones dropped (no summary message). Signals degraded compaction. */
  summaryFailed?: boolean;
  /** Clear error context when limits are exceeded even after compaction. */
  error?: string;
  /** The 0-based index of the last message in history replaced by this compaction. */
  replacesThrough?: number;
}

export const DEFAULT_MAX_TOKENS = 30_000;
export const DEFAULT_SUMMARY_INPUT_TOKENS = 20_000;

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 127) {
      tokens += 0.25;
    } else if (
      (code >= 0xac00 && code <= 0xd7a3) || // 한글 가~힣
      (code >= 0x1100 && code <= 0x11ff) || // 한글 자모
      (code >= 0x3130 && code <= 0x318f) || // 한글 호환 자모
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 통합 한자
      (code >= 0x3400 && code <= 0x4dbf) || // CJK 통합 한자 확장 A
      (code >= 0x3040 && code <= 0x309f) || // 히라가나
      (code >= 0x30a0 && code <= 0x30ff) || // 가타카나
      (code >= 0xff00 && code <= 0xffef)    // 전각 문자
    ) {
      tokens += 1 / 1.5;
    } else {
      tokens += 1 / 1.5; // Default CJK-like weight for non-ASCII
    }
  }
  return tokens;
}

/** Rough per-image vision-token cost (provider median for a clipboard screenshot).
 *  Keeps the context meter and compaction trigger honest when images are attached. */
const IMAGE_TOKEN_ESTIMATE = 1100;

/** Per-message estimate cache keyed by OBJECT IDENTITY. Engine/compaction always
 *  replace messages with new objects (never mutate `content` in place), so a
 *  cached count can never go stale; a WeakMap holds no reference once a message
 *  is dropped from history, so the cache CANNOT grow cumulatively. This turns
 *  the per-turn `historyTokens(history)` context meter from O(total chars) into
 *  O(new messages) on long sessions. */
const messageTokenCache = new WeakMap<Message, number>();

export function estimateMessageTokens(msg: Message): number {
  const hit = messageTokenCache.get(msg);
  if (hit !== undefined) return hit;
  const n = estimateTokens(msg.role) + estimateTokens(msg.content) + (msg.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE + 1;
  messageTokenCache.set(msg, n);
  return n;
}

export function historyTokens(history: Message[]): number {
  return history.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * Accurate BPE token total for a history, summing `countTokensAccurate` per
 * message (+1 per message for role/separator overhead, mirroring
 * `estimateMessageTokens`). Use this ONLY at the compaction decision boundary
 * and summary-budget points — never in the per-render footer path, which must
 * stay on the cheap `historyTokens` heuristic.
 */
export function accurateHistoryTokens(history: Message[], model?: string): number {
  return history.reduce(
    (sum, msg) =>
      sum +
      countTokensAccurate(msg.role, model) +
      countTokensAccurate(msg.content, model) +
      (msg.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE +
      1,
    0
  );
}

function formatMessagesForSummaryByTokens(messages: Message[], maxTokens: number): string {
  const out: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const msg of messages) {
    const line = `[${msg.role}] ${msg.content}`;
    const needed = estimateTokens(line) + 1;
    if (used + needed > maxTokens) {
      const remaining = Math.max(0, maxTokens - used);
      if (remaining > 20) {
        out.push(truncateRecentContentByTokens(line, remaining - 1) + "…");
        used = maxTokens;
      }
      omitted++;
      continue;
    }
    out.push(line);
    used += needed;
  }
  if (omitted > 0) out.push(`…(${omitted} older message(s) omitted from summary input to cap compaction context)`);
  return out.join("\n");
}

export function truncateRecentContentByTokens(content: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(content) <= maxTokens) return content;
  
  const marker = "\n…(recent message truncated to bound context)";
  const markerTokens = estimateTokens(marker);
  const targetTokens = maxTokens - markerTokens;
  
  if (targetTokens <= 0) {
    let curTokens = 0;
    let i = 0;
    for (; i < content.length; i++) {
      const code = content.charCodeAt(i);
      const t = code <= 127 ? 0.25 : 1 / 1.5;
      if (curTokens + t > maxTokens) break;
      curTokens += t;
    }
    return content.slice(0, i);
  }

  let curTokens = 0;
  let i = 0;
  for (; i < content.length; i++) {
    const code = content.charCodeAt(i);
    const t = code <= 127 ? 0.25 : 1 / 1.5;
    if (curTokens + t > targetTokens) break;
    curTokens += t;
  }
  return content.slice(0, i) + marker;
}

function truncateSummaryByTokens(summary: string, maxTokens: number): string {
  const prefix = "[Earlier conversation summary]\n";
  const prefixTokens = estimateTokens(prefix);
  return truncateRecentContentByTokens(summary, Math.max(0, maxTokens - prefixTokens));
}

function clampRecentMessagesByTokens(messages: Message[], budgetTokens: number): Message[] {
  if (messages.length === 0) return messages;
  const overhead = messages.reduce((sum, msg) => sum + estimateTokens(msg.role) + 1, 0);
  const contentBudget = Math.max(0, budgetTokens - overhead);
  const perMessageBudget = Math.floor(contentBudget / messages.length);
  return messages.map(msg => ({
    ...msg,
    content: truncateRecentContentByTokens(msg.content, perMessageBudget),
  }));
}

const SUMMARY_PREFIX = "[Earlier conversation summary]\n";
const FALLBACK_SUMMARY_PREFIX = "[Earlier conversation omitted:";

function alreadyCompacted(body: Message[]): boolean {
  if (body.length === 0) return false;
  const first = body[0];
  if (first.role !== "user") return false;
  return first.content.startsWith(SUMMARY_PREFIX) || first.content.startsWith(FALLBACK_SUMMARY_PREFIX);
}

export async function maybeCompact(
  history: Message[],
  opts: CompactionOptions = {}
): Promise<CompactionResult> {
  const maxMessages = opts.maxMessages ?? (opts.force ? 1 : 40);
  
  // opts.contextTokens가 제공되면 그것의 70%를 예산으로 사용하고, 없으면 opts.maxTokens 혹은 DEFAULT_MAX_TOKENS를 사용한다.
  // maxChars가 구버전에서 넘어온 경우의 fallback도 지원한다.
  const budgetTokens = opts.contextTokens
    ? opts.contextTokens * 0.7
    : (opts.maxTokens ?? (opts.maxChars ? Math.max(opts.maxChars / 4, 60) : DEFAULT_MAX_TOKENS));

  const keepRecent = opts.keepRecent ?? (opts.force ? 4 : 12);
  const maxSummaryInputTokens = opts.maxSummaryInputTokens ?? 
    (opts.maxSummaryInputChars ? opts.maxSummaryInputChars / 4 : DEFAULT_SUMMARY_INPUT_TOKENS);

  const hasSystem = history.length > 0 && history[0].role === "system";
  const systemCount = hasSystem ? 1 : 0;
  const body = history.slice(systemCount);
  
  const overMessages = opts.force || body.length > maxMessages;
  // Decision boundary: use accurate BPE counts against a real TOKEN budget so we neither
  // compact prematurely nor blow past the window on heuristic error. But when the budget
  // is CHAR-derived (legacy `maxChars` → chars/4), measure with the matching char heuristic
  // so the basis is consistent (accurate BPE under-counts repeated-char runs vs the heuristic).
  const budgetFromChars = !opts.contextTokens && opts.maxTokens === undefined && opts.maxChars !== undefined;
  const measuredTokens = budgetFromChars ? historyTokens(history) : accurateHistoryTokens(history, opts.model);
  const overTokens = measuredTokens > budgetTokens;

  if (!overMessages && !overTokens) {
    return { compacted: false, removed: 0 };
  }

  // Idempotence guard: once the body is `[summary|omitted] + recent`, another
  // compaction pass can only summarize the summary and lose information. If a
  // hard context window is still exceeded, report it; otherwise leave history
  // unchanged so repeated auto-/manual compaction converges.
  if (alreadyCompacted(body) && body.length <= keepRecent + 1) {
    const finalTokens = accurateHistoryTokens(history, opts.model);
    const error = opts.contextTokens && finalTokens > opts.contextTokens
      ? `Context window limit exceeded even after compaction. Remaining content size: ${Math.round(finalTokens)} tokens, Window limit: ${opts.contextTokens} tokens.`
      : undefined;
    return { compacted: false, removed: 0, error };
  }

  const recentCount = Math.min(keepRecent, Math.max(0, body.length - 1));
  const olderCount = body.length - recentCount;
  if (olderCount <= 0) {
    return { compacted: false, removed: 0 };
  }

  const older = body.slice(0, olderCount);
  const recent = body.slice(olderCount);

  const olderFormatted = formatMessagesForSummaryByTokens(older, maxSummaryInputTokens);

  const systemPrompt =
    "Summarize the following coding-agent conversation so work can continue. Capture decisions, files changed, current task state, and open TODOs. Be concise.";

  // Degradation ladder: (1) RETRY the summary a few times with short, abort-aware
  // backoff; (2) on persistent failure KEEP the recent messages verbatim and drop the
  // older ones — no misleading placeholder — and surface summaryFailed.
  const maxSummaryAttempts = 3; // initial attempt + up to 2 retries
  const summaryBackoffMs = 200;
  let summary: string | undefined;
  let summaryError: unknown;
  for (let attempt = 1; attempt <= maxSummaryAttempts; attempt++) {
    if (opts.signal?.aborted) {
      summaryError = new Error("aborted");
      break;
    }
    try {
      summary = await callLlm(
        [
          { role: "user", content: olderFormatted }
        ],
        {
          model: opts.model,
          systemPrompt,
          signal: opts.signal,
        }
      );
      summaryError = undefined;
      break;
    } catch (err) {
      summaryError = err;
      if (attempt < maxSummaryAttempts && !opts.signal?.aborted) {
        await new Promise<void>(resolve => setTimeout(resolve, summaryBackoffMs * attempt));
      }
    }
  }

  if (summary !== undefined) {
    // Rung 1 success: behave exactly as before — summary message + bounded recent.
    const systemMessages = hasSystem ? [history[0]] : [];
    const boundedSummary = truncateSummaryByTokens(summary, Math.min(budgetTokens, maxSummaryInputTokens));
    const summaryMessage: Message = { role: "user", content: SUMMARY_PREFIX + boundedSummary };
    const systemTokens = historyTokens(systemMessages);
    const summaryMessageTokens = historyTokens([summaryMessage]);
    const boundedRecent = clampRecentMessagesByTokens(recent, Math.max(0, budgetTokens - summaryMessageTokens - systemTokens));
    const next: Message[] = [
      ...systemMessages,
      summaryMessage,
      ...boundedRecent,
    ];

    history.splice(0, history.length, ...next);

    const finalTokens = accurateHistoryTokens(history, opts.model);
    let error: string | undefined;
    if (opts.contextTokens && finalTokens > opts.contextTokens) {
      error = `Context window limit exceeded even after compaction. Remaining content size: ${Math.round(finalTokens)} tokens, Window limit: ${opts.contextTokens} tokens.`;
    }

    return {
      compacted: true,
      removed: older.length,
      summary,
      error,
      replacesThrough: systemCount + older.length - 1,
    };
  }

  // Aborted (user cancelled the turn): do NOT mutate history as a side effect of a
  // cancelled compaction — leave it untouched and report no compaction.
  if (opts.signal?.aborted) {
    return { compacted: false, removed: 0 };
  }

  // Rung 2: KEEP-RECENT fallback. The summarizer persistently failed, so rather than inject
  // a placeholder the model could mistake for real conversation, keep the N most-recent
  // messages (token-bounded, like the success path) and drop the older ones (system kept).
  const systemMessages = hasSystem ? [history[0]] : [];
  const systemTokens = historyTokens(systemMessages);
  const boundedRecent = clampRecentMessagesByTokens(recent, Math.max(0, budgetTokens - systemTokens));
  const next: Message[] = [
    ...systemMessages,
    ...boundedRecent,
  ];
  history.splice(0, history.length, ...next);
  process.stderr.write(`[jeo] compaction summary failed (${(summaryError as Error)?.message ?? "error"}); kept ${boundedRecent.length} recent messages (token-bounded) and dropped ${older.length} older messages.\n`);

  const finalTokens = accurateHistoryTokens(history, opts.model);
  let error: string | undefined;
  if (opts.contextTokens && finalTokens > opts.contextTokens) {
    error = `Context window limit exceeded even after compaction. Remaining content size: ${Math.round(finalTokens)} tokens, Window limit: ${opts.contextTokens} tokens.`;
  }

  return {
    compacted: true,
    removed: older.length,
    summaryFailed: true,
    error,
    replacesThrough: systemCount + older.length - 1,
  };
}
