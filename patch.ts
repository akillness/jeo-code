import * as fs from "node:fs";

let engine = fs.readFileSync('src/agent/engine.ts', 'utf8');
let outputUtil = fs.readFileSync('src/agent/output-util.ts', 'utf8');

// The block starts at export function truncateToolOutput and ends before export async function invokeCallLlm or similar.
const lines = engine.split('\n');
let startIdx = lines.findIndex(l => l.includes('export function truncateToolOutput('));
if (startIdx === -1) {
  console.log("Could not find start");
  process.exit(1);
}
// walk back up to the JSDoc comment
while (startIdx > 0 && lines[startIdx-1].trim().startsWith('*') || lines[startIdx-1].trim().startsWith('/**')) {
  startIdx--;
}

let endIdx = lines.findIndex((l, i) => i > startIdx && l.includes('/** Levenshtein distance (small inputs'));
if (endIdx === -1) {
  console.log("Could not find end");
  process.exit(1);
}

const blockLines = lines.slice(startIdx, endIdx);
const blockToMove = blockLines.join('\n');

// Replace in outputUtil
const ouLines = outputUtil.split('\n');
const ouStart = ouLines.findIndex(l => l.includes('export const TOOL_SPILL_THRESHOLD'));
let ouEnd = ouLines.findIndex(l => l.includes('export interface PerfMetric {'));
while(ouEnd > 0 && ouLines[ouEnd-1].trim().startsWith('*') || ouLines[ouEnd-1].trim().startsWith('/**')) {
    ouEnd--;
}

ouLines.splice(ouStart, ouEnd - ouStart, blockToMove);
outputUtil = ouLines.join('\n');

// Remove from engine
lines.splice(startIdx, endIdx - startIdx);
engine = lines.join('\n');

// Add import
engine = engine.replace(
  'import { StepBudget, resolveStepBudgetConfig, type StepBudgetConfig } from "./step-budget";',
  'import { StepBudget, resolveStepBudgetConfig, type StepBudgetConfig } from "./step-budget";\nimport { truncateToolOutput, TOOL_SPILL_THRESHOLD, spillToolResult } from "./output-util";'
);

fs.writeFileSync('src/agent/engine.ts', engine);
fs.writeFileSync('src/agent/output-util.ts', outputUtil);

console.log("Refactoring complete");
