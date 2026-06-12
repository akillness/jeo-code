import { test, expect } from "bun:test";
import {
  complete,
  tokenize,
  commonPrefix,
  readlineCompleter,
  formatCompletionPreview,
  staticCompletionContext,
  type CompletionContext,
} from "../src/tui/components/autocomplete";
const ctx = (over: Partial<CompletionContext> = {}): CompletionContext => ({
  slashCommands: ["/model", "/models", "/provider", "/agents", "/thinking", "/help"],
  liveModels: ["claude-3-5-sonnet-live", "gpt-4o-live"],
  aliases: ["fast", "sonnet", "gpt"],
  catalogModels: ["claude-3-5-sonnet", "gpt-4o", "gemini-2.0-flash"],
  providers: ["anthropic", "openai", "gemini", "ollama"],
  roleIds: ["executor", "planner", "architect", "critic"],
  thinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
  modelsForProvider: p => (p === "openai" ? ["gpt-4o-live", "gpt-4o-mini-live"] : []),
  mentionPaths: prefix => (prefix === "" ? ["src/", "README.md"] : prefix === "src/" ? ["src/commands/", "src/tui/"] : prefix === "src/c" ? ["src/commands/"] : []),
  ...over,
});

test("tokenize tracks tokens + trailing space", () => {
  expect(tokenize("/model gpt")).toEqual({ tokens: ["/model", "gpt"], trailingSpace: false });
  expect(tokenize("/model ")).toEqual({ tokens: ["/model"], trailingSpace: true });
});

test("non-slash input is not completed", () => {
  expect(complete("hello world", ctx()).completions).toEqual([]);
});

test("@path mentions complete in free-text mode", () => {
  const root = complete("@", ctx());
  expect(root.kind).toBe("path");
  expect(root.completions).toContain("@src/");
  const nested = complete("please inspect @src/c", ctx());
  expect(nested.kind).toBe("path");
  expect(nested.token).toBe("@src/c");
  expect(nested.completions).toEqual(["@src/commands/"]);
});

test("completes the slash command name by prefix", () => {
  const r = complete("/mod", ctx());
  expect(r.kind).toBe("command");
  expect(r.completions).toEqual(["/model", "/models"]);
  expect(r.token).toBe("/mod");
});

test("completes dynamic skill slash command aliases from context", () => {
  const r = complete("/speckit.p", ctx({ slashCommands: ["/model", "/speckit.plan", "/speckit.tasks"] }));
  expect(r.kind).toBe("command");
  expect(r.completions).toEqual(["/speckit.plan"]);
});

test("/model completes live models first, then aliases, then catalog", () => {
  const r = complete("/model ", ctx()); // empty token → all
  expect(r.kind).toBe("model");
  // "save" keyword is offered, and model ids rank live → alias → catalog
  expect(r.completions).toContain("save");
  expect(r.completions).toContain("fast");
  const idx = (s: string) => r.completions.indexOf(s);
  expect(idx("claude-3-5-sonnet-live")).toBeLessThan(idx("fast"));
  expect(idx("fast")).toBeLessThan(idx("claude-3-5-sonnet"));
  // prefix filter
  const g = complete("/model gpt", ctx());
  expect(g.completions).toContain("gpt-4o-live");
  expect(g.completions).toContain("gpt"); // alias
  expect(g.completions.every(c => c.toLowerCase().startsWith("gpt"))).toBe(true);
});

test("/model #N is not completed (numbered pick)", () => {
  expect(complete("/model #1", ctx()).completions).toEqual([]);
});

test("/models completes model-list subcommands", () => {
  expect(complete("/models ", ctx()).completions).toEqual(["refresh", "caps", "catalog"]);
  expect(complete("/models re", ctx()).completions).toEqual(["refresh"]);
  expect(complete("/models ca", ctx()).completions).toEqual(["caps", "catalog"]);
});

test("/provider completes login/auth + names, then that provider's live models", () => {
  expect(complete("/provider ", ctx()).completions).toEqual(["login", "auth", "anthropic", "openai", "gemini", "ollama"]);
  // `/provider login ` → OAuth-capable cloud providers
  expect(complete("/provider login ", ctx()).completions).toEqual(["anthropic", "openai", "gemini", "antigravity"]);
  const second = complete("/provider openai ", ctx());
  expect(second.kind).toBe("model");
  expect(second.completions).toEqual(["gpt-4o-live", "gpt-4o-mini-live"]);
});

test("/logout completes cloud provider names", () => {
  expect(complete("/logout ", ctx()).completions).toEqual(["anthropic", "openai", "gemini", "antigravity"]);
});

test("/agents and /model subagent complete role ids, then models + maxSteps keyword", () => {
  expect(complete("/agents ", ctx()).completions).toEqual(["executor", "planner", "architect", "critic"]);
  expect(complete("/agents exec", ctx()).completions).toEqual(["executor"]);
  const m = complete("/agents executor ", ctx());
  expect(m.completions).toContain("reset");
  expect(m.completions).toContain("maxSteps");
  expect(m.completions).toContain("gpt-4o-live");
  expect(complete("/model subagent ", ctx()).completions).toEqual(["executor", "planner", "architect", "critic"]);
  expect(complete("/model role pla", ctx()).completions).toEqual(["planner"]);
  expect(complete("/model subagent executor ", ctx()).completions).toContain("gpt-4o-live");
});

test("/skill completes resolved skill names (bundled + user) from the context", () => {
  // No skillNames in context → falls back to bundled skills.
  expect(complete("/skill ", ctx()).completions.length).toBeGreaterThan(0);
  // Context-provided names (including a user skill) are offered and prefix-filtered.
  const withUser = ctx({ skillNames: ["deep-interview", "ralplan", "my-custom-skill"] });
  expect(complete("/skill ", withUser).completions).toContain("my-custom-skill");
  expect(complete("/skill my", withUser).completions).toEqual(["my-custom-skill"]);
});

test("/skill: completes GJC-style skill entrypoint names", () => {
  const withUser = ctx({ skillNames: ["deep-interview", "spec-kit"] });
  expect(complete("/skill:sp", withUser).completions).toEqual(["/skill:spec-kit"]);
});

test("formatCompletionPreview lists argument completions after slash commands", () => {
  const sub = formatCompletionPreview("/model subagent ", ctx()).join("\n");
  expect(sub).toContain("Subagent roles:");
  expect(sub).toContain("executor");
  expect(sub).toContain("planner");

  const login = formatCompletionPreview("/provider login ", ctx()).join("\n");
  expect(login).toContain("Providers:");
  expect(login).toContain("anthropic");
  expect(login).toContain("gemini");

  const models = formatCompletionPreview("/models ", ctx()).join("\n");
  expect(models).toContain("Subcommands:");
  expect(models).toContain("refresh");
  expect(models).toContain("catalog");
});

test("formatCompletionPreview shows path suggestions for @mentions", () => {
  const out = formatCompletionPreview("review @src/", ctx()).join("\n");
  expect(out).toContain("Paths:");
  expect(out).toContain("@src/commands/");
});

test("formatCompletionPreview stays empty for keyword-only slash probes", () => {
  expect(formatCompletionPreview("/sub", ctx())).toEqual([]);
  expect(formatCompletionPreview("hello", ctx())).toEqual([]);
});

test("/roles completes tier then live/catalog models", () => {
  expect(complete("/roles ", ctx()).completions).toEqual(["smol", "slow", "plan"]);
  const m = complete("/roles smol ", ctx());
  expect(m.kind).toBe("model");
  expect(m.completions).toContain("gpt-4o-live");
});

test("/thinking completes the five levels", () => {
  expect(complete("/thinking ", ctx()).completions).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  expect(complete("/thinking h", ctx()).completions).toEqual(["high"]);
});

test("commonPrefix returns the longest shared prefix", () => {
  expect(commonPrefix(["gpt-4o", "gpt-4o-mini"])).toBe("gpt-4o");
  expect(commonPrefix(["model", "models"])).toBe("model");
  expect(commonPrefix(["a", "b"])).toBe("");
  expect(commonPrefix([])).toBe("");
});

test("readlineCompleter returns [hits, token]; whole line when no hits", () => {
  expect(readlineCompleter("/mod", ctx())).toEqual([["/model", "/models"], "/mod"]);
  const [hits, repl] = readlineCompleter("/zzz", ctx());
  expect(hits).toEqual([]);
  expect(repl).toBe("/zzz"); // untouched
});

test("staticCompletionContext is wired to the real registries", () => {
  const s = staticCompletionContext();
  expect(s.slashCommands).toContain("/model");
  expect(s.providers).toContain("anthropic");
  expect(s.roleIds).toContain("executor");
  expect(s.catalogModels).toContain("gpt-4o");
  expect(s.thinkingLevels).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
});

test("/session completes its subcommands", () => {
  const r = complete("/session ", ctx());
  expect(r.kind).toBe("subcommand");
  expect(r.completions).toEqual(["info", "delete"]);
  expect(complete("/session d", ctx()).completions).toEqual(["delete"]);
  // Only the first argument is completed.
  expect(complete("/session info x", ctx()).completions).toEqual([]);
});

test("/theme completes the bundled theme names", () => {
  const r = complete("/theme ", ctx());
  expect(r.kind).toBe("subcommand");
  expect(r.completions).toEqual(["cosmic", "matrix", "solar", "red-claw", "blue-crab", "aurora", "synthwave", "sakura", "mono"]);
  expect(complete("/theme m", ctx()).completions).toEqual(["matrix", "mono"]);
});

test("/login completes the OAuth-capable cloud providers", () => {
  const r = complete("/login ", ctx());
  expect(r.kind).toBe("provider");
  expect(r.completions).toEqual(["anthropic", "openai", "gemini", "antigravity"]);
  expect(complete("/login o", ctx()).completions).toEqual(["openai"]);
});

test("/export completes format keywords for the first two args", () => {
  expect(complete("/export ", ctx()).completions).toEqual(["json", "markdown"]);
  expect(complete("/export out.md j", ctx()).completions).toEqual(["json"]);
  expect(complete("/export out.md json x", ctx()).completions).toEqual([]);
});

test("staticCompletionContext includes the gjc-parity commands", () => {
  const base = staticCompletionContext();
  for (const cmd of ["/new", "/session", "/rename", "/resume", "/retry", "/export", "/dump", "/btw", "/usage", "/context", "/tools", "/hotkeys", "/theme", "/settings", "/login"]) {
    expect(base.slashCommands).toContain(cmd);
  }
});

test("$skill mention completes at any position in the line", () => {
  const c = ctx({ skillNames: ["spec-kit", "team"] } as Partial<CompletionContext>);
  const lead = complete("$te", c);
  expect(lead.kind).toBe("skill");
  expect(lead.completions).toEqual(["$team"]);
  const mid = complete("please run $te", c);
  expect(mid.kind).toBe("skill");
  expect(mid.token).toBe("$te");
  expect(mid.completions).toEqual(["$team"]);
  // A finished token (space after) completes nothing.
  expect(complete("$team build it", c).completions).toEqual([]);
});

test("/command mention completes mid-line against the plugin command list", () => {
  const mid = complete("do X then /mo", ctx());
  expect(mid.kind).toBe("command");
  expect(mid.token).toBe("/mo");
  expect(mid.completions).toEqual(["/model", "/models"]);
  // Dynamic plugin/skill aliases in the context surface mid-line too.
  const dyn = complete("then /speckit.p", ctx({ slashCommands: ["/model", "/speckit.plan", "/speckit.tasks"] }));
  expect(dyn.completions).toEqual(["/speckit.plan"]);
  // Plain words and paths stay untouched.
  expect(complete("open src/cli.ts", ctx()).completions).toEqual([]);
});
