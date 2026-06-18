/**
 * `jeo memory-migrate` — one-shot, idempotent migration of a legacy single-doc
 * `.jeo/memory/MEMORY.md` into the OKF concept bundle (Sprint 05).
 *
 * Safe to re-run: if the bundle already holds concepts it is left untouched.
 * The legacy doc is preserved as `MEMORY.md.bak` for rollback; set
 * `JEO_MEMORY_LEGACY=1` to read that backup again if a rollback is needed.
 */
import { migrateLegacyMemory } from "../agent/memory";

export async function runMemoryMigrateCommand(_args: string[]): Promise<void> {
  const result = await migrateLegacyMemory(process.cwd());
  if (result.migrated) {
    console.log(`migrated ${result.conceptCount} concept(s) from MEMORY.md → OKF bundle (.jeo/memory/).`);
    if (result.backupPath) console.log(`legacy doc preserved at ${result.backupPath} (rollback: JEO_MEMORY_LEGACY=1).`);
  } else {
    console.log(`nothing to migrate — ${result.skipped}.`);
  }
}
