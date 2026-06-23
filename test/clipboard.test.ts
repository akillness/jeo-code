import { test, expect } from "bun:test";
import {
  osc52Sequence,
  systemClipboardCopyCommand,
  tmuxCopyCommand,
  copyTextToClipboard,
  OSC52_MAX_BASE64,
  osc52MaxBase64,
} from "../src/tui/clipboard";
import { tmuxProfileCommands } from "../src/commands/launch/tmux";

test("osc52Sequence: base64-encodes into the OSC 52 set-clipboard escape", () => {
  const seq = osc52Sequence("hello");
  expect(seq).toBe(`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`);
  // Round-trips through base64 back to the original text.
  const b64 = seq.slice("\x1b]52;c;".length, -1);
  expect(Buffer.from(b64, "base64").toString("utf8")).toBe("hello");
});

test("osc52Sequence: UTF-8 text is encoded by bytes, not code units", () => {
  const seq = osc52Sequence("복사 😀");
  const b64 = seq.slice("\x1b]52;c;".length, -1);
  expect(Buffer.from(b64, "base64").toString("utf8")).toBe("복사 😀");
});

test("osc52Sequence: primary selection target when requested", () => {
  expect(osc52Sequence("x", { clipboard: "p" })).toBe(`\x1b]52;p;${Buffer.from("x").toString("base64")}\x07`);
});

test("osc52Sequence: tmux passthrough wraps with DCS and doubles inner ESC", () => {
  const seq = osc52Sequence("hi", { tmux: true });
  const inner = `\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`;
  expect(seq).toBe(`\x1bPtmux;${inner.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`);
  expect(seq.startsWith("\x1bPtmux;")).toBe(true);
  expect(seq.endsWith("\x1b\\")).toBe(true);
  // The single inner ESC (from the OSC introducer) is doubled inside the payload.
  expect(seq).toContain("\x1b\x1b]52;c;");
});

test("osc52Sequence: oversized payload returns empty (caller falls back to a local tool)", () => {
  // base64 inflates by ~4/3; pick a length whose base64 exceeds the cap.
  const big = "a".repeat(OSC52_MAX_BASE64); // base64 ≈ 133k > 100k
  expect(osc52Sequence(big)).toBe("");
  // A payload safely under the cap still encodes.
  expect(osc52Sequence("a".repeat(1000))).not.toBe("");
});

test("systemClipboardCopyCommand: per-platform tool resolution", () => {
  const has = (set: string[]) => (bin: string) => (set.includes(bin) ? `/usr/bin/${bin}` : null);
  expect(systemClipboardCopyCommand("darwin", () => "/usr/bin/pbcopy")).toEqual(["pbcopy"]);
  expect(systemClipboardCopyCommand("darwin", () => null)).toBeNull();
  expect(systemClipboardCopyCommand("win32", () => null)).toEqual(["clip"]);
  // Linux: Wayland wins over X11 when both present.
  expect(systemClipboardCopyCommand("linux", has(["wl-copy", "xclip"]))).toEqual(["wl-copy"]);
  expect(systemClipboardCopyCommand("linux", has(["xclip"]))).toEqual(["xclip", "-selection", "clipboard"]);
  expect(systemClipboardCopyCommand("linux", has(["xsel"]))).toEqual(["xsel", "--clipboard", "--input"]);
  expect(systemClipboardCopyCommand("linux", has([]))).toBeNull();
});

test("tmuxCopyCommand: flattens the resolved tool to a single shell string", () => {
  expect(tmuxCopyCommand("darwin", () => "/usr/bin/pbcopy")).toBe("pbcopy");
  expect(tmuxCopyCommand("linux", bin => (bin === "xclip" ? "/usr/bin/xclip" : null))).toBe("xclip -selection clipboard");
  expect(tmuxCopyCommand("linux", () => null)).toBeNull();
});

test("copyTextToClipboard: emits OSC 52 AND pipes to the local tool", async () => {
  const writes: string[] = [];
  let piped = "";
  const result = await copyTextToClipboard("payload", {
    platform: "darwin",
    which: () => "/usr/bin/pbcopy",
    insideTmux: false,
    write: s => writes.push(s),
    spawn: (cmd) => {
      expect(cmd).toEqual(["pbcopy"]);
      return {
        stdin: { write: (s: string) => { piped += s; }, end: () => {} },
        exited: Promise.resolve(0),
      };
    },
  });
  expect(result).toEqual({ osc52: true, local: true, osc52SkippedTooLarge: false });
  expect(writes).toEqual([osc52Sequence("payload", { tmux: false })]);
  expect(piped).toBe("payload");
});

test("copyTextToClipboard: tmux-wraps OSC 52 when inside tmux", async () => {
  const writes: string[] = [];
  await copyTextToClipboard("x", {
    platform: "linux",
    which: () => null, // no local tool
    insideTmux: true,
    write: s => writes.push(s),
  });
  expect(writes).toEqual([osc52Sequence("x", { tmux: true })]);
});

test("copyTextToClipboard: a failing local tool still reports the OSC 52 success", async () => {
  const result = await copyTextToClipboard("x", {
    platform: "darwin",
    which: () => "/usr/bin/pbcopy",
    insideTmux: false,
    write: () => {},
    spawn: () => ({
      stdin: { write: () => {}, end: () => {} },
      exited: Promise.resolve(1), // non-zero → local copy failed
    }),
  });
  expect(result).toEqual({ osc52: true, local: false, osc52SkippedTooLarge: false });
});

test("copyTextToClipboard: no local tool → only OSC 52 fires", async () => {
  const result = await copyTextToClipboard("x", {
    platform: "linux",
    which: () => null,
    insideTmux: false,
    write: () => {},
  });
  expect(result).toEqual({ osc52: true, local: false, osc52SkippedTooLarge: false });
});

test("tmuxProfileCommands: adds copy-command piping the selection to the system clipboard", () => {
  const cmds = tmuxProfileCommands("jeo-x", {}, {}, { platform: "darwin", which: () => "/usr/bin/pbcopy" });
  const copy = cmds.find(c => c.args.includes("copy-command"));
  expect(copy).toBeDefined();
  expect(copy!.args).toEqual(["set-option", "-t", "=jeo-x:", "copy-command", "pbcopy"]);
  // Session-scoped, never global.
  expect(copy!.args).not.toContain("-g");
});

test("tmuxProfileCommands: no clipboard tool → no copy-command (best-effort skip)", () => {
  const cmds = tmuxProfileCommands("jeo-x", {}, {}, { platform: "linux", which: () => null });
  expect(cmds.some(c => c.args.includes("copy-command"))).toBe(false);
  // Core clipboard integration is still present.
  expect(cmds.some(c => c.args.includes("set-clipboard"))).toBe(true);
});

test("tmuxProfileCommands: JEO_TMUX_PROFILE=0 drops copy-command with the other extras", () => {
  const cmds = tmuxProfileCommands("jeo-x", { JEO_TMUX_PROFILE: "0" }, {}, { platform: "darwin", which: () => "/usr/bin/pbcopy" });
  expect(cmds.some(c => c.args.includes("copy-command"))).toBe(false);
});

// ── OSC 52 size-cap configurability + reporting (deferred paste-fix #4) ────────────
test("osc52MaxBase64: JEO_OSC52_MAX overrides, <=0 disables, junk keeps the default", () => {
  expect(osc52MaxBase64({})).toBe(OSC52_MAX_BASE64);
  expect(osc52MaxBase64({ JEO_OSC52_MAX: "" })).toBe(OSC52_MAX_BASE64);
  expect(osc52MaxBase64({ JEO_OSC52_MAX: "250000" })).toBe(250_000);
  expect(osc52MaxBase64({ JEO_OSC52_MAX: "0" })).toBe(Number.POSITIVE_INFINITY);
  expect(osc52MaxBase64({ JEO_OSC52_MAX: "-1" })).toBe(Number.POSITIVE_INFINITY);
  expect(osc52MaxBase64({ JEO_OSC52_MAX: "not-a-number" })).toBe(OSC52_MAX_BASE64);
});

test("osc52Sequence: a raised maxBase64 lets an otherwise-oversized payload through", () => {
  const big = "a".repeat(OSC52_MAX_BASE64); // base64 ≈ 133k, over the default cap
  expect(osc52Sequence(big)).toBe(""); // default cap → skipped
  expect(osc52Sequence(big, { maxBase64: Number.POSITIVE_INFINITY })).not.toBe(""); // cap lifted
});

test("copyTextToClipboard: oversized payload skips OSC 52 but flags it and still copies locally", async () => {
  const writes: string[] = [];
  let piped = "";
  const big = "a".repeat(OSC52_MAX_BASE64);
  const result = await copyTextToClipboard(big, {
    platform: "darwin",
    which: () => "/usr/bin/pbcopy",
    insideTmux: false,
    env: {}, // default cap
    write: s => writes.push(s),
    spawn: () => ({ stdin: { write: (s: string) => { piped += s; }, end: () => {} }, exited: Promise.resolve(0) }),
  });
  expect(result).toEqual({ osc52: false, local: true, osc52SkippedTooLarge: true });
  expect(writes).toEqual([]); // nothing pushed to the terminal
  expect(piped).toBe(big); // local tool still got the full text
});

test("copyTextToClipboard: JEO_OSC52_MAX=0 lifts the cap so OSC 52 fires for a huge payload", async () => {
  const writes: string[] = [];
  const big = "a".repeat(OSC52_MAX_BASE64);
  const result = await copyTextToClipboard(big, {
    platform: "linux",
    which: () => null, // no local tool
    insideTmux: false,
    env: { JEO_OSC52_MAX: "0" },
    write: s => writes.push(s),
  });
  expect(result).toEqual({ osc52: true, local: false, osc52SkippedTooLarge: false });
  expect(writes).toEqual([osc52Sequence(big, { tmux: false, maxBase64: Number.POSITIVE_INFINITY })]);
});

test("copyTextToClipboard: oversized AND no local tool → both paths empty, size flag set", async () => {
  const result = await copyTextToClipboard("a".repeat(OSC52_MAX_BASE64), {
    platform: "linux",
    which: () => null,
    insideTmux: false,
    env: {},
    write: () => {},
  });
  expect(result).toEqual({ osc52: false, local: false, osc52SkippedTooLarge: true });
});