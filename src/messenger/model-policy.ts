import { isUsageLimitError } from "../util/retry";

/** Only retry a worker's first failed step, before any tools could have executed. */
export function messengerUsageFallback(fallback: string | undefined, current: string, result: { done: boolean; steps: number; stopClass?: unknown; doneReason?: string }): string | undefined {
	if (!fallback || fallback === current || result.done || result.stopClass || result.steps !== 1) return undefined;
	const reason = result.doneReason ?? "";
	return isUsageLimitError(reason) || /usage\/quota limit reached/i.test(reason) ? fallback : undefined;
}
