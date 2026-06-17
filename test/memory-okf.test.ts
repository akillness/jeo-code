import { test, expect } from "bun:test";
import {
  conceptId,
  isReservedFile,
  slugify,
  parseConcept,
  serializeConcept,
  validateFile,
  validateBundle,
  JEO_TYPES,
  type Frontmatter,
} from "../src/agent/memory-okf";

// OKF v0.1 format foundation (docs/okf_mem/sprint-01-format-foundation):
// pure schema layer — frontmatter parse/serialize with extension-key round-trip,
// concept-ID computation, and a tolerant conformance validator. memory.ts is
// untouched by this sprint.

// ── concept identity ────────────────────────────────────────────────────────

test("conceptId strips .md and yields the bundle-relative path", () => {
  expect(conceptId("commands/bun-test.md")).toBe("commands/bun-test");
  expect(conceptId("tables/users.md")).toBe("tables/users");
  expect(conceptId("./facts/repo.md")).toBe("facts/repo");
  expect(conceptId("facts\\repo.md")).toBe("facts/repo");
  expect(conceptId("README.md")).toBe("README");
});

test("isReservedFile recognizes only index.md and log.md by basename", () => {
  expect(isReservedFile("index.md")).toBe(true);
  expect(isReservedFile("sprint-01/index.md")).toBe(true);
  expect(isReservedFile("log.md")).toBe(true);
  expect(isReservedFile("LOG.md")).toBe(true);
  expect(isReservedFile("commands/bun-test.md")).toBe(false);
  expect(isReservedFile("concepts/indexing.md")).toBe(false);
});

test("slugify produces collision-resistant kebab-case", () => {
  expect(slugify("bun test")).toBe("bun-test");
  expect(slugify("Run `bun run typecheck`!")).toBe("run-bun-run-typecheck");
  expect(slugify("  Multiple   Spaces  ")).toBe("multiple-spaces");
  expect(slugify("")).toBe("untitled");
  expect(slugify("---")).toBe("untitled");
});

// ── frontmatter round-trip (DoD #1: unknown extension keys preserved) ────────

test("parse→serialize round-trips and preserves unknown extension keys", () => {
  const doc = [
    "---",
    "type: Command",
    "title: bun test",
    "description: run the full suite",
    "tags: [test, bun]",
    "timestamp: 2026-06-17T00:00:00Z",
    "confidence: high",
    "last_verified: 2026-06-17",
    "source_session: abc-123",
    "---",
    "",
    "# Command",
    "",
    "- `bun test`",
  ].join("\n");

  const parsed = parseConcept(doc);
  expect(parsed.hasFrontmatter).toBe(true);
  expect(parsed.frontmatter.type).toBe("Command");
  expect(parsed.frontmatter.tags).toEqual(["test", "bun"]);
  // Extension keys survive parsing.
  expect(parsed.frontmatter.confidence).toBe("high");
  expect(parsed.frontmatter.last_verified).toBe("2026-06-17");
  expect(parsed.frontmatter.source_session).toBe("abc-123");
  expect(parsed.body).toBe("# Command\n\n- `bun test`");

  // Re-serialize, re-parse: frontmatter and body are stable (idempotent).
  const out = serializeConcept(parsed.frontmatter, parsed.body);
  const reparsed = parseConcept(out);
  expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
  expect(reparsed.body).toBe(parsed.body);
  // Key order preserved.
  expect(Object.keys(reparsed.frontmatter)).toEqual([
    "type", "title", "description", "tags", "timestamp",
    "confidence", "last_verified", "source_session",
  ]);
});

test("quoted string scalars round-trip as strings (okf_version 0.1)", () => {
  const fm: Frontmatter = { okf_version: "0.1" };
  const out = serializeConcept(fm, "");
  const reparsed = parseConcept(out + "\nbody");
  expect(reparsed.frontmatter.okf_version).toBe("0.1");
  expect(typeof reparsed.frontmatter.okf_version).toBe("string");
});

test("numbers and booleans round-trip with their JS types", () => {
  const fm: Frontmatter = { type: "Gotcha", priority: 3, resolved: false };
  const reparsed = parseConcept(serializeConcept(fm, "x"));
  expect(reparsed.frontmatter.priority).toBe(3);
  expect(reparsed.frontmatter.resolved).toBe(false);
});

test("empty inline list round-trips", () => {
  const fm: Frontmatter = { type: "RepoFact", tags: [] };
  const reparsed = parseConcept(serializeConcept(fm, "x"));
  expect(reparsed.frontmatter.tags).toEqual([]);
});

test("parseConcept is tolerant of a document with no frontmatter", () => {
  const parsed = parseConcept("# Just a heading\n\nbody text");
  expect(parsed.hasFrontmatter).toBe(false);
  expect(parsed.frontmatter).toEqual({});
  expect(parsed.body).toBe("# Just a heading\n\nbody text");
});

test("parseConcept tolerates an unterminated frontmatter block", () => {
  const parsed = parseConcept("---\ntype: Command\n\nno closing fence");
  expect(parsed.hasFrontmatter).toBe(false);
});

// ── conformance: errors (DoD #2) ────────────────────────────────────────────

test("validator rejects missing frontmatter on a concept document", () => {
  const issues = validateFile({ path: "commands/x.md", content: "no frontmatter here" });
  expect(issues.some(i => i.level === "error")).toBe(true);
});

test("validator rejects missing or empty type", () => {
  const missing = validateFile({ path: "facts/a.md", content: "---\ntitle: a\n---\nbody" });
  expect(missing.some(i => i.level === "error" && /type/.test(i.message))).toBe(true);

  const empty = validateFile({ path: "facts/b.md", content: '---\ntype: ""\n---\nbody' });
  expect(empty.some(i => i.level === "error" && /type/.test(i.message))).toBe(true);
});

test("log.md with a non-ISO date heading is rejected", () => {
  const bad = validateFile({ path: "log.md", content: "# Log\n\n## 06/17/2026\n- entry" });
  expect(bad.some(i => i.level === "error")).toBe(true);

  const good = validateFile({ path: "log.md", content: "# Log\n\n## 2026-06-17\n- entry" });
  expect(good.some(i => i.level === "error")).toBe(false);
});

// ── conformance: lenient consumption (DoD #2) ───────────────────────────────

test("unknown type is tolerated (warning, not error)", () => {
  const issues = validateFile({ path: "facts/x.md", content: "---\ntype: SomethingNew\ntitle: t\ndescription: d\n---\nbody" });
  expect(issues.some(i => i.level === "error")).toBe(false);
  expect(issues.some(i => i.level === "warning" && /unknown type/.test(i.message))).toBe(true);
});

test("missing recommended fields warn but never reject", () => {
  const issues = validateFile({ path: "facts/x.md", content: "---\ntype: RepoFact\n---\nbody" });
  expect(issues.some(i => i.level === "error")).toBe(false);
  expect(issues.some(i => i.level === "warning" && /title/.test(i.message))).toBe(true);
  expect(issues.some(i => i.level === "warning" && /description/.test(i.message))).toBe(true);
});

test("index.md needs no frontmatter and is never rejected", () => {
  const issues = validateFile({ path: "index.md", content: "# Index\n\n- [a](/facts/a.md)" });
  expect(issues.length).toBe(0);
});

test("all jeo vocabulary types are accepted without warning", () => {
  for (const t of JEO_TYPES) {
    const issues = validateFile({ path: `x/${t}.md`, content: `---\ntype: ${t}\ntitle: t\ndescription: d\n---\nbody` });
    expect(issues.some(i => /unknown type/.test(i.message))).toBe(false);
  }
});

// ── bundle-level conformance ────────────────────────────────────────────────

test("a well-formed bundle is conformant; broken links do not reject it", () => {
  const report = validateBundle([
    { path: "index.md", content: '# Memory\n\nokf_version: "0.1"\n\n- [bun test](/commands/bun-test.md)\n- [missing](/facts/not-written-yet.md)' },
    { path: "log.md", content: "# Log\n\n## 2026-06-17\n- created bundle" },
    { path: "commands/bun-test.md", content: "---\ntype: Command\ntitle: bun test\ndescription: run suite\n---\n# Command\n- `bun test`" },
    { path: "facts/stack.md", content: "---\ntype: RepoFact\ntitle: stack\ndescription: Bun + TS\n---\n# Fact\n- Bun runtime" },
  ]);
  expect(report.conformant).toBe(true);
});

test("a bundle with a typeless concept is non-conformant", () => {
  const report = validateBundle([
    { path: "facts/a.md", content: "---\ntitle: a\n---\nbody" },
  ]);
  expect(report.conformant).toBe(false);
  expect(report.issues.some(i => i.level === "error")).toBe(true);
});
