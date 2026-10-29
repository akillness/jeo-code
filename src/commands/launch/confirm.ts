/** Confirm a sensitive action on an isolated local TTY; all other input denies. */
export async function confirmLocalControl({
  input,
  output,
  timeoutMs = 15_000,
  warning = "Discord control grants authorized users the host session's tools and approval policy, including reading or changing files and running commands. This is not a sandbox.",
  prompt = "Confirm Discord control: press y to allow, any other key to cancel.",
}: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  timeoutMs?: number;
  warning?: string;
  prompt?: string;
}): Promise<boolean> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  const wasRaw = !!input.isRaw;
  const wasPaused = input.isPaused();
  const dataListeners = input.rawListeners("data");
  const keyListeners = input.rawListeners("keypress");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let phase: "drain" | "ready" | "candidate" = "drain";
  let finished = false;
  let resolveResult: (value: boolean) => void = () => {};
  const result = new Promise<boolean>(resolve => { resolveResult = resolve; });
  const finish = (accepted: boolean) => {
    if (finished) return;
    finished = true;
    resolveResult(accepted);
  };
  const startQuietDrain = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      if (finished) return;
      phase = "ready";
      try { output.write(`${prompt}\n`); }
      catch { finish(false); }
    }, 200);
  };
  const onData = (chunk: string | Uint8Array) => {
    if (phase === "drain") { startQuietDrain(); return; }
    if (phase !== "ready" || (typeof chunk === "string" ? chunk !== "y" : chunk.length !== 1 || chunk[0] !== 0x79)) { finish(false); return; }
    phase = "candidate";
    quiet = setTimeout(() => finish(true), 200);
  };
  const onEnd = () => finish(false);
  try {
    input.pause();
    for (const listener of dataListeners) input.removeListener("data", listener);
    for (const listener of keyListeners) input.removeListener("keypress", listener);
    input.setRawMode(true);
    output.write(`${warning}\n`);
    while (input.read() !== null) { /* discard input queued before the warning */ }
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.once("error", onEnd);
    deadline = setTimeout(() => finish(false), timeoutMs);
    startQuietDrain();
    input.resume();
    return await result;
  } catch {
    return false;
  } finally {
    clearTimeout(deadline);
    clearTimeout(quiet);
    input.pause();
    input.removeListener("data", onData);
    input.removeListener("end", onEnd);
    input.removeListener("close", onEnd);
    input.removeListener("error", onEnd);
    for (const listener of dataListeners) input.on("data", listener);
    for (const listener of keyListeners) input.on("keypress", listener);
    try { input.setRawMode(wasRaw); } catch {}
    if (wasPaused) input.pause();
    else input.resume();
  }
}
