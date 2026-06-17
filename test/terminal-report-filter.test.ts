import { test, expect } from "bun:test";
import { matchTerminalReport, stripMouseReports, queuePromptInputChunk, type PromptInputQueue } from "../src/commands/launch";

// `jeo --tmux` makes tmux probe the OUTER terminal on attach (Primary/Secondary Device
// Attributes + XTVERSION). The outer terminal's replies can land on jeo's stdin and,
// without filtering, get typed into the prompt as garbage like
// `62;4;9;22c0;276;0c>|xterm.js(6.1.0-beta.220)`. These sequences are never user input.

test("matchTerminalReport measures a DA1 reply: ESC[?…c", () => {
  const s = "\u001b[?62;4;9;22c";
  expect(matchTerminalReport(s, 0)).toBe(s.length);
});

test("matchTerminalReport measures a DA2 reply: ESC[>…c", () => {
  const s = "\u001b[>0;276;0c";
  expect(matchTerminalReport(s, 0)).toBe(s.length);
});

test("matchTerminalReport measures an XTVERSION DCS reply: ESC P … ST", () => {
  const s = "\u001bP>|xterm.js(6.1.0-beta.220)\u001b\\";
  expect(matchTerminalReport(s, 0)).toBe(s.length);
});

test("matchTerminalReport measures an OSC color reply: ESC ] 11 ; rgb … BEL", () => {
  const s = "\u001b]11;rgb:1e1e/1e1e/2e2e\u0007";
  expect(matchTerminalReport(s, 0)).toBe(s.length);
});

test("matchTerminalReport consumes an unterminated DCS tail (split across chunks)", () => {
  const s = "\u001bP>|xterm.js(6.1"; // terminator arrives in a later chunk
  expect(matchTerminalReport(s, 0)).toBe(s.length);
});

test("matchTerminalReport returns 0 for non-report input (incl. real keys)", () => {
  expect(matchTerminalReport("hello", 0)).toBe(0);
  expect(matchTerminalReport("\u001b[A", 0)).toBe(0); // cursor up — not a private reply
  expect(matchTerminalReport("\u001b[1;5C", 0)).toBe(0); // ctrl+right — params start with a digit, not ?/>/=
});

test("stripMouseReports also removes the leaked DA/XTVERSION garbage, keeping real text", () => {
  // The exact reported leak, with surrounding typed text.
  const leak = "\u001b[?62;4;9;22c\u001b[>0;276;0c\u001bP>|xterm.js(6.1.0-beta.220)\u001b\\";
  expect(stripMouseReports(`ab${leak}cd`)).toBe("abcd");
  expect(stripMouseReports("\u001b]11;rgb:00/00/00\u0007hi")).toBe("hi");
});

test("live-turn drain (queuePromptInputChunk) never injects terminal-report bytes", () => {
  const q: PromptInputQueue = { pendingLines: [], partial: "", pastedLines: [], inPaste: false };
  queuePromptInputChunk(q, "hi\u001b[?62;4;9;22c\u001b[>0;276;0cthere");
  expect(q.partial).toBe("hithere");
});
