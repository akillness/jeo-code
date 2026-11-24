export const DISCORD_THINKING_DEBOUNCE_MS = 1_800;
export const DISCORD_THINKING_MAX_EXCERPT_CHARS = 600;
export const DISCORD_SILENT_MESSAGE_FLAGS = 1 << 12;
export const DISCORD_MAX_MESSAGE_CHARS = 2_000;

export type ThinkingPhase =
  | "thinking"
  | "planning"
  | "executing"
  | "verifying"
  | "reporting"
  | "working";

export interface DiscordThinkingMessageParams {
  title: string;
  phase: ThinkingPhase;
  elapsedLabel: string;
  reasoning?: string;
  currentTool?: string;
  activeSubagents?: number;
  workerLabel?: string;
  finalized?: boolean;
  outcomeBadge?: string;
}

export type UnifiedTaskReportSource =
  | "todo"
  | "subagent"
  | "gate"
  | "queue"
  | "approval"
  | "job";

export interface UnifiedTaskReportItem {
  label: string;
  source: UnifiedTaskReportSource;
  detail?: string;
}

export type UnifiedCompletionStatus =
  | "completed"
  | "partial"
  | "failed"
  | "escalated"
  | "cancelled";

export interface UnifiedCompletionReportInput {
  title: string;
  status: UnifiedCompletionStatus;
  elapsedLabel?: string;
  summary?: string;
  completed: UnifiedTaskReportItem[];
  remaining: UnifiedTaskReportItem[];
  changedFiles?: string[];
}

const MAX_THINKING_MESSAGE_CHARS = 1_900;

const PHASE_BADGES: Record<ThinkingPhase, string> = {
  thinking: "🧠 Thinking",
  planning: "🗺️ Planning",
  executing: "⚙️ Executing",
  verifying: "🔍 Verifying",
  reporting: "📝 Reporting",
  working: "⏳ Working",
};

const STATUS_BADGES: Record<UnifiedCompletionStatus, string> = {
  completed: "✅ 완료",
  partial: "⚠️ 부분 완료",
  failed: "❌ 실패",
  escalated: "🚨 사람 확인 필요",
  cancelled: "⏹ 중단",
};

const COMPLETED_SOURCE_TAGS: Record<UnifiedTaskReportSource, string> = {
  todo: "✅ [Todo]",
  subagent: "🤖 [Subagent]",
  gate: "✔ [Gate]",
  queue: "💬 [대기 큐]",
  approval: "🛡️ [승인]",
  job: "⚙️ [백그라운드 작업]",
};

const REMAINING_SOURCE_TAGS: Record<UnifiedTaskReportSource, string> = {
  todo: "⬜ [Todo]",
  subagent: "⚠️ [Subagent]",
  gate: "❌ [Gate]",
  queue: "💬 [대기 큐]",
  approval: "🛡️ [승인 대기]",
  job: "⏳ [백그라운드 작업]",
};

const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-Z\\-_]/g;

const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const DISCORD_WEBHOOK_RE = /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/gi;
const SLACK_WEBHOOK_RE = /https:\/\/hooks\.slack\.com\/services\/[\w/]+/gi;
const ANTHROPIC_KEY_RE = /\bsk-ant-[A-Za-z0-9_-]{12,}/g;
const GENERIC_SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}/g;
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{16,}/g;
const GITHUB_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}/g;
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}/g;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const DISCORD_BOT_TOKEN_RE = /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/g;
const AUTH_HEADER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ENV_SECRET_RE = /(API_KEY|BOT_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|PRIVATE_KEY|WEBHOOK_URL)(\s*[:=]\s*)(?:(["'`])([^"'`\r\n]+)\3|([^\s"'`]+))/gi;

export function redactDiscordSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(PEM_PRIVATE_KEY_RE, "[REDACTED]")
    .replace(DISCORD_WEBHOOK_RE, "[REDACTED]")
    .replace(SLACK_WEBHOOK_RE, "[REDACTED]")
    .replace(ANTHROPIC_KEY_RE, "[REDACTED]")
    .replace(GENERIC_SK_KEY_RE, "[REDACTED]")
    .replace(GITHUB_TOKEN_RE, "[REDACTED]")
    .replace(GITHUB_PAT_RE, "[REDACTED]")
    .replace(SLACK_TOKEN_RE, "[REDACTED]")
    .replace(AWS_KEY_RE, "[REDACTED]")
    .replace(DISCORD_BOT_TOKEN_RE, "[REDACTED]")
    .replace(AUTH_HEADER_RE, "$1 [REDACTED]")
    .replace(ENV_SECRET_RE, (_match, key: string, sep: string, quote?: string) =>
      quote ? `${key}${sep}${quote}[REDACTED]${quote}` : `${key}${sep}[REDACTED]`,
    );
}

function clipText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  let end = maxChars - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}

export function extractThinkingExcerpt(
  raw: string,
  maxChars = DISCORD_THINKING_MAX_EXCERPT_CHARS,
): string {
  if (!raw || maxChars <= 0) return "";
  const stripped = raw
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/\r\n?/g, "\n");
  const redacted = redactDiscordSecrets(stripped)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!redacted) return "";
  if (redacted.length <= maxChars) return redacted;
  if (maxChars === 1) return "…";

  const budget = maxChars - 1;
  const startIdx = redacted.length - budget;
  let slice = redacted.slice(startIdx);

  // Drop orphaned low surrogate if we cut inside a surrogate pair.
  if (slice.length > 0) {
    const firstCode = slice.charCodeAt(0);
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
      slice = slice.slice(1);
    }
  }

  // If we cut mid-word, advance to the nearest newline or whitespace within the leading window.
  const prevChar = redacted[startIdx - 1] ?? "";
  const firstChar = slice[0] ?? "";
  if (prevChar && !/\s/.test(prevChar) && firstChar && !/\s/.test(firstChar)) {
    const maxLookahead = Math.min(80, Math.floor(slice.length * 0.35));
    const nlIdx = slice.indexOf("\n");
    if (nlIdx > 0 && nlIdx <= maxLookahead) {
      slice = slice.slice(nlIdx + 1).trimStart();
    } else {
      const wsMatch = /\s/.exec(slice.slice(0, maxLookahead + 1));
      if (wsMatch && wsMatch.index > 0) {
        slice = slice.slice(wsMatch.index + 1).trimStart();
      }
    }
  } else {
    slice = slice.trimStart();
  }

  return `…${slice}`;
}

export function formatDiscordThinkingMessage(params: DiscordThinkingMessageParams): string {
  const safeTitle = clipText(redactDiscordSecrets(params.title).replace(/[\r\n]+/g, " ").trim(), 160);
  const safeWorker = params.workerLabel
    ? clipText(redactDiscordSecrets(params.workerLabel).replace(/[\r\n]+/g, " ").trim(), 80)
    : "";
  const safeElapsed = params.elapsedLabel.replace(/[\r\n]+/g, " ").trim() || "0s";
  const badge = params.outcomeBadge
    ? redactDiscordSecrets(params.outcomeBadge).trim()
    : params.finalized
      ? "✅ Thinking 완료"
      : PHASE_BADGES[params.phase];

  const headerParts = [`**${badge}**`];
  if (safeTitle) headerParts.push(safeWorker ? `${safeTitle} (${safeWorker})` : safeTitle);
  else if (safeWorker) headerParts.push(safeWorker);
  headerParts.push(`⏱ ${safeElapsed}`);
  if (typeof params.activeSubagents === "number" && params.activeSubagents > 0) {
    headerParts.push(`🤖 ${params.activeSubagents}`);
  }

  const lines: string[] = [headerParts.join(" · ")];

  if (!params.finalized && params.currentTool && params.currentTool.trim()) {
    const safeTool = clipText(redactDiscordSecrets(params.currentTool).replace(/`/g, "'").replace(/[\r\n]+/g, " ").trim(), 120);
    if (safeTool) lines.push(`🔧 실행 중: \`${safeTool}\``);
  }

  if (params.reasoning && params.reasoning.trim()) {
    const excerpt = extractThinkingExcerpt(params.reasoning, DISCORD_THINKING_MAX_EXCERPT_CHARS);
    if (excerpt) {
      lines.push(`\`\`\`text\n${excerpt.replace(/```/g, "``\u200b`")}\n\`\`\``);
    }
  }

  const message = lines.join("\n");
  if (message.length <= MAX_THINKING_MESSAGE_CHARS) return message;
  return clipText(message, MAX_THINKING_MESSAGE_CHARS);
}

function formatReportItemLine(
  item: UnifiedTaskReportItem,
  tags: Record<UnifiedTaskReportSource, string>,
): string {
  const tag = tags[item.source];
  const label = clipText(redactDiscordSecrets(item.label).replace(/[\r\n]+/g, " ").trim(), 140);
  const detail = item.detail
    ? clipText(redactDiscordSecrets(item.detail).replace(/[\r\n]+/g, " ").trim(), 100)
    : "";
  return detail ? `- ${tag} ${label} — ${detail}` : `- ${tag} ${label}`;
}

function formatBoundedList(
  items: UnifiedTaskReportItem[],
  tags: Record<UnifiedTaskReportSource, string>,
  emptyLine: string,
  maxItems: number,
): string[] {
  if (items.length === 0) return [emptyLine];
  const visible = items.slice(0, maxItems);
  const lines = visible.map(item => formatReportItemLine(item, tags));
  const hidden = items.length - visible.length;
  if (hidden > 0) lines.push(`- … 외 ${hidden}건`);
  return lines;
}

export function formatDiscordCompletionReport(input: UnifiedCompletionReportInput): string {
  const statusBadge = STATUS_BADGES[input.status];
  const safeTitle = clipText(redactDiscordSecrets(input.title).replace(/[\r\n]+/g, " ").trim(), 160);
  const elapsed = input.elapsedLabel?.replace(/[\r\n]+/g, " ").trim();

  const headerParts = [`**${statusBadge}**`];
  if (safeTitle) headerParts.push(safeTitle);
  if (elapsed) headerParts.push(`⏱ ${elapsed}`);

  const sections: string[] = [headerParts.join(" · ")];

  if (input.summary && input.summary.trim()) {
    const safeSummary = clipText(
      redactDiscordSecrets(input.summary).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
      320,
    );
    if (safeSummary) sections.push(safeSummary);
  }

  const completedLines = formatBoundedList(
    input.completed,
    COMPLETED_SOURCE_TAGS,
    "- (없음)",
    12,
  );
  sections.push(`**완료된 작업**\n${completedLines.join("\n")}`);

  const remainingLines = formatBoundedList(
    input.remaining,
    REMAINING_SOURCE_TAGS,
    "- 없음 (모든 작업 완료)",
    12,
  );
  sections.push(`**남은 작업**\n${remainingLines.join("\n")}`);

  if (input.changedFiles && input.changedFiles.length > 0) {
    const maxFiles = 8;
    const shown = input.changedFiles
      .slice(0, maxFiles)
      .map(f => `\`${clipText(redactDiscordSecrets(f).replace(/`/g, "'").replace(/[\r\n]+/g, " ").trim(), 80)}\``);
    const extra = input.changedFiles.length - shown.length;
    const fileList = extra > 0 ? `${shown.join(", ")} 외 ${extra}개` : shown.join(", ");
    sections.push(`📁 변경 파일 (${input.changedFiles.length}): ${fileList}`);
  }

  const full = sections.join("\n\n");
  if (full.length <= DISCORD_MAX_MESSAGE_CHARS) return full;
  return clipText(full, DISCORD_MAX_MESSAGE_CHARS);
}

export function formatCompactDmCompletionSummary(input: UnifiedCompletionReportInput): string {
  const statusBadge = STATUS_BADGES[input.status];
  const safeTitle = clipText(redactDiscordSecrets(input.title).replace(/[\r\n]+/g, " ").trim(), 120);
  const elapsed = input.elapsedLabel?.replace(/[\r\n]+/g, " ").trim();

  const lines: string[] = [
    `${statusBadge}${safeTitle ? ` · ${safeTitle}` : ""}${elapsed ? ` (${elapsed})` : ""}`,
    `완료 ${input.completed.length}건 · 남은 작업 ${input.remaining.length}건`,
  ];

  if (input.remaining.length > 0) {
    const top = input.remaining
      .slice(0, 2)
      .map(item => clipText(redactDiscordSecrets(item.label).replace(/[\r\n]+/g, " ").trim(), 60));
    const more = input.remaining.length - top.length;
    lines.push(`남음: ${top.join(", ")}${more > 0 ? ` 외 ${more}건` : ""}`);
  } else if (input.summary && input.summary.trim()) {
    const safeSummary = clipText(redactDiscordSecrets(input.summary).replace(/[\r\n]+/g, " ").trim(), 140);
    if (safeSummary) lines.push(safeSummary);
  }

  return clipText(lines.join("\n"), DISCORD_MAX_MESSAGE_CHARS);
}
