import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const entry = path.join(root, "src/agent/sandbox/hands-worker.ts");
const output = path.join(root, "src/agent/sandbox/hands-source.text");
// Hands always runs in a Linux container. Do not embed Darwin's optional watcher binary.
export async function buildSandboxWorker(): Promise<void> {
  const build = Bun.spawn([process.execPath, "build", entry, "--target=bun", "--format=esm", "--minify", "--external=chromium-bidi", "--external=fsevents", "--outfile", output], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) throw new Error(`Hands bundle build failed (${exitCode})`);
}

if (import.meta.main) await buildSandboxWorker();
