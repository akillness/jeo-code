import { test, expect } from "bun:test";
import { matchSlash, isSlashAttempt, SLASH_COMMANDS } from "../src/tui/components/slash";

test("matchSlash: prefix-matches slash commands, case-insensitive", () => {
  expect(matchSlash("/")).toEqual(SLASH_COMMANDS);
  expect(matchSlash("/c")).toEqual(["/clear", "/compact"]);
  expect(matchSlash("/MO")).toEqual(["/model"]);
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
