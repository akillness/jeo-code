import { test, expect } from "bun:test";
import { applyBashFixups } from "../src/agent/bash-fixups";

test("applyBashFixups: Rule 1: strip-trailing", () => {
  expect(applyBashFixups("ls -la;")).toEqual({ command: "ls -la", applied: ["strip-trailing"] });
  expect(applyBashFixups("ls -la; ")).toEqual({ command: "ls -la", applied: ["strip-trailing"] });
  expect(applyBashFixups("ls -la ")).toEqual({ command: "ls -la", applied: ["strip-trailing"] });
  expect(applyBashFixups("ls -la")).toEqual({ command: "ls -la", applied: [] });
});

test("applyBashFixups: Rule 2: useless-cat (single-stage only)", () => {
  expect(applyBashFixups("cat file.txt | grep foo")).toEqual({
    command: "grep foo file.txt",
    applied: ["useless-cat"],
  });
  expect(applyBashFixups("cat 'file name.txt' | grep \"pattern\"")).toEqual({
    command: "grep \"pattern\" 'file name.txt'",
    applied: ["useless-cat"],
  });
  expect(applyBashFixups("cat file1 file2 | grep foo")).toEqual({ command: "cat file1 file2 | grep foo", applied: [] });
});

test("applyBashFixups: Rule 2 bails on a downstream pipe/compound (no corruption)", () => {
  // Appending the file after a multi-stage pipeline would corrupt it → must passthrough.
  for (const cmd of [
    "cat f | grep x | head",
    "cat f | grep x && echo done",
    "cat f | grep x || echo none",
    "cat f | grep x ; echo next",
  ]) {
    expect(applyBashFixups(cmd)).toEqual({ command: cmd, applied: [] });
  }
});

test("applyBashFixups: Rule 3: dev-null-merge (behavior-identical)", () => {
  expect(applyBashFixups("make build >/dev/null 2>/dev/null")).toEqual({
    command: "make build >/dev/null 2>&1",
    applied: ["dev-null-merge"],
  });
  expect(applyBashFixups("make build 2>/dev/null 1>/dev/null")).toEqual({
    command: "make build >/dev/null 2>&1",
    applied: ["dev-null-merge"],
  });
  // Already canonical, or only one stream redirected → no change.
  expect(applyBashFixups("make build >/dev/null 2>&1")).toEqual({ command: "make build >/dev/null 2>&1", applied: [] });
  expect(applyBashFixups("make build 2>/dev/null")).toEqual({ command: "make build 2>/dev/null", applied: [] });
});

test("applyBashFixups: stderr is never merged into a pipe (intent-changing rule removed)", () => {
  // The old stderr-merge rule changed which stream grep saw — it must NOT exist anymore.
  expect(applyBashFixups("npm test | grep -i error")).toEqual({ command: "npm test | grep -i error", applied: [] });
  expect(applyBashFixups("npm test | grep failed")).toEqual({ command: "npm test | grep failed", applied: [] });
});

test("applyBashFixups: Rule 4: collapse-dot-slash", () => {
  expect(applyBashFixups("././bin/run")).toEqual({ command: "./bin/run", applied: ["collapse-dot-slash"] });
  expect(applyBashFixups("./././bin/run --flag")).toEqual({ command: "./bin/run --flag", applied: ["collapse-dot-slash"] });
  expect(applyBashFixups("./bin/run")).toEqual({ command: "./bin/run", applied: [] });
});

test("applyBashFixups: Rule 5: grep-r-default-path (incl. -R)", () => {
  expect(applyBashFixups("grep -r 'pattern'")).toEqual({ command: "grep -r 'pattern' .", applied: ["grep-r-default-path"] });
  expect(applyBashFixups("grep -rn foo")).toEqual({ command: "grep -rn foo .", applied: ["grep-r-default-path"] });
  expect(applyBashFixups("grep -R foo")).toEqual({ command: "grep -R foo .", applied: ["grep-r-default-path"] });
  expect(applyBashFixups("grep --recursive \"pattern\"")).toEqual({ command: "grep --recursive \"pattern\" .", applied: ["grep-r-default-path"] });
  expect(applyBashFixups("grep -r pattern src/")).toEqual({ command: "grep -r pattern src/", applied: [] });
  expect(applyBashFixups("grep -l pattern")).toEqual({ command: "grep -l pattern", applied: [] });
});

test("applyBashFixups: passthrough; quotes/globs untouched", () => {
  const original = "echo 'hello world' && ls *.ts";
  expect(applyBashFixups(original)).toEqual({ command: original, applied: [] });
});

test("bashTool respects the JEO_BASH_FIXUPS env flag (off by default)", async () => {
  const { bashTool } = await import("../src/agent/tools");
  delete process.env.JEO_BASH_FIXUPS;
  const resOff = await bashTool("././nonexistent_script_file");
  expect(resOff.output).toContain("././nonexistent_script_file");

  process.env.JEO_BASH_FIXUPS = "1";
  const resOn = await bashTool("././nonexistent_script_file");
  expect(resOn.output).toContain("./nonexistent_script_file");
  expect(resOn.output).not.toContain("././nonexistent_script_file");

  delete process.env.JEO_BASH_FIXUPS;
});
