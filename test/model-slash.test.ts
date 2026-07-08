import { test, expect, mock } from "bun:test";
import { runModelSlash, type ModelSlashCtx } from "../src/commands/launch/model-slash";

// `/model auto`/`/model clear` must return BEFORE touching any provider/live-model
// machinery — every ctx hook below throws if called, so a regression that makes the
// early-return fall through fails loudly instead of silently doing extra I/O.
const unreachable = (name: string) => mock(() => {
  throw new Error(`unreachable: ${name} should not be called by /model auto|clear`);
});

function baseCtx(overrides: Partial<ModelSlashCtx> = {}): ModelSlashCtx {
  return {
    sessionModel: undefined,
    sessionThinking: undefined,
    defaultModel: "claude-sonnet-4-6",
    lastPickIndex: [],
    liveModelsCache: null,
    isTTY: false,
    getLiveModels: unreachable("getLiveModels"),
    applyPickedModelWithTarget: unreachable("applyPickedModelWithTarget"),
    persistSessionModel: unreachable("persistSessionModel"),
    pickLiveProviderModel: unreachable("pickLiveProviderModel"),
    ...overrides,
  };
}

test("/model auto releases an active pin: sessionModel becomes null (caller clears to undefined)", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const result = await runModelSlash("/model auto", baseCtx({ sessionModel: "claude-opus-4-6" }));
    expect(result.sessionModel).toBeNull();
    expect(logs.join("\n")).toContain("Model pin ('claude-opus-4-6') cleared");
  } finally {
    console.log = orig;
  }
});

test("/model clear is an alias for /model auto", async () => {
  const result = await runModelSlash("/model clear", baseCtx({ sessionModel: "gpt-5.5" }));
  expect(result.sessionModel).toBeNull();
});

test("/model auto with no active pin is a safe no-op (does not touch provider/live-model machinery)", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const result = await runModelSlash("/model auto", baseCtx({ sessionModel: undefined }));
    expect(result.sessionModel).toBeUndefined();
    expect(logs.join("\n")).toContain("No model pin is active");
  } finally {
    console.log = orig;
  }
});

test("/model auto does not clobber a pending sessionThinking/lastPickIndex change from earlier in the same call", async () => {
  const result = await runModelSlash("/model auto", baseCtx({ sessionModel: "claude-opus-4-6", sessionThinking: "high" }));
  // sessionThinking is unchanged this call (no /model thinking involved) -> must NOT
  // appear in the result at all (result-object convention: absent = unchanged).
  expect(result.sessionThinking).toBeUndefined();
  expect(result.sessionModel).toBeNull();
});
