import { test, expect, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// skill-lessons.ts closes the "skills never get written to" gap: a stalled
// turn (or a manual `jeo skills lesson` call) appends a failure-mode/anti-
// pattern bullet into the project-level .jeo/skills/<name>.md file, seeded
// from the bundled skill on first write, idempotent on exact-title re-append.

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-skill-lessons-"));
}

test("matchLessonToSkill returns undefined for unrelated text and matches a clear domain hit", async () => {
  const { matchLessonToSkill } = await import("../src/agent/skill-lessons");
  expect(matchLessonToSkill("the sky is blue")).toBeUndefined();
  expect(matchLessonToSkill("")).toBeUndefined();
  expect(matchLessonToSkill("the consensus critic returned an [ITERATE] verdict on the plan draft")).toBe("ralplan");
  expect(matchLessonToSkill("we need to clarify the ambiguity in the requirements before an interview")).toBe("deep-interview");
});

test("appendSkillLesson seeds from the bundled skill, writes a bullet, and is idempotent on exact-title re-append", async () => {
  const dir = await tmp();
  try {
    const { appendSkillLesson, skillFilePath } = await import("../src/agent/skill-lessons");

    const first = await appendSkillLesson(dir, {
      skill: "ralplan",
      kind: "failure-mode",
      title: "critic loop never converges",
      detail: "the [ITERATE] verdict kept firing past the retry budget; cap iterations and surface the last draft.",
    });
    expect(first.appended).toBe(true);

    const content = await fs.readFile(skillFilePath(dir, "ralplan"), "utf-8");
    expect(content).toContain("## Known Failure Modes");
    expect(content).toContain("- **critic loop never converges**: the [ITERATE] verdict kept firing");
    // seeded from the bundled skill: the file is not JUST the new section.
    expect(content.length).toBeGreaterThan(200);

    // exact-title (case-insensitive) re-append is a no-op duplicate.
    const dup = await appendSkillLesson(dir, {
      skill: "ralplan",
      kind: "failure-mode",
      title: "CRITIC LOOP NEVER CONVERGES",
      detail: "different detail text should still be treated as a duplicate by title",
    });
    expect(dup).toEqual({ appended: false, reason: "duplicate" });
    const contentAfterDup = await fs.readFile(skillFilePath(dir, "ralplan"), "utf-8");
    expect(contentAfterDup).toBe(content);

    // a second, distinct anti-pattern lesson appends its own new section.
    const second = await appendSkillLesson(dir, {
      skill: "ralplan",
      kind: "anti-pattern",
      title: "do not skip the contrarian pass",
      detail: "skipping the contrarian pass to save time reintroduces confirmation bias into the plan.",
    });
    expect(second.appended).toBe(true);
    const finalContent = await fs.readFile(skillFilePath(dir, "ralplan"), "utf-8");
    expect(finalContent).toContain("## Anti-Patterns (do NOT do)");
    expect(finalContent).toContain("- **do not skip the contrarian pass**:");
    // human-readable markdown, not JSON-in-markdown.
    expect(finalContent.trim().startsWith("{")).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("recordSkillLesson writes nothing for text with no clear skill match", async () => {
  const dir = await tmp();
  try {
    const { recordSkillLesson, skillFilePath } = await import("../src/agent/skill-lessons");
    const result = await recordSkillLesson(dir, "the sky is blue and grass is green", {
      kind: "failure-mode",
      title: "irrelevant",
      detail: "irrelevant",
    });
    expect(result).toEqual({ appended: false, reason: "no matching skill" });
    await expect(fs.readFile(skillFilePath(dir, "deep-interview"), "utf-8")).rejects.toThrow();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("evalSkillLessons returns null with zero lessons and tallies covered/stale from one batched LLM call", async () => {
  const dir = await tmp();
  try {
    const { appendSkillLesson } = await import("../src/agent/skill-lessons");
    const { evalSkillLessons: evalNoFile } = await import("../src/agent/skill-lessons");
    expect(await evalNoFile(dir, "ralplan")).toBeNull();

    await appendSkillLesson(dir, {
      skill: "ralplan",
      kind: "failure-mode",
      title: "stale lesson example",
      detail: "this describes a scenario the current guidance no longer covers.",
    });
    await appendSkillLesson(dir, {
      skill: "ralplan",
      kind: "anti-pattern",
      title: "still relevant anti-pattern",
      detail: "this one is still directly addressed by current guidance.",
    });

    let seenUserMessage = "";
    await mock.module("../src/agent/loop", () => ({
      callLlm: async (messages: { role: string; content: string }[]) => {
        seenUserMessage = messages.map(m => m.content).join("\n");
        return JSON.stringify({
          results: [
            { title: "stale lesson example", verdict: "stale", reason: "no longer matches guidance" },
            { title: "still relevant anti-pattern", verdict: "covered", reason: "still matches" },
          ],
        });
      },
    }));

    const { evalSkillLessons } = await import("../src/agent/skill-lessons");
    const result = await evalSkillLessons(dir, "ralplan", { model: "test-model" });
    expect(result).not.toBeNull();
    expect(result!.total).toBe(2);
    expect(result!.covered).toBe(1);
    expect(result!.stale).toEqual([{ title: "stale lesson example", reason: "no longer matches guidance" }]);
    expect(seenUserMessage).toContain("stale lesson example");
    expect(seenUserMessage).toContain("still relevant anti-pattern");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("evalSkillLessons fails conservatively (all covered) when the LLM response is unparseable", async () => {
  const dir = await tmp();
  try {
    const { appendSkillLesson } = await import("../src/agent/skill-lessons");
    await appendSkillLesson(dir, {
      skill: "team",
      kind: "failure-mode",
      title: "worktree collision",
      detail: "two parallel_group workers wrote the same file.",
    });

    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => "not json at all, sorry",
    }));

    const { evalSkillLessons } = await import("../src/agent/skill-lessons");
    const result = await evalSkillLessons(dir, "team", { model: "test-model" });
    expect(result).toEqual({ skill: "team", total: 1, covered: 1, stale: [] });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- Gap coverage (per parent-context review): the two named gaps are the
// section-BOUNDARY case (a lesson section followed by an unrelated trailing
// `## ` section/header) for BOTH the write side (appendSkillLesson/findSection
// must stop at the next header, not swallow it) and the read side
// (coreBodyWithoutLessons must resume emitting once skipping a lesson section
// ends). The stale-verdict multi-lesson-batch path is already exercised by
// "evalSkillLessons returns null with zero lessons and tallies covered/stale
// from one batched LLM call" above (2 lessons, one stale one covered, in ONE
// callLlm invocation) — no new test added for that gap, see report.

test("appendSkillLesson inserts into a NON-terminal section — a bullet lands before a trailing sibling section, never after it (section-boundary write path)", async () => {
  const dir = await tmp();
  try {
    const { appendSkillLesson, skillFilePath } = await import("../src/agent/skill-lessons");

    // 1) First failure-mode lesson creates "## Known Failure Modes" at EOF.
    await appendSkillLesson(dir, {
      skill: "boundary-test-skill",
      kind: "failure-mode",
      title: "old failure",
      detail: "the first recorded failure mode.",
    });
    // 2) An anti-pattern lesson creates "## Anti-Patterns (do NOT do)" AFTER it —
    //    now "Known Failure Modes" is a NON-terminal section with a sibling
    //    trailing header below it.
    await appendSkillLesson(dir, {
      skill: "boundary-test-skill",
      kind: "anti-pattern",
      title: "an anti-pattern",
      detail: "do not do this thing.",
    });
    // 3) A SECOND failure-mode lesson must be inserted back into "Known Failure
    //    Modes" — i.e. BEFORE the "Anti-Patterns" header findSection must detect
    //    as the section's end boundary, not appended past it at EOF.
    await appendSkillLesson(dir, {
      skill: "boundary-test-skill",
      kind: "failure-mode",
      title: "second failure",
      detail: "the second recorded failure mode.",
    });

    const content = await fs.readFile(skillFilePath(dir, "boundary-test-skill"), "utf-8");
    const lines = content.split("\n");
    const failureHeaderIdx = lines.findIndex(l => l.trim() === "## Known Failure Modes");
    const antiHeaderIdx = lines.findIndex(l => l.trim() === "## Anti-Patterns (do NOT do)");
    const oldFailureIdx = lines.findIndex(l => l.includes("**old failure**"));
    const secondFailureIdx = lines.findIndex(l => l.includes("**second failure**"));
    const antiPatternIdx = lines.findIndex(l => l.includes("**an anti-pattern**"));

    expect(failureHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(antiHeaderIdx).toBeGreaterThan(failureHeaderIdx);
    // Both failure bullets sit strictly BETWEEN the two headers — the second
    // insertion did not land after "Anti-Patterns" or at end-of-file.
    expect(oldFailureIdx).toBeGreaterThan(failureHeaderIdx);
    expect(oldFailureIdx).toBeLessThan(antiHeaderIdx);
    expect(secondFailureIdx).toBeGreaterThan(failureHeaderIdx);
    expect(secondFailureIdx).toBeLessThan(antiHeaderIdx);
    // The anti-pattern bullet stays in its own section, untouched by the insert.
    expect(antiPatternIdx).toBeGreaterThan(antiHeaderIdx);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("evalSkillLessons's core-guidance prompt includes content AFTER a lesson section, not just before it (section-boundary read path)", async () => {
  const dir = await tmp();
  try {
    const { skillFilePath, evalSkillLessons } = await import("../src/agent/skill-lessons");
    const filePath = skillFilePath(dir, "boundary-read-skill");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Hand-crafted: a lesson section is BUNDLED IN THE MIDDLE of the file, with
    // an unrelated trailing "## Usage Notes" section (real skill body content)
    // after it — the exact "trailing header after the lesson section" shape.
    await fs.writeFile(
      filePath,
      [
        "# boundary-read-skill",
        "",
        "Intro guidance before any lessons.",
        "",
        "## Known Failure Modes",
        "",
        "- **only lesson**: something that went wrong once.",
        "",
        "## Usage Notes",
        "",
        "This trailing section must survive into the core-guidance judge prompt.",
        "",
      ].join("\n"),
      "utf-8",
    );

    let userMessage = "";
    await mock.module("../src/agent/loop", () => ({
      callLlm: async (messages: { role: string; content: string }[]) => {
        userMessage = messages.map(m => m.content).join("\n");
        return JSON.stringify({ results: [{ title: "only lesson", verdict: "covered", reason: "still fine" }] });
      },
    }));

    const result = await evalSkillLessons(dir, "boundary-read-skill", { model: "test-model" });
    expect(result).not.toBeNull();
    expect(result!.total).toBe(1);

    // The core-guidance block sent to the judge is everything BEFORE "Recorded
    // lessons:" — it must contain the trailing "Usage Notes" section (proves
    // `skipping` correctly turned back off at the next header) and must NOT
    // contain the lesson bullet text itself (proves the lesson section was
    // actually stripped, not just left in place alongside the trailing content).
    const coreGuidanceBlock = userMessage.split("Recorded lessons:")[0] ?? "";
    expect(coreGuidanceBlock).toContain("Usage Notes");
    expect(coreGuidanceBlock).toContain("must survive into the core-guidance judge prompt");
    expect(coreGuidanceBlock).toContain("Intro guidance before any lessons");
    expect(coreGuidanceBlock).not.toContain("only lesson");
    expect(coreGuidanceBlock).not.toContain("## Known Failure Modes");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
