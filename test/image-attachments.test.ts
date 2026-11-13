import { test, expect } from "bun:test";
import { anthropicPayload } from "../src/ai/providers/anthropic";
import { openaiRequest } from "../src/ai/providers/openai";
import { codexResponsesRequest } from "../src/ai/providers/openai-responses";
import { geminiRequest } from "../src/ai/providers/gemini";
import { looksLikePng, attachmentFromBytes } from "../src/util/clipboard-image";
import { estimateMessageTokens } from "../src/agent/compaction";
import type { Message } from "../src/ai/types";
import { CompactPasteStore } from "../src/commands/launch/input";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fakebody")]);
const IMG = { mediaType: "image/png", data: PNG.toString("base64") };

const withImage: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "what is in [image #1]?", images: [IMG] },
];
const textOnly: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hello" },
];

test("anthropic: image attachments become content blocks; text-only stays a plain string", () => {
  const payload = JSON.parse(anthropicPayload(withImage, { model: "claude-sonnet-4-5" } as any, false, true));
  const content = payload.messages[0].content;
  expect(Array.isArray(content)).toBe(true);
  expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: IMG.data } });
  // The image message is the LAST message here, so its tail text block also
  // carries the conversation prompt-cache breakpoint (see perf-fixes.test.ts).
  expect(content[1]).toMatchObject({ type: "text", text: "what is in [image #1]?" });

  const plain = JSON.parse(anthropicPayload(textOnly, { model: "claude-sonnet-4-5" } as any, false, true));
  // Text-only LAST message becomes a single cached text block; the text is intact.
  expect(plain.messages[0].content[0]).toMatchObject({ type: "text", text: "hello" });
});

test("openai: image attachments use content parts with a data URL; text-only stays a string", () => {
  const cred = { kind: "api_key" as const, provider: "openai" as const, token: "k" };
  const { body } = openaiRequest(withImage, { model: "gpt-4o" } as any, cred, false);
  const msg = JSON.parse(body).messages.find((m: any) => m.role === "user");
  expect(msg.content[0]).toEqual({ type: "text", text: "what is in [image #1]?" });
  expect(msg.content[1].type).toBe("image_url");
  expect(msg.content[1].image_url.url).toBe(`data:image/png;base64,${IMG.data}`);

  const plain = JSON.parse(openaiRequest(textOnly, { model: "gpt-4o" } as any, cred, false).body);
  expect(plain.messages.find((m: any) => m.role === "user").content).toBe("hello");
});

test("codex responses: user images map to input_image data URLs; assistant turns never carry images", () => {
  const cred = { kind: "oauth" as const, provider: "openai" as const, token: "t" };
  const history: Message[] = [...withImage, { role: "assistant", content: "a reply", images: [IMG] }];
  const { body } = codexResponsesRequest(history, { model: "gpt-5.5" } as any, cred);
  const input = JSON.parse(body).input;
  expect(input[0].content[0]).toEqual({ type: "input_text", text: "what is in [image #1]?" });
  expect(input[0].content[1]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${IMG.data}` });
  // Assistant history stays text-only even if an images field sneaks in.
  expect(input[1].content).toHaveLength(1);
  expect(input[1].content[0].type).toBe("output_text");
});

test("gemini: image attachments become inlineData parts before the text part", () => {
  const cred = { kind: "api_key" as const, provider: "gemini" as const, token: "k" };
  const { body } = geminiRequest(withImage, { model: "gemini-2.5-flash" } as any, cred, "generateContent");
  const parts = JSON.parse(body).contents[0].parts;
  expect(parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: IMG.data } });
  expect(parts[1]).toEqual({ text: "what is in [image #1]?" });
});

test("clipboard-image: PNG magic detection and attachment building", () => {
  expect(looksLikePng(PNG)).toBe(true);
  expect(looksLikePng(Buffer.from("not a png at all"))).toBe(false);
  const att = attachmentFromBytes(PNG);
  expect(att).toEqual({ mediaType: "image/png", data: PNG.toString("base64") });
  expect(attachmentFromBytes(Buffer.from("nope"))).toBeNull();
});

test("compaction: image attachments add a per-image token estimate", () => {
  const plain = estimateMessageTokens({ role: "user", content: "hi" });
  const withOne = estimateMessageTokens({ role: "user", content: "hi", images: [IMG] });
  const withTwo = estimateMessageTokens({ role: "user", content: "hi", images: [IMG, IMG] });
  expect(withOne - plain).toBe(1100);
  expect(withTwo - plain).toBe(2200);
});

for (const { name, serialize } of [
  { name: "Anthropic", serialize: (messages: Message[]) => anthropicPayload(messages, { model: "claude-sonnet-4-5" }, false, true) },
  { name: "OpenAI", serialize: (messages: Message[]) => openaiRequest(messages, { model: "gpt-4o" }, { kind: "api_key", provider: "openai", token: "local-test" }, false).body },
  { name: "Codex", serialize: (messages: Message[]) => codexResponsesRequest(messages, { model: "gpt-5.5" }, { kind: "oauth", provider: "openai", token: "local-test" }).body },
  { name: "Gemini", serialize: (messages: Message[]) => geminiRequest(messages, { model: "gemini-2.5-flash" }, { kind: "api_key", provider: "gemini", token: "local-test" }, "generateContent").body },
]) {
  test(`${name}: model requests preserve canonical input and images but exclude editor display metadata`, () => {
    const store = new CompactPasteStore();
    const marker = store.store("private canonical\r\n한🙂\t$&");
    const display = `before ${marker} after`;
    const canonical = store.expand(display);
    const message: Message = { role: "user", content: canonical, images: [IMG], inputDisplay: store.snapshot(display, canonical) };
    const request = serialize([message]);
    expect(request).toContain(JSON.stringify(canonical));
    expect(request).toContain(IMG.data);
    expect(request).not.toContain(marker);
    expect(request).not.toContain('"inputDisplay"');
  });
}
