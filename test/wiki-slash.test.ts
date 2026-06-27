import { describe, it, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { wikiRootPromptLine, decideWikiSlash } from "../src/commands/launch/wiki-slash";

describe("wikiRootPromptLine", () => {
  it("returns empty string when no root is set", () => {
    expect(wikiRootPromptLine(undefined)).toBe("");
    expect(wikiRootPromptLine("")).toBe("");
  });

  it("embeds the root path and the global-not-project distinction when set", () => {
    const line = wikiRootPromptLine("/srv/wiki");
    expect(line).toContain("/srv/wiki");
    expect(line).toContain("$JEO_WIKI_ROOT");
    expect(line).toContain("/srv/wiki/index.md");
    // Must clarify it is the global wiki, NOT the project-scoped .jeo/memory store.
    expect(line).toContain(".jeo/memory/");
    expect(line.startsWith("\n\n")).toBe(true);
  });
});

describe("decideWikiSlash", () => {
  it("shows the unset hint for a bare /wiki with no current root", () => {
    const d = decideWikiSlash("/wiki", undefined, false);
    expect(d.kind).toBe("show");
    expect(d.lines[0]).toContain("No global llm-wiki root set");
    expect(d.lines).toContain("Clear with /wiki off.");
  });

  it("reports the config source for a current root from config", () => {
    const d = decideWikiSlash("/wiki", "/cfg/wiki", false);
    expect(d.kind).toBe("show");
    expect(d.lines[0]).toBe("Global llm-wiki root: /cfg/wiki  (from ~/.jeo/config.json)");
  });

  it("reports the env source when the root came from JEO_WIKI_ROOT", () => {
    const d = decideWikiSlash("/wiki", "/env/wiki", true);
    expect(d.kind).toBe("show");
    expect(d.lines[0]).toBe("Global llm-wiki root: /env/wiki  (from env JEO_WIKI_ROOT)");
  });

  it("treats /wiki off, clear, and none as a clear", () => {
    for (const word of ["off", "clear", "none"]) {
      const d = decideWikiSlash(`/wiki ${word}`, "/cfg/wiki", false);
      expect(d.kind).toBe("clear");
      expect(d.lines[0]).toContain("cleared");
    }
  });

  it("sets the root: expands ~ for display but persists the raw argument", () => {
    const d = decideWikiSlash("/wiki ~/vaults/llm-wiki", undefined, false);
    expect(d.kind).toBe("set");
    if (d.kind !== "set") throw new Error("unreachable");
    expect(d.root).toBe(path.join(os.homedir(), "vaults", "llm-wiki"));
    // The RAW arg is persisted (resolveWikiRoot re-expands on read), not the absolute form.
    expect(d.persistArg).toBe("~/vaults/llm-wiki");
    expect(d.lines[0]).toContain(d.root);
    expect(d.lines[0]).toContain("applies to all sessions");
  });

  it("absolutizes a relative path against cwd on set", () => {
    const d = decideWikiSlash("/wiki notes/wiki", undefined, false);
    expect(d.kind).toBe("set");
    if (d.kind !== "set") throw new Error("unreachable");
    expect(d.root).toBe(path.resolve("notes/wiki"));
    expect(d.persistArg).toBe("notes/wiki");
  });

  it("treats a whitespace-only argument as a bare show, not a set", () => {
    const d = decideWikiSlash("/wiki    ", "/cfg/wiki", false);
    expect(d.kind).toBe("show");
  });
});
