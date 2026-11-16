// Baseline: cost of answering "who calls <symbol>?" with grep + reading whole hit files.
// Usage: bun bench/baseline.ts <symbol> [srcDir]
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const sym = process.argv[2] ?? "readEvents";
const root = process.argv[3] ?? "../../src";
const re = new RegExp(`\\b${sym}\\b`);
const t0 = performance.now();
let hitFiles = 0, hitLines = 0, fullBytes = 0, lineBytes = 0;
for (const f of new Glob("**/*.ts").scanSync({ cwd: root, absolute: true })) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n").filter((l) => re.test(l));
  if (lines.length) { hitFiles++; hitLines += lines.length; fullBytes += text.length; lineBytes += lines.join("\n").length; }
}
const ms = performance.now() - t0;
console.log(JSON.stringify({ sym, ms: +ms.toFixed(1), hitFiles, hitLines, grepOnlyTokens: Math.ceil(lineBytes / 4), grepPlusReadTokens: Math.ceil(fullBytes / 4) }));
