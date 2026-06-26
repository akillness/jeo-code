/**
 * Runtime smoke-check for the RRF hybrid memory reranker.
 * NOT a test — drives the *production* entry point `memoryPromptSection`
 * (the exact call the agent loop makes each turn) against a real on-disk
 * .jeo concept bundle, with real file IO / parse / graph build / RRF rerank.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { memoryPromptSection, invalidateConceptCache } from "../src/agent/memory";

async function writeConcept(dir: string, sub: string, slug: string, fm: Record<string, string>, body: string) {
  const d = path.join(dir, ".jeo", "memory", sub);
  await fs.mkdir(d, { recursive: true });
  const front = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  await fs.writeFile(path.join(d, `${slug}.md`), `---\n${front}\n---\n${body}\n`, "utf-8");
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-rrf-runtime-"));
invalidateConceptCache();

// Two query-hit seeds both link a shared "rollback" hub that has NO query keyword.
// An equal-(zero)-lexical "changelog" concept has no links. Graph proximity (dense
// channel) must surface the multiply-linked hub; RRF fuses it with lexical hits.
await writeConcept(dir, "commands", "deploy",  { type: "Command", title: "deploy step",  description: "ship it", confidence: "low" }, "Deploy. On failure see [rollback](/commands/rollback.md).");
await writeConcept(dir, "commands", "release", { type: "Command", title: "release step", description: "cut it",  confidence: "low" }, "Release flow. Undo via [rollback](/commands/rollback.md).");
await writeConcept(dir, "commands", "rollback",{ type: "Command", title: "undo a bad release", description: "revert", confidence: "low" }, "Steps to revert.");
await writeConcept(dir, "facts", "changelog",  { type: "RepoFact", title: "changelog notes", description: "history", confidence: "low" }, "Release notes live here.");
const big = "w ".repeat(900);
for (let i = 0; i < 8; i++) {
  await writeConcept(dir, "facts", `noise-${i}`, { type: "RepoFact", title: `Noise ${i}`, description: "filler", confidence: "low" }, big);
}

const section = await memoryPromptSection(dir, "deploy release");
console.log("----- injected memory section (query='deploy release') -----");
console.log(section);
console.log("------------------------------------------------------------");

const checks: [string, boolean][] = [
  ["lexical seed 'deploy step' injected",  section.includes("deploy step")],
  ["lexical seed 'release step' injected", section.includes("release step")],
  ["graph hub 'undo a bad release' rode in via proximity (no query keyword)", section.includes("undo a bad release")],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
await fs.rm(dir, { recursive: true, force: true });
console.log(ok ? "\nRUNTIME OK: RRF hybrid reranker fired through production path." : "\nRUNTIME FAIL");
process.exit(ok ? 0 : 1);
