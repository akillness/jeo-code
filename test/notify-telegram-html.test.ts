import { test, expect } from "bun:test";
import {
  bold,
  code,
  escapeHtml,
  finalizeTelegramHtml,
  italic,
  markdownToTelegramHtml,
  pre,
  splitTelegramHtml,
  truncateTelegramHtml,
} from "../src/agent/notify/telegram-html";

// ============================================================
// escapeHtml
// ============================================================

test("escapeHtml escapes &, <, > individually", () => {
  expect(escapeHtml("&")).toBe("&amp;");
  expect(escapeHtml("<")).toBe("&lt;");
  expect(escapeHtml(">")).toBe("&gt;");
});

test("escapeHtml escapes a mix of all three plus plain text", () => {
  expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
});

test("escapeHtml on an empty string returns an empty string", () => {
  expect(escapeHtml("")).toBe("");
});

// ============================================================
// bold / italic / code / pre — escape internally, then wrap
// ============================================================

test("bold wraps escaped content in <b>, preventing raw HTML injection", () => {
  expect(bold("<script>")).toBe("<b>&lt;script&gt;</b>");
});

test("italic wraps escaped content in <i>, preventing raw HTML injection", () => {
  expect(italic("<script>")).toBe("<i>&lt;script&gt;</i>");
});

test("code wraps escaped content in <code>, preventing raw HTML injection", () => {
  expect(code("<script>")).toBe("<code>&lt;script&gt;</code>");
});

test("pre wraps escaped content in <pre>, preventing raw HTML injection", () => {
  expect(pre("<script>")).toBe("<pre>&lt;script&gt;</pre>");
});

// ============================================================
// markdownToTelegramHtml
// ============================================================

test("converts **bold** to <b>bold</b>", () => {
  expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
});

test("converts *italic* to <i>italic</i>", () => {
  expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
});

test("bold takes priority over italic for ambiguous ***text*** markers", () => {
  // The source applies the bold regex (**...**) before the italic regex
  // (*...*), and it is non-anchored: for "***text***" the bold pass matches
  // starting at index 1 ("**text**"), leaving one leading and one trailing
  // "*" behind. The italic pass then wraps those leftovers around the
  // already-bolded result, producing NESTED tags: <i><b>text</b></i>.
  // (Verified against the live implementation, not guessed.)
  expect(markdownToTelegramHtml("***text***")).toBe("<i><b>text</b></i>");
});

test("converts inline `code` to <code>code</code>", () => {
  expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
});

test("fenced code blocks wrap escaped content in <pre> and drop the language tag", () => {
  // The language identifier ("js") is consumed by the opening-fence match but
  // never appears in the output — Telegram's plain <pre> has no language
  // attribute. The regex's non-greedy body capture includes the trailing
  // newline before the closing fence.
  expect(markdownToTelegramHtml("```js\nconst a = 1 < 2;\n```")).toBe("<pre>const a = 1 &lt; 2;\n</pre>");
  expect(markdownToTelegramHtml("```js\nconst a = 1 < 2;\n```")).not.toContain("js");
});

test("a fenced code block with no language tag still works", () => {
  expect(markdownToTelegramHtml("```\nplain\n```")).toBe("<pre>plain\n</pre>");
});

test("converts a # header line to bold text", () => {
  expect(markdownToTelegramHtml("# Heading")).toBe("<b>Heading</b>");
});

test("converts headers of any level (##) to bold text the same way", () => {
  expect(markdownToTelegramHtml("## Sub heading")).toBe("<b>Sub heading</b>");
});

test("wraps a single blockquote line in <blockquote>", () => {
  expect(markdownToTelegramHtml("> quoted line")).toBe("<blockquote>quoted line</blockquote>");
});

test("merges multiple consecutive '> ' lines into ONE blockquote block", () => {
  // flushQuote() only emits when a non-quote line (or end of input) is hit,
  // so a run of "> " lines accumulates in quoteBuffer and is joined with "\n"
  // inside a single <blockquote>...</blockquote>, not one per line.
  const out = markdownToTelegramHtml("> line one\n> line two\n> line three");
  expect(out).toBe("<blockquote>line one\nline two\nline three</blockquote>");
  // Exactly one blockquote pair, not three.
  expect((out.match(/<blockquote>/g) ?? []).length).toBe(1);
});

test("a blockquote run flushes when a non-quote line follows", () => {
  const out = markdownToTelegramHtml("> quoted\nnormal text");
  expect(out).toBe("<blockquote>quoted</blockquote>\nnormal text");
});

test("converts a safe https link to an <a> tag", () => {
  expect(markdownToTelegramHtml("[text](https://example.com)")).toBe('<a href="https://example.com">text</a>');
});

test("converts a safe mailto link to an <a> tag", () => {
  expect(markdownToTelegramHtml("[mail](mailto:a@b.com)")).toBe('<a href="mailto:a@b.com">mail</a>');
});

test("an unsafe URL scheme is left literal, NOT converted to a tag", () => {
  // Security-relevant: only http(s)/mailto pass isSafeUrl(); anything else
  // (e.g. javascript:) must NOT become a clickable/renderable <a> tag.
  const out = markdownToTelegramHtml("[x](javascript:alert(1))");
  expect(out).toBe("[x](javascript:alert(1))");
  expect(out).not.toContain("<a ");
  expect(out).not.toContain("href");
});

test("a 2-column, 2-row GFM table converts to an aligned monospace <pre> block", () => {
  const table = "| Name | Score |\n|---|---|\n| Alice | 10 |\n| Bob | 200 |";
  const out = markdownToTelegramHtml(table);
  // Verified against the live implementation: column widths are the max
  // cell width per column (header included); default alignment is left
  // (padded on the right), and the divider uses "-" repeated per column
  // width joined by "-|-".
  expect(out).toBe("<pre>Name  | Score\n------|------\nAlice | 10   \nBob   | 200  </pre>");
});

test("a GFM table honors left/right/center alignment markers from the separator row", () => {
  const table = "| Left | Right | Center |\n|:---|---:|:---:|\n| a | b | c |\n| dd | ee | ff |";
  const out = markdownToTelegramHtml(table);
  // Verified against the live implementation. Left column pads on the
  // right, right column pads on the left, center column splits padding
  // with the extra space (if any) on the right (Math.floor for left pad).
  expect(out).toBe("<pre>Left | Right | Center\n-----|-------|-------\na    |     b |   c   \ndd   |    ee |   ff  </pre>");
});

test("text with no markdown constructs passes through with only HTML-escaping applied", () => {
  expect(markdownToTelegramHtml("plain text with < and & chars")).toBe("plain text with &lt; and &amp; chars");
});

// ============================================================
// truncateTelegramHtml
// ============================================================

test("a string shorter than max is returned unchanged", () => {
  expect(truncateTelegramHtml("hello", 100)).toBe("hello");
});

test("truncation never splits a tag mid-way and closes any still-open allowed tag", () => {
  // At max=11, a naive char-slice of "AAAA<b>BBBBBB</b>CCCC" would cut
  // through the middle of "<b>", producing broken markup. The real
  // tokenizer instead accepts the full "<b>" open tag (bringing length to
  // 7) then finds no room for any "B" content once the "</b>" closer is
  // budgeted for (7 + 1 + 4 = 12 > 11), so it stops right after the intact
  // opening tag and synthesizes the closer itself.
  const s = "AAAA<b>BBBBBB</b>CCCC";
  const out = truncateTelegramHtml(s, 11, "");
  expect(out).toBe("AAAA<b></b>");
  expect(out).not.toMatch(/<b(?!>)/); // no truncated/broken opening tag
  expect(out.length).toBeLessThanOrEqual(11);
});

test("truncation partially includes tag content when it fits, still closing the tag", () => {
  const s = "AAAA<b>BBBBBB</b>CCCC";
  expect(truncateTelegramHtml(s, 15, "")).toBe("AAAA<b>BBBB</b>");
});

test("output length is always <= max across a range of max values, including ones smaller than the marker", () => {
  const long = "hello world this is a long message with <b>bold</b> content";
  const marker = "… [truncated]"; // 13 chars
  for (const max of [1, 3, 5, marker.length - 1, marker.length, marker.length + 1, 20, 50, long.length]) {
    const out = truncateTelegramHtml(long, max, marker);
    expect(out.length).toBeLessThanOrEqual(max);
  }
});

test("when max is smaller than the marker's own length, the marker is dropped entirely", () => {
  // effectiveMarker = marker.length <= max ? marker : "" — so at max=5 with
  // a 13-char marker, no marker text can appear in the output at all.
  const marker = "… [truncated]";
  expect(marker.length).toBe(13);
  const out = truncateTelegramHtml("hello world this is long", 5, marker);
  expect(out).toBe("hello");
  expect(out).not.toContain("truncated");
});

test("when max is large enough for the marker, it is appended after truncated content", () => {
  const marker = "… [truncated]";
  const out = truncateTelegramHtml("hello world this is long", marker.length + 1, marker);
  expect(out).toBe("h… [truncated]");
});

test("truncation respects the default 4096-char Telegram limit when max is omitted", () => {
  const long = "x".repeat(5000);
  const out = truncateTelegramHtml(long);
  expect(out.length).toBe(4096);
  expect(out.endsWith("… [truncated]")).toBe(true);
});

// ============================================================
// splitTelegramHtml
// ============================================================

test("a string shorter than max returns a one-element array with the original string unchanged", () => {
  expect(splitTelegramHtml("hello", 100)).toEqual(["hello"]);
});

test("a long plain string with no tags splits evenly into chunks each <= max", () => {
  const plain = "abcdefghij".repeat(3); // 30 chars
  const chunks = splitTelegramHtml(plain, 10);
  expect(chunks).toEqual(["abcdefghij", "abcdefghij", "abcdefghij"]);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
});

test("splitting re-opens a tag that was still open across a chunk boundary, each chunk independently valid", () => {
  // Verified against the live implementation. At max=13, "<b>" (3 chars) +
  // "</b>" (4 chars) + at least 1 char of content fits the 13-char budget,
  // so the tag survives the split: chunk 1 closes </b> at the boundary,
  // chunk 2 re-opens <b> at its start using the exact original opening tag
  // text (openersFor), then closes it again before its own boundary.
  const s = "1234<b>ABCDEFGHIJ</b>5678";
  const chunks = splitTelegramHtml(s, 13);
  expect(chunks).toEqual(["1234<b>AB</b>", "<b>CDEFGH</b>", "<b>IJ</b>5678"]);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(13);
  // Every opened <b> in a chunk is closed within that same chunk.
  for (const c of chunks) {
    const opens = (c.match(/<b>/g) ?? []).length;
    const closes = (c.match(/<\/b>/g) ?? []).length;
    expect(opens).toBe(closes);
  }
});

test("concatenating all chunks' text content (stripping synthetic re-opened tags) reconstructs the original content", () => {
  const s = "1234<b>ABCDEFGHIJ</b>5678";
  const chunks = splitTelegramHtml(s, 13);
  const stripTags = (chunk: string): string => chunk.replace(/<\/?b>/g, "");
  expect(chunks.map(stripTags).join("")).toBe(s.replace(/<\/?b>/g, ""));
});

test("a tag too small to ever fit the budget is dropped, falling back to plain-text splitting", () => {
  // At max=6/7, minimumChunkLengthFor(["b"]) = "<b>".length + "</b>".length + 1
  // = 8, which exceeds max, so the <b>/</b> tokens are skipped entirely and
  // their inner characters flow through as plain text.
  const s = "1234<b>ABCDEFGHIJ</b>5678";
  const chunks = splitTelegramHtml(s, 6);
  expect(chunks).toEqual(["1234AB", "CDEFGH", "IJ5678"]);
  expect(chunks.join("")).not.toContain("<b>");
});

test("splitting never breaks an HTML entity across a chunk boundary", () => {
  const s = "AAAAAAAAAA&amp;BBBBBBBBBB";
  const chunks = splitTelegramHtml(s, 10);
  expect(chunks).toEqual(["AAAAAAAAAA", "&amp;BBBBB", "BBBBB"]);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
  // The entity is never sliced into a partial "&amp" or ";" fragment.
  for (const c of chunks) expect(c).not.toMatch(/&(?!amp;)/);
});

test("nested tags re-open together across a boundary that falls inside the inner tag", () => {
  const nested = "<b>outer AAAAAAAA <i>inner BBBBBBBB</i> more CCCCCCCC</b>";
  const chunks = splitTelegramHtml(nested, 20);
  expect(chunks).toEqual([
    "<b>outer AAAAAAA</b>",
    "<b>A <i>inne</i></b>",
    "<b><i>r BBBB</i></b>",
    "<b><i>BBBB</i> m</b>",
    "<b>ore CCCCCCCC</b>",
  ]);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(20);
});

test("splitting respects the default 4096-char Telegram limit when max is omitted", () => {
  const longPlain = "z".repeat(9000);
  const chunks = splitTelegramHtml(longPlain);
  expect(chunks).toHaveLength(3);
  expect(chunks[0]).toHaveLength(4096);
  expect(chunks[1]).toHaveLength(4096);
  expect(chunks[2]).toHaveLength(808);
  expect(chunks.join("")).toBe(longPlain);
});

// ============================================================
// finalizeTelegramHtml
// ============================================================

test("finalizeTelegramHtml passes undefined through unchanged", () => {
  expect(finalizeTelegramHtml(undefined)).toBeUndefined();
});

test("finalizeTelegramHtml leaves a short defined string unchanged", () => {
  expect(finalizeTelegramHtml("hello")).toBe("hello");
});

test("finalizeTelegramHtml truncates a too-long defined string via truncateTelegramHtml", () => {
  const long = "y".repeat(5000);
  const out = finalizeTelegramHtml(long);
  expect(out).toBeDefined();
  expect(out!.length).toBe(4096);
  expect(out!.endsWith("… [truncated]")).toBe(true);
});
