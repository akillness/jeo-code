import chalk from "chalk";
import { BOX_ASCII, BOX_UNICODE, boxBlock } from "./layout";
import { categoryBadge } from "./category-index";

export interface InputBoxOptions {
  cols?: number;
  color?: boolean;
  unicode?: boolean;
  cwdLabel?: string;
  placeholder?: string;
  maxBodyRows?: number;
}

function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  const cap = Math.max(1, width);
  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    if (line.length === 0) {
      out.push("");
      continue;
    }
    for (let i = 0; i < line.length; i += cap) out.push(line.slice(i, i + cap));
  }
  return out;
}

export function renderInputBox(line: string, opts: InputBoxOptions = {}): string[] {
  const cols = Math.max(24, Math.trunc(opts.cols ?? 80));
  const placeholder = opts.placeholder ?? "Type a request, /help, or @path";
  const bodyWidth = Math.max(1, cols - 4);
  const wrapped = wrapPlain(line || placeholder, bodyWidth);
  const maxBodyRows = Math.max(1, Math.trunc(opts.maxBodyRows ?? wrapped.length));
  const body = wrapped.length > maxBodyRows
    ? [`…${wrapped[wrapped.length - maxBodyRows] ?? ""}`.slice(0, bodyWidth), ...wrapped.slice(-(maxBodyRows - 1))]
    : wrapped;
  const title = `${categoryBadge("cmd", { color: opts.color })} input${opts.cwdLabel ? ` · ${opts.cwdLabel}` : ""}`;
  const glyphs = opts.unicode === false ? BOX_ASCII : BOX_UNICODE;
  const paint = opts.color === false ? (s: string) => s : chalk.blue;
  return boxBlock([title, "DIVIDER", ...body], cols, { glyphs, paint, align: "left" });
}
