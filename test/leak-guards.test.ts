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

test("LaunchTui: process 'exit' listener does not accumulate across many turns", () => {
  // The exit-safety net (armExitSafety) registers a single process.once("exit")
  // handler guarded by a module-level flag. A regression that drops the guard would
  // add one handler PER turn — a real long-term leak on the global process object in
  // a long-lived REPL. Lock the guard in: the count must never grow across turns.
  const before = process.listenerCount("exit");
  const realRender = Renderer.prototype.render;
  (Renderer.prototype as unknown as { render: (f: string[]) => void }).render = function () {};
  try {
    for (let i = 0; i < 25; i++) {
      const out: string[] = [];
      const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
      tui.start();
      tui.finish("done");
      expect(process.listenerCount("exit")).toBeLessThanOrEqual(before + 1);
    }
    // After the first turn arms the net, the count is fixed for the rest of the run.
    const settled = process.listenerCount("exit");
    for (let i = 0; i < 10; i++) {
      const out: string[] = [];
      const tui = new LaunchTui({ model: "m1", tty: true, write: s => out.push(s) });
      tui.start();
      tui.finish("done");
    }
    expect(process.listenerCount("exit")).toBe(settled);
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

test("LaunchTui: finish('done') clears stream, liveBlockWrapCaches, subagentSlotMeta, history caches, cachedArt, and forgeSummaries", () => {
  const origAlt = process.env.JEO_TUI_ALT_SCREEN;
  process.env.JEO_TUI_ALT_SCREEN = "1";
  const realRender = Renderer.prototype.render;
  Renderer.prototype.render = function () {};
  const tui = new LaunchTui({ model: "m1", tty: true, write: () => {} });
  try {
    tui.start();
    const ev = tui.events();
    ev.onStep!(1);
    ev.onReasoningStream!("thinking through a long block");
    ev.onAssistant!("", { tool: "bash", arguments: { command: "echo ok" } });
    ev.onToolProgress!("bash", "streaming output");
    ev.onToolResult!("bash", true, "ok");
    tui.onSubagentEvent({ kind: "start", role: "executor", runId: "clean-1", detail: "work" });
    tui.showDetail(["history line 1", "history line 2"]);
    // Trigger renderHistoryPanel and draw so cachedHistoryLines / cachedWrappedHistory / cachedArt populate.
    const renderHistory = Reflect.get(tui, "renderHistoryPanel");
    if (typeof renderHistory === "function") renderHistory.call(tui, 60, 12);
    const draw = Reflect.get(tui, "draw");
    if (typeof draw === "function") draw.call(tui);

    tui.finish("done");

    const stream = Reflect.get(tui, "stream");
    expect(stream && typeof stream === "object" && "render" in stream && typeof stream.render === "function" ? stream.render(80) : null).toEqual([]);

    const liveBlockWrapCaches = Reflect.get(tui, "liveBlockWrapCaches");
    expect(liveBlockWrapCaches instanceof Map).toBe(true);
    if (liveBlockWrapCaches instanceof Map) expect(liveBlockWrapCaches.size).toBe(0);

    const subagentSlotMeta = Reflect.get(tui, "subagentSlotMeta");
    expect(subagentSlotMeta instanceof Map).toBe(true);
    if (subagentSlotMeta instanceof Map) expect(subagentSlotMeta.size).toBe(0);

    expect(Reflect.get(tui, "historyLines")).toBeNull();
    expect(Reflect.get(tui, "cachedWrappedHistory")).toBeNull();
    expect(Reflect.get(tui, "cachedHistoryLines")).toBeNull();

    const cachedArt = Reflect.get(tui, "cachedArt");
    expect(Array.isArray(cachedArt)).toBe(true);
    if (Array.isArray(cachedArt)) expect(cachedArt.length).toBe(0);

    const forgeSummaries = Reflect.get(tui, "forgeSummaries");
    expect(Array.isArray(forgeSummaries)).toBe(true);
    if (Array.isArray(forgeSummaries)) expect(forgeSummaries.length).toBe(0);
  } finally {
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    Renderer.prototype.render = realRender;
    if (origAlt === undefined) delete process.env.JEO_TUI_ALT_SCREEN;
    else process.env.JEO_TUI_ALT_SCREEN = origAlt;
  }
});

test("LaunchTui: flooding >64 distinct unclosed runIds bounds slot maps and subagentLiveOrder to <=64", () => {
  const tui = new LaunchTui({ model: "m1", tty: false, write: () => {} });
  try {
    tui.start();
    for (let i = 0; i < 100; i++) {
      tui.onSubagentEvent({
        kind: "start",
        role: "executor",
        runId: `flood-run-${i}`,
        detachedId: `flood-det-${i}`,
        detail: `unclosed task ${i}`,
      });
    }

    const liveSlots = Reflect.get(tui, "subagentLiveSlots");
    const recordedSlots = Reflect.get(tui, "subagentRecordedSlots");
    const detachedSlots = Reflect.get(tui, "detachedSubagentSlots");
    const slotMeta = Reflect.get(tui, "subagentSlotMeta");
    const liveOrder = Reflect.get(tui, "subagentLiveOrder");

    expect(liveSlots instanceof Map).toBe(true);
    expect(recordedSlots instanceof Map).toBe(true);
    expect(detachedSlots instanceof Set).toBe(true);
    expect(slotMeta instanceof Map).toBe(true);
    expect(Array.isArray(liveOrder)).toBe(true);

    if (liveSlots instanceof Map) expect(liveSlots.size).toBeLessThanOrEqual(64);
    if (recordedSlots instanceof Map) expect(recordedSlots.size).toBeLessThanOrEqual(64);
    if (detachedSlots instanceof Set) expect(detachedSlots.size).toBeLessThanOrEqual(64);
    if (slotMeta instanceof Map) expect(slotMeta.size).toBeLessThanOrEqual(64);
    if (Array.isArray(liveOrder)) expect(liveOrder.length).toBeLessThanOrEqual(64);
  } finally {
    const timer = Reflect.get(tui, "timer");
    if (timer) clearInterval(timer as NodeJS.Timeout);
    tui.finish("done");
  }
});
