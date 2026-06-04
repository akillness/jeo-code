export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.endsWith("\r") ? part.slice(0, -1) : part;
        if (line !== "") {
          yield line;
        }
      }
    }
    buffer += decoder.decode();
    const parts = buffer.split("\n");
    for (const part of parts) {
      const line = part.endsWith("\r") ? part.slice(0, -1) : part;
      if (line !== "") {
        yield line;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of readLines(stream)) {
    if (line.startsWith("data:")) {
      let data = line.slice(5);
      if (data.startsWith(" ")) {
        data = data.slice(1);
      }
      if (data !== "[DONE]") {
        yield data;
      }
    }
  }
}
