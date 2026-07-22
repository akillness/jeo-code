import { expect, test } from "bun:test";
import { JobRegistry } from "../src/agent/job-registry";
import { createMonitorTool } from "../src/agent/monitor-tool";

const cwd = process.cwd();

async function cleanup(registry: JobRegistry): Promise<void> {
  registry.cancelAll();
  await registry.awaitIds(registry.list().map(record => record.id), 1000);
}

test("monitor: buffers stdout chunks into newline-delimited line events only", async () => {
  const registry = new JobRegistry();
  const events: Array<{ type: string; line?: string }> = [];
  const unsubscribe = registry.subscribeMonitor(event => events.push(event));
  try {
    const record = registry.startMonitor("printf first; sleep 0.03; printf '\\nsecond\\n'; printf ignored >&2", cwd, {
      category: "log",
      description: "chunked output",
      persistent: true,
    });
    await registry.awaitIds([record.id], 3000);

    expect(events.map(event => event.type)).toEqual(["start", "line", "line", "done"]);
    expect(events.filter(event => event.type === "line").map(event => event.line)).toEqual(["first", "second"]);
    expect(registry.tail(record.id)).toContain("ignored");
  } finally {
    unsubscribe();
    await cleanup(registry);
  }
});
test("monitor: flushes newline-less stdout at EOF and strips carriage returns", async () => {
  const registry = new JobRegistry();
  const lines: string[] = [];
  const unsubscribe = registry.subscribeMonitor(event => {
    if (event.type === "line") lines.push(event.line);
  });
  try {
    const record = registry.startMonitor("printf 'ready\\r'", cwd, {
      category: "other",
      description: "newline-less output",
      persistent: true,
    });
    await registry.awaitIds([record.id], 3000);

    expect(lines).toEqual(["ready"]);
    expect(registry.get(record.id)!.status).toBe("exited");
  } finally {
    unsubscribe();
    await cleanup(registry);
  }
});

test("monitor: stderr stays in the job tail and cannot trigger one-shot delivery", async () => {
  const registry = new JobRegistry();
  const lines: string[] = [];
  const unsubscribe = registry.subscribeMonitor(event => {
    if (event.type === "line") lines.push(event.line);
  });
  try {
    const record = registry.startMonitor("printf 'err\\n' >&2; sleep 0.03; printf 'out\\n'; exec sleep 5", cwd, {
      category: "log",
      description: "stdout only",
    });
    await registry.awaitIds([record.id], 3000);

    expect(lines).toEqual(["out"]);
    expect(registry.tail(record.id)).toContain("err");
    expect(registry.get(record.id)!.status).toBe("killed");
  } finally {
    unsubscribe();
    await cleanup(registry);
  }
});

test("monitor: non-persistent monitors cancel immediately after the first stdout line", async () => {
  const registry = new JobRegistry();
  const lines: string[] = [];
  const unsubscribe = registry.subscribeMonitor(event => {
    if (event.type === "line") lines.push(event.line);
  });
  try {
    const record = registry.startMonitor("printf 'first\\n'; exec sleep 5", cwd, {
      category: "watch",
      description: "first line only",
    });
    await registry.awaitIds([record.id], 3000);

    expect(lines).toEqual(["first"]);
    expect(registry.get(record.id)!.status).toBe("killed");
  } finally {
    unsubscribe();
    await cleanup(registry);
  }
});

test("monitor: persistent monitors deliver multiple lines and complete normally", async () => {
  const registry = new JobRegistry();
  const events: Array<{ type: string; line?: string; status: string }> = [];
  const unsubscribe = registry.subscribeMonitor(event => {
    if (event.type === "line") {
      events.push({ type: event.type, line: event.line, status: event.record.status });
    } else {
      events.push({ type: event.type, status: event.record.status });
    }
  });
  try {
    const record = registry.startMonitor("printf 'one\\n'; sleep 0.03; printf 'two\\n'", cwd, {
      category: "poll",
      description: "two lines",
      persistent: true,
    });
    const [settled] = await registry.awaitIds([record.id], 3000);

    expect(settled!.status).toBe("exited");
    expect(events).toEqual([
      { type: "start", status: "running" },
      { type: "line", line: "one", status: "running" },
      { type: "line", line: "two", status: "running" },
      { type: "done", status: "exited" },
    ]);
  } finally {
    unsubscribe();
    await cleanup(registry);
  }
});

test("monitor: timeout seconds cancel an unfinished persistent monitor", async () => {
  const registry = new JobRegistry();
  try {
    const record = registry.startMonitor("exec sleep 5", cwd, {
      category: "watch",
      description: "timeout",
      persistent: true,
      timeout: 0.03,
    });
    await registry.awaitIds([record.id], 3000);

    expect(registry.get(record.id)!.status).toBe("killed");
  } finally {
    await cleanup(registry);
  }
});
test("monitor tool: reports the allocated job id and persistent state", async () => {
  const registry = new JobRegistry();
  const tool = createMonitorTool(registry);
  try {
    const result = await tool({
      command: "exec sleep 5",
      description: "reported monitor",
      kind: "other",
      persistent: true,
    }, cwd);

    expect(result.success).toBe(true);
    expect(result.output).toContain("job-1");
    expect(result.output).toContain("persistent: true");
  } finally {
    await cleanup(registry);
  }
});

test("monitor tool: rejects invalid monitor arguments", async () => {
  const registry = new JobRegistry();
  const tool = createMonitorTool(registry);
  try {
    for (const args of [
      {},
      { command: "echo hi" },
      { command: "echo hi", description: "test", kind: "invalid" },
      { command: "echo hi", description: "test", kind: "log", timeout: Infinity },
      { command: "echo hi", description: "test", kind: "log", persistent: "true" },
    ]) {
      const result = await tool(args, cwd);
      expect(result.success).toBe(false);
    }
  } finally {
    await cleanup(registry);
  }
});
