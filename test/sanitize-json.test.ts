import { test, expect } from "bun:test";
import { sanitizeJsonStrings } from "../src/util/sanitize-json";
import { anthropicRequest } from "../src/ai/providers/anthropic";
import type { CallOptions, Message } from "../src/ai/types";
import type { Credential } from "../src/auth";

const LONE_HIGH = "\ud800"; // unpaired high surrogate
const LONE_LOW = "\udc00"; // unpaired low surrogate
const EMOJI = "\ud83d\ude00"; // 😀 — a valid, well-formed surrogate pair

test("sanitizeJsonStrings replaces a lone high surrogate value with U+FFFD", () => {
  const sanitized = sanitizeJsonStrings({ arg: `hi ${LONE_HIGH} there` }) as { arg: string };
  expect(sanitized.arg.isWellFormed()).toBe(true);
  expect(sanitized.arg).toBe(`hi ${LONE_HIGH} there`.toWellFormed());
});

test("sanitizeJsonStrings replaces a lone low surrogate value with U+FFFD", () => {
  const sanitized = sanitizeJsonStrings({ arg: `hi ${LONE_LOW} there` }) as { arg: string };
  expect(sanitized.arg.isWellFormed()).toBe(true);
  expect(sanitized.arg).toBe(`hi ${LONE_LOW} there`.toWellFormed());
});

test("sanitizeJsonStrings preserves a well-formed surrogate pair (real emoji) unchanged", () => {
  const sanitized = sanitizeJsonStrings({ arg: `look ${EMOJI} !` }) as { arg: string };
  expect(sanitized.arg).toBe(`look ${EMOJI} !`);
  expect(sanitized.arg.isWellFormed()).toBe(true);
});

test("sanitizeJsonStrings sanitizes a lone surrogate nested inside an object", () => {
  const sanitized = sanitizeJsonStrings({ outer: { inner: LONE_HIGH } }) as { outer: { inner: string } };
  expect(sanitized.outer.inner.isWellFormed()).toBe(true);
  expect(sanitized.outer.inner).not.toBe(LONE_HIGH);
});

test("sanitizeJsonStrings sanitizes a lone surrogate in an array element", () => {
  const sanitized = sanitizeJsonStrings({ list: ["fine", LONE_LOW, "also fine"] }) as { list: string[] };
  expect(sanitized.list[1]?.isWellFormed()).toBe(true);
  expect(sanitized.list[0]).toBe("fine");
  expect(sanitized.list[2]).toBe("also fine");
});

test("sanitizeJsonStrings sanitizes a lone surrogate used as an object KEY", () => {
  const key = `bad${LONE_HIGH}key`;
  const sanitized = sanitizeJsonStrings({ [key]: "value" }) as Record<string, string>;
  const sanitizedKeys = Object.keys(sanitized);
  expect(sanitizedKeys).toHaveLength(1);
  expect(sanitizedKeys[0]?.isWellFormed()).toBe(true);
  expect(sanitizedKeys[0]).not.toBe(key);
});

test("sanitizeJsonStrings does not infinite-loop on a reference cycle", () => {
  const cyclic: Record<string, unknown> = { name: LONE_HIGH };
  cyclic.self = cyclic;
  const sanitized = sanitizeJsonStrings(cyclic) as Record<string, unknown>;
  expect(sanitized.self).toBe(sanitized); // cycle preserved, not re-walked
  expect((sanitized.name as string).isWellFormed()).toBe(true);
});

test("sanitizeJsonStrings lets JSON.stringify succeed and round-trip without an unpaired escape", () => {
  const payload = { args: { note: `emoji-cut-mid-way ${LONE_HIGH}` } };
  const json = JSON.stringify(sanitizeJsonStrings(payload));
  expect(json).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?![\\]u[dD][c-fC-F])/i);
  const parsed = JSON.parse(json);
  expect(parsed.args.note.isWellFormed()).toBe(true);
});

test("anthropicRequest sanitizes a lone surrogate in tool-call arguments before stringifying the body", () => {
  const cred: Credential = { kind: "api_key", provider: "anthropic", token: "sk-test" };
  const messages: Message[] = [
    { role: "user", content: "do it" },
    {
      role: "assistant",
      content: "",
      toolUse: [{ id: "tu1", tool: "read", arguments: { path: `foo${LONE_HIGH}bar.ts` } }],
    },
    {
      role: "user",
      content: "",
      toolResults: [{ id: "tu1", output: `result with lone surrogate ${LONE_LOW}`, isError: false }],
    },
  ];
  const options = { model: "claude-sonnet-4-5" } as CallOptions;
  const { body } = anthropicRequest(messages, options, cred, false, true);

  // The body itself must be valid JSON (a literal unpaired surrogate escape would still
  // round-trip through JSON.parse, so we additionally assert the sanitized string content
  // is well-formed all the way down).
  const parsed = JSON.parse(body);
  const serialized = JSON.stringify(parsed);
  expect(serialized.isWellFormed()).toBe(true);
});
