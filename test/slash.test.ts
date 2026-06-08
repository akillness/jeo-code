import { test, expect } from "bun:test";
import { matchSlash, isSlashAttempt, SLASH_COMMANDS, SLASH_COMMAND_DETAILS, formatSlashCommandList, formatSlashPreview, slashPreviewMatches } from "../src/tui/components/slash";

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
test("SLASH_COMMANDS includes the config and subagent commands", () => {
  for (const cmd of ["/model", "/models", "/provider", "/agents", "/subagent", "/subagents", "/config", "/thinking"]) {
    expect(SLASH_COMMANDS).toContain(cmd);
  }
});

test("slash command details stay in sync with command names", () => {
  expect(SLASH_COMMAND_DETAILS.map(c => c.command)).toEqual(SLASH_COMMANDS);
  expect(SLASH_COMMAND_DETAILS.find(c => c.command === "/agents")?.usage).toContain("maxSteps");
});

test("matchSlash distinguishes /model from /models", () => {
  expect(matchSlash("/model")).toEqual(["/model", "/models"]);
  expect(matchSlash("/models")).toEqual(["/models"]);
  expect(matchSlash("/p")).toEqual(["/provider"]);
  expect(matchSlash("/t")).toEqual(["/thinking"]);
  expect(matchSlash("/sub")).toEqual(["/subagent", "/subagents"]);
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

test("formatSlashCommandList lists all commands for bare slash and narrows by prefix", () => {
  const all = formatSlashCommandList("/").join("\n");
  expect(all).toContain("Slash Commands:");
  expect(all).toContain("/model [id|#N|save]");
  expect(all).toContain("/agents [role] [model|#N|maxSteps N|reset]");
  expect(all).toContain("Subagents:");
  expect(all).toContain("/subagent [role] [model|#N|maxSteps N|reset]");
  expect(formatSlashCommandList("/?").join("\n")).toContain("/agents [role] [model|#N|maxSteps N|reset]");

  const modelOnly = formatSlashCommandList("/m").join("\n");
  expect(modelOnly).toContain("Slash Commands matching '/m':");
  expect(modelOnly).toContain("/model");
  expect(modelOnly).toContain("/models");
  expect(modelOnly).not.toContain("/agents");
});

test("formatSlashCommandList returns an unknown hint for non-matches", () => {
  expect(formatSlashCommandList("/zzz")).toEqual(["Unknown command '/zzz'. Try /help."]);
});

test("formatSlashPreview: live preview for a slash keyword prefix", () => {
  // bare "/m" → matching command usages
  const m = formatSlashPreview("/m").join("\n");
  expect(m).toContain("/model");
  expect(m).toContain("/models");
  expect(m).not.toContain("/agents");
  // a unique prefix shows the one command
  expect(formatSlashPreview("/thi").join("\n")).toContain("/thinking");
});

test("formatSlashPreview: empty for non-slash, argument input, or no match", () => {
  expect(formatSlashPreview("")).toEqual([]);
  expect(formatSlashPreview("hello")).toEqual([]);
  expect(formatSlashPreview("/model gpt-4o")).toEqual([]); // has a space → real command, not a keyword probe
  expect(formatSlashPreview("/zzz")).toEqual([]);
});

test("formatSlashPreview: caps the list with a +N more line", () => {
  const out = formatSlashPreview("/", 3);
  expect(out.length).toBe(4); // 3 rows + overflow line
  expect(out[3]).toContain("more");
});

test("formatSlashPreview: selected index marks the highlighted row with ❯", () => {
  const out = formatSlashPreview("/m", 6, 1).map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
  // /m → /model (row 0), /models (row 1) → row 1 selected
  expect(out[0].startsWith("  ")).toBe(true);
  expect(out[1].startsWith("❯ ")).toBe(true);
  expect(out[1]).toContain("/models");
});

test("slashPreviewMatches: command names in display order; empty for args/non-slash", () => {
  expect(slashPreviewMatches("/m")).toEqual(["/model", "/models"]);
  expect(slashPreviewMatches("/model gpt")).toEqual([]); // has a space
  expect(slashPreviewMatches("hello")).toEqual([]);
  // index alignment: matches[i] corresponds to formatSlashPreview row i
  const matches = slashPreviewMatches("/c");
  const rows = formatSlashPreview("/c", 20).map(l => l.replace(/❯ |  /, ""));
  matches.forEach((cmd, i) => expect(rows[i]).toContain(cmd));
});
