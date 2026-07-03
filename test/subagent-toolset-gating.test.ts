import { test, expect } from "bun:test";
import { subagentToolset, getSubagentRole } from "../src/agent/subagents";

test("read-only roles get the read-only ast_grep/lsp tools but not their mutating counterparts", () => {
  const planner = getSubagentRole("planner")!;
  expect(planner.readOnly).toBe(true);
  const toolset = subagentToolset(planner);

  expect(typeof toolset.ast_grep).toBe("function");
  expect(toolset.ast_edit).toBeUndefined();

  expect(typeof toolset.lsp).toBe("function");
  expect(toolset.lsp_rename).toBeUndefined();

  expect(toolset.computer).toBeUndefined();
  expect(toolset.debug).toBeUndefined();
  expect(toolset.write).toBeUndefined();
  expect(toolset.edit).toBeUndefined();
  expect(toolset.bash).toBeUndefined();
});

test("the mutating executor role gets every tool, including the mutating ones", () => {
  const executor = getSubagentRole("executor")!;
  expect(executor.readOnly).toBe(false);
  const toolset = subagentToolset(executor);

  expect(typeof toolset.ast_grep).toBe("function");
  expect(typeof toolset.ast_edit).toBe("function");
  expect(typeof toolset.lsp).toBe("function");
  expect(typeof toolset.lsp_rename).toBe("function");
  expect(typeof toolset.computer).toBe("function");
  expect(typeof toolset.debug).toBe("function");
});

test("every bundled read-only role (planner/architect/critic) excludes ast_edit, lsp_rename, computer, and debug", () => {
  for (const id of ["planner", "architect", "critic"]) {
    const role = getSubagentRole(id)!;
    expect(role.readOnly).toBe(true);
    const toolset = subagentToolset(role);
    expect(toolset.ast_edit).toBeUndefined();
    expect(toolset.lsp_rename).toBeUndefined();
    expect(toolset.computer).toBeUndefined();
    expect(toolset.debug).toBeUndefined();
  }
});
