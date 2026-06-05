import { createInterface } from "node:readline/promises";
import { runAgentLoop, executorSystemPrompt } from "../agent/engine";
import { LaunchTui } from "../tui/app";
import { skillsPromptSection } from "../skills/catalog";
import { matchSlash, isSlashAttempt } from "../tui/components/slash";
import type { Message } from "../agent/loop";
import { readGlobalConfig } from "../agent/state";
import { describeModel } from "../ai";
import { loadProjectContext, withProjectContext } from "../agent/context-files";
import { maybeCompact } from "../agent/compaction";
import {
  createSession,
  appendMessage,
  loadSession,
  listSessions,
  latestSessionId,
} from "../agent/session";

interface LaunchFlags {
  list: boolean;
  resume: boolean;
  resumeId?: string;
  noSession: boolean;
  noTui: boolean;
  maxSteps: number;
  message: string;
}

function parseFlags(args: string[]): LaunchFlags {
  const flags: LaunchFlags = { list: false, resume: false, noSession: false, noTui: false, maxSteps: 25, message: "" };
  const rest: string[] = [];
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--list") {
      flags.list = true;
    } else if (a === "--no-session") {
      flags.noSession = true;
    } else if (a === "--no-tui") {
      flags.noTui = true;
    } else if (a === "--max-steps") {
      const n = parseInt(args[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) {
        flags.maxSteps = n;
        i++;
      }
    } else if (a.startsWith("--max-steps=")) {
      const n = parseInt(a.slice(12), 10);
      if (Number.isFinite(n) && n > 0) flags.maxSteps = n;
    } else if (a === "--resume") {
      flags.resume = true;
      const next = args[i + 1];
      if (next && UUID_REGEX.test(next)) {
        flags.resumeId = next;
        i++;
      }
    } else if (a.startsWith("--resume=")) {
      flags.resume = true;
      const val = a.slice(9);
      if (UUID_REGEX.test(val)) {
        flags.resumeId = val;
      } else {
        rest.push(val);
      }
    } else {
      rest.push(a);
    }
  }
  flags.message = rest.join(" ").trim();
  return flags;
}

export async function runLaunchCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const flags = parseFlags(args);
  const cfg = await readGlobalConfig();
  const defaultModel = cfg.defaultModel;

  // --list: print persisted sessions and exit.
  if (flags.list) {
    const sessions = await listSessions(cwd);
    if (sessions.length === 0) {
      console.log("No saved sessions in .joc/sessions/.");
      return;
    }
    console.log("Saved sessions (newest first):");
    for (const s of sessions) {
      console.log(`  ${s.id}  ${s.timestamp}  (${s.messageCount} msgs)  ${s.preview}`);
    }
    console.log("\nResume with: joc launch --resume <id>");
    return;
  }

  // pi-style: load project context (JEO.md / AGENTS.md / .joc/context.md / CLAUDE.md) into the prompt.
  const contextFiles = await loadProjectContext(cwd);
  const baseSystemPrompt =
    executorSystemPrompt("joc, an interactive coding agent") +
    "\nWhen you have finished the user's request, or need to reply to or ask the user something, call done with {\"reason\": <your natural-language reply to the user>}. The reason text is shown to the user as your message." +
    "\n\nAvailable joc workflow skills (suggest the relevant command when the user's task fits one):\n" +
    skillsPromptSection();
  const systemPrompt = withProjectContext(baseSystemPrompt, contextFiles);

  const history: Message[] = [{ role: "system", content: systemPrompt }];
  let sessionModel: string | undefined = undefined;

  // pi-style session persistence: resume an existing session or create a new one.
  let sessionId: string | undefined;
  if (!flags.noSession) {
    if (flags.resume) {
      const id = flags.resumeId ?? (await latestSessionId(cwd));
      if (!id) {
        console.log("No session to resume. Starting a new one.");
        sessionId = (await createSession(cwd)).id;
      } else {
        try {
          const { messages } = await loadSession(id, cwd);
          for (const m of messages) history.push(m);
          sessionId = id;
          console.log(`Resumed session ${id} (${messages.length} messages).`);
        } catch (err) {
          console.log(`Could not resume ${id}: ${(err as Error).message}. Starting fresh.`);
          sessionId = (await createSession(cwd)).id;
        }
      }
    } else {
      sessionId = (await createSession(cwd)).id;
    }
  }

  const streamEvents = {
    onToolResult: (tool: string, ok: boolean) => console.log(`  · ${tool} ${ok ? "ok" : "FAILED"}`),
    onError: (msg: string) => console.log(`  ! ${msg}`),
  };

  // Run one conversational turn: compact, persist user msg, run the loop, persist + return the reply.
  // When `useTui`, a live TUI renders the turn and prints the final reply itself (rendered=true).
  const runTurn = async (
    userInput: string,
    useTui: boolean
  ): Promise<{ done: boolean; steps: number; reply: string; rendered: boolean; usage: string }> => {
    await maybeCompact(history, { model: sessionModel });
    const beforeLen = history.length;
    history.push({ role: "user", content: userInput });

    const tui = useTui ? new LaunchTui({ model: sessionModel || defaultModel, sessionId, maxSteps: flags.maxSteps }) : null;
    if (tui) tui.start();
    let result;
    const ac = new AbortController();
    const onSigint = () => ac.abort();
    process.once("SIGINT", onSigint);
    try {
      result = await runAgentLoop(history, {
        cwd,
        maxSteps: flags.maxSteps,
        model: sessionModel,
        signal: ac.signal,
        events: tui ? tui.events() : streamEvents,
      });
    } catch (err) {
      if (tui) tui.finish(`! ${(err as Error).message}`);
      throw err;
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
    const reply = result.doneReason || `(reached the ${result.steps}-step limit without signaling done)`;
    // Full-fidelity persistence: append every message the engine added this turn
    // (user prompt + intermediate tool-call/tool-result turns), then the final reply.
    if (sessionId) {
      for (const m of history.slice(beforeLen)) await appendMessage(sessionId, m, cwd);
    }
    history.push({ role: "assistant", content: reply });
    if (sessionId) await appendMessage(sessionId, { role: "assistant", content: reply }, cwd);
    if (tui) tui.finish(reply);
    const usage = result.usage ? `  (${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens)` : "";
    return { done: result.done, steps: result.steps, reply, rendered: !!tui, usage };
  };

  const joinedArgs = flags.message;
  const isOneShot = joinedArgs.length > 0 || !process.stdin.isTTY;

  if (isOneShot) {
    let messageContent = joinedArgs;
    if (!process.stdin.isTTY && joinedArgs.length === 0) {
      messageContent = (await Bun.stdin.text()).trim();
    }
    if (!messageContent) {
      console.log("No input provided.");
      return;
    }
    try {
      const { reply, usage } = await runTurn(messageContent, false);
      console.log(reply + usage);
    } catch (err) {
      console.log(`! ${(err as Error).message}`);
    }
    return;
  }

  // INTERACTIVE mode
  console.log("=== joc launch — interactive coding agent ===");
  console.log(`Model: ${defaultModel}`);
  if (sessionId) console.log(`Session: ${sessionId}`);
  if (contextFiles.length > 0) console.log(`Project context: ${contextFiles.map(f => f.path).join(", ")}`);
  console.log("Type your request. Slash commands: /help /clear /compact /model <id> /sessions /exit" + (LaunchTui.usable(flags.noTui) ? "" : "  (plain output)"));

  const useTui = LaunchTui.usable(flags.noTui);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      const input = (await rl.question("\njoc> ")).trim();
      if (input === "/exit" || input === "/quit") break;
      if (input === "") continue;
      if (input === "/help") {
        console.log("Slash Commands:");
        console.log("  /help           - Show this help message");
        console.log("  /clear          - Clear conversation history (keeps system prompt)");
        console.log("  /model [model]  - Set or display the session model");
        console.log("  /sessions       - List saved sessions");
        console.log("  /compact        - Summarize older turns to free context");
        console.log("  /exit, /quit    - Exit the agent");
        console.log("Tools: read / write / edit / bash / find / search. Sessions persist to .joc/sessions/.");
        continue;
      }
      if (input === "/clear") {
        history.length = 1;
        console.log("(history cleared)");
        continue;
      }
      if (input === "/compact") {
        const res = await maybeCompact(history, { model: sessionModel, force: true });
        console.log(res.compacted ? `(compacted ${res.removed} older messages)` : "(nothing to compact)");
        continue;
      }
      if (input === "/sessions") {
        const sessions = await listSessions(cwd);
        if (sessions.length === 0) console.log("(no saved sessions)");
        for (const s of sessions) console.log(`  ${s.id}  (${s.messageCount} msgs)  ${s.preview}`);
        continue;
      }
      if (input.startsWith("/model") && (input === "/model" || input[6] === " ")) {
        const arg = input.substring(6).trim();
        const label = arg || (sessionModel || defaultModel);
        if (arg) sessionModel = arg;
        const { resolved, provider } = await describeModel(label);
        const expansion = resolved !== label ? ` → ${resolved}` : "";
        console.log(`${arg ? "Model set to" : "Current model"}: ${label}${expansion} (${provider})`);
        continue;
      }

      // Unhandled slash attempt → suggest, don't send the typo to the model.
      if (isSlashAttempt(input)) {
        const m = matchSlash(input);
        console.log(m.length ? `Did you mean: ${m.join("  ")} ?` : `Unknown command '${input}'. Try /help.`);
        continue;
      }

      try {
        const { done, steps, reply, rendered, usage } = await runTurn(input, useTui);
        if (!rendered) {
          console.log(`joc> ${reply}${usage}`);
          if (!done) console.log(`(agent did not converge in ${steps} steps)`);
        } else if (usage) {
          console.log(usage.trim());
        }
      } catch (err) {
        console.log(`! ${(err as Error).message}`);
      }
    }
  } finally {
    rl.close();
  }
}
