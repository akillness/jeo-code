/** Slash-command palette/autocomplete for the interactive REPL (TUI M3). */

export const SLASH_COMMANDS = [
  "/help",
  "/clear",
  "/compact",
  "/model",
  "/models",
  "/provider",
  "/agents",
  "/config",
  "/thinking",
  "/sessions",
  "/evolve",
  "/exit",
  "/quit",
];

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
