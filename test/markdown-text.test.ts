import { expect, test } from "bun:test";
import { stripMarkdown } from "../src/tui/components/markdown-text";

test("stripMarkdown strips headers, bold, italic, code blocks, links, and blockquotes", () => {
  const input = `
# Header 1
## Header 2

This is **bold** and *italic* text.

Here is some \`inline code\`.

\`\`\`ts
const x = 1;
\`\`\`

Check out [Google](https://google.com).

> This is a blockquote.

---
`;

  const expected = `Header 1
Header 2

This is bold and italic text.

Here is some inline code.


const x = 1;

Check out Google (https://google.com).

This is a blockquote.`;

  expect(stripMarkdown(input)).toBe(expected.trim());
});