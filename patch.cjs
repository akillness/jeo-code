const fs = require('fs');

let engine = fs.readFileSync('src/agent/engine.ts', 'utf8');
let outputUtil = fs.readFileSync('src/agent/output-util.ts', 'utf8');

// The block to extract
const blockMatch = engine.match(/\/\*\*[\s\S]*?export function truncateToolOutput[\s\S]*?\}\n\n\/\*\* Tool output larger than this[\s\S]*?export const TOOL_SPILL_THRESHOLD[\s\S]*?\}\n\n/);

if (!blockMatch) {
  console.log("Could not find the block in engine.ts");
  process.exit(1);
}

const blockToMove = blockMatch[0];

// Remove the block from engine.ts
engine = engine.replace(blockToMove, "");

// Add import to engine.ts
engine = engine.replace(
  'import { StepBudget, resolveStepBudgetConfig, type StepBudgetConfig } from "./step-budget";',
  'import { StepBudget, resolveStepBudgetConfig, type StepBudgetConfig } from "./step-budget";\nimport { truncateToolOutput, TOOL_SPILL_THRESHOLD, spillToolResult } from "./output-util";'
);

// Remove the weak implementations from output-util.ts
outputUtil = outputUtil.replace(/export const TOOL_SPILL_THRESHOLD[\s\S]*?return path.relative\(cwd, fullPath\);\n}\n\n/, blockToMove);

fs.writeFileSync('src/agent/engine.ts', engine);
fs.writeFileSync('src/agent/output-util.ts', outputUtil);

console.log("Refactoring complete");
