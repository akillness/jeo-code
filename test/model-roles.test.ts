import { test, expect } from "bun:test";
import { resolveRoleModel, type ModelRole } from "../src/ai/model-manager";

test("resolveRoleModel: tier override wins, else falls back to defaultModel", () => {
  const cfg = { defaultModel: "claude-3-5-sonnet", roles: { smol: "fast", plan: "o3" } };
  expect(resolveRoleModel("smol", cfg)).toBe("fast");
  expect(resolveRoleModel("plan", cfg)).toBe("o3");
  expect(resolveRoleModel("slow", cfg)).toBe("claude-3-5-sonnet"); // unset → default
});

test("resolveRoleModel with no roles falls back for every tier", () => {
  const cfg = { defaultModel: "gpt-4o" };
  for (const role of ["smol", "slow", "plan"] as ModelRole[]) {
    expect(resolveRoleModel(role, cfg)).toBe("gpt-4o");
  }
});

test("an empty-string tier value falls back to default (not the empty string)", () => {
  const cfg = { defaultModel: "flash", roles: { smol: "" } };
  expect(resolveRoleModel("smol", cfg)).toBe("flash");
});
