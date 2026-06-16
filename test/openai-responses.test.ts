import { test, expect } from "bun:test";
import {
  codexResponsesRequest,
  parseResponsesEvent,
  extractChatgptAccountId,
  CODEX_RESPONSES_URL,
} from "../src/ai/providers/openai-responses";
import type { Credential } from "../src/auth";
import type { CallOptions, Message } from "../src/ai/types";

// A minimal ChatGPT/Codex-style JWT: header.payload.signature with the account-id claim.
function fakeJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("extractChatgptAccountId pulls the account id from the JWT auth claim", () => {
  expect(extractChatgptAccountId(fakeJwt("acct-123"))).toBe("acct-123");
  expect(extractChatgptAccountId("not-a-jwt")).toBeUndefined();
  expect(extractChatgptAccountId("a.b")).toBeUndefined(); // payload not JSON
});

test("codexResponsesRequest targets the Codex backend with OAuth + account-id headers", () => {
  const cred: Credential = { kind: "oauth", provider: "openai", token: fakeJwt("acct-xyz") };
  const messages: Message[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "prev" },
  ];
  const options = { model: "openai/gpt-5.5" } as CallOptions;
  const { url, headers, body } = codexResponsesRequest(messages, options, cred);

  expect(url).toBe(CODEX_RESPONSES_URL);
  expect(headers.authorization).toBe(`Bearer ${cred.token}`);
  expect(headers["chatgpt-account-id"]).toBe("acct-xyz");
  expect(headers["OpenAI-Beta"]).toBe("responses=experimental");

  const payload = JSON.parse(body);
  expect(payload.model).toBe("gpt-5.5"); // openai/ prefix stripped
  expect(payload.instructions).toBe("SYS"); // system → instructions
  expect(payload.stream).toBe(true); // Codex backend only streams
  // System message excluded; user → input_text, assistant → output_text.
  expect(payload.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
    { role: "assistant", content: [{ type: "output_text", text: "prev" }] },
  ]);
});

test("parseResponsesEvent extracts deltas, usage, and errors", () => {
  expect(parseResponsesEvent(JSON.stringify({ type: "response.output_text.delta", delta: "PO" }))).toEqual({ delta: "PO" });
  expect(
    parseResponsesEvent(JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 19, output_tokens: 17 } } })),
  ).toEqual({ usage: { inputTokens: 19, outputTokens: 17 } });
  expect(parseResponsesEvent(JSON.stringify({ type: "response.failed", response: { error: { message: "boom" } } }))).toEqual({ error: "boom" });
  expect(parseResponsesEvent(JSON.stringify({ type: "response.created" }))).toEqual({}); // ignored
  expect(parseResponsesEvent("not json")).toEqual({}); // tolerant
});

test("parseResponsesEvent surfaces reasoning-summary deltas (live thinking)", () => {
  // Documented Responses event.
  expect(parseResponsesEvent(JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "let me" })))
    .toEqual({ reasoningDelta: "let me" });
  // Codex backend's raw reasoning variant.
  expect(parseResponsesEvent(JSON.stringify({ type: "response.reasoning_text.delta", delta: " think" })))
    .toEqual({ reasoningDelta: " think" });
  // A reasoning delta is NOT mistaken for output text, and vice-versa.
  expect(parseResponsesEvent(JSON.stringify({ type: "response.output_text.delta", delta: "answer" })))
    .toEqual({ delta: "answer" });
  // Non-delta reasoning events (part.added/done) are ignored, not surfaced as text.
  expect(parseResponsesEvent(JSON.stringify({ type: "response.reasoning_summary_part.added" }))).toEqual({});
});

test("codexResponsesRequest asks for streamed reasoning summaries when an effort is set", () => {
  const cred: Credential = { kind: "oauth", token: "t", provider: "openai" } as unknown as Credential;
  const opts = { model: "openai/gpt-5", reasoningEffort: "medium" } as unknown as CallOptions;
  const { body } = codexResponsesRequest([{ role: "user", content: "hi" }] as Message[], opts, cred);
  expect(JSON.parse(body).reasoning).toEqual({ effort: "medium", summary: "auto" });
});
