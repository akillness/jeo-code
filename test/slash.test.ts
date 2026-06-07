import { test, expect } from "bun:test";
import { matchSlash, isSlashAttempt, SLASH_COMMANDS } from "../src/tui/components/slash";

test("matchSlash: prefix-matches slash commands, case-insensitive", () => {
  expect(matchSlash("/")).toEqual(SLASH_COMMANDS);
  expect(matchSlash("/c")).toEqual(["/clear", "/compact", "/config"]);
  expect(matchSlash("/MO")).toEqual(["/model", "/models"]);
  expect(matchSlash("/exit")).toEqual(["/exit"]);
  expect(matchSlash("/zzz")).toEqual([]);
  expect(matchSlash("hello")).toEqual([]); // non-slash → no matches
});

test("isSlashAttempt: slash without a space", () => {
  expect(isSlashAttempt("/model")).toBe(true);
  expect(isSlashAttempt("/foo")).toBe(true);
  expect(isSlashAttempt("/model gpt-4o")).toBe(false); // has an arg → real command, not a typo probe
  expect(isSlashAttempt("hello")).toBe(false);
});
test("SLASH_COMMANDS includes the config commands (model/provider/agents/config/thinking)", () => {
  for (const cmd of ["/model", "/models", "/provider", "/agents", "/config", "/thinking"]) {
    expect(SLASH_COMMANDS).toContain(cmd);
  }
});

test("matchSlash distinguishes /model from /models", () => {
  expect(matchSlash("/model")).toEqual(["/model", "/models"]);
  expect(matchSlash("/models")).toEqual(["/models"]);
  expect(matchSlash("/p")).toEqual(["/provider"]);
  expect(matchSlash("/t")).toEqual(["/thinking"]);
});

test("SLASH_COMMANDS includes the code-view commands (view/diff/find/search)", () => {
  for (const cmd of ["/view", "/diff", "/find", "/search"]) {
    expect(SLASH_COMMANDS).toContain(cmd);
  }
});

test("matchSlash resolves the code-view command prefixes", () => {
  expect(matchSlash("/v")).toEqual(["/view"]);
  expect(matchSlash("/d")).toEqual(["/diff"]);
  expect(matchSlash("/sea")).toEqual(["/search"]);
});
