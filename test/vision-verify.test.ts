import { test, expect, mock, afterEach } from "bun:test";
import { visionVerify } from "../src/agent/vision-verify";
import type { Message } from "../src/agent/loop";
import type { ImageAttachment } from "../src/ai/types";

// Mirrors test/goal-verifier.test.ts's established convention for mocking
// callLlm: mock.module() on the exact path vision-verify.ts imports from
// (../src/agent/loop), then call the SUT directly (visionVerify doesn't
// need a fresh dynamic import since it isn't itself re-imported here).

afterEach(() => {
  mock.restore();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fakebody")]);
const IMG: ImageAttachment = { mediaType: "image/png", data: PNG.toString("base64") };
const PRIOR_IMG: ImageAttachment = { mediaType: "image/png", data: Buffer.from("priorbody").toString("base64") };

test("visionVerify: PASS verdict parses correctly and attaches the image to the LLM call", async () => {
  let capturedMessages: Message[] = [];
  mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: Message[]) => {
      capturedMessages = messages;
      return JSON.stringify({ verdict: "PASS", detail: "The button is visibly green as required." });
    },
  }));

  const result = await visionVerify(IMG, "the button should be green");
  expect(result.verdict).toBe("PASS");
  expect(result.detail).toBe("The button is visibly green as required.");

  // The image(s) must actually reach the LLM call — this IS the contract
  // (vision verification is worthless if the pixels never leave the process).
  const userMsg = capturedMessages.find(m => m.role === "user");
  expect(userMsg?.images).toEqual([IMG]);
});

test("visionVerify: MISMATCH verdict parses correctly", async () => {
  mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ verdict: "MISMATCH", detail: "The button is red, not green." }),
  }));

  const result = await visionVerify(IMG, "the button should be green");
  expect(result.verdict).toBe("MISMATCH");
  expect(result.detail).toBe("The button is red, not green.");
});

test("visionVerify: priorImage given attaches BOTH images, prior first then current", async () => {
  let capturedMessages: Message[] = [];
  mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: Message[]) => {
      capturedMessages = messages;
      return JSON.stringify({ verdict: "PASS", detail: "Changed as expected." });
    },
  }));

  await visionVerify(IMG, "the counter should have incremented", { priorImage: PRIOR_IMG });

  const userMsg = capturedMessages.find(m => m.role === "user");
  expect(userMsg?.images).toEqual([PRIOR_IMG, IMG]);
});

test("visionVerify: empty goal short-circuits with MISMATCH and makes NO LLM call", async () => {
  let called = false;
  mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      called = true;
      return JSON.stringify({ verdict: "PASS", detail: "should never get here" });
    },
  }));

  const result = await visionVerify(IMG, "   ");
  expect(result.verdict).toBe("MISMATCH");
  expect(result.detail).toContain("non-empty 'goal'");
  expect(called).toBe(false);
});

test("visionVerify: malformed/unparseable LLM JSON response -> MISMATCH with the raw response in the message", async () => {
  mock.module("../src/agent/loop", () => ({
    callLlm: async () => "this is not json at all, just prose the model emitted",
  }));

  const result = await visionVerify(IMG, "the button should be green");
  expect(result.verdict).toBe("MISMATCH");
  expect(result.detail).toContain("unparseable response");
  expect(result.detail).toContain("this is not json at all, just prose the model emitted");
});

test("visionVerify: LLM call throwing -> MISMATCH with the error message surfaced", async () => {
  mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      throw new Error("network timeout talking to vision model");
    },
  }));

  const result = await visionVerify(IMG, "the button should be green");
  expect(result.verdict).toBe("MISMATCH");
  expect(result.detail).toContain("Vision verification failed to execute");
  expect(result.detail).toContain("network timeout talking to vision model");
});

test("visionVerify: opts.designTokens text appears verbatim in the system prompt sent to the LLM", async () => {
  let capturedMessages: Message[] = [];
  mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: Message[]) => {
      capturedMessages = messages;
      return JSON.stringify({ verdict: "PASS", detail: "matches tokens" });
    },
  }));

  const tokens = "primary color: #FF00AA; border-radius: 8px";
  await visionVerify(IMG, "the card should match the design system", { designTokens: tokens });

  const systemMsg = capturedMessages.find(m => m.role === "system");
  expect(systemMsg?.content).toContain(tokens);
});

test("visionVerify: no designTokens given -> system prompt does NOT mention design constraints", async () => {
  let capturedMessages: Message[] = [];
  mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: Message[]) => {
      capturedMessages = messages;
      return JSON.stringify({ verdict: "PASS", detail: "ok" });
    },
  }));

  await visionVerify(IMG, "the card should look fine");

  const systemMsg = capturedMessages.find(m => m.role === "system");
  expect(systemMsg?.content).not.toContain("Design constraints");
});
