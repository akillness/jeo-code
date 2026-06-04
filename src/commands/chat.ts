import { createModelManager } from "../ai/model-manager";

/**
 * `joc chat "<message>"` — a quick, single-shot streaming chat (no tools).
 * Renders the reply token-by-token via the provider streaming path
 * (`ModelManager.stream`), complementary to the tool-loop `joc launch`.
 */
export async function runChatCommand(args: string[] = []): Promise<void> {
  let message = args.join(" ").trim();
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
    for await (const chunk of manager.stream([{ role: "user", content: message }], { onUsage: u => { usage = u; } })) {
      process.stdout.write(chunk);
      any = true;
    }
  } catch (err) {
    process.stdout.write("\n");
    console.log(`! ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(any ? "\n" : "(no output)\n");
  if (usage && (usage.inputTokens != null || usage.outputTokens != null)) {
    const tps = usage.outputTokens && usage.durationMs ? ` · ${Math.round((usage.outputTokens / usage.durationMs) * 1000)} tok/s` : "";
    console.log(`(${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out tokens${tps})`);
  }
}
