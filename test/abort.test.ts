import { test, expect } from "bun:test";
import { ollamaAdapter } from "../src/ai/providers/ollama";
import type { CallOptions } from "../src/ai/types";

test("adapter passes signal to fetch; an aborted signal rejects the call", async () => {
  const prev = globalThis.fetch;
  let sawSignal = false;
  // Honor the abort signal like real fetch does.
  globalThis.fetch = (async (_url: any, init: any) => {
    sawSignal = init?.signal instanceof AbortSignal;
    if (init?.signal?.aborted) throw new Error("The operation was aborted");
    return Response.json({ message: { content: "ok" } });
  }) as typeof fetch;
  try {
    const ac = new AbortController();
    ac.abort();
    const opts: CallOptions = { model: "ollama/qwen2.5:0.5b", signal: ac.signal };
    await expect(
      ollamaAdapter.call([{ role: "user", content: "x" }], opts, { kind: "none", provider: "openai" })
    ).rejects.toThrow(/abort/i);
    expect(sawSignal).toBe(true);

    // Non-aborted signal → normal completion.
    const ok = await ollamaAdapter.call(
      [{ role: "user", content: "x" }],
      { model: "ollama/qwen2.5:0.5b", signal: new AbortController().signal },
      { kind: "none", provider: "openai" }
    );
    expect(ok).toBe("ok");
  } finally {
    globalThis.fetch = prev;
  }
});
