/** Slash-command palette/autocomplete for the interactive REPL (TUI M3). */

export interface SlashCommandInfo {
  command: string;
  usage: string;
  description: string;
  group: "session" | "models" | "subagents" | "code" | "system";
}

export const SLASH_COMMAND_DETAILS: readonly SlashCommandInfo[] = [
  { command: "/help", usage: "/help", description: "Show this help message", group: "system" },
  { command: "/clear", usage: "/clear", description: "Clear conversation history (keeps system prompt)", group: "session" },
  { command: "/compact", usage: "/compact", description: "Summarize older turns to free context", group: "session" },
  { command: "/model", usage: "/model [id|#N|save]", description: "Show/set session model by id, live #N, fuzzy match, or save default", group: "models" },
  { command: "/models", usage: "/models [refresh|caps|catalog]", description: "Live OAuth/API-key models; caps/catalog add capability tables", group: "models" },
  { command: "/provider", usage: "/provider [name] [model|#N]", description: "Credentials, switch provider, list live models; `login <name>` starts OAuth", group: "models" },
  { command: "/logout", usage: "/logout <anthropic|openai|gemini>", description: "Remove the stored OAuth token for a provider", group: "models" },
  { command: "/agents", usage: "/agents [role] [model|#N|maxSteps N|reset]", description: "List subagent roles or pin role model/settings", group: "subagents" },
  { command: "/config", usage: "/config", description: "Show the effective runtime configuration", group: "models" },
  { command: "/roles", usage: "/roles [tier model]", description: "Show or set model role tiers (smol/slow/plan)", group: "models" },
  { command: "/thinking", usage: "/thinking [level]", description: "Show or set thinking budget (minimal/low/medium/high/xhigh)", group: "models" },
  { command: "/view", usage: "/view <file> [a-b]", description: "Render a file with line numbers + light highlight", group: "code" },
  { command: "/diff", usage: "/diff [file]", description: "Render `git diff` with +/- coloring", group: "code" },
  { command: "/find", usage: "/find <glob>", description: "List files matching a glob", group: "code" },
  { command: "/search", usage: "/search <pat> [glob]", description: "Search the repo for a pattern", group: "code" },
  { command: "/sessions", usage: "/sessions", description: "List saved sessions", group: "session" },
  { command: "/evolve", usage: "/evolve", description: "Simulate and view the agent's evolutionary gallery", group: "system" },
  { command: "/exit", usage: "/exit", description: "Exit the agent", group: "system" },
  { command: "/quit", usage: "/quit", description: "Exit the agent", group: "system" },
];

export const SLASH_COMMANDS = SLASH_COMMAND_DETAILS.map(c => c.command);

/** Return the slash commands that prefix-match `input` (case-insensitive). Empty for non-slash input. */
export function matchSlash(input: string, commands: string[] = SLASH_COMMANDS): string[] {
  if (!input.startsWith("/")) return [];
  const q = input.toLowerCase();
  return commands.filter(c => c.startsWith(q));
}

/** True when `input` looks like a slash command (starts with "/" and has no space). */
export function isSlashAttempt(input: string): boolean {
  return input.startsWith("/") && !input.slice(1).includes(" ");
}

/** Format a visible command palette for `/`, `/help`, or a partial slash prefix. */
export function formatSlashCommandList(input = "/"): string[] {
  const query = input === "/?" ? "/" : input;
  const matches = matchSlash(query);
  if (matches.length === 0) return [`Unknown command '${input}'. Try /help.`];
  const wanted = new Set(matches);
  const rows = SLASH_COMMAND_DETAILS.filter(c => wanted.has(c.command));
  const usageWidth = Math.max(...rows.map(c => c.usage.length), 6);
  const title = query === "/" || query === "/help"
    ? "Slash Commands:"
    : `Slash Commands matching '${query}':`;
  return [
    title,
    ...rows.map(c => `  ${c.usage.padEnd(usageWidth)} - ${c.description}`),
    "Tip: type a slash prefix like /m to narrow, or press Tab for inline completion.",
  ];
}
