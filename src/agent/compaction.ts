import { callLlm, type Message } from "./loop";

export interface CompactionOptions {
  maxMessages?: number;
  keepRecent?: number;
  model?: string;
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

export async function maybeCompact(
  history: Message[],
  opts: CompactionOptions = {}
): Promise<CompactionResult> {
  const maxMessages = opts.maxMessages ?? (opts.force ? 1 : 40);
  const keepRecent = opts.keepRecent ?? (opts.force ? 4 : 12);

  const hasSystem = history.length > 0 && history[0].role === "system";
  const systemCount = hasSystem ? 1 : 0;
  const body = history.slice(systemCount);

  if (body.length <= maxMessages) {
    return { compacted: false, removed: 0 };
  }

  const olderCount = body.length - keepRecent;
  if (olderCount <= 0) {
    return { compacted: false, removed: 0 };
  }

  const older = body.slice(0, olderCount);
  const recent = body.slice(olderCount);

  const olderFormatted = older
    .map(msg => `[${msg.role}] ${msg.content}`)
    .join("\n");

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
    const next: Message[] = [
      ...systemMessages,
      { role: "user", content: "[Earlier conversation summary]\n" + summary },
      ...recent
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
    const next: Message[] = [
      ...systemMessages,
      { role: "user", content: `[Earlier conversation omitted: ${older.length} messages — summary unavailable]` },
      ...recent,
    ];
    history.splice(0, history.length, ...next);
    process.stderr.write(`[joc] compaction summary failed (${(err as Error)?.message ?? "error"}); dropped ${older.length} older messages to bound memory.\n`);
    return { compacted: true, removed: older.length, summaryFailed: true };
  }
}
