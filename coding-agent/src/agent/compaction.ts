import { callLlm, type Message } from "./loop";

export interface CompactionOptions {
  maxMessages?: number;
  keepRecent?: number;
  model?: string;
}

export interface CompactionResult {
  compacted: boolean;
  removed: number;
  summary?: string;
}

export async function maybeCompact(
  history: Message[],
  opts: CompactionOptions = {}
): Promise<CompactionResult> {
  const maxMessages = opts.maxMessages ?? 40;
  const keepRecent = opts.keepRecent ?? 12;

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
  } catch {
    return { compacted: false, removed: 0 };
  }
}
