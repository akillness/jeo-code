import type { ReadableStreamDefaultReader as WebStreamReader } from "node:stream/web";

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MODEL_TIMEOUT_MS = 15_000;
const MAX_TURN_TIMEOUT_MS = DEFAULT_TURN_TIMEOUT_MS;
const MAX_MODEL_TIMEOUT_MS = DEFAULT_MODEL_TIMEOUT_MS;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_OUTPUT_BYTES = 256 * 1024;
const KILL_ESCALATION_MS = 250;

export interface AgyModelOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  executable?: string;
}

export interface AgyUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
}

export interface AgyTurnOptions {
  model: string;
  prompt: string;
  cwd: string;
  conversationId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: "plan" | "auto" | "accept-edits";
  executable?: string;
  onText?: (text: string) => void;
  onNotice?: (text: string) => void;
  onConversation?: (id: string) => void | Promise<void>;
}

export interface AgyTurnResult {
  model: string;
  conversationId: string;
  response: string;
  steps: number;
  usage?: AgyUsage;
}

export type AgyCliErrorKind = "spawn" | "timeout" | "cancelled" | "protocol" | "upstream" | "exit";

export class AgyCliError extends Error {
  constructor(
    message: string,
    readonly kind: AgyCliErrorKind,
    readonly exitCode?: number | null,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "AgyCliError";
  }
}

interface InitPayload {
  model: string;
}

interface StepPayload {
  step_type?: unknown;
  step_index?: unknown;
  state?: unknown;
  text_delta?: unknown;
  tool_name?: unknown;
  tool_info?: unknown;
  permission_mode?: unknown;
  permission?: unknown;
  [key: string]: unknown;
}

interface ResultPayload {
  conversation_id?: unknown;
  status?: unknown;
  response?: unknown;
  error?: unknown;
  model?: unknown;
  usage?: unknown;
  [key: string]: unknown;
}

interface AgyEvent {
  event: unknown;
  conversation_id?: unknown;
  init?: unknown;
  step_update?: unknown;
  result?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const normalizeTimeout = (value: number | undefined, defaultMs: number, maxMs: number): number => {
  if (value === undefined) return defaultMs;
  if (!Number.isFinite(value) || value <= 0) throw new AgyCliError("Agy timeout must be a positive finite number of milliseconds.", "protocol");
  return Math.min(Math.max(1, Math.ceil(value)), maxMs);
};


const canonicalModelParts = (model: string): { canonical: string; slug: string } => {
  if (typeof model !== "string" || !model.startsWith("agy/")) {
    throw new AgyCliError(`Agy model must use the explicit agy/<slug> namespace; received ${String(model)}.`, "protocol");
  }
  const slug = model.slice("agy/".length);
  if (!slug || /[\s/]/u.test(slug)) {
    throw new AgyCliError(`Agy model must contain one non-empty CLI slug; received ${model}.`, "protocol");
  }
  return { canonical: `agy/${slug}`, slug };
};

const decodeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

const appendBounded = (current: string, chunk: string, limit: number): string => {
  if (!chunk) return current;
  const next = current + chunk;
  return next.length <= limit ? next : next.slice(0, limit);
};

const killProcess = (proc: Pick<Bun.Subprocess, "kill">, signal: "SIGTERM" | "SIGKILL"): void => {
  try {
    proc.kill(signal);
  } catch {
    // The process may have exited between the liveness check and the signal.
  }
};

function parseModelList(stdout: string): string[] {
  const models: string[] = [];
  const seen = new Set<string>();
  for (const [index, rawLine] of stdout.split(/\r?\n/u).entries()) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) {
      throw new AgyCliError(`Malformed agy model list record at line ${index + 1}; expected <slug>\\t<label>.`, "protocol");
    }
    const slug = line.slice(0, tab);
    const label = line.slice(tab + 1);
    if (!slug.trim() || !label.trim() || /[\s/]/u.test(slug)) {
      throw new AgyCliError(`Malformed agy model list record at line ${index + 1}; slug and label are required.`, "protocol");
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push(`agy/${slug}`);
  }
  return models;
}

export async function listAgyModels(options: AgyModelOptions = {}): Promise<string[]> {
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_MODEL_TIMEOUT_MS, MAX_MODEL_TIMEOUT_MS);
  if (options.signal?.aborted) throw new AgyCliError("Agy model discovery was aborted before spawn.", "cancelled");

  const executable = options.executable ?? "agy";
  const cwd = options.cwd ?? process.cwd();
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([executable, "models"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new AgyCliError(`Failed to start agy model discovery: ${decodeError(error)}. Install agy and authenticate it with its own CLI.`, "spawn");
  }

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let cancelled = false;
  let killed = false;
  let escalation: NodeJS.Timeout | undefined;
  let stdoutReader: WebStreamReader<Uint8Array> | undefined;
  let stderrReader: WebStreamReader<Uint8Array> | undefined;
  let streamFailed: unknown;

  const stopProcess = (): void => {
    if (killed) return;
    killed = true;
    void stdoutReader?.cancel().catch(() => {});
    void stderrReader?.cancel().catch(() => {});
    killProcess(proc, "SIGTERM");
    escalation = setTimeout(() => killProcess(proc, "SIGKILL"), KILL_ESCALATION_MS);
  };
  const terminate = (reason: "timeout" | "cancelled"): void => {
    if (reason === "timeout") timedOut = true;
    else cancelled = true;
    stopProcess();
  };
  const onAbort = (): void => terminate("cancelled");
  if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });

  const drain = async (stream: ReadableStream<Uint8Array>, which: "stdout" | "stderr"): Promise<void> => {
    const reader = stream.getReader();
    if (which === "stdout") stdoutReader = reader;
    else stderrReader = reader;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        const text = decoder.decode(part.value, { stream: true });
        if (which === "stdout") {
          stdoutBytes += part.value.byteLength;
          if (stdoutBytes > MAX_MODEL_OUTPUT_BYTES) throw new AgyCliError("Agy model list exceeded the bounded output limit.", "protocol");
          stdout = appendBounded(stdout, text, MAX_MODEL_OUTPUT_BYTES);
        } else {
          stderrBytes += part.value.byteLength;
          stderr = appendBounded(stderr, text, MAX_MODEL_OUTPUT_BYTES);
          if (stderrBytes > MAX_MODEL_OUTPUT_BYTES) stderr = `${stderr}\n[agy stderr truncated]`;
        }
      }
      const tail = decoder.decode();
      if (which === "stdout") stdout = appendBounded(stdout, tail, MAX_MODEL_OUTPUT_BYTES);
      else stderr = appendBounded(stderr, tail, MAX_MODEL_OUTPUT_BYTES);
    } finally {
      reader.releaseLock();
    }
  };

  const stdoutPromise = drain(proc.stdout, "stdout").catch(error => { streamFailed = error; stopProcess(); });
  const stderrPromise = drain(proc.stderr, "stderr").catch(error => { if (!streamFailed) streamFailed = error; stopProcess(); });
  try {
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    let exitCode: number | null;
    try {
      exitCode = await proc.exited;
      await Promise.all([stdoutPromise, stderrPromise]);
    } finally {
      clearTimeout(timer);
    }
    if (cancelled) throw new AgyCliError("Agy model discovery was cancelled.", "cancelled", exitCode, stderr);
    if (timedOut) throw new AgyCliError(`Agy model discovery timed out after ${timeoutMs}ms.`, "timeout", exitCode, stderr);
    if (streamFailed) throw streamFailed;
    if (exitCode !== 0) {
      const detail = stderr.trim() || `agy models exited with code ${exitCode}`;
      throw new AgyCliError(`${detail} (exit ${exitCode}).`, "exit", exitCode, stderr);
    }
    return parseModelList(stdout);
  } catch (error) {
    if (!killed && proc.exitCode === null) stopProcess();
    if (error instanceof AgyCliError) throw error;
    throw new AgyCliError(`Agy model discovery failed: ${decodeError(error)}${stderr.trim() ? ` — ${stderr.trim()}` : ""}`, "protocol", proc.exitCode, stderr);
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
    try { await proc.exited; } catch { /* ignore exit read failures during cleanup */ }
    clearTimeout(escalation);
    try { await stdoutReader?.cancel(); } catch { /* ignore closed reader */ }
    try { await stderrReader?.cancel(); } catch { /* ignore closed reader */ }
  }
}

function parseUsage(value: unknown): AgyUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = finiteNonNegative(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = finiteNonNegative(usage.output_tokens ?? usage.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const out: AgyUsage = { inputTokens, outputTokens };
  const thinkingTokens = finiteNonNegative(usage.thinking_tokens ?? usage.thinkingTokens);
  const cacheReadTokens = finiteNonNegative(usage.cache_read_tokens ?? usage.cacheReadTokens);
  if (thinkingTokens !== undefined) out.thinkingTokens = thinkingTokens;
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  return out;
}

export async function runAgyTurn(options: AgyTurnOptions): Promise<AgyTurnResult> {
  const { canonical, slug } = canonicalModelParts(options.model);
  if (typeof options.prompt !== "string") throw new AgyCliError("Agy prompt must be a string.", "protocol");
  if (!options.cwd) throw new AgyCliError("Agy cwd is required.", "protocol");
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TURN_TIMEOUT_MS, MAX_TURN_TIMEOUT_MS);
  if (options.signal?.aborted) throw new AgyCliError("Agy turn was aborted before spawn.", "cancelled");

  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", slug,
    "--sandbox",
    "--print-timeout", `${timeoutMs}ms`,
  ];
  if (options.conversationId !== undefined) {
    if (!options.conversationId.trim()) throw new AgyCliError("Agy conversationId must be non-empty when provided.", "protocol");
    args.push("--conversation", options.conversationId);
  }
  if (options.mode !== undefined) args.push("--mode", options.mode);

  const executable = options.executable ?? "agy";
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([executable, ...args], { cwd: options.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new AgyCliError(`Failed to start agy: ${decodeError(error)}. Install agy and authenticate it with its own CLI.`, "spawn");
  }

  let stdoutBytes = 0;
  let stderr = "";
  let stderrBytes = 0;
  let stdoutLine = "";
  let initModel: string | undefined;
  let conversationId: string | undefined;
  let terminal: ResultPayload | undefined;
  let stepCount = 0;
  let streamedText = "";
  let streamFailed: unknown;
  let timedOut = false;
  let cancelled = false;
  let killed = false;
  let escalation: NodeJS.Timeout | undefined;
  let stdoutReader: WebStreamReader<Uint8Array> | undefined;
  let stderrReader: WebStreamReader<Uint8Array> | undefined;
  const stopProcess = (): void => {
    if (killed) return;
    killed = true;
    void stdoutReader?.cancel().catch(() => {});
    void stderrReader?.cancel().catch(() => {});
    killProcess(proc, "SIGTERM");
    escalation = setTimeout(() => killProcess(proc, "SIGKILL"), KILL_ESCALATION_MS);
  };
  const terminate = (reason: "timeout" | "cancelled"): void => {
    if (reason === "timeout") timedOut = true;
    else cancelled = true;
    stopProcess();
  };
  const onAbort = (): void => terminate("cancelled");
  if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });

  const handleEvent = async (line: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new AgyCliError(`Malformed agy NDJSON event: ${decodeError(error)}`, "protocol", proc.exitCode, stderr);
    }
    const event = asRecord(parsed) as AgyEvent | undefined;
    if (!event || typeof event.event !== "string") throw new AgyCliError("Malformed agy NDJSON envelope: missing event type.", "protocol", proc.exitCode, stderr);

    if (event.event === "init") {
      if (initModel !== undefined) throw new AgyCliError("Agy emitted more than one init event.", "protocol", proc.exitCode, stderr);
      const init = asRecord(event.init) as InitPayload | undefined;
      const model = nonEmptyString(init?.model);
      const id = nonEmptyString(event.conversation_id);
      if (!init || !model || !id) throw new AgyCliError("Agy init event is missing model or conversation_id.", "protocol", proc.exitCode, stderr);
      if (model !== slug) throw new AgyCliError(`Agy init model mismatch: expected ${slug}, received ${model}.`, "protocol", proc.exitCode, stderr);
      if (options.conversationId !== undefined && id !== options.conversationId) {
        throw new AgyCliError(`Agy init conversation_id mismatch: expected ${options.conversationId}, received ${id}.`, "protocol", proc.exitCode, stderr);
      }
      initModel = model;
      conversationId = id;
      if (options.onConversation) await options.onConversation(id);
      return;
    }

    if (event.event === "step_update") {
      if (terminal) throw new AgyCliError("Agy emitted step_update after terminal result.", "protocol", proc.exitCode, stderr);
      if (!initModel || !conversationId) throw new AgyCliError("Agy emitted step_update before init.", "protocol", proc.exitCode, stderr);
      const step = asRecord(event.step_update) as StepPayload | undefined;
      if (!step || typeof step.step_index !== "number" || !Number.isInteger(step.step_index) || step.step_index < 0
        || !nonEmptyString(step.state) || !nonEmptyString(step.step_type)
        || (step.text_delta !== undefined && typeof step.text_delta !== "string")
        || (step.tool_name !== undefined && typeof step.tool_name !== "string")
        || (step.permission_mode !== undefined && typeof step.permission_mode !== "string")
        || (step.tool_info !== undefined && !asRecord(step.tool_info))
        || (step.subagent_info !== undefined && !asRecord(step.subagent_info))) {
        throw new AgyCliError("Malformed agy step_update event.", "protocol", proc.exitCode, stderr);
      }
      stepCount++;
      if (step.conversation_id !== conversationId) {
        throw new AgyCliError("Agy step_update conversation_id does not match init.", "protocol", proc.exitCode, stderr);
      }
      const textDelta = typeof step.text_delta === "string" ? step.text_delta : undefined;
      if (step.step_type === "agent_response" && textDelta) {
        streamedText += textDelta;
        options.onText?.(textDelta);
      }
      if (step.step_type === "tool" || step.tool_info !== undefined || step.permission !== undefined || step.permission_mode !== undefined) {
        const notice = typeof step.tool_name === "string" ? `agy tool: ${step.tool_name}` : `agy ${String(step.step_type ?? "permission")} notice`;
        options.onNotice?.(notice);
      }
      return;
    }

    if (event.event === "result") {
      if (terminal) throw new AgyCliError("Agy emitted more than one terminal result event.", "protocol", proc.exitCode, stderr);
      const result = asRecord(event.result) as ResultPayload | undefined;
      if (!result) throw new AgyCliError("Malformed agy result event.", "protocol", proc.exitCode, stderr);
      terminal = result;
      return;
    }
    // Forward-compatible unknown event types are intentionally ignored.
  };

  const drainStdout = async (): Promise<void> => {
    const reader = proc.stdout.getReader();
    stdoutReader = reader;
    const decoder = new TextDecoder();
    const consume = async (text: string): Promise<void> => {
      stdoutLine += text;
      if (stdoutLine.length > MAX_STREAM_BYTES) throw new AgyCliError("Agy output exceeded the bounded stream limit.", "protocol", proc.exitCode, stderr);
      let newline = stdoutLine.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutLine.slice(0, newline).replace(/\r$/u, "");
        stdoutLine = stdoutLine.slice(newline + 1);
        if (line.trim()) await handleEvent(line);
        newline = stdoutLine.indexOf("\n");
      }
    };
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        stdoutBytes += part.value.byteLength;
        if (stdoutBytes > MAX_STREAM_BYTES) throw new AgyCliError("Agy output exceeded the bounded stream limit.", "protocol", proc.exitCode, stderr);
        await consume(decoder.decode(part.value, { stream: true }));
      }
      await consume(decoder.decode());
      if (stdoutLine.trim()) await handleEvent(stdoutLine.trim());
      stdoutLine = "";
    } finally {
      reader.releaseLock();
    }
  };

  const drainStderr = async (): Promise<void> => {
    const reader = proc.stderr.getReader();
    stderrReader = reader;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        stderrBytes += part.value.byteLength;
        stderr = appendBounded(stderr, decoder.decode(part.value, { stream: true }), MAX_STREAM_BYTES);
        if (stderrBytes > MAX_STREAM_BYTES) stderr = `${stderr}\n[agy stderr truncated]`;
      }
      stderr = appendBounded(stderr, decoder.decode(), MAX_STREAM_BYTES);
    } finally {
      reader.releaseLock();
    }
  };

  const stdoutPromise = drainStdout().catch(error => { streamFailed = error; stopProcess(); });
  const stderrPromise = drainStderr().catch(error => { if (!streamFailed) streamFailed = error; stopProcess(); });
  const input = `${JSON.stringify({ event: "user", message: { content: options.prompt } })}\n`;
  const timer = setTimeout(() => terminate("timeout"), timeoutMs);
  try {
    await proc.stdin.write(input);
    await proc.stdin.end();
    const exitCode = await proc.exited;
    await Promise.all([stdoutPromise, stderrPromise]);
    if (cancelled) throw new AgyCliError("Agy turn was cancelled.", "cancelled", exitCode, stderr);
    if (timedOut) throw new AgyCliError(`Agy turn timed out after ${timeoutMs}ms.`, "timeout", exitCode, stderr);
    if (streamFailed) throw streamFailed;
    const terminalStatus = nonEmptyString(terminal?.status)?.toUpperCase();
    if (exitCode !== 0) {
      const upstream = terminal?.error;
      const detail = nonEmptyString(upstream) ?? (stderr.trim() || `agy exited with code ${exitCode}`);
      throw new AgyCliError(`${detail} (exit ${exitCode}).`, terminalStatus === "ERROR" ? "upstream" : "exit", exitCode, stderr);
    }
    if (!initModel || !conversationId) throw new AgyCliError("Agy exited successfully without a valid init event.", "protocol", exitCode, stderr);
    if (!terminal) throw new AgyCliError("Agy exited successfully without a terminal result event.", "protocol", exitCode, stderr);
    const status = terminalStatus;
    const resultConversation = nonEmptyString(terminal.conversation_id);
    if (!resultConversation || resultConversation !== conversationId) throw new AgyCliError("Agy result conversation_id does not match init.", "protocol", exitCode, stderr);
    if (status !== "SUCCESS") {
      const detail = nonEmptyString(terminal.error) ?? `Agy returned terminal status ${status ?? "unknown"}.`;
      throw new AgyCliError(`${detail}${exitCode === 0 ? " (exit 0)." : ` (exit ${exitCode}).`}`, "upstream", exitCode, stderr);
    }
    if (terminal.model !== undefined && terminal.model !== slug) throw new AgyCliError(`Agy result model mismatch: expected ${slug}, received ${String(terminal.model)}.`, "protocol", exitCode, stderr);
    const response = typeof terminal.response === "string" ? terminal.response : undefined;
    if (!response || !response.trim()) throw new AgyCliError("Agy returned SUCCESS with an empty response.", "protocol", exitCode, stderr);
    if (!streamedText && response) options.onText?.(response);
    else if (streamedText && response.startsWith(streamedText) && response.length > streamedText.length) options.onText?.(response.slice(streamedText.length));
    return { model: canonical, conversationId, response, steps: stepCount, usage: parseUsage(terminal.usage) };
  } catch (error) {
    if (!killed && proc.exitCode === null) stopProcess();
    if (cancelled) throw new AgyCliError("Agy turn was cancelled.", "cancelled", proc.exitCode, stderr);
    if (timedOut) throw new AgyCliError(`Agy turn timed out after ${timeoutMs}ms.`, "timeout", proc.exitCode, stderr);
    if (error instanceof AgyCliError) throw error;
    if (error instanceof Error && /abort|cancel/i.test(error.message)) throw new AgyCliError(error.message, "cancelled", proc.exitCode, stderr);
    throw new AgyCliError(`Agy turn failed: ${decodeError(error)}${stderr.trim() ? ` — ${stderr.trim()}` : ""}`, "protocol", proc.exitCode, stderr);
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
    clearTimeout(timer);
    try { await proc.exited; } catch { /* ignore exit read failures during cleanup */ }
    clearTimeout(escalation);
    try { await stdoutReader?.cancel(); } catch { /* ignore closed reader */ }
    try { await stderrReader?.cancel(); } catch { /* ignore closed reader */ }
  }
}
