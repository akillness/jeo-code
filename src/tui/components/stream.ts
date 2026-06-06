export class StreamRegion {
  private buffer: string = "";

  append(text: string): void {
    this.buffer += text;
  }

  render(width: number, maxLines?: number): string[] {
    if (this.buffer === "") {
      return [];
    }

    const cols = Math.max(1, width);
    const segments = this.buffer.split("\n");
    const result: string[] = [];

    for (const segment of segments) {
      if (segment === "") {
        result.push("");
      } else {
        for (let i = 0; i < segment.length; i += cols) {
          result.push(segment.slice(i, i + cols));
        }
      }
    }

    if (maxLines !== undefined && maxLines > 0 && result.length > maxLines) {
      return result.slice(result.length - maxLines);
    }
    return result;
  }

  clear(): void {
    this.buffer = "";
  }
}
