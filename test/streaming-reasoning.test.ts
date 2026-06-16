import { test, expect } from "bun:test";
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
