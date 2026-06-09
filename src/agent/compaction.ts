import { callLlm, type Message } from "./loop";

export interface CompactionOptions {
  maxMessages?: number;
  /** Compact even a short history when pasted/tool content exceeds this many characters. */
  maxChars?: number;
  keepRecent?: number;
  model?: string;
  /** Cap the summarizer prompt so compaction itself cannot balloon context. */
  maxSummaryInputChars?: number;
  /** User-initiated `/compact`: lower the trigger floor so it actually compacts a small history. */
  force?: boolean;
}

export interface CompactionResult {
  compacted: boolean;
  removed: number;
  summary?: string;
  /** True when the LLM summary failed and a deterministic placeholder was used. */
  summaryFailed?: boolean;
}

const DEFAULT_MAX_CHARS = 120_000;
const DEFAULT_SUMMARY_INPUT_CHARS = 80_000;

function messageChars(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + msg.role.length + msg.content.length + 4, 0);
}

function formatMessagesForSummary(messages: Message[], maxChars: number): string {
  const out: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const msg of messages) {
    const line = `[${msg.role}] ${msg.content}`;
    const needed = line.length + 1;
    if (used + needed > maxChars) {
      const remaining = Math.max(0, maxChars - used);
      if (remaining > 80) {
        out.push(line.slice(0, remaining - 1) + "…");
        used = maxChars;
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

function truncateRecentContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  if (maxChars <= 0) return "";
  const marker = "\n…(recent message truncated to bound context)";
  if (maxChars <= marker.length + 16) return content.slice(0, Math.max(0, maxChars - 1)) + "…";
  return content.slice(0, maxChars - marker.length) + marker;
}

function clampRecentMessages(messages: Message[], budgetChars: number): Message[] {
  if (messages.length === 0) return messages;
  const overhead = messages.reduce((sum, msg) => sum + msg.role.length + 4, 0);
  const contentBudget = Math.max(0, budgetChars - overhead);
  const perMessageBudget = Math.floor(contentBudget / messages.length);
  return messages.map(msg => ({
    ...msg,
    content: truncateRecentContent(msg.content, perMessageBudget),
  }));
}

export async function maybeCompact(
  history: Message[],
  opts: CompactionOptions = {}
): Promise<CompactionResult> {
  const maxMessages = opts.maxMessages ?? (opts.force ? 1 : 40);
  const maxChars = opts.maxChars ?? (opts.force ? 1 : DEFAULT_MAX_CHARS);
  const keepRecent = opts.keepRecent ?? (opts.force ? 4 : 12);
  const maxSummaryInputChars = opts.maxSummaryInputChars ?? DEFAULT_SUMMARY_INPUT_CHARS;

  const hasSystem = history.length > 0 && history[0].role === "system";
  const systemCount = hasSystem ? 1 : 0;
  const body = history.slice(systemCount);
  const overMessages = opts.force || body.length > maxMessages;
  const overChars = messageChars(body) > maxChars;

  if (!overMessages && !overChars) {
    return { compacted: false, removed: 0 };
  }

  // `keepRecent` is best-effort. If a short history contains huge pasted skill docs or tool
  // output, still summarize at least the oldest body message so a session cannot balloon
  // indefinitely while staying below the message-count threshold.
  const recentCount = Math.min(keepRecent, Math.max(0, body.length - 1));
  const olderCount = body.length - recentCount;
  if (olderCount <= 0) {
    return { compacted: false, removed: 0 };
  }

  const older = body.slice(0, olderCount);
  const recent = body.slice(olderCount);

  const olderFormatted = formatMessagesForSummary(older, maxSummaryInputChars);

  const systemPrompt =
    "Summarize the following coding-agent conversation so work can continue. Capture decisions, files changed, current task state, and open TODOs. Be concise.";

  try {
    const summary = await callLlm(
      [
        { role: "user", content: olderFormatted }
      ],
      {
        model: opts.model,
        systemPrompt,
      }
    );

    const systemMessages = hasSystem ? [history[0]] : [];
    const summaryMessage: Message = { role: "user", content: "[Earlier conversation summary]\n" + summary };
    const boundedRecent = clampRecentMessages(recent, Math.max(0, maxChars - messageChars([summaryMessage])));
    const next: Message[] = [
      ...systemMessages,
      summaryMessage,
      ...boundedRecent
    ];

    history.splice(0, history.length, ...next);

    return {
      compacted: true,
      removed: older.length,
      summary,
    };
  } catch (err) {
    // Summarizer LLM unavailable (provider/auth/rate-limit/offline). Still bound
    // in-memory history with a deterministic placeholder so it never grows
    // unbounded across a session (and the prompt doesn't balloon every turn).
    const systemMessages = hasSystem ? [history[0]] : [];
    const placeholderMessage: Message = {
      role: "user",
      content: `[Earlier conversation omitted: ${older.length} messages — summary unavailable]`,
    };
    const boundedRecent = clampRecentMessages(recent, Math.max(0, maxChars - messageChars([placeholderMessage])));
    const next: Message[] = [
      ...systemMessages,
      placeholderMessage,
      ...boundedRecent,
    ];
    history.splice(0, history.length, ...next);
    process.stderr.write(`[joc] compaction summary failed (${(err as Error)?.message ?? "error"}); dropped ${older.length} older messages to bound memory.\n`);
    return { compacted: true, removed: older.length, summaryFailed: true };
  }
}
