import type { AgentLoopEvents, ToolInvocation } from "../agent/engine";
import type { MessengerActivityReporter } from "./types";


/** Report only fixed status text and validated tool names, never model-authored content. */
export function createMessengerActivityEvents(report: MessengerActivityReporter): AgentLoopEvents {
	let step = 0;
	return {
		onStep(current) {
			step = current;
			report(`Step ${step} · Thinking`);
		},
		onAssistant(_raw: string, invocation: ToolInvocation | null) {
			if (!invocation || invocation.tool === "done") return;
			const tool = /^[a-zA-Z0-9_-]{1,40}$/.test(invocation.tool) ? invocation.tool : "tool";
			report(`Step ${step} · Running ${tool}`);
		},
		onToolResult(tool, success) {
			const name = /^[a-zA-Z0-9_-]{1,40}$/.test(tool) ? tool : "tool";
			report(`Step ${step} · ${name} ${success ? "finished" : "failed"}`);
		},
		onNotice(message: string) {
			if (/compact/i.test(message)) report("Compacting context");
			else if (/retry|rate limit/i.test(message)) report("Retrying after a provider error");
		},
	};
}
