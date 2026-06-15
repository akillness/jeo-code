import { test, expect } from "bun:test";
import { isStandaloneBackspace } from "../src/commands/launch";

// The input filter swallows a standalone Backspace (DEL 0x7f / BS 0x08) when the line
// buffer is empty, so a no-op backspace can't trip some Bun readline builds into a
// spurious `close` (which the REPL would treat as a hard exit — "Backspace quits jeo").

test("isStandaloneBackspace matches a lone DEL/BS keystroke", () => {
  expect(isStandaloneBackspace("\x7f")).toBe(true);  // DEL
  expect(isStandaloneBackspace("\b")).toBe(true);    // BS (0x08)
  expect(isStandaloneBackspace("\x7f\x7f")).toBe(true); // key-repeat / held backspace
});

test("isStandaloneBackspace ignores chunks that carry real input", () => {
  expect(isStandaloneBackspace("")).toBe(false);       // empty chunk
  expect(isStandaloneBackspace("a")).toBe(false);      // a character
  expect(isStandaloneBackspace("a\x7f")).toBe(false);  // type-then-delete: forward it
  expect(isStandaloneBackspace("\x7fa")).toBe(false);  // delete-then-type
  expect(isStandaloneBackspace("\r")).toBe(false);     // Enter
  expect(isStandaloneBackspace("\x1b[200~")).toBe(false); // paste start
  expect(isStandaloneBackspace("\x03")).toBe(false);   // Ctrl-C must NOT be swallowed here
});
