export async function* readLines(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // Wire-level heartbeat: ANY bytes from the server (including SSE keepalive/ping
      // comments and events that never become a yielded chunk) mark the stream as alive,
      // so the idle watchdog re-arms instead of falsely aborting a connected-but-quiet
      // stream (e.g. a model reasoning server-side that emits only ping events).
      if (value && value.length > 0) {
        onActivity?.();
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
    // cancel() frees the underlying HTTP connection on early generator return
    // (consumer break) — releaseLock() alone leaks the socket until GC. No-op on a
    // normally-drained stream.
    await reader.cancel().catch(() => {});
  }
}

export async function* readSse(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<string> {
  for await (const line of readLines(stream, onActivity)) {
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
