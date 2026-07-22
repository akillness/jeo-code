/**
 * Slash command handlers extracted from launch.ts.
 * Each handler is a pure function taking context and returning a result.
 */

import type { Message } from "../../agent/loop";
import type { Config } from "../../agent/state";
import { TOOL_PROTOCOL } from "../../agent/engine";
import { taskToolProtocolLine } from "../../agent/task-tool";
import { TODO_TOOL_PROTOCOL_LINE } from "../../agent/todo-tool";
import { SUBAGENT_TOOL_PROTOCOL_LINE } from "../../agent/subagent-tool";
import { JOB_TOOL_PROTOCOL_LINE } from "../../agent/job-tool";
import { MONITOR_TOOL_PROTOCOL_LINE } from "../../agent/monitor-tool";
import { IRC_TOOL_PROTOCOL_LINE } from "../../agent/irc-tool";
import { GOAL_TOOL_PROTOCOL_LINE } from "../../agent/goal-tool";
import { hotkeysLines, contextUsageLines } from "./slash-views";
import { describeModel, catalogMetadata } from "../../ai";
import { readGlobalConfig } from "../../agent/state";

/** Shared context passed to all slash handlers. */
export interface SlashContext {
  history: Message[];
  sessionModel?: string;
  sessionId?: string;
  cwd: string;
  config: Config;
}

/** Handler result: lines to print, or undefined if handler didn't match. */
export type SlashResult = { lines: string[] } | { action: "exit" | "continue" } | undefined;

/** Handles /usage command. */
export function handleUsage(ctx: SlashContext, sessionUsage: { turns: number; inputTokens: number; outputTokens: number }): SlashResult {
  const total = sessionUsage.inputTokens + sessionUsage.outputTokens;
  return {
    lines: [
      "Provider token usage (this REPL):",
      `  turns   ${sessionUsage.turns}`,
      `  input   ${sessionUsage.inputTokens}`,
      `  output  ${sessionUsage.outputTokens}`,
      `  total   ${total}${total === 0 ? "  (providers report usage per turn; run a request first)" : ""}`,
    ],
  };
}

/** Handles /tools command. */
export async function handleTools(ctx: SlashContext): Promise<SlashResult> {
  const lines = ["Tools visible to the agent:"];
  for (const line of TOOL_PROTOCOL.split("\n")) lines.push(`  ${line}`);
  lines.push(`  ${taskToolProtocolLine(await readGlobalConfig())}`);
  lines.push(`  ${TODO_TOOL_PROTOCOL_LINE}`);
  lines.push(`  ${SUBAGENT_TOOL_PROTOCOL_LINE}`);
  lines.push(`  ${JOB_TOOL_PROTOCOL_LINE}`);
  lines.push(`  ${MONITOR_TOOL_PROTOCOL_LINE}`);
  lines.push(`  ${IRC_TOOL_PROTOCOL_LINE}`);
  lines.push(`  ${GOAL_TOOL_PROTOCOL_LINE}`);
  return { lines };
}

/** Handles /hotkeys command. */
export function handleHotkeys(_ctx: SlashContext): SlashResult {
  return { lines: hotkeysLines() };
}

/** Handles /context command. */
export async function handleContext(ctx: SlashContext): Promise<SlashResult> {
  const { resolved } = await describeModel(ctx.sessionModel || ctx.config.defaultModel);
  const window = catalogMetadata(resolved)?.contextTokens;
  return { lines: contextUsageLines(ctx.history, resolved, window) };
}
