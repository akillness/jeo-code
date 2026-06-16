import { test, expect } from "bun:test";
import { parseSkillInvocation, parseSkillChain, parseSkillMarkdown, SKILLS, uniquePrefixSkill, suggestSkills } from "../src/skills/catalog";
import { complete } from "../src/tui/components/autocomplete";
import type { CompletionContext } from "../src/tui/components/autocomplete";

// `$name` exact-name skill entrypoint (gjc/Codex style): the FIRST token `$team`
// invokes the loaded skill "team" directly; unknown `$word` stays an ordinary prompt.

const userSkill = parseSkillMarkdown("spec-kit", "summary: Spec-driven development router\n\nUse specify CLI.");
const skills = [...SKILLS, userSkill];

test("$name invokes a bundled skill with intent and invokedAs", () => {
  const inv = parseSkillInvocation("$team split into 3 lanes", skills);
  expect(inv?.skill.name).toBe("team");
  expect(inv?.intent).toBe("split into 3 lanes");
  expect(inv?.invokedAs).toBe("$team");
});

test("$name resolves user/project skills case-insensitively", () => {
  const inv = parseSkillInvocation("$Spec-Kit start from specify init", skills);
  expect(inv?.skill.name).toBe("spec-kit");
  expect(inv?.intent).toBe("start from specify init");
});

test("$name without intent invokes with empty intent", () => {
  const inv = parseSkillInvocation("$ultragoal", skills);
  expect(inv?.skill.name).toBe("ultragoal");
  expect(inv?.intent).toBe("");
});

test("unknown $word falls through to the model (null invocation)", () => {
  expect(parseSkillInvocation("$HOME is what?", skills)).toBeNull();
  expect(parseSkillInvocation("$nope do something", skills)).toBeNull();
  expect(parseSkillInvocation("$", skills)).toBeNull();
});

test("$name mentioned mid-prompt does NOT invoke (first token only)", () => {
  expect(parseSkillInvocation("please run $team for me", skills)).toBeNull();
});

test("$prefix uniquely resolves the skill (precise invoke without full spelling)", () => {
  expect(parseSkillInvocation("$te do x", skills)?.skill.name).toBe("team"); // only "te*" skill
  expect(parseSkillInvocation("$ultra", skills)?.skill.name).toBe("ultragoal");
  // An ambiguous prefix does NOT auto-resolve (stays null, the REPL then suggests).
  const two = [...skills, parseSkillMarkdown("teamwork", "summary: x\n\ny")];
  expect(parseSkillInvocation("$te plan", two)).toBeNull(); // team + teamwork → ambiguous
  // …but an EXACT name still wins even when a longer sibling exists.
  expect(parseSkillInvocation("$team plan", two)?.skill.name).toBe("team");
});

test("uniquePrefixSkill: unique → skill, ambiguous/none → undefined", () => {
  expect(uniquePrefixSkill(skills, "team")?.name).toBe("team");
  expect(uniquePrefixSkill(skills, "te")?.name).toBe("team");
  expect(uniquePrefixSkill(skills, "zzz")).toBeUndefined();
  expect(uniquePrefixSkill(skills, "")).toBeUndefined();
  const two = [...skills, parseSkillMarkdown("teamwork", "summary: x\n\ny")];
  expect(uniquePrefixSkill(two, "team")).toBeUndefined(); // team + teamwork
});

test("suggestSkills: prefix-first then fuzzy; empty for no match", () => {
  expect(suggestSkills(skills, "tea").map(s => s.name)).toContain("team");
  expect(suggestSkills(skills, "tm").map(s => s.name)).toContain("team"); // fuzzy t…m
  expect(suggestSkills(skills, "qqqzzz")).toEqual([]);
});

test("parseSkillChain: multiple leading $skills all resolve, sharing the trailing intent", () => {
  const c = parseSkillChain("$ralplan $team build the auth flow", skills);
  expect(c?.invocations.map(i => i.skill.name)).toEqual(["ralplan", "team"]);
  expect(c?.invocations.every(i => i.intent === "build the auth flow")).toBe(true);
  expect(c?.invocations.map(i => i.invokedAs)).toEqual(["$ralplan", "$team"]);
  expect(c?.unresolved).toEqual([]);
});

test("parseSkillChain: prefixes resolve and a lone $skill is a chain of one", () => {
  expect(parseSkillChain("$te $ultra go", skills)?.invocations.map(i => i.skill.name)).toEqual(["team", "ultragoal"]);
  const one = parseSkillChain("$team only", skills);
  expect(one?.invocations.map(i => i.skill.name)).toEqual(["team"]);
  expect(one?.invocations[0]?.intent).toBe("only");
});

test("parseSkillChain: unknown tokens collected, env-var token ends the chain", () => {
  const c = parseSkillChain("$team $nope build", skills);
  expect(c?.invocations.map(i => i.skill.name)).toEqual(["team"]);
  expect(c?.unresolved).toEqual(["nope"]);
  // `$HOME` is env-var-style → boundary; it and the rest become the intent.
  const env = parseSkillChain("$team $HOME run", skills);
  expect(env?.invocations.map(i => i.skill.name)).toEqual(["team"]);
  expect(env?.invocations[0]?.intent).toBe("$HOME run");
  // A leading env-var token means no chain at all (passes through to the model).
  expect(parseSkillChain("$HOME is what?", skills)).toBeNull();
  // Non-$ input is never a chain.
  expect(parseSkillChain("explain $team", skills)).toBeNull();
});

function ctx(): CompletionContext {
  return {
    slashCommands: ["/help", "/skill"],
    liveModels: [],
    aliases: [],
    catalogModels: [],
    providers: [],
    roleIds: [],
    skillNames: ["team", "spec-kit", "ultragoal"],
    modelsForProvider: () => [],
  } as unknown as CompletionContext;
}

test("autocomplete: leading $ completes skill names", () => {
  const r = complete("$sp", ctx());
  expect(r.completions).toEqual(["$spec-kit"]);
  const all = complete("$", ctx());
  expect(all.completions).toEqual(["$team", "$spec-kit", "$ultragoal"]);
});

test("autocomplete: $ completes skill names at any position (mention-style)", () => {
  const r = complete("explain $sp", ctx());
  expect(r.completions).toEqual(["$spec-kit"]);
  expect(r.token).toBe("$sp");
  // A finished `$name` (space after) is no longer the active token.
  expect(complete("$team build it", ctx()).completions).toEqual([]);
  // Glued $ inside a word (env vars) never completes.
  expect(complete("echo FOO$BAR", ctx()).completions).toEqual([]);
});

test("/name does NOT dispatch a skill — $name is the only entrypoint ($-only)", () => {
  // The bare-slash workflow entry was removed; `/` never loads a skill now.
  expect(parseSkillInvocation("/team split into 3 lanes", skills)).toBeNull();
  expect(parseSkillInvocation("/deep-interview", skills)).toBeNull();
  expect(parseSkillInvocation("/ultragoal go", skills)).toBeNull();
  // …only `$name` (exact or unique prefix) invokes.
  expect(parseSkillInvocation("$team split", skills)?.skill.name).toBe("team");
  expect(parseSkillInvocation("$team split", skills)?.invokedAs).toBe("$team");
  expect(parseSkillInvocation("$ultra go", skills)?.skill.name).toBe("ultragoal");
});
