import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import {
  repoRoot,
  devLinkTarget,
  defaultLinkDir,
  splitPathEntries,
  findShadowingJeo,
  classifyDevDoctor,
} from "../scripts/dev-link";

describe("dev-link target resolution", () => {
  test("devLinkTarget points at <root>/src/cli.ts", () => {
    expect(devLinkTarget("/repo")).toBe(path.join("/repo", "src", "cli.ts"));
  });

  test("repoRoot()/src/cli.ts is the default target and the file exists", () => {
    const target = devLinkTarget();
    expect(target).toBe(path.join(repoRoot(), "src", "cli.ts"));
    expect(require("node:fs").existsSync(target)).toBe(true);
  });
});

describe("defaultLinkDir", () => {
  test("JEO_DEV_LINK_DIR overrides and is resolved to absolute", () => {
    const prev = process.env.JEO_DEV_LINK_DIR;
    process.env.JEO_DEV_LINK_DIR = "custom/bin";
    try {
      expect(defaultLinkDir()).toBe(path.resolve("custom/bin"));
    } finally {
      if (prev === undefined) delete process.env.JEO_DEV_LINK_DIR;
      else process.env.JEO_DEV_LINK_DIR = prev;
    }
  });

  test("falls back to ~/.local/bin when unset", () => {
    const prev = process.env.JEO_DEV_LINK_DIR;
    delete process.env.JEO_DEV_LINK_DIR;
    try {
      expect(defaultLinkDir()).toBe(path.join(process.env.HOME || os.homedir(), ".local", "bin"));
    } finally {
      if (prev !== undefined) process.env.JEO_DEV_LINK_DIR = prev;
    }
  });
});

describe("splitPathEntries", () => {
  test("splits, trims, drops empties, resolves to absolute", () => {
    const entries = splitPathEntries(["/usr/bin", " ", "rel/dir", "/opt/x"].join(path.delimiter));
    expect(entries).toEqual(["/usr/bin", path.resolve("rel/dir"), "/opt/x"]);
  });

  test("undefined/empty PATH yields no entries", () => {
    expect(splitPathEntries(undefined)).toEqual([]);
    expect(splitPathEntries("")).toEqual([]);
  });
});

describe("findShadowingJeo", () => {
  const exists = (set: Set<string>) => (p: string) => set.has(path.resolve(p));

  test("flags a jeo on an earlier PATH entry than the managed link dir", () => {
    const shadow = findShadowingJeo({
      linkDir: "/home/me/.local/bin",
      pathEntries: ["/usr/local/bin", "/home/me/.local/bin"],
      exists: exists(new Set([path.resolve("/usr/local/bin/jeo")])),
    });
    expect(shadow).toBe(path.join("/usr/local/bin", "jeo"));
  });

  test("returns null when the managed dir comes first (it wins)", () => {
    const shadow = findShadowingJeo({
      linkDir: "/home/me/.local/bin",
      pathEntries: ["/home/me/.local/bin", "/usr/local/bin"],
      // even though a later jeo exists, it cannot shadow the managed link
      exists: exists(new Set([path.resolve("/usr/local/bin/jeo")])),
    });
    expect(shadow).toBeNull();
  });

  test("returns null when no other jeo exists on PATH", () => {
    const shadow = findShadowingJeo({
      linkDir: "/home/me/.local/bin",
      pathEntries: ["/usr/local/bin", "/home/me/.local/bin"],
      exists: exists(new Set()),
    });
    expect(shadow).toBeNull();
  });
});

describe("classifyDevDoctor", () => {
  const target = "/repo/src/cli.ts";

  test("missing when nothing resolves on PATH", () => {
    const r = classifyDevDoctor({ resolved: null, expectedTarget: target });
    expect(r.status).toBe("missing");
  });

  test("linked when the resolved path equals the hot source target", () => {
    const r = classifyDevDoctor({ resolved: "/repo/src/cli.ts", expectedTarget: target });
    expect(r.status).toBe("linked");
  });

  test("drift when jeo resolves to a different path (compiled binary / installed copy)", () => {
    const r = classifyDevDoctor({ resolved: "/usr/local/bin/jeo", expectedTarget: target });
    expect(r.status).toBe("drift");
    expect(r.detail).toContain("dev:link");
  });
});
