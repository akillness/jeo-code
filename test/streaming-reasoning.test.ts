import { test, expect } from "bun:test";
import { clipReasoningLines, thinkingHeader, THINKING_COMMIT_MAX_LINES } from "../src/tui/app";
import { LaunchTui } from "../src/tui/app";
import { buildToolProtocol } from "../src/commands/launch";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("buildToolProtocol invites an optional reasoning field (streamed to the user)", () => {
  const proto = buildToolProtocol(new Set(["read", "write", "bash"]));
  expect(proto).toContain('"reasoning"');
  expect(proto).toMatch(/"reasoning":\s*"<one short sentence>"/);
});

test("LaunchTui: streams the model's reasoning live, then flushes it once to scrollback", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  // Partial streaming JSON — reasoning field still unterminated mid-stream.
  out.length = 0;
  ev.onModelStream!('{"reasoning":"checking the package version');
  expect(strip(out.join(""))).toContain("checking the package version");

  // On the tool dispatch, the reasoning is flushed ONCE into scrollback grouped under a
  // single `jeo` agent-name label, the (italic dimmed) prose below it — gjc layout.
  out.length = 0;
  ev.onAssistant!(
    '{"reasoning":"checking the package version","tool":"read","arguments":{"filePath":"package.json"}}',
    { tool: "read", arguments: { filePath: "package.json" } },
  );
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  const flushed = strip(out.join(""));
  expect(flushed).toContain("checking the package version");
  // The `jeo` agent label leads the grouped thought block (boundary, not inline).
  const labelIdx = flushed.search(/(^|\n)jeo(\s|$)/m);
  expect(labelIdx).toBeGreaterThanOrEqual(0);
  expect(labelIdx).toBeLessThan(flushed.indexOf("checking the package version"));
  tui.finish("done");
});

test("LaunchTui: onModelStream with no reasoning field renders nothing extra", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  out.length = 0;
  ev.onModelStream!('{"tool":"read","arguments":{}}'); // no reasoning
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  expect(strip(out.join(""))).not.toContain("💭");
  tui.finish("done");
});

test("LaunchTui: streams native thinking live, then persists it under a jeo label on commit", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  // Native reasoning channel (Anthropic/OpenAI-style) streams plain text, not JSON.
  out.length = 0;
  ev.onReasoningStream!("weighing two approaches");
  expect(strip(out.join(""))).toContain("weighing two approaches");

  // On commit the native thought is flushed ONCE into scrollback grouped under a single
  // `jeo` agent-name label, the (italic dimmed) prose below it — gjc layout.
  out.length = 0;
  ev.onAssistant!('{"tool":"read","arguments":{}}', { tool: "read", arguments: {} });
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  const flushed = strip(out.join(""));
  expect(flushed).toContain("weighing two approaches");
  const labelIdx = flushed.search(/(^|\n)jeo(\s|$)/m);
  expect(labelIdx).toBeGreaterThanOrEqual(0);
  expect(labelIdx).toBeLessThan(flushed.indexOf("weighing two approaches"));
  tui.finish("done");
});

test("HUD shows only a STATUS while a JSON-protocol model streams; reasoning goes to the Thinking block", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  out.length = 0;
  // A model streaming its JSON tool call with a reasoning field.
  ev.onModelStream!('{"reasoning":"my secret chain of thought","tool":"read","arguments":{"filePath":"x"}}');
  const full = strip(out.join(""));
  // HUD status row carries a derived STATUS ("calling read…"), and the raw JSON is
  // never dumped to the frame.
  expect(full).toMatch(/calling read|forming the next tool/);
  expect(full).not.toContain('{"reasoning"');
  // The reasoning is surfaced in the live Thinking block (after the "Thinking" label),
  // not in the status row.
  expect(full).toContain("Thinking");
  expect(full).toContain("my secret chain of thought");
  expect(full.indexOf("my secret chain of thought")).toBeGreaterThan(full.indexOf("Thinking"));
  // The status text right before the esc hint is a status, not the reasoning prose.
  const escAt = full.search(/⟦esc⟧|\[esc\]/);
  const statusWindow = escAt > 0 ? full.slice(Math.max(0, escAt - 60), escAt) : "";
  expect(statusWindow).not.toContain("my secret chain of thought");
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  tui.finish("done");
});

test("HUD prose stream shows 'writing the reply…' status, not the reply text", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  out.length = 0;
  ev.onModelStream!("Here is the long final answer prose the model is writing out");
  const escLine = strip(out.join("")).split("\n").find(l => l.includes("⟦esc⟧") || l.includes("[esc]")) ?? "";
  expect(escLine).toContain("writing the reply");
  expect(escLine).not.toContain("long final answer prose");
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  tui.finish("done");
});

test("thinkingHeader: gjc 'thought for Ns' label with duration, omitted when unknown", () => {
  expect(thinkingHeader(4200, true)).toBe("◇ thinking · 4.2s");
  expect(thinkingHeader(0, true)).toBe("◇ thinking · 0.0s");
  expect(thinkingHeader(undefined, true)).toBe("◇ thinking");
  // ASCII fallback uses the * diamond.
  expect(thinkingHeader(1000, false)).toBe("* thinking · 1.0s");
});

test("thinkingHeader: optional modelLabel names the routed model/provider (cross-provider routing visibility)", () => {
  expect(thinkingHeader(4200, true, "gemini-2.5-pro (gemini)")).toBe("◇ thinking · gemini-2.5-pro (gemini) · 4.2s");
  expect(thinkingHeader(undefined, true, "gpt-4o-mini (openai)")).toBe("◇ thinking · gpt-4o-mini (openai)");
  // ASCII fallback + modelLabel together.
  expect(thinkingHeader(1000, false, "claude-opus-4-8 (anthropic)")).toBe("* thinking · claude-opus-4-8 (anthropic) · 1.0s");
  // Omitted modelLabel is IDENTICAL to the legacy 2-arg call (backward compat).
  expect(thinkingHeader(4200, true)).toBe(thinkingHeader(4200, true, undefined));
});

test("clipReasoningLines: collapses long traces with a (+N more lines) hint", () => {
  const short = "one\ntwo\nthree";
  expect(clipReasoningLines(short)).toBe(short); // under cap → verbatim
  const long = Array.from({ length: THINKING_COMMIT_MAX_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
  const clipped = clipReasoningLines(long).split("\n");
  expect(clipped.length).toBe(THINKING_COMMIT_MAX_LINES + 1);
  expect(clipped[THINKING_COMMIT_MAX_LINES]).toBe("… (+5 more lines)");
});

test("LaunchTui: committed thought carries a 'thinking ·' duration header (gjc parity)", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  ev.onReasoningStream!("weighing two approaches");
  out.length = 0;
  ev.onAssistant!('{"tool":"read","arguments":{}}', { tool: "read", arguments: {} });
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  const flushed = strip(out.join(""));
  // A "thinking · {model} · Ns" header sits between the jeo label and the thought prose.
  expect(flushed).toMatch(/thinking · m1 · \d+\.\d+s/);
  const headerIdx = flushed.search(/thinking · m1 · \d/);
  expect(headerIdx).toBeGreaterThanOrEqual(0);
  expect(headerIdx).toBeLessThan(flushed.indexOf("weighing two approaches"));
  tui.finish("done");
});

test("LaunchTui: a long committed thought is collapsed in scrollback", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  ev.onStep!(1);
  const longThought = Array.from({ length: THINKING_COMMIT_MAX_LINES + 8 }, (_, i) => `thought row ${i}`).join("\n");
  ev.onReasoningStream!(longThought);
  out.length = 0;
  ev.onAssistant!('{"tool":"read","arguments":{}}', { tool: "read", arguments: {} });
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  const flushed = strip(out.join(""));
  expect(flushed).toContain("… (+8 more lines)");
  // The clipped tail rows never reach scrollback.
  expect(flushed).not.toContain(`thought row ${THINKING_COMMIT_MAX_LINES + 7}`);
  tui.finish("done");
});
