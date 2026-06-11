import { test, expect } from "bun:test";
import { parseSkillInvocation, parseSkillMarkdown, SKILLS } from "../src/skills/catalog";
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
