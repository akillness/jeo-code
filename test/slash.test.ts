import { test, expect } from "bun:test";
import { matchSlash, isSlashAttempt, suggestSlashCommands, SLASH_COMMANDS, SLASH_COMMAND_DETAILS, formatSlashCommandList, formatSlashPreview, slashPreviewMatches, activeTriggerToken, committedTriggerToken, allTriggerTokens, type SlashCommandInfo } from "../src/tui/components/slash";

test("matchSlash: prefix matches lead, fuzzy subsequence hits trail (case-insensitive)", () => {
  expect(matchSlash("/")).toEqual(SLASH_COMMANDS);
  // Prefix block comes first, in palette order; fuzzy hits may follow.
  expect(matchSlash("/c").slice(0, 5)).toEqual(["/clear", "/changelog", "/compact", "/context", "/computer"]);

  expect(matchSlash("/MO").slice(0, 1)).toEqual(["/model"]);
  expect(matchSlash("/exit")).toEqual(["/exit"]);
  expect(matchSlash("/zzz")).toEqual([]);
  expect(matchSlash("hello")).toEqual([]); // non-slash → no matches
  // Fuzzy fallback: an abbreviation with no prefix match still finds its command.
  expect(matchSlash("/expt")).toEqual(["/export"]);
});

test("matchSlash: description fallback resolves intent queries with no name match (gjc §2.1)", () => {
  // No command name is a subsequence of "oauth", but /login & /provider describe OAuth.
  const oauth = matchSlash("/oauth");
  expect(oauth).toContain("/login");
  expect(oauth).toContain("/provider");
  // Only /dump mentions the clipboard in its description.
  expect(matchSlash("/clipboard")).toEqual(["/dump"]);
  // A real name match suppresses the description fallback entirely (no noise leak).
  expect(matchSlash("/mod")).toEqual(["/model"]);
  // Sub-2-char queries never trigger the fallback.
  expect(matchSlash("/z")).toEqual([]);
});

test("isSlashAttempt: slash without a space", () => {
  expect(isSlashAttempt("/model")).toBe(true);
  expect(isSlashAttempt("/foo")).toBe(true);
  expect(isSlashAttempt("/model gpt-4o")).toBe(false); // has an arg → real command, not a typo probe
  expect(isSlashAttempt("hello")).toBe(false);
});
test("SLASH_COMMANDS includes the config and role-model commands", () => {
  for (const cmd of ["/model", "/fast", "/provider", "/agents", "/config", "/thinking"]) {
    expect(SLASH_COMMANDS).toContain(cmd);
  }
});

test("slash command details stay in sync with command names", () => {
  expect(SLASH_COMMAND_DETAILS.map(c => c.command)).toEqual(SLASH_COMMANDS);
  expect(SLASH_COMMAND_DETAILS.find(c => c.command === "/agents")?.usage).toContain("thinking");
});

test("matchSlash exposes /model and /fast without the removed /models menu item", () => {
  expect(matchSlash("/model")[0]).toBe("/model");
  expect(matchSlash("/models")).not.toContain("/models");
  expect(matchSlash("/f")[0]).toBe("/fast");
  expect(matchSlash("/p")[0]).toBe("/provider");
  expect(matchSlash("/t").slice(0, 3)).toEqual(["/thinking", "/tools", "/theme"]);
  expect(matchSlash("/ag")[0]).toBe("/agents");
});

test("SLASH_COMMANDS includes the code-view commands (view/diff/find/search)", () => {
  for (const cmd of ["/view", "/diff", "/find", "/search"]) {
    expect(SLASH_COMMANDS).toContain(cmd);
  }
});

test("matchSlash resolves the code-view command prefixes", () => {
  expect(matchSlash("/v")[0]).toBe("/view");
  expect(matchSlash("/d").slice(0, 3)).toEqual(["/drop", "/dump", "/diff"]);
  expect(matchSlash("/sea")[0]).toBe("/search");
});

test("formatSlashCommandList lists all commands for bare slash and narrows by prefix", () => {
  const all = formatSlashCommandList("/").join("\n");
  expect(all).toContain("Slash Commands:");
  expect(all).toContain("/model [id|#N|save|thinking <level>|subagent <role> <model|#N|thinking L>]");
  expect(all).toContain("/agents [edit|role] [model|#N|thinking L|maxSteps N|reset]");
  expect(all).toContain("Subagents:");
  expect(all).toContain("/subagent [role]"); // view alias of /agents (re-added by user request)
  expect(formatSlashCommandList("/?").join("\n")).toContain("/agents [edit|role] [model|#N|thinking L|maxSteps N|reset]");

  const modelOnly = formatSlashCommandList("/m").join("\n");
  expect(modelOnly).toContain("Slash Commands matching '/m':");
  expect(modelOnly).toContain("/model");
  expect(modelOnly).not.toContain("/models");
  expect(modelOnly).not.toContain("/agents");
});

test("formatSlashCommandList returns an unknown hint for non-matches", () => {
  expect(formatSlashCommandList("/zzz")).toEqual(["Unknown command '/zzz'. Try /help."]);
});

test("suggestSlashCommands: a near-miss typo resolves to the closest command (gjc /provicer → /provider)", () => {
  expect(suggestSlashCommands("/provicer")).toContain("/provider");
  expect(suggestSlashCommands("/proivder")).toContain("/provider");
  expect(suggestSlashCommands("/modle")).toContain("/model");
});

test("suggestSlashCommands: no suggestion for far-off input or exact/prefix hits", () => {
  expect(suggestSlashCommands("/zzz")).toEqual([]);
  // exact + prefix hits are surfaced by matchSlash, so they are excluded here
  expect(suggestSlashCommands("/model")).not.toContain("/model");
});

test("formatSlashCommandList suggests the nearest command for a typo", () => {
  expect(formatSlashCommandList("/provicer")).toEqual(["Unknown command '/provicer'. Did you mean /provider?"]);
});

test("formatSlashPreview: live preview for a slash keyword prefix", () => {
  // bare "/m" → matching command usages
  const m = formatSlashPreview("/m").join("\n");
  expect(m).toContain("/model");
  expect(m).not.toContain("/models");
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

test("formatSlashPreview: overflow scrolls a window within the row budget with ↑/↓ markers", () => {
  const out = formatSlashPreview("/", 3);
  // 23 commands match "/", budget 3 → at most 3 lines total (markers included).
  expect(out.length).toBeLessThanOrEqual(3);
  // From the top (no selection) there are hidden rows below → a ↓ marker, no ↑ marker.
  expect(out.some(l => l.includes("↓") && l.includes("more"))).toBe(true);
  expect(out.some(l => l.includes("↑"))).toBe(false);
});

test("formatSlashPreview: a far-down selection stays visible inside the scroll window", () => {
  const matches = slashPreviewMatches("/"); // full command list
  const last = matches.length - 1;
  const out = formatSlashPreview("/", 8, last).map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
  expect(out.length).toBeLessThanOrEqual(8);
  // The selected (last) command is rendered AND carries the ▸ cursor.
  const sel = out.find(l => l.startsWith("▸ "));
  expect(sel).toBeDefined();
  expect(sel!).toContain(matches[last]!.slice(1)); // usage starts with the command name sans leading marker
  // Scrolled past the top → an ↑ marker is present.
  expect(out.some(l => l.includes("↑"))).toBe(true);
});

test("formatSlashPreview: selected index marks the highlighted row with ▸", () => {
  const out = formatSlashPreview("/f", 6, 0).map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
  expect(out[0].startsWith("▸ ")).toBe(true);
  expect(out[0]).toContain("/fast");
});

test("slashPreviewMatches: command names in display order; empty for args/non-slash", () => {
  expect(slashPreviewMatches("/m").slice(0, 1)).toEqual(["/model"]); // prefix hits lead; fuzzy may trail
  expect(slashPreviewMatches("/model gpt")).toEqual([]); // has a space
  expect(slashPreviewMatches("hello")).toEqual([]);
  // index alignment: matches[i] corresponds to formatSlashPreview row i
  const matches = slashPreviewMatches("/c");
  const rows = formatSlashPreview("/c", 20).map(l => l.replace(/▸ |  /, ""));
  matches.forEach((cmd, i) => expect(rows[i]).toContain(cmd));
});

test("dynamic skill slash aliases appear in palette, preview, and selection order", () => {
  const dynamic: SlashCommandInfo[] = [
    { command: "/speckit.plan", usage: "/speckit.plan [intent]", description: "Run spec-kit plan", group: "skills" },
    { command: "/speckit.tasks", usage: "/speckit.tasks [intent]", description: "Run spec-kit tasks", group: "skills" },
  ];
  expect(matchSlash("/speckit.p", dynamic.map(d => d.command))).toEqual(["/speckit.plan"]);
  expect(formatSlashCommandList("/speckit", dynamic).join("\n")).toContain("Skills:");
  expect(formatSlashPreview("/speckit.t", 6, 0, dynamic).join("\n")).toContain("▸ /speckit.tasks");
  expect(slashPreviewMatches("/speckit", dynamic)).toEqual(["/speckit.plan", "/speckit.tasks"]);
});

test("formatSlashPreview: overflow shows an (i/total) position counter that tracks selected", () => {
  const total = slashPreviewMatches("/").length;
  expect(total).toBeGreaterThan(3); // ensure the list overflows a budget of 3

  // No selection → window starts at the top → (1/total) on the ↓ marker.
  const top = formatSlashPreview("/", 3, -1);
  expect(top.length).toBeLessThanOrEqual(3);
  const topMore = top.find(l => l.includes("↓") && l.includes("more"));
  expect(topMore).toBeDefined();
  expect(topMore!).toContain(`(1/${total})`);

  // Selecting row 2 (0-based) → counter reads (3/total) and the index follows.
  const mid = formatSlashPreview("/", 3, 2).map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
  expect(mid.length).toBeLessThanOrEqual(3);
  expect(mid.some(l => l.includes(`(3/${total})`))).toBe(true);
  expect(mid.some(l => l.includes(`(1/${total})`))).toBe(false);

  // Selecting the last row → counter reads (total/total) on whichever marker is shown.
  const last = formatSlashPreview("/", 3, total - 1).map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
  expect(last.length).toBeLessThanOrEqual(3);
  expect(last.some(l => l.includes(`(${total}/${total})`))).toBe(true);
});

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("$ prefix pops up matching skills with summaries (live popup)", () => {
  const skills = [
    { name: "spec-kit", summary: "Spec-first workflow kit" },
    { name: "speckit-extra", summary: "" },
    { name: "team", summary: "Coordinated execution" },
  ];
  // Bare `$` lists every skill.
  const all = formatSlashPreview("$", 6, -1, [], skills).map(stripAnsi);
  expect(all.length).toBe(3);
  expect(all[0]).toContain("$spec-kit [intent]");
  expect(all[0]).toContain("Spec-first workflow kit");
  expect(all[1]).toContain("run this skill directly"); // empty summary fallback
  // Prefix narrows: `$sp` → the two spec* skills only.
  const sp = formatSlashPreview("$sp", 6, -1, [], skills).map(stripAnsi);
  expect(sp.length).toBe(2);
  expect(sp.join("\n")).not.toContain("$team");
  // Selection highlight marker on the chosen row.
  const sel = formatSlashPreview("$", 6, 2, [], skills).map(stripAnsi);
  expect(sel[2]).toContain("▸");
  expect(sel[2]).toContain("$team");
  // A space means a real invocation is being typed — popup closes.
  expect(formatSlashPreview("$team build it", 6, -1, [], skills)).toEqual([]);
});

test("slashPreviewMatches returns $skill names for arrow-key navigation", () => {
  const skills = [{ name: "spec-kit" }, { name: "team" }];
  expect(slashPreviewMatches("$", [], skills)).toEqual(["$spec-kit", "$team"]);
  expect(slashPreviewMatches("$te", [], skills)).toEqual(["$team"]);
  expect(slashPreviewMatches("$zzz", [], skills)).toEqual([]);
  expect(slashPreviewMatches("$team go", [], skills)).toEqual([]);
  // `/` behavior unchanged
  expect(slashPreviewMatches("/he", [], skills).length).toBeGreaterThan(0);
});

test("activeTriggerToken: finds /cmd and $skill tokens anywhere in the line", () => {
  // Leading tokens (classic behavior).
  expect(activeTriggerToken("/mo")).toEqual({ kind: "/", token: "/mo", start: 0 });
  expect(activeTriggerToken("$te")).toEqual({ kind: "$", token: "$te", start: 0 });
  expect(activeTriggerToken("/")).toEqual({ kind: "/", token: "/", start: 0 });
  expect(activeTriggerToken("$")).toEqual({ kind: "$", token: "$", start: 0 });
  // Mid-text tokens (mention-style, position-independent).
  expect(activeTriggerToken("fix the bug /mo")).toEqual({ kind: "/", token: "/mo", start: 12 });
  expect(activeTriggerToken("explain $te")).toEqual({ kind: "$", token: "$te", start: 8 });
  expect(activeTriggerToken("  /he")).toEqual({ kind: "/", token: "/he", start: 2 });
  // No trigger once the token is finished (space follows) or the active word is plain.
  expect(activeTriggerToken("/model gpt")).toBeUndefined();
  expect(activeTriggerToken("$team build it")).toBeUndefined();
  expect(activeTriggerToken("/model ")).toBeUndefined();
  // Glued / and $ inside a word are paths/vars, never triggers.
  expect(activeTriggerToken("see src/cli")).toBeUndefined();
  expect(activeTriggerToken("echo FOO$BAR")).toBeUndefined();
  expect(activeTriggerToken("hello")).toBeUndefined();
  expect(activeTriggerToken("")).toBeUndefined();
});

test("committedTriggerToken: keeps the LEADING /cmd or $skill keyword after a space", () => {
  // Once committed with a trailing space the leading keyword stays recognizable so
  // the trigger highlight persists while arguments are typed.
  expect(committedTriggerToken("/model gpt-4")).toEqual({ kind: "/", token: "/model", start: 0 });
  expect(committedTriggerToken("$test the bug")).toEqual({ kind: "$", token: "$test", start: 0 });
  expect(committedTriggerToken("/model ")).toEqual({ kind: "/", token: "/model", start: 0 });
  expect(committedTriggerToken("  /help me")).toEqual({ kind: "/", token: "/help", start: 2 });
  // Still being typed (no space yet) — the active-token path owns it.
  expect(committedTriggerToken("/model")).toBeUndefined();
  expect(committedTriggerToken("/mo")).toBeUndefined();
  // Only the LEADING word counts; a mid-sentence finished token is not a command.
  expect(committedTriggerToken("fix the bug /mo done")).toBeUndefined();
  expect(committedTriggerToken("plain text here")).toBeUndefined();
  expect(committedTriggerToken("")).toBeUndefined();
});

test("allTriggerTokens: every /command and $skill word, left-to-right, anywhere", () => {
  // Multiple invocations on one line are all reported, in order.
  expect(allTriggerTokens("/model x then $test y")).toEqual([
    { kind: "/", token: "/model", start: 0 },
    { kind: "$", token: "$test", start: 14 },
  ]);
  // A still-being-typed trailing token is included too (highlight follows it live).
  expect(allTriggerTokens("fix the bug /mo")).toEqual([{ kind: "/", token: "/mo", start: 12 }]);
  // Leading whitespace is skipped; start points at the token's first char.
  expect(allTriggerTokens("  /help me")).toEqual([{ kind: "/", token: "/help", start: 2 }]);
  // Glued /·$ inside a word stay excluded — paths and shell vars never light up.
  expect(allTriggerTokens("see src/cli and echo FOO$BAR")).toEqual([]);
  // No triggers / empty line → empty list.
  expect(allTriggerTokens("plain text here")).toEqual([]);
  expect(allTriggerTokens("")).toEqual([]);
});

test("formatSlashPreview: command popup opens for a /token at any position", () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const mid = formatSlashPreview("fix the bug then /mo", 6, -1).map(stripAnsi).join("\n");
  expect(mid).toContain("/model");
  expect(mid).not.toContain("/models");
  // Path-looking words do not pop the command list.
  expect(formatSlashPreview("open src/cli.ts", 6, -1)).toEqual([]);
});

test("formatSlashPreview: skill popup opens for a $token at any position", () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const skills = [{ name: "spec-kit", summary: "Spec writing" }, { name: "team", summary: "Coordinated execution" }];
  const mid = formatSlashPreview("please run $te", 6, -1, [], skills).map(stripAnsi).join("\n");
  expect(mid).toContain("$team");
  expect(mid).not.toContain("$spec-kit");
  // Env-var-looking words do not pop the skill list.
  expect(formatSlashPreview("echo $HOME stuff", 6, -1, [], skills)).toEqual([]);
});

test("slashPreviewMatches: arrow-selection matches follow the mid-text token", () => {
  const skills = [{ name: "spec-kit" }, { name: "team" }];
  expect(slashPreviewMatches("do X then $te", [], skills)).toEqual(["$team"]);
  expect(slashPreviewMatches("do X then /mo", [], skills).slice(0, 1)).toEqual(["/model"]);
  expect(slashPreviewMatches("do X then $te done", [], skills)).toEqual([]);
});

import { tabCompleteSelection } from "../src/tui/components/slash";

test("tabCompleteSelection: highlighted row wins, else top match; trailing space closes the popup", () => {
  const matches = ["/model", "/models", "/mod"];
  expect(tabCompleteSelection("/mo", matches, -1)).toBe("/model ");  // no highlight → top (prefix-first) match
  expect(tabCompleteSelection("/mo", matches, 1)).toBe("/models ");  // arrowed selection wins
  expect(tabCompleteSelection("/mo", matches, 99)).toBe("/model ");  // out-of-range → top
  expect(tabCompleteSelection("/mo", [], 0)).toBeUndefined();        // nothing to complete
  expect(tabCompleteSelection("$sp", ["$spec-kit"], -1)).toBe("$spec-kit "); // $ skills complete the same way

});
