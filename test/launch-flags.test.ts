import { test, expect } from "bun:test";
import { parseFlags, gatedStdout, shouldUseOneShotTui, createInFlightAbortHarness, queuePromptInputChunk, captureLivePromptInputChunk, formatResumeHint, PASTE_START, PASTE_END, type PromptInputQueue } from "../src/commands/launch";
import { createInterface } from "node:readline/promises";
import { Readable, Writable } from "node:stream";

test("parseFlags captures GJC-style model/provider/thinking launch flags", () => {
  const flags = parseFlags(["--model", "gpt-4o-mini", "--provider=OPENAI", "--thinking", "high", "fix", "it"]);
  expect(flags.model).toBe("gpt-4o-mini");
  expect(flags.provider).toBe("openai");
  expect(flags.thinking).toBe("high");
  expect(flags.message).toBe("fix it");
});

import { fastThinkingLevelForModel, isProviderName } from "../src/commands/launch/flags";

test("isProviderName accepts every registered provider, not just the OAuth few", () => {
  // Regression: the guard used to hardcode 5 names, so `/agents <role> provider
  // groq` (and every other OpenAI-compat provider) was rejected as invalid.
  for (const p of ["anthropic", "openai", "gemini", "groq", "deepseek", "openrouter", "mistral", "xai", "kimi"]) {
    expect(isProviderName(p)).toBe(true);
  }
  expect(isProviderName("not-a-provider")).toBe(false);
  expect(isProviderName(undefined)).toBe(false);
});

test("fastThinkingLevelForModel: digit-agnostic gemini gate (multi-digit major never silently loses thinking)", () => {
  // Catalogued reasoning ids resolve via catalog thinking caps.
  expect(fastThinkingLevelForModel("gemini-2.5-flash")).toBe("low");
  // The last-resort family gate must stay digit-count agnostic: gemini-10 (prefixed)
  // and 2.6+ are reasoning-capable just like 2.5/3.x — the opus-4-8 bug, generalized.
  expect(fastThinkingLevelForModel("models/gemini-10-pro")).toBe("low");
  expect(fastThinkingLevelForModel("models/gemini-2.7-flash")).toBe("low");
  // Pre-2.5 Gemini and non-reasoning chat models get no fast-thinking default.
  expect(fastThinkingLevelForModel("gemini-2.0-flash")).toBeUndefined();
  expect(fastThinkingLevelForModel("gpt-4o")).toBeUndefined();
});

test("parseFlags captures model role tiers without consuming the prompt", () => {
  const slow = parseFlags(["--slow", "investigate", "this"]);
  expect(slow.modelRole).toBe("slow");
  expect(slow.message).toBe("investigate this");
  const plan = parseFlags(["--plan", "--max-steps=7", "draft"]);
  expect(plan.modelRole).toBe("plan");
  expect(plan.maxSteps).toBe(7);
  expect(plan.message).toBe("draft");
});

test("parseFlags records invalid provider/thinking values as launch errors", () => {
  const flags = parseFlags(["--provider", "bogus", "--thinking", "extreme", "hello"]);
  expect(flags.provider).toBeUndefined();
  expect(flags.thinking).toBeUndefined();
  expect(flags.errors).toEqual([
    "--provider must be one of: anthropic, openai, gemini, ollama",
    "--thinking must be one of: low, medium, high, xhigh",
  ]);
  expect(flags.message).toBe("hello");
});

test("parseFlags treats -- as end-of-options and omits the sentinel", () => {
  const flags = parseFlags(["--tmux", "--", "--models", "routing"]);
  expect(flags.tmux).toBe(true);
  expect(flags.message).toBe("--models routing");
  expect(flags.errors).toEqual([]);
});

test("shouldUseOneShotTui enables the live TUI for command-argument input on a TTY", () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    expect(shouldUseOneShotTui(false)).toBe(true);
    expect(shouldUseOneShotTui(true)).toBe(false);

    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(shouldUseOneShotTui(false)).toBe(false);
  } finally {
    if (desc) Object.defineProperty(process.stdout, "isTTY", desc);
  }
});

test("gatedStdout: write is a no-op while gated, forwarded when open", () => {
  const seen: string[] = [];
  const fake = new Writable({ write(c, _e, cb) { seen.push(c.toString()); cb(); } }) as any;
  fake.columns = 80; fake.rows = 24; fake.isTTY = true;
  let gated = true;
  const out = gatedStdout(fake, () => gated);

  let cbCalled = false;
  expect(out.write("hidden", () => { cbCalled = true; })).toBe(true);
  expect(seen).toEqual([]);          // swallowed while gated
  expect(cbCalled).toBe(true);       // callback still fired so readline never stalls

  gated = false;
  out.write("shown");
  expect(seen).toEqual(["shown"]);   // forwarded when open

  // geometry/props are forwarded unchanged
  expect((out as any).columns).toBe(80);
  expect((out as any).isTTY).toBe(true);
});

test("gatedStdout: readline's own prompt/echo is suppressed while gated (single-box)", async () => {
  const seen: string[] = [];
  const out = new Writable({ write(c, _e, cb) { seen.push(c.toString()); cb(); } }) as any;
  out.columns = 80; out.rows = 24; out.isTTY = true;
  const input = new Readable({ read() {} }) as any;
  input.isTTY = true; input.setRawMode = () => {};

  let armed = true; // box mode: readline output must be suppressed
  const rl = createInterface({ input, output: gatedStdout(out, () => armed) });
  const answer = rl.question("jeo> ");
  input.push("hi");
  await new Promise(r => setTimeout(r, 30));
  input.push("\n");
  expect((await answer)).toBe("hi");
  rl.close();

  const joined = seen.join("");
  expect(joined).not.toContain("jeo>"); // no duplicated raw CLI prompt line
  expect(joined).not.toContain("hi");   // no raw echo either — only our box would show it
});

const freshQueue = (): PromptInputQueue => ({ pendingLines: [], partial: "", pastedLines: [], inPaste: false });

test("captureLivePromptInputChunk keeps live-turn text in the prompt draft, not a hidden queue", () => {
  const state = freshQueue();
  expect(captureLivePromptInputChunk(state, "작업내용 확인")).toBe(true);
  expect(state).toEqual({ ...freshQueue(), partial: "작업내용 확인" });

  expect(captureLivePromptInputChunk(state, "해줘\r")).toBe(true);
  expect(state).toEqual({ ...freshQueue(), partial: "작업내용 확인해줘" });

  expect(captureLivePromptInputChunk(state, "\u001b[A")).toBe(false);
  expect(state).toEqual({ ...freshQueue(), partial: "작업내용 확인해줘" });
});

test("bracketed paste: multi-line paste splits into pastedLines + editable partial", () => {
  const state = freshQueue();
  const chunk = `${PASTE_START}/help\n/config\n테마 정리해줘\npartial tail${PASTE_END}`;
  expect(queuePromptInputChunk(state, chunk)).toBe(true);
  expect(state.pastedLines).toEqual(["/help", "/config", "테마 정리해줘"]);
  expect(state.partial).toBe("partial tail");
  expect(state.pendingLines).toEqual([]); // pasted lines NEVER fold into the prefill path
  expect(state.inPaste).toBe(false);
});

test("bracketed paste: a paste spanning chunks keeps paste mode across reads", () => {
  const state = freshQueue();
  expect(queuePromptInputChunk(state, `${PASTE_START}first li`)).toBe(true);
  expect(state.inPaste).toBe(true);
  expect(queuePromptInputChunk(state, "ne\nsecond line\n")).toBe(true);
  expect(queuePromptInputChunk(state, PASTE_END)).toBe(false); // marker only — no new content
  expect(state.inPaste).toBe(false);
  expect(state.pastedLines).toEqual(["first line", "second line"]);
  expect(state.partial).toBe("");
});

test("bracketed paste: typed noise outside markers is still rejected; CRLF normalizes", () => {
  const state = freshQueue();
  expect(queuePromptInputChunk(state, `${PASTE_START}a\r\nb\r${PASTE_END}`)).toBe(true);
  expect(state.pastedLines).toEqual(["a", "b"]);
  expect(queuePromptInputChunk(state, "\u001b[B")).toBe(false); // arrow noise after the paste
  expect(state.pastedLines).toEqual(["a", "b"]);
});

test("in-flight abort harness routes bracketed-paste chunks to the queue, never to noise/abort", () => {
  const chunks: string[] = [];
  let noise = 0;
  let aborted = false;
  let pasteActive = false;
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode() {},
    resume() {},
    on() {},
    off() {},
  };
  const harness = createInFlightAbortHarness({
    stdin,
    captureEsc: true,
    pasteActive: () => pasteActive,
    onBufferedInput: chunk => chunks.push(chunk),
    onNoise: () => { noise++; },
    onAbortNotice: () => { aborted = true; },
  });

  // Marker-carrying chunk: contains ESC but must route to the queue, not noise/abort.
  harness.handleData(`${PASTE_START}/help\n/conf`);
  expect(chunks).toEqual([`${PASTE_START}/help\n/conf`]);
  expect(noise).toBe(0);
  expect(aborted).toBe(false);

  // Mid-paste continuation (no marker): pasteActive() keeps it on the queue path.
  pasteActive = true;
  harness.handleData("ig\n");
  harness.handleData(PASTE_END); // end marker contains ESC — still queue-routed
  pasteActive = false;
  expect(chunks).toEqual([`${PASTE_START}/help\n/conf`, "ig\n", PASTE_END]);
  expect(noise).toBe(0);

  // After the paste, a lone ESC is still the abort key.
  harness.handleData("\u001b");
  expect(aborted).toBe(true);
  harness.dispose();
});
test("in-flight abort harness forwards printable live-turn input for the next prompt", () => {
  const listeners = new Set<(chunk: string | Uint8Array) => void>();
  const rawModes: boolean[] = [];
  const chunks: string[] = [];
  let noise = 0;
  const scrolls: Array<[number, boolean]> = [];
  let resumed = false;
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) { rawModes.push(raw); },
    resume() { resumed = true; },
    on(event: "data", listener: (chunk: string | Uint8Array) => void) {
      if (event === "data") listeners.add(listener);
    },
    off(event: "data", listener: (chunk: string | Uint8Array) => void) {
      if (event === "data") listeners.delete(listener);
    },
  };

  const harness = createInFlightAbortHarness({
    stdin,
    captureEsc: true,
    onBufferedInput: chunk => chunks.push(chunk),
    onNoise: () => { noise++; },
    onScrollKey: (dir, page) => { scrolls.push([dir, page]); },
  });

  expect(rawModes).toEqual([true]);
  expect(resumed).toBe(true);
  expect(listeners.size).toBe(1);

  harness.handleData("작업내용 확인해줘\r");
  expect(chunks).toEqual(["작업내용 확인해줘\r"]);

  // Arrow up/down + PageUp/PageDown now drive the Ctrl+O detail scroll, not noise.
  harness.handleData("\u001b[A");
  expect(scrolls).toEqual([[-1, false]]);
  expect(noise).toBe(0);
  harness.handleData("\u001b[B");
  harness.handleData("\u001b[5~");
  harness.handleData("\u001b[6~");
  expect(scrolls).toEqual([[-1, false], [1, false], [-1, true], [1, true]]);
  expect(noise).toBe(0);
  expect(chunks).toEqual(["작업내용 확인해줘\r"]);

  // A non-scroll escape (left-arrow) still splits printable prefix → input, rest → noise.
  harness.handleData("다음\u001b[D");
  expect(noise).toBe(1);
  expect(chunks).toEqual(["작업내용 확인해줘\r", "다음"]);

  harness.dispose();
  expect(rawModes).toEqual([true, false]);
  expect(listeners.size).toBe(0);
});

// gjc-parity (logs/gjc-tui-study analysis Gap C): the /exit path prints a resume
// pointer using the same convention as the --list handler.

test("formatResumeHint matches the --list handler convention", () => {
  expect(formatResumeHint("019eb4b5-17fe-7000-a9d5-d6c9d7923f45"))
    .toBe("Resume with: jeo launch --resume 019eb4b5-17fe-7000-a9d5-d6c9d7923f45");
});

test("parseFlags defaults maxSteps to 0 (dynamic process-driven budget, no hardcoded 100)", () => {
  const flags = parseFlags([]);
  expect(flags.maxSteps).toBe(0);
  // An explicit cap still wins (both flag spellings).
  expect(parseFlags(["--max-steps", "40"]).maxSteps).toBe(40);
  expect(parseFlags(["--max-steps=40"]).maxSteps).toBe(40);
  // Invalid values keep the dynamic default instead of inventing a cap.
  expect(parseFlags(["--max-steps=-3"]).maxSteps).toBe(0);
});
