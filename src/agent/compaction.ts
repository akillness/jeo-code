import { callLlm, type Message } from "./loop";
import { countTokensAccurate, encodingFamilyForModel } from "./tokenizer";

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
  /** Files mutated in the span this compaction dropped — surfaced so callers
   *  (engine/session) can keep file context even when the LLM summary omits it. */
  touchedFiles?: string[];
}

export const DEFAULT_MAX_TOKENS = 30_000;
export const DEFAULT_SUMMARY_INPUT_TOKENS = 20_000;

export function estimateTokens(text: string): number {
  // ASCII ≈ 4 chars/token; everything else (CJK, Hangul, emoji, …) ≈ 1.5 chars/token.
  // A previous version listed the CJK ranges explicitly, but BOTH branches resolved
  // to the same 1/1.5 weight — two counters keep the same result in one cheap pass.
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 127) ascii++;
  }
  return ascii * 0.25 + (text.length - ascii) / 1.5;
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
  let n = estimateTokens(msg.role) + estimateTokens(msg.content) + (msg.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE + 1;
  // Native reasoning artifacts (signature / encrypted_content / thought text) are NOT in
  // `content` but become REAL input tokens once an adapter replays them — count them so
  // the context meter and compaction trigger stay honest (OpenAI encrypted blobs are KB-scale).
  // toolUse/toolResults/toolResultExtra are already reflected in `content`, so they are not re-added.
  for (const a of msg.reasoningArtifacts ?? []) {
    n += estimateTokens(a.text ?? "") + estimateTokens(a.signature ?? "")
      + estimateTokens(a.redacted ?? "") + estimateTokens(a.thoughtSignature ?? "")
      + estimateTokens(a.encrypted ?? "");
  }
  messageTokenCache.set(msg, n);
  return n;
}

export function historyTokens(history: Message[]): number {
  return history.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/** Engine tool-feedback message prefix (`Tool [name] result (ok|fail):`). */
const TOOL_RESULT_RE = /^Tool \[[^\]]+\] result \((ok|fail)\):/;

/**
 * MID-TURN deterministic context trim: when a single long agent turn grows the
 * history past `budgetTokens`, elide the BODIES of the OLDEST tool-result
 * feedback messages in place (newest `keepRecent` kept verbatim) until the
 * estimate fits the budget. This is what keeps a 60+-step turn from snowballing
 * to multi-million-token prompts (degrading the model into repeat loops and
 * compounding cost): turn-boundary compaction (`maybeCompact`) never runs
 * mid-turn, so without this the per-step input grew without bound.
 *  - Deterministic, zero LLM calls — safe to run between any two steps.
 *  - Only tool-result feedback is elided; system / real user prompts /
 *    assistant messages are never touched (the model keeps its own reasoning).
 *  - Messages are REPLACED with new objects (never mutated) so the
 *    identity-keyed token caches stay truthful.
 * Returns the number of elided messages and the resulting token estimate.
 */
export function trimToolResultsInPlace(
  history: Message[],
  opts: { budgetTokens: number; keepRecent?: number },
): { trimmed: number; tokens: number } {
  const keepRecent = Math.max(0, opts.keepRecent ?? 8);
  let tokens = historyTokens(history);
  if (tokens <= opts.budgetTokens) return { trimmed: 0, tokens };

  // Candidate indices: tool-result user messages, oldest first, excluding the
  // newest `keepRecent` of them (the model still needs its recent evidence).
  const candidates: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === "user" && TOOL_RESULT_RE.test(m.content)) candidates.push(i);
  }
  const trimmable = candidates.slice(0, Math.max(0, candidates.length - keepRecent));

  let trimmed = 0;
  for (const i of trimmable) {
    if (tokens <= opts.budgetTokens) break;
    const m = history[i]!;
    const header = m.content.match(TOOL_RESULT_RE)?.[0] ?? "Tool result:";
    const stub = `${header} [elided mid-turn to free context — re-run the tool if this result is needed again]`;
    if (m.content.length <= stub.length) continue; // already tiny — nothing to win
    const replacement: Message = { ...m, content: stub };
    tokens -= estimateMessageTokens(m);
    history[i] = replacement;
    tokens += estimateMessageTokens(replacement);
    trimmed++;
  }
  return { trimmed, tokens };
}

/**
 * Refusal-recovery companion to `trimToolResultsInPlace`: drop provider-native
 * reasoning artifacts (and native tool-use replay records) from ASSISTANT turns
 * so the next request replays plain text instead of native thinking blocks.
 *
 * Why: Anthropic's refusal classifier judges the WHOLE resent conversation, and
 * replayed `thinking` blocks are model-authored content — the usual trip wire
 * that tool-result eliding cannot clear (field case: a fable-5 turn re-refused
 * through the entire ladder because every resend replayed the flagged thinking
 * blocks verbatim). Messages are REPLACED, never mutated (identity caches).
 * Display fields (`reasoning`) are kept — only the wire-replay channel is cut.
 */
export function stripReasoningArtifactsInPlace(history: Message[]): number {
  let stripped = 0;
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role !== "assistant" || (!m.reasoningArtifacts?.length && !m.toolUse?.length)) continue;
    const { reasoningArtifacts: _artifacts, toolUse: _toolUse, ...rest } = m;
    history[i] = rest;
    stripped++;
  }
  return stripped;
}

/**
 * Accurate BPE token total for a history, summing `countTokensAccurate` per
 * message (+1 per message for role/separator overhead, mirroring
 * `estimateMessageTokens`). Use this ONLY at the compaction decision boundary
 * and summary-budget points — never in the per-render footer path, which must
 * stay on the cheap `historyTokens` heuristic.
 */
const accurateMessageTokenCache = new WeakMap<Message, Map<string, number>>();

/** Accurate BPE count for ONE message, cached by message IDENTITY (same contract
 *  as `messageTokenCache`: messages are replaced, never mutated in place) and
 *  partitioned by tokenizer family so a mid-session model switch can never serve
 *  a count from the wrong encoder. The WeakMap holds no reference once a message
 *  leaves history — the cache CANNOT grow cumulatively. */
export function accurateMessageTokens(msg: Message, model?: string): number {
  const family = encodingFamilyForModel(model);
  let perFamily = accurateMessageTokenCache.get(msg);
  const hit = perFamily?.get(family);
  if (hit !== undefined) return hit;
  const n =
    countTokensAccurate(msg.role, model) +
    countTokensAccurate(msg.content, model) +
    (msg.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE +
    1;
  if (!perFamily) {
    perFamily = new Map();
    accurateMessageTokenCache.set(msg, perFamily);
  }
  perFamily.set(family, n);
  return n;
}

export function accurateHistoryTokens(history: Message[], model?: string): number {
  return history.reduce((sum, msg) => sum + accurateMessageTokens(msg, model), 0);
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

/** File paths the agent mutated in `messages` — parsed mechanically (capped,
 *  deduped, insertion order) from two sources:
 *   1. the assistant's write/edit tool-call JSON (`"tool":"write"…"filePath":…`);
 *   2. CONSERVATIVE bash mutation mentions in `Tool [bash] result` feedback
 *      (`created/wrote/written to/deleted/removed <path>`) — gated to bash output
 *      and filtered to path-shaped tokens so prose ("wrote 123 bytes") is ignored. */
const BASH_RESULT_RE = /^Tool \[bash\] result \((?:ok|fail)\):/;
export function extractTouchedFiles(messages: Message[], max = 20): string[] {
  const seen = new Set<string>();
  const writeRe = /"tool"\s*:\s*"(?:write|edit)"[^}]*?"filePath"\s*:\s*"((?:[^"\\]|\\.){1,300})"/g;
  const bashRe = /(?:created|wrote|written to|deleted|removed)\s+(['"`]?)([\w./@+-]{1,200})\1/gi;
  const looksLikePath = (p: string) => /\//.test(p) || /[\w-]\.[A-Za-z0-9]{1,8}$/.test(p);
  const add = (p: string): boolean => {
    if (p && !seen.has(p)) seen.add(p);
    return seen.size >= max;
  };
  for (const msg of messages) {
    if (msg.role === "assistant") {
      let m: RegExpExecArray | null;
      while ((m = writeRe.exec(msg.content))) {
        try {
          const p = JSON.parse(`"${m[1]}"`) as string;
          if (add(p)) return [...seen];
        } catch { /* malformed escape — skip this path */ }
      }
      writeRe.lastIndex = 0;
    }
    if (BASH_RESULT_RE.test(msg.content)) {
      let m: RegExpExecArray | null;
      while ((m = bashRe.exec(msg.content))) {
        if (looksLikePath(m[2]) && add(m[2])) return [...seen];
      }
      bashRe.lastIndex = 0;
    }
  }
  return [...seen];
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

  // gjc-style file-operation preservation (plan/gjc-inheritance.md B8, gjc
  // CompactionDetails 계승): the summary model may drop WHICH files were touched —
  // extract them mechanically from the to-be-summarized messages and pin them
  // into the prompt so post-compaction turns keep their file context.
  const touched = extractTouchedFiles(older);
  const touchedNote = touched.length
    ? `\nFiles touched in the summarized span (PRESERVE this list verbatim in the summary): ${touched.join(", ")}`
    : "";

  const systemPrompt =
    "Summarize the following coding-agent conversation so work can continue. Capture decisions, files changed, current task state, and open TODOs. " +
    "Also preserve approaches that were tried and FAILED (with the cause) and any unconfirmed candidates/hypotheses still to check, so the next steps do not repeat dead ends or lose open leads. Be concise." +
    touchedNote;

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
          reasoningEffort: "none",
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
    // Force a mechanical "Files touched:" header at the FRONT of the summary so
    // the file list survives even if the LLM dropped it from its prose (cycle 11).
    const filesHeader = touched.length ? `Files touched: ${touched.join(", ")}\n\n` : "";
    const summaryMessage: Message = { role: "user", content: SUMMARY_PREFIX + filesHeader + boundedSummary };
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
      touchedFiles: touched.length ? touched : undefined,
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
    touchedFiles: touched.length ? touched : undefined,
  };
}
export interface HandoffOptions {
  model?: string;
  /** Cap the summarizer prompt/output so a handoff document itself cannot balloon context. */
  maxSummaryInputTokens?: number;
  /** Optional focus text — CLI-typed `/handoff <focus>` argument, or the
   *  configured `compaction.handoffFocus` default when no argument is given.
   *  APPEND-ONLY: rendered as its own trailing section, never merged into or
   *  replacing the base handoff sections above it. */
  focus?: string;
  signal?: AbortSignal;
}

export interface HandoffResult {
  ok: boolean;
  document?: string;
  error?: string;
  touchedFiles?: string[];
}

/** Below this many non-system messages there is nothing meaningful to hand off. */
const MIN_HANDOFF_MESSAGES = 2;

/**
 * Generate a bounded, read-only handoff document from the CURRENT history —
 * jeo-native subset of gjc `/handoff` parity. Unlike `maybeCompact`, this
 * NEVER mutates `history`: jeo has no ACP/SDK-broker managed-session boundary
 * to hand off INTO, so this is a display/export operation (like
 * `exportSession`), not a session-transition primitive. It reuses the same
 * LLM summarizer and touched-file extraction as compaction so the base shape
 * (state/decisions/files/open TODOs) matches what `/compact` already
 * produces, then appends the optional focus text as its OWN trailing
 * section — append-only, it never edits the base sections.
 */
export async function buildHandoffDocument(
  history: Message[],
  opts: HandoffOptions = {},
): Promise<HandoffResult> {
  const hasSystem = history.length > 0 && history[0].role === "system";
  const body = history.slice(hasSystem ? 1 : 0);
  if (body.length < MIN_HANDOFF_MESSAGES) {
    return {
      ok: false,
      error: `Nothing to hand off yet — need at least ${MIN_HANDOFF_MESSAGES} conversation messages (have ${body.length}).`,
    };
  }

  const maxSummaryInputTokens = opts.maxSummaryInputTokens ?? DEFAULT_SUMMARY_INPUT_TOKENS;
  const formatted = formatMessagesForSummaryByTokens(body, maxSummaryInputTokens);
  const touched = extractTouchedFiles(body);
  const touchedNote = touched.length
    ? `\nFiles touched in this session (PRESERVE this list verbatim): ${touched.join(", ")}`
    : "";

  const systemPrompt =
    "Write a concise handoff document for the next person/agent continuing this coding session. " +
    "Capture: current goal/state, key decisions, files touched, open TODOs, and approaches already tried " +
    "and failed (with cause) so they are not repeated. Be concise." +
    touchedNote;

  let summary: string;
  try {
    summary = await callLlm(
      [{ role: "user", content: formatted }],
      { model: opts.model, systemPrompt, reasoningEffort: "none", signal: opts.signal },
    );
  } catch (err) {
    if (opts.signal?.aborted) {
      return { ok: false, error: "Handoff cancelled." };
    }
    return {
      ok: false,
      error: `Handoff summary failed: ${(err as Error)?.message ?? "error"}. History was left untouched — retry, or use /export for a raw transcript.`,
    };
  }

  const bounded = truncateRecentContentByTokens(summary, maxSummaryInputTokens);
  const filesHeader = touched.length ? `Files touched: ${touched.join(", ")}\n` : "";

  const sections = ["# Session Handoff", "", `${filesHeader}${bounded}`.trim()];
  const focus = opts.focus?.trim();
  if (focus) sections.push("", "## Focus", "", focus);

  return { ok: true, document: sections.join("\n"), touchedFiles: touched.length ? touched : undefined };
}
