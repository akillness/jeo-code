import { test, expect } from "bun:test";
import { LaunchTui } from "../src/tui/app";
import { StreamRegion } from "../src/tui/components/stream";
import { ToolList } from "../src/tui/components/tool-list";
import { Renderer } from "../src/tui/renderer";

test("LaunchTui: sequential turns and resize listener cleanup (including error and double-finish paths)", () => {
  const before = process.stdout.listenerCount("resize");
  const realRender = Renderer.prototype.render;
  (Renderer.prototype as unknown as { render: (f: string[]) => void }).render = function () {};

  try {
    for (let i = 0; i < 25; i++) {
      const out: string[] = [];
      const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
      tui.start();

      // Normal path
      if (i % 3 === 0) {
        tui.finish("done");
      }
      // Error path (finish called from a catch block)
      else if (i % 3 === 1) {
        try {
          throw new Error("simulated turn error");
        } catch (err) {
          tui.finish("! error");
        }
      }
      // Double finish path
      else {
        tui.finish("done");
        tui.finish("done again");
      }

      // Assert resize listener returns to baseline after each finish
      expect(process.stdout.listenerCount("resize")).toBe(before);
    }
  } finally {
    Renderer.prototype.render = realRender;
  }
});

test("LaunchTui: no live timers leak after finish", async () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
  tui.start();
  
  tui.finish("done");
  
  // Advance time: check if the timer continues to write/draw after finish
  const initialLen = out.length;
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(out.length).toBe(initialLen); // write sink receives nothing new
});

test("StreamRegion: never exceeds cap of 500 when appending 10k lines", () => {
  const stream = new StreamRegion(500);
  for (let i = 0; i < 10000; i++) {
    stream.append(`line ${i}\n`);
  }
  const output = stream.render(80);
  expect(output.length).toBeLessThanOrEqual(500);
});

test("ToolList: bounded after 10k start/finish", () => {
  const list = new ToolList(500);
  for (let i = 0; i < 10000; i++) {
    const idx = list.start(`tool-${i}`);
    list.finish(idx, true);
  }
  const snapshot = list.snapshot();
  expect(snapshot.length).toBeLessThanOrEqual(500);
  const stats = list.stats();
  expect(stats.total).toBe(10000);
  expect(list.render().length).toBeLessThanOrEqual(501); // +1 for earlier hidden count
});

test("LaunchTui: forgeSummaries bounded - drive events with 100 tool invocations", () => {
  const out: string[] = [];
  const tui = new LaunchTui({ model: "m1", write: s => out.push(s) });
  tui.start();
  const ev = tui.events();
  
  for (let i = 0; i < 100; i++) {
    ev.onStep!(i + 1);
    ev.onAssistant!("", { tool: `heavy-tool-${i}`, arguments: { arg: i } });
    ev.onToolResult!(`heavy-tool-${i}`, true, `result-${i}`);
  }
  
  const summaries = (tui as any).forgeSummaries;
  expect(summaries.length).toBeLessThanOrEqual(8);
  
  tui.finish("done");
});
