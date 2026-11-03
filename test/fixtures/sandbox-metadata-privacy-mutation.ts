import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Opt-in negative control. Reopen the two historical HIGH bugs only in a temp
// source copy, then run the exact focused tests against that copy. Never edit
// the checkout, load a real user catalog, or invoke a provider.
const checkout = path.resolve(import.meta.dir, "../..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-metadata-mutant-"));
try {
  await fs.cp(path.join(checkout, "src"), path.join(root, "src"), { recursive: true });
  await fs.copyFile(path.join(checkout, "package.json"), path.join(root, "package.json"));
  await fs.symlink(path.join(checkout, "node_modules"), path.join(root, "node_modules"));
  const memoryPath = path.join(root, "src/agent/memory.ts");
  let memory = await fs.readFile(memoryPath, "utf8");
  const retentionGuard = 'if (currentSandboxExecution()) throw new Error("SANDBOX_MEMORY: raw session payloads are parent-only");';
  const parentDistill = 'return (await distillSessionMemory(history, cwd, { model })).updated;';
  if (!memory.includes(retentionGuard) || !memory.includes(parentDistill)) throw new Error("Memory negative control no longer matches implementation");
  memory = memory.replace(retentionGuard, 'if (currentSandboxExecution()) return sandboxMemory("saveRaw", bundleDir, { payload });');
  memory = memory.replace(parentDistill, 'await saveRawPayload(path.join(cwd, ".jeo", "memory"), { model, messages: history });\n      ' + parentDistill);
  memory = memory.replace('switch (action) {\n    case "loadMemory":', 'switch (action) {\n    case "saveRaw": await saveRawPayload(cwd, args.payload); return null;\n    case "loadMemory":');
  await fs.writeFile(memoryPath, memory);

  const catalogPath = path.join(root, "src/skills/catalog.ts");
  let catalog = await fs.readFile(catalogPath, "utf8");
  const rootGuard = '  if (!protectedRoots.some(root => withinCatalogRoot(absolute, root))) return { path: absolute, traversal, guestPath: absolute };\n';
  const hopGuard = '    if (!protectedRoots.some(root => withinCatalogRoot(current, root) || withinCatalogRoot(root, current))) {\n      return { path: candidate, traversal, visited, guestPath: candidate };\n    }\n';
  if (!catalog.includes(rootGuard) || !catalog.includes(hopGuard)) throw new Error("Catalog negative control no longer matches implementation");
  catalog = catalog.replace(rootGuard, "").replace(hopGuard, "");
  await fs.writeFile(catalogPath, catalog);

  const child = Bun.spawn([process.execPath, "test", "test/sandbox-metadata-privacy.test.ts"], {
    cwd: checkout,
    env: { PATH: process.env.PATH ?? "", HOME: path.join(root, "home"), JEO_CONFIG_DIR: path.join(root, "config"), JEO_METADATA_PRIVACY_SOURCE_ROOT: root },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const exit = await child.exited;
  if (exit === 0) throw new Error("Negative control survived: metadata regressions have no teeth");
  process.exitCode = exit;
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
