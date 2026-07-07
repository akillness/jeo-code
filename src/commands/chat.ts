import { createModelManager, thinkingMaxTokens } from "../ai/model-manager";
import { friendlyProviderError } from "../util/provider-error";

/**
 * `jeo chat "<message>"` — a quick, single-shot streaming chat (no tools).
 * Renders the reply token-by-token via the provider streaming path
 * (`ModelManager.stream`), complementary to the tool-loop `jeo launch`.
 */
/** Pull chat-only flags out of args; the rest joins into the message.
 *  Previously flags were swallowed into the message text, so `jeo chat --model X "hi"`
 *  silently chatted with the DEFAULT model — the worst kind of wrong. */
export function parseChatArgs(args: string[]): { model?: string; thinking?: string; maxTokens?: number; message: string } {
  let model: string | undefined;
  let thinking: string | undefined;
  let maxTokens: number | undefined;
  const rest: string[] = [];
  const parsePositiveInt = (value: string | undefined): number | undefined => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--model" || a === "-m") { model = args[++i]; continue; }
    if (a.startsWith("--model=")) { model = a.slice("--model=".length); continue; }
    if (a === "--thinking") { thinking = args[++i]; continue; }
    if (a.startsWith("--thinking=")) { thinking = a.slice("--thinking=".length); continue; }
    if (a === "--max-tokens") { maxTokens = parsePositiveInt(args[++i]); continue; }
    if (a.startsWith("--max-tokens=")) { maxTokens = parsePositiveInt(a.slice("--max-tokens=".length)); continue; }
    rest.push(a);
  }
  return { model, thinking, maxTokens, message: rest.join(" ").trim() };
}

export async function runChatCommand(args: string[] = []): Promise<void> {
  const { model, thinking, maxTokens: explicitMaxTokens, message: parsed } = parseChatArgs(args);
  let message = parsed;
  if (!message && !process.stdin.isTTY) message = (await Bun.stdin.text()).trim();
  if (!message) {
    console.log('Usage: jeo chat [--model <id>] [--thinking <level>] [--max-tokens <n>] "<message>"   (streams the reply token-by-token)');
    process.exitCode = 1;
    return;
  }

  const manager = createModelManager();
  process.stdout.write("jeo> ");
  let any = false;
  let usage: { inputTokens?: number; outputTokens?: number; durationMs?: number } | undefined;
  try {
    const effort = (thinking === "xhigh" ? "high" : thinking) as "low" | "medium" | "high" | undefined;
    const maxTokens = explicitMaxTokens ?? (thinking ? thinkingMaxTokens(thinking as "low" | "medium" | "high" | "xhigh") : undefined);
    for await (const chunk of manager.stream([{ role: "user", content: message }], { model, maxTokens, reasoningEffort: effort, onUsage: u => { usage = u; } })) {
      process.stdout.write(chunk);
      any = true;
    }
  } catch (err) {
    process.stdout.write("\n");
    console.log(`! ${friendlyProviderError(err)}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(any ? "\n" : "(no output)\n");
  if (usage && (usage.inputTokens != null || usage.outputTokens != null)) {
    const tps = usage.outputTokens && usage.durationMs ? ` · ${Math.round((usage.outputTokens / usage.durationMs) * 1000)} tok/s` : "";
    console.log(`(${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out tokens${tps})`);
  }
}
