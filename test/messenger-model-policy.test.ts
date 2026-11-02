import { describe, expect, test } from "bun:test";
import { messengerUsageFallback } from "../src/messenger/model-policy";
import { parseMessengerConfig } from "../src/messenger/config";

const failure = (doneReason: string) => ({ done: false, steps: 1, doneReason });

describe("messenger model policy", () => {
  test("switches only for persistent usage limits before any completed step", () => {
    for (const reason of ["quota exceeded", "Error: Gemini usage/quota limit reached — auto-retry was skipped.", "usage limit reached"]) {
      expect(messengerUsageFallback("terra", "gemini", failure(reason))).toBe("terra");
    }
    for (const reason of ["429 rate limit", "HTTP 500", "credential rejected", "safety refusal", "payment required", "resource exhausted"]) {
      expect(messengerUsageFallback("terra", "gemini", failure(reason))).toBeUndefined();
    }
    expect(messengerUsageFallback("terra", "gemini", { ...failure("quota exceeded"), steps: 2 })).toBeUndefined();
    expect(messengerUsageFallback("terra", "gemini", { ...failure("quota exceeded"), stopClass: "guard" })).toBeUndefined();
    expect(messengerUsageFallback("terra", "gemini", { ...failure("quota exceeded"), done: true })).toBeUndefined();
    expect(messengerUsageFallback("gemini", "gemini", failure("quota exceeded"))).toBeUndefined();
  });
  test("accepts model policy only on Discord and requires a primary model", () => {
    const discord = { allowedUserIds: ["1"], model: "gemini", usageFallbackModel: "terra" };
    expect(parseMessengerConfig({ platforms: { discord } }, ".").platforms.discord?.usageFallbackModel).toBe("terra");
    expect(() => parseMessengerConfig({ platforms: { telegram: discord } }, ".")).toThrow();
    expect(() => parseMessengerConfig({ platforms: { discord: { allowedUserIds: ["1"], usageFallbackModel: "terra" } } }, ".")).toThrow();
  });
});
