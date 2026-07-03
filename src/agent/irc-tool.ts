/**
 * `irc` tool — lets the PARENT list running DETACHED subagents as "peers" and send
 * a live message to one or all of them (gjc `irc` parity, scoped to an in-process
 * registry: no separate peer directory, no channels — a running detached subagent
 * IS a peer). Built entirely on `SubagentRegistry.running()` / `.steer()`; this file
 * holds no state of its own.
 *
 * Delivery mechanism is identical to `subagent {action:"steer"}` — a pushed message
 * sits in that subagent's registry inbox until its own agent loop drains it between
 * steps (see `subagent-registry.ts` steer()/steerDrainFor()). "send to all" simply
 * loops registry.steer() over every currently running id.
 */
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import type { SubagentRegistry, SubagentRecord } from "./subagent-registry";

/** One-line protocol description appended to the launch system prompt. */
export const IRC_TOOL_PROTOCOL_LINE =
  `irc {action:"list"|"send", to?, message?} — live peer messaging with DETACHED ` +
  `subagents started with task{detached:true}. 'list' shows running subagents as peers; ` +
  `'send' delivers {to, message} to one running peer (to: its id) or every running peer ` +
  `(to:"all"), picked up before its next step.`;

function peerLine(rec: SubagentRecord): string {
  return `- ${rec.id} (${rec.role}) · ${rec.task}`;
}

export function createIrcTool(registry: SubagentRegistry): ToolHandler {
  return async (args: Record<string, any>, _cwd: string): Promise<ToolResult> => {
    const action = String(args.action ?? "list").trim().toLowerCase();

    if (action === "list") {
      const peers = registry.running();
      if (peers.length === 0) {
        return { success: true, output: "No running subagent peers. Launch one with task {detached:true}." };
      }
      return { success: true, output: peers.map(peerLine).join("\n") };
    }

    if (action === "send") {
      const message = typeof args.message === "string" ? args.message : typeof args.text === "string" ? args.text : "";
      const to = typeof args.to === "string" ? args.to.trim() : "";
      if (!message.trim()) {
        return { success: false, output: "", error: "irc 'send' requires a non-empty 'message' (or 'text')." };
      }
      if (!to) {
        return { success: false, output: "", error: "irc 'send' requires a 'to' target: a running subagent id, or \"all\"." };
      }

      if (to === "all") {
        const peers = registry.running();
        let sent = 0;
        for (const peer of peers) {
          if (registry.steer(peer.id, message)) sent++;
        }
        if (sent === 0) {
          return { success: false, output: "", error: "No running subagent peers to send to." };
        }
        return { success: true, output: `Sent to ${sent} running peer(s).` };
      }

      const ok = registry.steer(to, message);
      if (!ok) {
        return { success: false, output: "", error: `No running subagent peer '${to}'.` };
      }
      return { success: true, output: `Sent to ${to}.` };
    }

    return { success: false, output: "", error: `Unknown irc action '${action}'. Use list | send.` };
  };
}
