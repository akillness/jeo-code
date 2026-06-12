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

  // On the tool dispatch, the reasoning is flushed ONCE into scrollback as a
  // jeo-ref reasoning block: the agent name on its own line, the prose below.
  out.length = 0;
  ev.onAssistant!(
    '{"reasoning":"checking the package version","tool":"read","arguments":{"filePath":"package.json"}}',
    { tool: "read", arguments: { filePath: "package.json" } },
  );
  clearInterval((tui as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  expect(strip(out.join(""))).toContain("jeo\nchecking the package version");
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
