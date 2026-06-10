import { createModelManager } from "../ai/model-manager";
import { friendlyProviderError } from "../util/provider-error";

/**
 * `joc chat "<message>"` — a quick, single-shot streaming chat (no tools).
 * Renders the reply token-by-token via the provider streaming path
 * (`ModelManager.stream`), complementary to the tool-loop `joc launch`.
 */
/** Pull --model/-m and --thinking out of chat args; the rest joins into the message.
 *  Previously flags were swallowed into the message text, so `joc chat --model X "hi"`
 *  silently chatted with the DEFAULT model — the worst kind of wrong. */
export function parseChatArgs(args: string[]): { model?: string; thinking?: string; message: string } {
  let model: string | undefined;
  let thinking: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--model" || a === "-m") { model = args[++i]; continue; }
    if (a.startsWith("--model=")) { model = a.slice("--model=".length); continue; }
    if (a === "--thinking") { thinking = args[++i]; continue; }
    if (a.startsWith("--thinking=")) { thinking = a.slice("--thinking=".length); continue; }
    rest.push(a);
  }
  return { model, thinking, message: rest.join(" ").trim() };
}

export async function runChatCommand(args: string[] = []): Promise<void> {
  const { model, thinking, message: parsed } = parseChatArgs(args);
  let message = parsed;
  if (!message && !process.stdin.isTTY) message = (await Bun.stdin.text()).trim();
  if (!message) {
    console.log('Usage: joc chat "<message>"   (streams the reply token-by-token)');
    process.exitCode = 1;
    return;
  }

  const manager = createModelManager();
  process.stdout.write("joc> ");
  let any = false;
  let usage: { inputTokens?: number; outputTokens?: number; durationMs?: number } | undefined;
  try {
    const effort = (thinking === "xhigh" ? "high" : thinking) as "minimal" | "low" | "medium" | "high" | undefined;
    for await (const chunk of manager.stream([{ role: "user", content: message }], { model, reasoningEffort: effort, onUsage: u => { usage = u; } })) {
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
