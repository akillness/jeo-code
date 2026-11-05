import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// C1: nothing outside jeo-code is ever installed, changed or deleted by jeo code. The two shared-global
// modules therefore have to stay read-only. This scans their SOURCE TEXT by call form (not by substring):
// plain words such as `execPath`, the literal `jeopi-cli`, the kind 'dangling-symlink' and `readlink` are
// fine, member calls such as `re.exec(` are fine, and a mutating fs call, a process spawn or a write-mode
// open is not. Process execution is additionally excluded by the child_process import ban.

const MODULES = ["src/util/shared-global.ts", "src/util/shared-install-report.ts"];

const sources = MODULES.map(rel => ({ rel, text: fs.readFileSync(path.join(import.meta.dir, "..", rel), "utf8") }));

const ALLOWED_IMPORTS: Record<string, true> = {
  "node:fs": true,
  "node:path": true,
  "node:os": true,
  "./shared-global": true,
  "../messenger/launcher": true,
};

const FROM_IMPORT = /^(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/gm;
const BARE_IMPORT = /^import\s*["']([^"']+)["']/gm;

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(FROM_IMPORT), ...text.matchAll(BARE_IMPORT)].map(match => match[1] ?? "");
}

const FORBIDDEN_CALLS: { name: string; pattern: RegExp }[] = [
  { name: "Bun.spawn(", pattern: /\bBun\.spawn\(/ },
  { name: "Bun.spawnSync(", pattern: /\bBun\.spawnSync\(/ },
  { name: "Bun.$", pattern: /\bBun\.\$/ },
  { name: "Bun.write(", pattern: /\bBun\.write\(/ },
  // `re.exec(` and `/x/.exec(` (RegExp parsing of ~/.npmrc and bunfig lines) are allowed.
  { name: "exec(", pattern: /(?<![.\w$])exec(Sync|File|FileSync)?\(/ },
  {
    name: "mutating fs call",
    pattern:
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|link|linkSync|chmod|chmodSync|chown|chownSync|utimes|utimesSync|truncate|truncateSync)\(/,
  },
  { name: "open( with a write flag", pattern: /\b(?:open|openSync)\([^)]*(?:["'](?:[wa][sx]?\+?|rs?\+)["']|O_WRONLY|O_RDWR|O_APPEND|O_CREAT)/ },
  { name: "write-mode open flag constant", pattern: /\bO_(?:WRONLY|RDWR|APPEND|CREAT)\b/ },
];

function findMatches(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (pattern.test(line)) out.push(`line ${i + 1}: ${line.trim()}`);
  }
  return out;
}

describe("shared-global modules stay read-only (C1)", () => {
  test("both modules exist and have content to scan", () => {
    for (const { rel, text } of sources) {
      expect(text.length, rel).toBeGreaterThan(500);
    }
  });

  test("imports are limited to node:fs, node:path, node:os, ./shared-global and ../messenger/launcher", () => {
    for (const { rel, text } of sources) {
      const specifiers = importSpecifiers(text);
      expect(specifiers, `${rel} import scan found nothing`).toContain("node:fs");
      for (const specifier of specifiers) {
        expect(Object.hasOwn(ALLOWED_IMPORTS, specifier), `${rel} imports ${specifier}`).toBe(true);
      }
    }
  });

  test("neither module imports child_process, requires, or dynamically imports anything", () => {
    for (const { rel, text } of sources) {
      expect(text, rel).not.toMatch(/child_process/);
      expect(findMatches(text, /\brequire\s*\(/), rel).toEqual([]);
      expect(findMatches(text, /\bimport\s*\(/), rel).toEqual([]);
    }
  });

  for (const { name, pattern } of FORBIDDEN_CALLS) {
    test(`no ${name} call form in either module`, () => {
      for (const { rel, text } of sources) {
        expect(findMatches(text, pattern), `${rel} matches ${name}`).toEqual([]);
      }
    });
  }

  test("the words the scan must tolerate appear in the combined text, so it cannot pass vacuously", () => {
    const combined = sources.map(source => source.text).join("\n");
    for (const word of ["execPath", "jeopi-cli", "dangling-symlink"]) {
      expect(combined, `combined text lacks ${word}`).toContain(word);
    }
  });
});

describe("the call-form scan itself", () => {
  const flagged = [
    "fs.rmSync(dir)",
    "rm(dir)",
    "fs.writeFileSync(file, text)",
    "fs.mkdirSync(dir)",
    "fs.symlinkSync(a, b)",
    'exec("ls")',
    'execSync("ls")',
    'execFileSync("ls")',
    'Bun.spawn(["ls"])',
    'Bun.spawnSync(["ls"])',
    "Bun.$`ls`",
    "Bun.write(file, text)",
    'fs.openSync(file, "w")',
    'fs.openSync(file, "a+")',
    'fs.open(file, "r+", cb)',
    "fs.openSync(file, fs.constants.O_WRONLY)",
  ];
  const tolerated = [
    "re.exec(line)",
    "/^prefix=/.exec(text)",
    "fs.readlinkSync(link)",
    "entry.isSymbolicLink()",
    "const kind = 'dangling-symlink';",
    "process.execPath",
    "currentJeoCommand(o.entry, o.execPath)",
    'fs.openSync(file, "r")',
    "fs.readFileSync(file, 'utf8')",
    "name === 'jeopi-cli'",
  ];

  test("every forbidden sample is caught by at least one call form", () => {
    for (const sample of flagged) {
      const hit = FORBIDDEN_CALLS.some(({ pattern }) => pattern.test(sample));
      expect(hit, sample).toBe(true);
    }
  });

  test("tolerated samples are caught by none", () => {
    for (const sample of tolerated) {
      const hit = FORBIDDEN_CALLS.find(({ pattern }) => pattern.test(sample));
      expect(hit?.name, sample).toBeUndefined();
    }
  });

  test("the import scan reads multi-line and bare imports", () => {
    const text = 'import {\n  a,\n  type B,\n} from "./x";\nimport "node:child_process";\nexport { c } from "../y";\nconst d = 1;\n';
    expect(importSpecifiers(text).sort()).toEqual(["./x", "../y", "node:child_process"].sort());
  });
});
