import type { GrantAuthority, SandboxActor } from "./authority";

export interface SandboxControlResult {
  handled: boolean;
  output: string;
}

const USAGE = "Usage: /sandbox approve <requestId> | /sandbox deny <requestId> | /sandbox revoke | /sandbox status";

/** Only standalone, directly submitted parent controls can make human decisions. */
export async function handleSandboxControl(
  text: string,
  actor: SandboxActor,
  authority: GrantAuthority,
): Promise<SandboxControlResult> {
  // Multiline prompts, quotations, and embedded examples belong to conversation.
  if (/[\r\n]/.test(text) || !/^\/sandbox(?:[\t ]|$)/.test(text)) {
    return { handled: false, output: "" };
  }
  const parts = text.trim().split(/[\t ]+/);
  const command = parts[1];
  try {
    if ((command === "approve" || command === "deny") && parts.length === 3) {
      const request = command === "approve"
        ? await authority.approve(parts[2]!, actor)
        : await authority.reject(parts[2]!, actor);
      return { handled: true, output: `Sandbox request ${request.id}: ${request.status} (${request.mode} ${request.host}).` };
    }
    if (command === "revoke" && parts.length === 2) {
      await authority.revoke(actor);
      return { handled: true, output: "Sandbox access revoked; owned containers confirmed removed." };
    }
    if (command === "status" && parts.length === 2) {
      const state = authority.snapshot(actor);
      const pending = state.requests.filter(request => request.status === "pending");
      const details = pending.map(request => `${request.id}: ${request.mode} ${request.host}`);
      return {
        handled: true,
        output: [
          `Sandbox session ${state.sessionKey}, revision ${state.revision}: ${state.blocked ? "blocked" : "ready"}; ${state.grants.length} grants, ${pending.length} pending requests.`,
          ...details,
        ].join("\n"),
      };
    }
    return { handled: true, output: `Invalid sandbox control. ${USAGE}` };
  } catch (error) {
    return { handled: true, output: `Sandbox control error: ${error instanceof Error ? error.message : "Unknown error"}` };
  }
}
