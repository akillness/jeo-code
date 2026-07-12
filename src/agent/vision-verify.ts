/**
 * Vision self-check loop (maker -> renderer -> vision-verifier -> caller), the
 * missing half of the browser tool's screenshot capability: `tab.screenshot()`
 * already captures pixels, but nothing previously fed those bytes to a vision-
 * capable model for judgment — the tool's own protocol line told the calling
 * agent to "prefer observe over screenshot", so a screenshot was a human-only
 * debug artifact (a temp file path), never an automated pass/fail signal.
 *
 * `visionVerify` closes that loop: render -> screenshot -> attach as an
 * ImageAttachment -> ask an INDEPENDENT model call (never the maker's own turn)
 * to compare the image against a plain-language goal, returning a structured
 * PASS/MISMATCH verdict plus a concrete diff on mismatch. Mirrors
 * `goal-verifier.ts`'s shape (independent judge, JSON verdict, graceful parse
 * failure -> conservative MISMATCH) so the two verifier call sites stay
 * consistent for anyone reading either file.
 */
import { callLlm } from "./loop";
import { tryExtractJsonObject } from "./json";
import type { ImageAttachment } from "../ai/types";

export interface VisionVerdict {
  verdict: "PASS" | "MISMATCH";
  detail: string;
}

/**
 * Compare a screenshot against a plain-language goal (optionally scoped by
 * design tokens/constraints) using a vision-capable model. `priorImage`, when
 * given, is attached alongside `image` so the verifier can also judge "what
 * changed" (e.g. confirming a specific element updated, not just that SOME
 * state now matches the goal).
 */
export async function visionVerify(
  image: ImageAttachment,
  goal: string,
  opts: { model?: string; designTokens?: string; priorImage?: ImageAttachment } = {},
): Promise<VisionVerdict> {
  const goalTrimmed = goal.trim();
  if (!goalTrimmed) {
    return { verdict: "MISMATCH", detail: "vision-verify requires a non-empty 'goal' to compare the screenshot against." };
  }

  const systemPrompt = `You are an independent Vision Verifier. You are shown a screenshot and a goal it should satisfy. Judge ONLY what is visible in the image(s) against the goal — you have no access to the code or reasoning that produced it.

Goal:
"${goalTrimmed}"
${opts.designTokens ? `\nDesign constraints/tokens to check against:\n${opts.designTokens}\n` : ""}
${opts.priorImage ? "\nTwo images are attached: the FIRST is the prior state, the SECOND is the current state. Judge whether the current state now satisfies the goal (the prior image is context for what changed, not itself the thing being judged).\n" : "\nOne image is attached: the current state to judge against the goal.\n"}
Verdict discipline:
- PASS only when the visible content clearly satisfies the goal as written. Do not reframe or narrow the goal to fit what you see.
- On MISMATCH, describe the concrete, visible gap (what is missing, wrong, or different from the goal) precisely enough that another agent could act on it without re-looking at the image.
- Judge only what is visibly present. Do not assume off-screen or unrendered content satisfies the goal.

Respond with ONLY a JSON object: {"verdict": "PASS" | "MISMATCH", "detail": "<one paragraph, concrete>"}. No markdown, no code fences, no other text.`;

  const images = opts.priorImage ? [opts.priorImage, image] : [image];

  try {
    const response = await callLlm(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Judge the attached screenshot(s) against the goal above.", images },
      ],
      { model: opts.model, jsonMode: true, maxTokens: 600, reasoningEffort: "none" },
    );

    const parsed = tryExtractJsonObject<{ verdict?: unknown; detail?: unknown }>(response);
    if (parsed && (parsed.verdict === "PASS" || parsed.verdict === "MISMATCH") && typeof parsed.detail === "string") {
      return { verdict: parsed.verdict, detail: parsed.detail };
    }
    return { verdict: "MISMATCH", detail: `Vision verifier returned an unparseable response: ${response.slice(0, 300)}` };
  } catch (err) {
    return { verdict: "MISMATCH", detail: `Vision verification failed to execute: ${(err as Error).message}` };
  }
}
