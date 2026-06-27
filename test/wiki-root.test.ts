import { describe, it, expect, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeWikiRoot, resolveWikiRoot } from "../src/agent/state";

const ENV = "JEO_WIKI_ROOT";
const original = process.env[ENV];

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe("normalizeWikiRoot", () => {
  it("expands a leading ~/ to the home directory and absolutizes", () => {
    expect(normalizeWikiRoot("~/vaults/llm-wiki")).toBe(path.join(os.homedir(), "vaults", "llm-wiki"));
  });

  it("expands a bare ~ to the home directory", () => {
    expect(normalizeWikiRoot("~")).toBe(path.resolve(os.homedir()));
  });

  it("absolutizes a relative path against cwd", () => {
    expect(normalizeWikiRoot("notes/wiki")).toBe(path.resolve("notes/wiki"));
  });

  it("leaves an already-absolute path intact", () => {
    expect(normalizeWikiRoot("/srv/wiki")).toBe("/srv/wiki");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeWikiRoot("  /srv/wiki  ")).toBe("/srv/wiki");
  });

  it("returns undefined for blank or missing input", () => {
    expect(normalizeWikiRoot("")).toBeUndefined();
    expect(normalizeWikiRoot("   ")).toBeUndefined();
    expect(normalizeWikiRoot(undefined)).toBeUndefined();
  });
});

describe("resolveWikiRoot", () => {
  it("returns undefined when neither env nor config sets a root", () => {
    delete process.env[ENV];
    expect(resolveWikiRoot({})).toBeUndefined();
    expect(resolveWikiRoot({ wikiRoot: "" })).toBeUndefined();
  });

  it("uses config.wikiRoot (expanded) when no env override", () => {
    delete process.env[ENV];
    expect(resolveWikiRoot({ wikiRoot: "~/vaults/llm-wiki" })).toBe(
      path.join(os.homedir(), "vaults", "llm-wiki"),
    );
  });

  it("lets the env override win over config", () => {
    process.env[ENV] = "/env/override/wiki";
    expect(resolveWikiRoot({ wikiRoot: "/config/wiki" })).toBe("/env/override/wiki");
  });

  it("falls back to config when env is blank", () => {
    process.env[ENV] = "   ";
    expect(resolveWikiRoot({ wikiRoot: "/config/wiki" })).toBe("/config/wiki");
  });
});
