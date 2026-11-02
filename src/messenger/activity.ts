import type { AgentLoopEvents, ToolInvocation } from "../agent/engine";
import type { MessengerActivityReporter } from "./types";

/**
 * Derive one-line progress from session events: the model's declared tool intent (falling back to the
 * tool name) and long-running lifecycle notices. Raw tool arguments, results and errors never surface.
 */
export function createMessengerActivityEvents(report: MessengerActivityReporter): AgentLoopEvents {
	let step = 0;
	return {
		onAssistant(_raw: string, invocation: ToolInvocation | null) {
			if (!invocation || invocation.tool === "done") return;
			step++;
			const intent =
				invocation.arguments &&
				typeof invocation.arguments.i === "string" &&
				invocation.arguments.i.trim()
					? invocation.arguments.i.trim()
					: `Using ${invocation.tool}`;
			report(`Step ${step} · ${intent}`);
		},
		onNotice(message: string) {
			if (/compact/i.test(message)) {
				report("Compacting context");
			} else if (/retry|rate limit/i.test(message)) {
				report("Retrying after a provider error");
			}
		},
	};
}
