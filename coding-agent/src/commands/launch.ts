import { createInterface } from "node:readline/promises";
import { runAgentLoop, executorSystemPrompt } from "../agent/engine";
import type { Message } from "../agent/loop";
import { readGlobalConfig } from "../agent/state";

export async function runLaunchCommand(args: string[]): Promise<void> {
  const systemPrompt =
    executorSystemPrompt("joc, an interactive coding agent") +
    "\nWhen you have finished the user's request, or need to reply to or ask the user something, call done with {\"reason\": <your natural-language reply to the user>}. The reason text is shown to the user as your message.";

  const history: Message[] = [{ role: "system", content: systemPrompt }];
  let sessionModel: string | undefined = undefined;
  const cfg = await readGlobalConfig();
  const defaultModel = cfg.defaultModel;

  const events = {
    onToolResult: (tool: string, ok: boolean) => console.log(`  · ${tool} ${ok ? "ok" : "FAILED"}`),
    onError: (msg: string) => console.log(`  ! ${msg}`),
  };

  const joinedArgs = args.join(" ").trim();
  const isOneShot = joinedArgs.length > 0 || !process.stdin.isTTY;

  if (isOneShot) {
    let messageContent = joinedArgs;
    if (!process.stdin.isTTY && joinedArgs.length === 0) {
      messageContent = await Bun.stdin.text();
    }
    history.push({ role: "user", content: messageContent });

    try {
      const result = await runAgentLoop(history, {
        cwd: process.cwd(),
        maxSteps: 25,
        model: sessionModel,
        events,
      });
      console.log(result.doneReason ?? "(agent stopped without a final message)");
    } catch (err) {
      console.log(`! ${(err as Error).message}`);
    }
    return;
  }

  // INTERACTIVE mode
  console.log("=== joc launch — interactive coding agent ===");
  console.log(`Model: ${defaultModel}`);
  console.log("Type your request. Slash commands: /help /clear /model <id> /exit");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const input = (await rl.question("\njoc> ")).trim();
      if (input === "/exit" || input === "/quit") {
        break;
      }
      if (input === "/help") {
        console.log("Slash Commands:");
        console.log("  /help           - Show this help message");
        console.log("  /clear          - Clear conversation history");
        console.log("  /model [model]  - Set or display the LLM model used for the session");
        console.log("  /exit, /quit    - Exit the agent");
        console.log("\nNote: The agent can invoke tools to read/write/edit files, run bash commands, and search files.");
        continue;
      }
      if (input === "/clear") {
        history.length = 1;
        console.log("(history cleared)");
        continue;
      }
      if (input.startsWith("/model") && (input === "/model" || input[6] === " ")) {
        const arg = input.substring(6).trim();
        if (arg) {
          sessionModel = arg;
          console.log(`Model set to: ${sessionModel}`);
        } else {
          console.log(`Current model: ${sessionModel || defaultModel}`);
        }
        continue;
      }
      if (input === "") {
        continue;
      }

      history.push({ role: "user", content: input });
      try {
        const result = await runAgentLoop(history, {
          cwd: process.cwd(),
          maxSteps: 25,
          model: sessionModel,
          events,
        });
        if (result.doneReason) {
          console.log(`joc> ${result.doneReason}`);
        } else {
          console.log("joc> (agent stopped without a final message)");
        }
        if (!result.done) {
          console.log(`(agent did not converge in ${result.steps} steps)`);
        }
      } catch (err) {
        console.log(`! ${(err as Error).message}`);
      }
    }
  } finally {
    rl.close();
  }
}
