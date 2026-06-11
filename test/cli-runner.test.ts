import { test, expect } from "bun:test";
import { suggestCommands, findCommand, dispatch, renderHelp, globalModelsArgs } from "../src/cli/runner";

test("suggestCommands: recovers from common typos", () => {
  expect(suggestCommands("lauch")).toContain("launch");
  expect(suggestCommands("modls")).toContain("models");
  expect(suggestCommands("doctr")).toContain("doctor");
  expect(suggestCommands("set")).toContain("setup"); // prefix
  expect(suggestCommands("xqzptv")).toEqual([]); // nothing close
  expect(suggestCommands("")).toEqual([]);
});

test("findCommand: known commands resolve, unknown returns undefined", () => {
  expect(findCommand("doctor")?.name).toBe("doctor");
  expect(findCommand("nope")).toBeUndefined();
});

test("globalModelsArgs only scans the leading global flag segment", () => {
  expect(globalModelsArgs(["--tmux", "--models", "--catalog", "gpt"])).toEqual(["--catalog", "gpt"]);
  expect(globalModelsArgs(["--tmux", "--list-models=gemini"])).toEqual(["--catalog", "gemini"]);
  expect(globalModelsArgs(["--tmux", "--models", "--caps", "--thinking=high"])).toEqual(["--caps", "--thinking=high"]);
  expect(globalModelsArgs(["--tmux", "--", "--models", "routing"])).toBeNull();
  expect(globalModelsArgs(["--tmux", "fix", "--models", "routing"])).toBeNull();
  expect(globalModelsArgs(["doctor", "--models"])).toBeNull();
  // A real 8-4-4-4-12 UUID after --resume must be skipped so a trailing --models is still seen.
  expect(globalModelsArgs(["--resume", "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "--models", "caps"])).toEqual(["caps"]);
});

test("dispatch: --version prints and returns 0", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["--version"], { appName: "jeo", version: "9.9.9" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(0);
  expect(logs.join("\n")).toContain("jeo v9.9.9");
});

test("dispatch: --tmux --version and --tmux --help stay global", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    expect(await dispatch(["--tmux", "--version"], { appName: "jeo", version: "9.9.9" })).toBe(0);
    expect(await dispatch(["--tmux", "--help"], { appName: "jeo", version: "9.9.9" })).toBe(0);
  } finally {
    console.log = orig;
  }
  const text = logs.join("\n");
  expect(text).toContain("jeo v9.9.9");
  expect(text).toContain("Options:");
  expect(text).not.toContain("Starting new tmux session");
});

test("dispatch: unknown command returns 1 and suggests a near match", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["doctr"], { appName: "jeo", version: "0.0.0" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(1);
  const text = logs.join("\n");
  expect(text).toContain("Unknown command: doctr");
  expect(text).toContain("Did you mean");
  expect(text).toContain("doctor");
});

test("renderHelp lists every command", () => {
  const help = renderHelp({ appName: "jeo", version: "0.0.0" });
  expect(help).toContain("launch");
  expect(help).toContain("doctor");
  expect(help).toContain("ultragoal");
  expect(help).toContain("--model <id>");
  expect(help).toContain("--models");
  expect(help).toContain("--thinking <level>");
});

test("dispatch: per-command --help prints that command's usage without running it", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["deep-interview", "--help"], { appName: "jeo", version: "0.0.0" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(0);
  const text = logs.join("\n");
  expect(text).toContain("Usage: jeo deep-interview");
  expect(text).toContain("Socratic"); // the command summary, not the global help
  expect(text).not.toContain("Commands:"); // global help not printed
});

test("dispatch: --list-models routes to GJC-style catalog output", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["--list-models", "gpt"], { appName: "jeo", version: "0.0.0" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(0);
  const text = logs.join("\n");
  expect(text).toContain("Canonical models matching 'gpt'");
  expect(text).toContain("Provider models");
});

test("dispatch: --models routes to the models command", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["--models", "--catalog", "gpt"], { appName: "jeo", version: "0.0.0" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(0);
  const text = logs.join("\n");
  expect(text).toContain("Canonical models matching 'gpt'");
});

test("dispatch: tmux plus --models still routes to models listing", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["--tmux", "--models", "--catalog", "gpt"], { appName: "jeo", version: "0.0.0" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(0);
  const text = logs.join("\n");
  expect(text).toContain("Canonical models matching 'gpt'");
  expect(text).not.toContain("Starting new tmux session");
});

test("dispatch: tmux plus --list-models still routes to catalog listing", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["--tmux", "--list-models", "gemini"], { appName: "jeo", version: "0.0.0" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(0);
  expect(logs.join("\n")).toContain("Canonical models matching 'gemini'");
});

test("dispatch: launch plus tmux model-list flags routes to models command", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["launch", "--tmux", "--list-models=gemini"], { appName: "jeo", version: "0.0.0" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(0);
  expect(logs.join("\n")).toContain("Canonical models matching 'gemini'");
});

test("dispatch: unknown command with later --models is not hijacked", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["definitely-not-a-cmd", "--models"], { appName: "jeo", version: "0.0.0" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(1);
  expect(logs.join("\n")).toContain("Unknown command: definitely-not-a-cmd");
});
