export class Spinner {
  private frames: string[];
  private index: number = 0;

  constructor(frames?: string[]) {
    this.frames = frames || [
      "\u280b", "\u2819", "\u2839", "\u2838", "\u283c",
      "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"
    ];
  }

  next(): string {
    const frame = this.frames[this.index];
    this.index = (this.index + 1) % this.frames.length;
    return frame;
  }

  current(): string {
    return this.frames[this.index];
  }
}
