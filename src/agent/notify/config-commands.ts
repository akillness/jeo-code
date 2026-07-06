/**
 * In-thread configuration slash commands for the per-session Telegram surface
 * (gjc `notifications/config-commands.ts` parity). A user can adjust how their
 * OWN session's activity mirrors into its topic without touching global config:
 *
 * - `/verbose`            switch the mirror to verbose (full tool output + reasoning)
 * - `/lean`               switch back to lean (assistant text + tool names only)
 * - `/verbosity lean|verbose`
 * - `/redact on|off`      toggle redaction of mirrored turn/context text
 *
 * Pure and unit-testable; the daemon maps a returned change onto a
 * `config_command` frame sent to the owning session's WebSocket. Only reachable
 * when `notifications.telegram.perSessionTopics` is enabled — the flat/global
 * `topicId` surface has no per-session settings to change.
 */

/** A parsed in-thread configuration change. */
export interface ConfigCommandChange {
  verbosity?: "lean" | "verbose";
  redact?: boolean;
}

/**
 * Parse an in-thread config command. Returns the requested change, or
 * `undefined` when the text is not a recognised config command (the daemon
 * then falls through to treating it as a free-text `user_message`).
 */
export function parseInThreadConfigCommand(text: string): ConfigCommandChange | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
  const command = rawCommand?.toLowerCase();
  const arg = rest[0]?.toLowerCase();

  switch (command) {
    case "verbose":
      return { verbosity: "verbose" };
    case "lean":
      return { verbosity: "lean" };
    case "verbosity":
      if (arg === "lean" || arg === "verbose") return { verbosity: arg };
      return undefined;
    case "redact":
      if (arg === "on" || arg === "true" || arg === "1") return { redact: true };
      if (arg === "off" || arg === "false" || arg === "0") return { redact: false };
      return undefined;
    default:
      return undefined;
  }
}
