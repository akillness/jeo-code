const fs = require('fs');
const path = 'src/agent/state.ts';
let content = fs.readFileSync(path, 'utf-8');
const oldBlock = `  const tmpPath = \`\${statePath}.\${Math.random().toString(36).slice(2)}.tmp\`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  // Cache the just-written state keyed on the new file fingerprint so the next read
  // (often the mutation guard milliseconds later) is served from memory.
  try {
    const st = await fs.stat(statePath);
    cacheWorkflowState(statePath, st.mtimeMs, st.size, state);
  } catch {
    workflowStateCache.delete(statePath);
  }
  return statePath;`;
const newBlock = `  const tmpPath = \`\${statePath}.\${Math.random().toString(36).slice(2)}.tmp\`;
  let st;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    // Stat the temp file BEFORE renaming. If we stat statePath after rename,
    // a concurrent writer could have already overwritten it, causing us to cache
    // our state object with their file's stats (a post-write re-read race).
    st = await fs.stat(tmpPath);
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  // Cache the just-written state keyed on the new file fingerprint so the next read
  // (often the mutation guard milliseconds later) is served from memory.
  if (st) {
    cacheWorkflowState(statePath, st.mtimeMs, st.size, state);
  } else {
    workflowStateCache.delete(statePath);
  }
  return statePath;`;
content = content.replace(oldBlock, newBlock);
fs.writeFileSync(path, content);
