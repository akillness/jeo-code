import { test, expect } from "bun:test";
import {
  filterPromptInputChunk,
  ROW_HOME_SEQS,
  ROW_END_SEQS,
  type PromptKeyFilterRl,
  type PromptKeyFilterState,
} from "../src/commands/launch/input";

// macOS Cmd+Left/Right and bare Home/End should reposition the caret to the START/END of
// the CURRENT VISUAL ROW of a multi-row draft (Shift+Enter breaks), not the whole buffer —
// unlike the OLD Cmd+Left/Right → Ctrl+A/Ctrl+E rewrite in CURSOR_COMBO_REWRITES, which is
// whole-buffer only. This is checked BEFORE `matchCursorCombo` in the filter loop so it wins
// whenever `rl` (the live readline view) is available.

const env = { loneLfShiftEnter: false, slashMatchCount: 0, historyPanelOpen: false, columns: 80 };

function freshState(): PromptKeyFilterState {
  return { inPaste: false };
}

test("Cmd+Left (CSI 1;9D) jumps to the start of the current row on a multi-row draft", () => {
  // Draft is "abc<sentinel>defgh<sentinel>ij"; readline's `line` uses the sentinel, not "\n".
  const line = "abc\uE000defgh\uE000ij";
  const rl: PromptKeyFilterRl = { line, cursor: 6 }; // caret inside "defgh" (offset 6 = "de|fgh")
  const result = filterPromptInputChunk(ROW_HOME_SEQS[0]!, rl, env, freshState());
  expect(result.out).toBe(""); // the combo is consumed, nothing forwarded to readline as text
  expect(result.drop).toBe(false);
  expect(rl.cursor).toBe(4); // start of the "defgh" row
});

test("Cmd+Right (CSI 1;9C) jumps to the end of the current row on a multi-row draft", () => {
  const line = "abc\uE000defgh\uE000ij";
  const rl: PromptKeyFilterRl = { line, cursor: 6 };
  filterPromptInputChunk(ROW_END_SEQS[0]!, rl, env, freshState());
  expect(rl.cursor).toBe(9); // end of the "defgh" row
});

test("bare Home/End (xterm CSI H / CSI F) get the same row-aware treatment", () => {
  const line = "abc\uE000defgh\uE000ij";
  const rlHome: PromptKeyFilterRl = { line, cursor: 6 };
  filterPromptInputChunk("\u001b[H", rlHome, env, freshState());
  expect(rlHome.cursor).toBe(4);

  const rlEnd: PromptKeyFilterRl = { line, cursor: 6 };
  filterPromptInputChunk("\u001b[F", rlEnd, env, freshState());
  expect(rlEnd.cursor).toBe(9);
});

test("row-aware Home/End degenerates to whole-buffer start/end on a single-row draft", () => {
  const line = "hello world";
  const rlHome: PromptKeyFilterRl = { line, cursor: 5 };
  filterPromptInputChunk(ROW_HOME_SEQS[0]!, rlHome, env, freshState());
  expect(rlHome.cursor).toBe(0);

  const rlEnd: PromptKeyFilterRl = { line, cursor: 5 };
  filterPromptInputChunk(ROW_END_SEQS[0]!, rlEnd, env, freshState());
  expect(rlEnd.cursor).toBe(line.length);
});

test("without an `rl` view, the sequence falls through instead of being silently eaten", () => {
  // No readline to compute a caret against — the filter must not swallow the bytes;
  // vt220 Home (`\u001b[1~`)/End (`\u001b[4~`) still land somewhere (old combo table or passthrough).
  const result = filterPromptInputChunk(ROW_HOME_SEQS[0]!, null, env, freshState());
  expect(result.drop).toBe(false);
  expect(result.out.length).toBeGreaterThan(0); // rewritten (Ctrl+A) or passed through, never dropped
});
