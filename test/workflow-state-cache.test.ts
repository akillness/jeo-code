import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { readWorkflowState, readWorkflowStateStrict, writeWorkflowState, clearWorkflowState } from "../src/agent/state";

// The mtime+size-validated workflow-state cache must never sacrifice correctness — the
// mutation guard (readWorkflowStateStrict) reads the lock before every mutating tool, so a
// stale cache could let a write slip past an active interview lock.
test("workflow-state cache: write→read, cross-process change detected, clear invalidates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-wfstate-"));
  try {
    await writeWorkflowState("team", { active: true, current_phase: "running", skill: "team" } as any, dir);
    // Served from the cache the write populated.
    expect((await readWorkflowState("team", dir))?.current_phase).toBe("running");
    expect((await readWorkflowStateStrict("team", dir))?.current_phase).toBe("running");

    // ANOTHER process overwrites the file directly (bypassing writeWorkflowState). The
    // mtime/size-validated cache MUST detect this and serve the fresh content.
    const statePath = path.join(dir, ".jeo", "state", "team-state.json");
    await new Promise(r => setTimeout(r, 12)); // distinct mtime
    await fs.writeFile(statePath, JSON.stringify({ active: false, current_phase: "complete", skill: "team" }), "utf-8");
    expect((await readWorkflowState("team", dir))?.current_phase).toBe("complete");

    // A corrupt external write is surfaced by the strict reader (fail-closed), not masked
    // by the cached valid value.
    await new Promise(r => setTimeout(r, 12));
    await fs.writeFile(statePath, "{ not json", "utf-8");
    await expect(readWorkflowStateStrict("team", dir)).rejects.toThrow(/corrupt/);

    // clear() invalidates the cache → null.
    await clearWorkflowState("team", dir);
    expect(await readWorkflowState("team", dir)).toBeNull();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
