import { createInterface } from "node:readline/promises";
import { runAgentLoop, executorSystemPrompt } from "../agent/engine";
import { LaunchTui } from "../tui/app";
import { skillsPromptSection } from "../skills/catalog";
import { matchSlash, isSlashAttempt } from "../tui/components/slash";
import { staticCompletionContext, readlineCompleter, type CompletionContext } from "../tui/components/autocomplete";
import { EVOLUTION_STAGES, renderAsciiArt, animateAsciiArt } from "../tui/components/ascii-art";
import { getEvolutionTip } from "../tui/components/evolution";
import chalk from "chalk";
import type { Message } from "../agent/loop";
import { readGlobalConfig, saveGlobalConfig } from "../agent/state";
import { describeModel, describeAllProviders, thinkingMaxTokens, discoverModels, flattenModels, resolveSelection, catalogMetadata } from "../ai";
import type { ProviderModelsResult, PickEntry } from "../ai";

import { listAliases } from "../ai/model-registry";

import { SUBAGENT_ROLES, getSubagentRole, resolveSubagentModel, resolveSubagentMaxSteps } from "../agent/subagents";
import {
  formatModelLine,
  formatAliasLines,
  formatProviderPanel,
  formatAgentsPanel,
  formatAgentDetail,
  formatConfigPanel,

  liveModelKnown,
  formatPickList,
  formatCapabilityLine,
} from "../tui/components/config-panel";
import { detectLanguage, languageLabel, parseLineRange, sliceLines, formatCodeBlock, formatDiff } from "../tui/components/code-view";
import { findTool, searchTool } from "../agent/tools";
import { loadProjectContext, withProjectContext } from "../agent/context-files";
import { maybeCompact } from "../agent/compaction";
import * as path from "node:path";
import * as fs from "node:fs";
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
  tmux: boolean;
  worktree?: string;
}

function parseFlags(args: string[]): LaunchFlags {
  const flags: LaunchFlags = { list: false, resume: false, noSession: false, noTui: false, maxSteps: 25, message: "", tmux: false };
  const rest: string[] = [];
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--list") {
      flags.list = true;
    } else if (a === "--tmux") {
      flags.tmux = true;
    } else if (a === "--worktree") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags.worktree = next;
        i++;
      }
    } else if (a.startsWith("--worktree=")) {
      flags.worktree = a.slice("--worktree=".length);
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

/**
 * Resolve a git worktree path (gjc `--worktree <path>` parity). If the path
 * already exists it is reused as-is; otherwise a new worktree is created on a
 * branch derived from the path basename. Returns the absolute worktree path.
 */
function resolveWorktree(cwd: string, wt: string): string {
  const abs = path.isAbsolute(wt) ? wt : path.resolve(cwd, wt);
  if (fs.existsSync(abs)) return abs;
  if (!Bun.which("git")) {
    console.error("error: --worktree requires git on PATH");
    process.exit(1);
  }
  const branch = (path.basename(abs).replace(/[^a-zA-Z0-9_-]/g, "-") || "joc-wt");
  const withBranch = Bun.spawnSync(["git", "worktree", "add", "-b", branch, abs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (withBranch.exitCode !== 0) {
    // Branch may already exist; retry attaching the existing branch.
    const plain = Bun.spawnSync(["git", "worktree", "add", abs], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (plain.exitCode !== 0) {
      console.error(
        `error: failed to create git worktree at ${abs}: ${withBranch.stderr.toString().trim()}`,
      );
      process.exit(1);
    }
  }
  return abs;
}

export async function runLaunchCommand(args: string[]): Promise<void> {
  let cwd = process.cwd();
  const flags = parseFlags(args);

  if (flags.worktree) {
    const wt = resolveWorktree(cwd, flags.worktree);
    if (wt !== cwd) {
      process.chdir(wt);
      cwd = wt;
      if (process.env.JOC_TMUX_LAUNCHED !== "1") console.log(`Using worktree: ${wt}`);
    }
  }
  if (flags.tmux) {
    if (!process.env.TMUX && process.env.JOC_TMUX_LAUNCHED !== "1") {
      const tmuxBin = Bun.which("tmux");
      if (tmuxBin) {
        let branch = "";
        try {
          const gitRes = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
            cwd,
            stdout: "pipe",
            stderr: "ignore",
          });
          if (gitRes.exitCode === 0) {
            branch = gitRes.stdout.toString().trim().replace(/[^a-zA-Z0-9_-]/g, "-");
          }
        } catch {}
        const sessionName = branch ? `joc-${branch}` : "joc-session";

        // Strip orchestration flags: the worktree is already the tmux session
        // cwd (`-c cwd` below), so the inner process inherits it directly.
        const innerArgs: string[] = [];
        for (let j = 0; j < args.length; j++) {
          const a = args[j];
          if (a === "--tmux") continue;
          if (a === "--worktree") { j++; continue; }
          if (a.startsWith("--worktree=")) continue;
          innerArgs.push(a);
        }
        const entrypoint = process.argv[1] || "joc";
        const resolvedEntrypoint = path.isAbsolute(entrypoint) ? entrypoint : path.resolve(cwd, entrypoint);
        let cmd: string[] = [];
        if (entrypoint.endsWith(".ts") || entrypoint.endsWith(".js") || entrypoint.endsWith(".mjs")) {
          cmd = [process.execPath, resolvedEntrypoint];
        } else {
          cmd = [resolvedEntrypoint];
        }

        const innerCmd = `exec env JOC_TMUX_LAUNCHED=1 ${[...cmd, "launch", ...innerArgs].map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;

        const hasSession = Bun.spawnSync([tmuxBin, "has-session", "-t", `=${sessionName}`]);
        if (hasSession.exitCode === 0) {
          console.log(`Attaching to existing tmux session: ${sessionName}`);
          const proc = Bun.spawn([tmuxBin, "attach-session", "-t", `=${sessionName}`], {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          });
          await proc.exited;
          return;
        }

        console.log(`Starting new tmux session: ${sessionName}`);
        const createSession = Bun.spawnSync([
          tmuxBin,
          "new-session",
          "-d",
          "-s",
          sessionName,
          "-c",
          cwd,
          innerCmd
        ]);
        if (createSession.exitCode !== 0) {
          console.error(`Error: Failed to create tmux session: ${createSession.stderr.toString()}`);
          process.exit(1);
        }

        const attach = Bun.spawn([tmuxBin, "attach-session", "-t", `=${sessionName}`], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        await attach.exited;
        return;
      } else {
        console.warn("warning: tmux is not available on PATH. Launching directly...");
      }
    }
  }

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
  // Session thinking-level override (`/thinking`); falls back to the config level.
  let sessionThinking: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined = cfg.thinkingLevel;
  // Cache of live, credential-validated models per provider (refreshed via `/models refresh`).
  let liveModelsCache: ProviderModelsResult[] | null = null;
  const getLiveModels = async (force = false): Promise<ProviderModelsResult[]> => {
    if (force || !liveModelsCache) {
      process.stdout.write("(fetching models from logged-in providers…)\n");
      liveModelsCache = await discoverModels({ timeoutMs: 4000 });
    }
    return liveModelsCache;
  };
  // The most recently displayed numbered pick list; `/model #N` selects from it.
  let lastPickIndex: PickEntry[] = [];

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
    onToolResult: (tool: string, ok: boolean) => console.log(`  └─ stream:${ok ? "complete" : "error"} tool ${tool}`),
    onError: (msg: string) => console.log(`  └─ stream:error ${msg}`),
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

    const activeModel = sessionModel || defaultModel;
    const { provider: activeProvider } = await describeModel(activeModel);
    const tui = useTui ? new LaunchTui({ model: activeModel, provider: activeProvider, sessionId, maxSteps: flags.maxSteps }) : null;
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
        maxTokens: sessionThinking ? thinkingMaxTokens(sessionThinking) : undefined,
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
  const welcomeStage = EVOLUTION_STAGES[0];
  await animateAsciiArt(welcomeStage);
  console.log(`\n=== joc launch — interactive coding agent (Evolution Stage: ${welcomeStage.name}) ===`);
  const { provider: startProvider } = await describeModel(defaultModel);
  console.log(`Model: ${defaultModel} (${startProvider})  ·  thinking: ${sessionThinking ?? "medium"}`);
  if (sessionId) console.log(`Session: ${sessionId}`);
  if (contextFiles.length > 0) console.log(`Project context: ${contextFiles.map(f => f.path).join(", ")}`);
  console.log("Type your request. Slash: /help /model /models /provider /agents /config /thinking /view /diff /find /search /sessions /exit" + (LaunchTui.usable(flags.noTui) ? "" : "  (plain output)"));

  const useTui = LaunchTui.usable(flags.noTui);
  // Tab autocomplete: alias names snapshotted once; live models come from the
  // background-warmed cache (logged-in/OAuth accounts). The completer is sync, so
  // it never blocks on the network — it reads whatever the cache currently holds.
  const aliasNames = Object.keys(await listAliases());
  void discoverModels({ timeoutMs: 4000 })
    .then(r => {
      liveModelsCache ??= r;
    })
    .catch(() => {});
  const completionContext = (): CompletionContext => ({
    ...staticCompletionContext(),
    liveModels: liveModelsCache ? flattenModels(liveModelsCache).map(e => e.model) : [],
    aliases: aliasNames,
    modelsForProvider: p => liveModelsCache?.find(r => r.provider === p)?.models ?? [],
  });
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => readlineCompleter(line, completionContext()),
  });

  try {
    while (true) {
      const input = (await rl.question("\njoc> ")).trim();
      if (input === "/exit" || input === "/quit") break;
      if (input === "") continue;
      if (input === "/help") {
        console.log("Slash Commands:");
        console.log("  /help               - Show this help message");
        console.log("  /clear              - Clear conversation history (keeps system prompt)");
        console.log("  /model [id|#N|save] - Set the session model by id, by #N from /models, or save as default");
        console.log("  /models [refresh]   - Live model list from logged-in providers (+ aliases)");
        console.log("  /provider [name] [model] - Provider credentials, or switch + list that provider's live models");
        console.log("  /agents [role] [model]   - List subagent roles, show one, or pin a role's model (saved)");
        console.log("  /config             - Show the effective runtime configuration");
        console.log("  /thinking [level]   - Show or set the thinking budget (low/medium/high)");
        console.log("  /view <file> [a-b]  - Code view: render a file with line numbers + light highlight");
        console.log("  /diff [file]        - Render `git diff` with +/- coloring");
        console.log("  /find <glob>        - List files matching a glob");
        console.log("  /search <pat> [glob]- Grep the repo for a pattern");
        console.log("  /sessions           - List saved sessions");
        console.log("  /evolve             - Simulate and view the agent's evolutionary gallery");
        console.log("  /compact            - Summarize older turns to free context");
        console.log("  /exit, /quit        - Exit the agent");
        console.log("Tools: read / write / edit / bash / find / search. Sessions persist to .joc/sessions/.");
        const tip = getEvolutionTip(history.length, flags.maxSteps);
        console.log(`\n${chalk.cyan("Evolutionary Tip:")} ${tip}`);
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
      if (input === "/evolve") {
        console.log("=== Initiating Evolutionary Simulation ===");
        for (const stage of EVOLUTION_STAGES) {
          console.log(`\nStage: ${stage.name}`);
          await animateAsciiArt(stage, { delayMs: 40 });
        }
        console.log("\n=== Evolved to Singularity! ===");
        continue;
      }
      if (input.startsWith("/models") && (input === "/models" || input[7] === " ")) {
        const refresh = input.substring(7).trim().toLowerCase() === "refresh";
        const cfgNow = await readGlobalConfig();
        const def = sessionModel || cfgNow.defaultModel;
        const { resolved, provider } = await describeModel(def);
        console.log(`Default model: ${formatModelLine({ label: def, resolved, provider })}`);
        console.log("Aliases:");
        for (const line of formatAliasLines(await listAliases())) console.log(line);
        const live = await getLiveModels(refresh);
        lastPickIndex = flattenModels(live);
        console.log("Live models (logged-in providers) — select with /model #N:");
        for (const line of formatPickList(lastPickIndex, { current: resolved })) console.log(line);
        console.log("Refresh: /models refresh  ·  one provider: /provider <name>");
        continue;
      }
      if (input.startsWith("/provider") && (input === "/provider" || input[9] === " ")) {
        const tokens = input.substring(9).trim().split(/\s+/).filter(Boolean);
        const name = (tokens[0] ?? "").toLowerCase();
        const explicitModel = tokens[1];
        const cfgNow = await readGlobalConfig();
        const statuses = await describeAllProviders(cfgNow);
        if (!name) {
          console.log("Providers (credential · base URL):");
          for (const line of formatProviderPanel(statuses)) console.log(line);
          console.log("Switch with: /provider <name> [model]  ·  list live models: /models");
          continue;
        }
        const PROVIDER_DEFAULT: Record<string, string> = { anthropic: "sonnet", openai: "gpt", gemini: "flash", ollama: "fast" };
        if (!(name in PROVIDER_DEFAULT)) {
          console.log(`Unknown provider '${name}'. Known: ${statuses.map(s => s.name).join(", ")}.`);
          continue;
        }
        const st = statuses.find(s => s.name === name);
        if (st && !st.ready) {
          console.log(`! ${name} is not logged in — run 'joc auth login' or set ${st.envVar ?? "the provider key"}. Switching anyway.`);
        }
        const target = explicitModel ?? PROVIDER_DEFAULT[name];
        sessionModel = target;
        const { resolved, provider } = await describeModel(target);
        console.log(`Model set to ${formatModelLine({ label: target, resolved, provider, ready: st?.ready })}`);
        // Show the provider's live, credentialed catalog so the user can pick a concrete id.
        const live = await getLiveModels();
        const forProvider = live.filter(r => r.provider === name);
        if (forProvider.length) {
          lastPickIndex = flattenModels(forProvider);
          console.log(`Live ${name} models — select with /model #N:`);
          for (const line of formatPickList(lastPickIndex, { current: resolved })) console.log(line);
        }
        if (explicitModel && !liveModelKnown(live, target)) {
          console.log(`  (note: '${target}' is not in ${name}'s live list — it may still work, or pick one above)`);
        }
        continue;
      }
      if (input.startsWith("/agents") && (input === "/agents" || input[7] === " ")) {
        const tokens = input.substring(7).trim().split(/\s+/).filter(Boolean);
        const roleArg = tokens[0];
        const modelArg = tokens[1];
        const cfgNow = await readGlobalConfig();
        if (!roleArg) {
          console.log("Subagent roles (used by 'joc team'):");
          for (const line of formatAgentsPanel(SUBAGENT_ROLES, r => ({
            model: resolveSubagentModel(r.id, cfgNow),
            maxSteps: resolveSubagentMaxSteps(r.id, cfgNow),
          }))) console.log(line);
          console.log("Detail: /agents <role>  ·  set model: /agents <role> <model>");
          continue;
        }
        const role = getSubagentRole(roleArg);
        if (!role) {
          console.log(`Unknown role '${roleArg}'. Known: ${SUBAGENT_ROLES.map(r => r.id).join(", ")}.`);
          continue;
        }
        if (modelArg) {
          // Persist a per-role model override to ~/.joc/config.json (consumed by 'joc team').
          const next = { ...cfgNow, subagents: { ...(cfgNow.subagents ?? {}) } };
          next.subagents[role.id] = { ...next.subagents[role.id], model: modelArg };
          await saveGlobalConfig(next);
          const { provider } = await describeModel(modelArg);
          console.log(`${role.title} model set to ${modelArg} (${provider}) — saved to ~/.joc/config.json`);
          const live = await getLiveModels();
          if (!liveModelKnown(live, modelArg)) {
            console.log(`  (note: '${modelArg}' is not in any live model list — verify it is valid for ${provider})`);
          }
          continue;
        }
        for (const line of formatAgentDetail(role, {
          model: resolveSubagentModel(role.id, cfgNow),
          maxSteps: resolveSubagentMaxSteps(role.id, cfgNow),
        })) console.log(line);
        continue;
      }
      if (input === "/config") {
        const cfgNow = await readGlobalConfig();
        const label = sessionModel || cfgNow.defaultModel;
        const { resolved, provider } = await describeModel(label);
        console.log("Effective runtime config:");
        for (const line of formatConfigPanel({
          model: label,
          resolved,
          provider,
          thinkingLevel: sessionThinking ?? cfgNow.thinkingLevel ?? "medium",
          ollamaBaseUrl: cfgNow.ollamaBaseUrl,
          openaiBaseUrl: cfgNow.openaiBaseUrl,
          requestMaxRetries: cfgNow.retry?.requestMaxRetries,
          sessionId,
        })) console.log(line);
        continue;
      }
      if (input.startsWith("/thinking") && (input === "/thinking" || input[9] === " ")) {
        const arg = input.substring(9).trim().toLowerCase();
        if (!arg) {
          console.log(`Thinking level: ${sessionThinking ?? "medium"} (~${thinkingMaxTokens(sessionThinking)} max tokens/step)`);
          continue;
        }
        if (arg === "minimal" || arg === "low" || arg === "medium" || arg === "high" || arg === "xhigh") {
          sessionThinking = arg;
          console.log(`Thinking set to ${arg} (~${thinkingMaxTokens(arg)} max tokens/step)`);
        } else {
          console.log(`Invalid level '${arg}'. Use: minimal | low | medium | high | xhigh.`);
        }
        continue;
      }
      if (input.startsWith("/model") && (input === "/model" || input[6] === " ")) {
        let arg = input.substring(6).trim();
        // `/model save [id]` → persist the (session or given) model as the config default.
        if (arg === "save" || arg.startsWith("save ")) {
          const toSave = arg.slice(4).trim() || sessionModel || defaultModel;
          const cfgNow = await readGlobalConfig();
          await saveGlobalConfig({ ...cfgNow, defaultModel: toSave });
          const { resolved, provider } = await describeModel(toSave);
          console.log(`Default model saved: ${formatModelLine({ label: toSave, resolved, provider })} → ~/.joc/config.json`);
          continue;
        }
        // Selection from the last numbered pick list (`#N`) or a fuzzy substring.
        if (arg && lastPickIndex.length) {
          const sel = resolveSelection(lastPickIndex, arg);
          if (sel.kind === "index" || sel.kind === "match") {
            arg = sel.entry.model;
          } else if (sel.kind === "ambiguous") {
            console.log(`'${arg}' matches ${sel.matches.length} models — be more specific:`);
            for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
            continue;
          } else if (sel.kind === "out-of-range") {
            console.log(`#${arg.slice(1)} is out of range (1-${sel.max}). Run /models first.`);
            continue;
          }
          // kind "none" → fall through and treat `arg` as a literal model id/alias.
        } else if (arg.startsWith("#")) {
          console.log("Run /models (or /provider <name>) first to build the numbered list.");
          continue;
        }
        const label = arg || (sessionModel || defaultModel);
        if (arg) sessionModel = arg;
        const { resolved, provider } = await describeModel(label);
        const statuses = await describeAllProviders();
        const st = statuses.find(s => s.name === provider);
        console.log(`${arg ? "Model set to" : "Current model"}: ${formatModelLine({ label, resolved, provider, ready: st?.ready })}`);
        if (st && !st.ready) console.log(`  ! ${provider} has no credential — run 'joc setup' or set ${st.envVar ?? "the provider key"}.`);
        if (arg && liveModelsCache && resolved === label && !liveModelKnown(liveModelsCache, resolved)) {
          console.log(`  (note: '${resolved}' is not in the live ${provider} catalog — run /models to see valid ids)`);
        }
        const meta = catalogMetadata(resolved);
        if (meta) console.log(`  ${formatCapabilityLine(meta)}`);
        console.log("  (persist as default: /model save)");
        continue;
      }
      if (input.startsWith("/view") && (input === "/view" || input[5] === " ")) {
        const tokens = input.substring(5).trim().split(/\s+/).filter(Boolean);
        const file = tokens[0];
        if (!file) {
          console.log("Usage: /view <file> [start-end]   (e.g. /view src/cli.ts 1-40)");
          continue;
        }
        let content: string;
        try {
          content = await fs.promises.readFile(path.resolve(cwd, file), "utf-8");
        } catch (err) {
          console.log(`! cannot read ${file}: ${(err as Error).message}`);
          continue;
        }
        const range = tokens[1] ? parseLineRange(tokens[1]) : undefined;
        if (tokens[1] && !range) {
          console.log(`Invalid range '${tokens[1]}'. Use start-end | start- | start.`);
          continue;
        }
        const lang = detectLanguage(file);
        const { lines, startLine } = sliceLines(content, range ?? undefined);
        const { cols } = await import("../tui/terminal").then(m => m.size());
        console.log(chalk.bold(`${file}`) + chalk.gray(`  (${languageLabel(lang)}, lines ${startLine}-${startLine + lines.length - 1})`));
        for (const line of formatCodeBlock(lines.join("\n"), { startLine, lang, cols: Math.max(40, cols - 1), maxLines: 200 })) {
          console.log(line);
        }
        continue;
      }
      if (input.startsWith("/diff") && (input === "/diff" || input[5] === " ")) {
        const target = input.substring(5).trim();
        const proc = Bun.spawnSync(["git", "diff", ...(target ? ["--", target] : [])], { cwd, stdout: "pipe", stderr: "pipe" });
        if (proc.exitCode !== 0 && !proc.stdout.length) {
          console.log(`! git diff failed: ${proc.stderr.toString().trim() || "not a git repo?"}`);
          continue;
        }
        const text = proc.stdout.toString();
        if (!text.trim()) {
          console.log("(no unstaged changes)");
          continue;
        }
        const { cols } = await import("../tui/terminal").then(m => m.size());
        for (const line of formatDiff(text, { cols: Math.max(40, cols - 1), maxLines: 400 })) console.log(line);
        continue;
      }
      if (input.startsWith("/find") && (input === "/find" || input[5] === " ")) {
        const glob = input.substring(5).trim();
        if (!glob) {
          console.log("Usage: /find <glob>   (e.g. /find src/**/*.ts)");
          continue;
        }
        const res = await findTool(glob, cwd);
        console.log(res.success ? (res.output || "(no matches)") : `! ${res.error}`);
        continue;
      }
      if (input.startsWith("/search") && (input === "/search" || input[7] === " ")) {
        const tokens = input.substring(7).trim().split(/\s+/).filter(Boolean);
        const pattern = tokens[0];
        const glob = tokens[1] ?? "*";
        if (!pattern) {
          console.log("Usage: /search <pattern> [glob]   (e.g. /search resolveProvider src/**/*.ts)");
          continue;
        }
        const res = await searchTool(pattern, glob, cwd);
        console.log(res.success ? (res.output || "(no matches)") : `! ${res.error}`);
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
