import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runPreToolHooks, runPostTurnHooks, loadHooks } from "../src/agent/hooks";

const testDir = path.join(os.tmpdir(), `joc-hooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const globalConfigDir = path.join(testDir, "global-config");
const projectDir = path.join(testDir, "project");

let originalConfigDir: string | undefined;

beforeAll(async () => {
  originalConfigDir = process.env.JOC_CONFIG_DIR;
  await fs.mkdir(globalConfigDir, { recursive: true });
  await fs.mkdir(path.join(projectDir, ".joc"), { recursive: true });
  process.env.JOC_CONFIG_DIR = globalConfigDir;
});

afterAll(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.JOC_CONFIG_DIR;
  } else {
    process.env.JOC_CONFIG_DIR = originalConfigDir;
  }
  await fs.rm(testDir, { recursive: true, force: true });
});

test("disabled hooks never run", async () => {
  // Global config has hooks disabled
  const globalConfig = {
    defaultModel: "claude-sonnet-4-5",
    providers: {},
    hooks: {
      enabled: false,
      hooks: [
        {
          event: "pre-tool",
          run: "echo 'global pre' && exit 1",
        }
      ]
    }
  };
  await fs.writeFile(path.join(globalConfigDir, "config.json"), JSON.stringify(globalConfig), "utf-8");

  // Local .joc/hooks.json exists
  const localHooks = {
    enabled: true,
    hooks: [
      {
        event: "pre-tool",
        run: "echo 'local pre' && exit 1",
      }
    ]
  };
  await fs.writeFile(path.join(projectDir, ".joc", "hooks.json"), JSON.stringify(localHooks), "utf-8");

  const loaded = await loadHooks(projectDir);
  expect(loaded).toEqual([]);

  const preRes = await runPreToolHooks(projectDir, "read", { path: "foo" });
  expect(preRes.vetoed).toBe(false);
});

test("enabled pre-tool can veto", async () => {
  const globalConfig = {
    defaultModel: "claude-sonnet-4-5",
    providers: {},
    hooks: {
      enabled: true,
      hooks: [
        {
          event: "pre-tool",
          match: { tool: "write" },
          run: "echo 'pre-veto-write' && exit 1",
        }
      ]
    }
  };
  await fs.writeFile(path.join(globalConfigDir, "config.json"), JSON.stringify(globalConfig), "utf-8");

  // No local hooks file
  try {
    await fs.unlink(path.join(projectDir, ".joc", "hooks.json"));
  } catch {}

  const loaded = await loadHooks(projectDir);
  expect(loaded.length).toBe(1);

  // Match tool "read" (no veto because match is for write)
  const preResRead = await runPreToolHooks(projectDir, "read", { path: "foo" });
  expect(preResRead.vetoed).toBe(false);

  // Match tool "write" (should veto)
  let noticeMessage = "";
  const preResWrite = await runPreToolHooks(projectDir, "write", { path: "foo" }, undefined, (msg) => {
    noticeMessage = msg;
  });
  expect(preResWrite.vetoed).toBe(true);
  expect(noticeMessage).toContain("vetoed execution");
});

test("enabled local hook file takes precedence / is parsed", async () => {
  const globalConfig = {
    defaultModel: "claude-sonnet-4-5",
    providers: {},
    hooks: {
      enabled: true,
      hooks: [
        {
          event: "pre-tool",
          run: "echo 'global' && exit 0",
        }
      ]
    }
  };
  await fs.writeFile(path.join(globalConfigDir, "config.json"), JSON.stringify(globalConfig), "utf-8");

  // Local hook file defined
  const localHooks = {
    enabled: true,
    hooks: [
      {
        event: "pre-tool",
        match: { tool: "read" },
        run: "echo 'local veto' && exit 2",
      }
    ]
  };
  await fs.writeFile(path.join(projectDir, ".joc", "hooks.json"), JSON.stringify(localHooks), "utf-8");

  const loaded = await loadHooks(projectDir);
  expect(loaded.length).toBe(1);
  expect(loaded[0].run).toBe("echo 'local veto' && exit 2");

  const preRes = await runPreToolHooks(projectDir, "read", { path: "foo" });
  expect(preRes.vetoed).toBe(true);
  expect(preRes.error).toContain("exit code 2");
});

test("enabled post-turn advisory does not fail loop", async () => {
  const globalConfig = {
    defaultModel: "claude-sonnet-4-5",
    providers: {},
    hooks: {
      enabled: true,
      hooks: [
        {
          event: "post-turn",
          run: "echo 'post-fail' && exit 5",
        }
      ]
    }
  };
  await fs.writeFile(path.join(globalConfigDir, "config.json"), JSON.stringify(globalConfig), "utf-8");

  try {
    await fs.unlink(path.join(projectDir, ".joc", "hooks.json"));
  } catch {}

  let noticeMessage = "";
  await runPostTurnHooks(projectDir, "read", { path: "foo" }, true, "some output", undefined, (msg) => {
    noticeMessage = msg;
  });

  expect(noticeMessage).toContain("exited with non-zero code 5");
});

test("timeout path returns notice", async () => {
  const globalConfig = {
    defaultModel: "claude-sonnet-4-5",
    providers: {},
    hooks: {
      enabled: true,
      hooks: [
        {
          event: "pre-tool",
          run: "sleep 1",
          timeoutMs: 10,
        }
      ]
    }
  };
  await fs.writeFile(path.join(globalConfigDir, "config.json"), JSON.stringify(globalConfig), "utf-8");

  let noticeMessage = "";
  const preRes = await runPreToolHooks(projectDir, "read", { path: "foo" }, undefined, (msg) => {
    noticeMessage = msg;
  });

  expect(preRes.vetoed).toBe(true);
  expect(noticeMessage).toContain("timed out after 10ms");
});

test("signal abort path returns notice", async () => {
  const globalConfig = {
    defaultModel: "claude-sonnet-4-5",
    providers: {},
    hooks: {
      enabled: true,
      hooks: [
        {
          event: "pre-tool",
          run: "sleep 5",
        }
      ]
    }
  };
  await fs.writeFile(path.join(globalConfigDir, "config.json"), JSON.stringify(globalConfig), "utf-8");

  const controller = new AbortController();
  setTimeout(() => {
    controller.abort();
  }, 10);

  let noticeMessage = "";
  const preRes = await runPreToolHooks(projectDir, "read", { path: "foo" }, controller.signal, (msg) => {
    noticeMessage = msg;
  });

  expect(preRes.vetoed).toBe(true);
  expect(noticeMessage).toContain("aborted");
});
