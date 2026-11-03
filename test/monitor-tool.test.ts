import { test, expect } from "bun:test";
import { MonitorRegistry } from "../src/agent/monitor-registry";
import { createMonitorTool, MONITOR_TOOL_PROTOCOL_LINE } from "../src/agent/monitor-tool";

const cwd = process.cwd();

async function cleanup(registry: MonitorRegistry): Promise<void> {
  const running = registry.running().map(record => record.id);
  if (running.length === 0) return;
  registry.cancelAll();
  await registry.awaitIds(running);
}

function resolveWhenCountReached(
  values: readonly unknown[],
  count: number,
  resolve: () => void,
): void {
  if (values.length >= count) resolve();
}

function lineBarrier(values: readonly unknown[], count: number): { promise: Promise<void>; notify: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {
    promise,
    notify: () => resolveWhenCountReached(values, count, resolve),
  };
}

test("registry: start returns running immediately, emits stdout/stderr lines, and settles exited", async () => {
  const lines: Array<{ id: string; line: string }> = [];
  const ready = lineBarrier(lines, 2);
  const registry = new MonitorRegistry({
    onLine: (record, line) => {
      lines.push({ id: record.id, line: line.trim() });
      ready.notify();
    },
  });

  try {
    const record = registry.start(
      "printf 'monitor-stdout\\n'; printf 'monitor-stderr\\n' >&2; sleep 0.05",
      cwd,
      true,
    );
    expect(record.status).toBe("running");
    expect(record.id).toBe("monitor-1");

    const [settled] = await registry.awaitIds([record.id], 2_000);
    expect(settled!.status).toBe("exited");
    expect(settled!.exitCode).toBe(0);
    await ready.promise;
    expect(new Set(lines.map(entry => entry.line))).toEqual(
      new Set(["monitor-stdout", "monitor-stderr"]),
    );
    expect(lines.every(entry => entry.id === record.id)).toBe(true);
  } finally {
    await cleanup(registry);
  }
});

test("registry: non-persistent monitors stop after the first emitted line", async () => {
  const lines: string[] = [];
  const ready = lineBarrier(lines, 1);
  const registry = new MonitorRegistry({
    onLine: (_record, line) => {
      lines.push(line.trim());
      ready.notify();
    },
  });

  try {
    const record = registry.start(
      "printf 'first-line\\n'; sleep 0.15; printf 'second-line\\n'",
      cwd,
      false,
    );
    const [settled] = await registry.awaitIds([record.id], 2_000);
    await ready.promise;

    expect(lines).toEqual(["first-line"]);
    expect(lines).not.toContain("second-line");
    expect(settled!.status).toBe("killed");
  } finally {
    await cleanup(registry);
  }
});

test("fast one-shot monitor settles and clears its observed mutation", async () => {
  const registry = new MonitorRegistry();
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const monitor = registry.start("echo hi", cwd, false);
      const [settled] = await registry.awaitIds([monitor.id]);
      expect(settled!.status).toBe("killed");
      expect(registry.consumeMutations([monitor.id])).toBe(true);
      expect(registry.unobserved().map(record => record.id)).not.toContain(monitor.id);
    }
  } finally {
    await cleanup(registry);
  }
});

test("registry: persistent monitors deliver multiple lines and cancel marks them killed", async () => {
  const lines: string[] = [];
  const ready = lineBarrier(lines, 2);
  const registry = new MonitorRegistry({
    onLine: (_record, line) => {
      lines.push(line.trim());
      ready.notify();
    },
  });

  try {
    const record = registry.start(
      "printf 'line-one\\nline-two\\n'; sleep 0.2",
      cwd,
      true,
    );
    await ready.promise;
    expect(lines.slice(0, 2)).toEqual(["line-one", "line-two"]);
    expect(registry.get(record.id)!.status).toBe("running");

    const [cancelled] = registry.cancel([record.id]);
    expect(cancelled!.status).toBe("killed");
    await registry.awaitIds([record.id], 1_000);
    expect(registry.get(record.id)!.status).toBe("killed");
  } finally {
    await cleanup(registry);
  }
});

test("registry: bounded await returns a slow monitor as running without stopping it", async () => {
  const registry = new MonitorRegistry();

  try {
    const record = registry.start("sleep 1", cwd, true);
    const [snapshot] = await registry.awaitIds([record.id], 25);
    expect(snapshot!.status).toBe("running");
    expect(registry.running().map(item => item.id)).toContain(record.id);
  } finally {
    await cleanup(registry);
  }
});

test("monitor tool: list/start/await/tail/cancel expose truthful monitor state", async () => {
  const outputLines: string[] = [];
  const ready = lineBarrier(outputLines, 1);
  const registry = new MonitorRegistry({
    onLine: (_record, line) => {
      outputLines.push(line.trim());
      ready.notify();
    },
  });
  const tool = createMonitorTool(registry);

  try {
    let result = await tool({ action: "list" }, cwd);
    expect(result.success).toBe(true);
    expect(result.output).toContain("No monitors in this session");

    result = await tool({
      action: "start",
      command: "printf 'tool-output\\n'; sleep 0.05",
      persistent: true,
    }, cwd);
    expect(result.success).toBe(true);
    expect(result.output).toContain("monitor-1");

    await ready.promise;
    result = await tool({ action: "tail", ids: ["monitor-1"] }, cwd);
    expect(result.success).toBe(true);
    expect(result.output).toContain("tool-output");

    result = await tool({ action: "await", ids: ["monitor-1"], timeoutMs: 2_000 }, cwd);
    expect(result.success).toBe(true);
    expect(result.output).toContain("all settled");
    expect(result.output).toContain("EXITED");

    result = await tool({ action: "start", command: "sleep 0.2", persistent: true }, cwd);
    expect(result.success).toBe(true);
    expect(result.output).toContain("monitor-2");
    result = await tool({ action: "cancel", ids: ["monitor-2"] }, cwd);
    expect(result.success).toBe(true);
    expect(result.output).toContain("Cancelled 1 monitor");
    expect(registry.get("monitor-2")!.status).toBe("killed");
    await registry.awaitIds(["monitor-2"], 1_000);
  } finally {
    await cleanup(registry);
  }
});

test("monitor tool: protocol and invalid arguments report actionable failures", async () => {
  const registry = new MonitorRegistry();
  const tool = createMonitorTool(registry);

  expect(MONITOR_TOOL_PROTOCOL_LINE).toContain('monitor {action:"start", command');
  expect(MONITOR_TOOL_PROTOCOL_LINE).toContain("tail");
  expect(MONITOR_TOOL_PROTOCOL_LINE).toContain("cancel");

  const missingCommand = await tool({ action: "start" }, cwd);
  expect(missingCommand.success).toBe(false);
  expect(missingCommand.error).toContain("requires a non-empty 'command'");

  const unknownAction = await tool({ action: "bogus" }, cwd);
  expect(unknownAction.success).toBe(false);
  expect(unknownAction.error).toContain("Unknown monitor action");

  const unknownMonitor = await tool({ action: "tail", ids: ["monitor-404"] }, cwd);
  expect(unknownMonitor.success).toBe(false);
  expect(unknownMonitor.error).toContain("No monitor matches monitor-404");

  await cleanup(registry);
});

test("monitor await rejects unknown IDs atomically and reports nonzero exit", async () => {
  const registry = new MonitorRegistry();
  const tool = createMonitorTool(registry);
  const monitor = registry.start("exit 7", cwd, true);
  try {
    const unknown = await tool({ action: "await", ids: [monitor.id, "monitor-999"] }, cwd);
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain("monitor-999");
    const result = await tool({ action: "await", ids: [monitor.id] }, cwd);
    expect(result.success).toBe(false);
    expect(result.output).toContain("exit code 7");
  } finally {
    await cleanup(registry);
  }
});

test("monitor cancel rejects mixed unknown IDs without killing the valid monitor", async () => {
  const registry = new MonitorRegistry();
  const tool = createMonitorTool(registry);
  const monitor = registry.start("sleep 30", cwd, true);
  try {
    const result = await tool({ action: "cancel", ids: [monitor.id, "monitor-999"] }, cwd);
    expect(result.success).toBe(false);
    expect(result.error).toContain("monitor-999");
    expect(registry.running().map(record => record.id)).toContain(monitor.id);
  } finally {
    await cleanup(registry);
  }
});

test.skipIf(process.platform !== "win32")("Windows monitor cancellation remains unresolved after the shell exits", async () => {
  const registry = new MonitorRegistry();
  const tool = createMonitorTool(registry);
  const monitor = registry.start("while :; do :; done", cwd, true);
  try {
    const result = await tool({ action: "cancel", ids: [monitor.id] }, cwd);
    expect(result.success).toBe(false);
    const [settled] = await registry.awaitIds([monitor.id], 2500);
    expect(settled!.status).toBe("failed");
    registry.consumeMutations([monitor.id]);
    expect(registry.unobserved().map(record => record.id)).toContain(monitor.id);
    expect(registry.cancellable().map(record => record.id)).toContain(monitor.id);
    const retry = await tool({ action: "cancel" }, cwd);
    expect(retry.success).toBe(false);
    expect(registry.unobserved().map(record => record.id)).toContain(monitor.id);
  } finally {
    registry.cancelAll();
    await registry.awaitIds([monitor.id], 2500);
  }
}, 5000);
