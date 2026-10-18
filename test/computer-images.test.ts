import { test, expect, mock } from "bun:test";
import type { Message, ImageAttachment } from "../src/ai/types";
import { buildAnthropicMessages } from "../src/ai/providers/anthropic";
import { buildResponsesInput } from "../src/ai/providers/openai-responses";
import * as loop from "../src/agent/loop";

const image: ImageAttachment = { mediaType: "image/png", data: "c2NyZWVu" };

function replayHistory(provider: "openai" | "anthropic", model: string): Message[] {
  return [
    { role: "assistant", content: "capture", toolUse: [{ id: "shot", tool: "computer", arguments: { action: "screenshot" } }],
      reasoningArtifacts: [{ provider, model, signature: "signature", text: "inspect", itemId: "rs_1", encrypted: "encrypted" }] },
    { role: "user", content: "Screenshot captured.", images: [image], toolResults: [{ id: "shot", output: "Screenshot captured.", isError: false }] },
  ];
}

test("computer screenshot survives Anthropic native tool replay and plain fallback", () => {
  const history = replayHistory("anthropic", "claude-3-5-sonnet");
  for (const thinking of [true, false]) {
    const wire = buildAnthropicMessages(history, "claude-3-5-sonnet", thinking);
    expect(wire[1]!.content).toContainEqual({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
  }
});

test("computer screenshot survives Responses native tool replay and plain fallback", () => {
  const history = replayHistory("openai", "openai/gpt-5");
  for (const strip of [true, false]) {
    const wire = buildResponsesInput(history, "openai/gpt-5", strip);
    const imageTurn = wire.find(item => Array.isArray(item.content) && item.content.some((part: any) => part.type === "input_image"));
    expect(imageTurn?.role).toBe("user");
    expect(imageTurn?.content).toContainEqual({ type: "input_image", image_url: `data:image/png;base64,${image.data}` });
  }
});

test("engine forwards screenshot images to the next model turn without base64 text spill", async () => {
  const realLoop = { ...loop };
  let turn = 0;
  const history: Message[] = [{ role: "system", content: "test" }];
  mock.module("../src/agent/loop", () => ({ ...realLoop, callLlm: async () => {
    if (++turn === 1) return JSON.stringify({ tool: "computer", arguments: { action: "screenshot" } });
    const result = history.find(m => m.images?.length);
    expect(result?.images).toEqual([image]);
    expect(result?.content).not.toContain(image.data);
    return JSON.stringify({ tool: "done", arguments: { reason: "observed image" } });
  } }));
  try {
    const { runAgentLoop } = await import("../src/agent/engine");
    await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 3,
      tools: { computer: async () => ({ success: true, output: "Screenshot captured.", images: [image] }) } });
    expect(turn).toBe(2);
    expect(history.find(m => m.images?.length)?.images).toEqual([image]);
  } finally { mock.module("../src/agent/loop", () => realLoop); }
});
