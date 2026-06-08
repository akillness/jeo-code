import { test, expect } from "bun:test";
import { suggestCommands, findCommand, dispatch, renderHelp } from "../src/cli/runner";

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

test("dispatch: --version prints and returns 0", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["--version"], { appName: "joc", version: "9.9.9" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(0);
  expect(logs.join("\n")).toContain("joc v9.9.9");
});

test("dispatch: unknown command returns 1 and suggests a near match", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["doctr"], { appName: "joc", version: "0.0.0" });
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
  const help = renderHelp({ appName: "joc", version: "0.0.0" });
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
    code = await dispatch(["deep-interview", "--help"], { appName: "joc", version: "0.0.0" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(0);
  const text = logs.join("\n");
  expect(text).toContain("Usage: joc deep-interview");
  expect(text).toContain("Socratic"); // the command summary, not the global help
  expect(text).not.toContain("Commands:"); // global help not printed
});

test("dispatch: --list-models routes to GJC-style catalog output", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let code: number;
  try {
    code = await dispatch(["--list-models", "gpt"], { appName: "joc", version: "0.0.0" });
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
    code = await dispatch(["--models", "--catalog", "gpt"], { appName: "joc", version: "0.0.0" });
  } finally {
    console.log = orig;
  }
  expect(code).toBe(0);
  const text = logs.join("\n");
  expect(text).toContain("Canonical models matching 'gpt'");
});
