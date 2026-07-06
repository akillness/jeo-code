/**
 * User-attached image → scrollback block. Bridges `ImageAttachment[]` (the
 * clipboard/drag-drop/file-path attachments already supported by
 * `util/file-attachment.ts` and `util/clipboard-image.ts`) to the inline-image
 * escape sequences in `terminal-image.ts`, producing one stacked block ready for
 * `Renderer.insertAbove` — gjc TUI-parity: jeo could already ATTACH an image to a
 * turn, this is the missing DISPLAY half (the transcript previously showed only a
 * `⧉ N image(s) attached` count, never the picture itself).
 */
import type { ImageAttachment } from "../../ai/types";
import { detectImageProtocol, renderInlineImage, type ImageProtocol } from "../terminal-image";

export interface ImagePreviewOptions {
  /** Terminal columns available for the block (already margin-adjusted by the
   *  caller, same convention as every other card renderer in `tui/app.ts`). */
  cols: number;
  /** Cap on how many terminal rows a SINGLE image may occupy — keeps one huge
   *  screenshot from pushing the whole scrollback off-screen. */
  maxRowsPerImage?: number;
  /** Pre-detected protocol (tests / callers that already resolved it once per
   *  process). Defaults to live detection against `process.env`/`process.stdout`. */
  protocol?: ImageProtocol;
  /** Dim/muted painter applied to text captions (fallback path) so they read as
   *  secondary content, matching the rest of the TUI's caption styling. */
  muted?: (s: string) => string;
}

/**
 * Render every attachment as a stacked block of lines: an inline picture when the
 * terminal protocol + format support it, else a dim text caption. Multiple
 * attachments stack top-to-bottom, each keeping its own row reservation — see
 * `terminal-image.ts#renderInlineImage` for why each image is self-contained
 * (no dependency on being first/last in the stack).
 */
export function renderImageAttachments(images: ImageAttachment[], opts: ImagePreviewOptions): string[] {
  if (images.length === 0) return [];
  const protocol = opts.protocol ?? detectImageProtocol(process.env, !!process.stdout.isTTY);
  const maxColumns = Math.max(10, Math.min(60, opts.cols - 4));
  const maxRows = Math.max(4, opts.maxRowsPerImage ?? 20);
  const muted = opts.muted ?? ((s: string) => s);

  const lines: string[] = [];
  for (const img of images) {
    const result = renderInlineImage(img, protocol, { maxColumns, maxRows });
    if (result.rendered) lines.push(...result.lines);
    else lines.push(...result.lines.map(muted));
  }
  return lines;
}
