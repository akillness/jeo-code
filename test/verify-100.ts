const TOTAL_RUNS = 100;
const CONCURRENCY = 15;

console.log(`Starting 100x verification runs with concurrency ${CONCURRENCY}...`);

let completed = 0;
let passed = 0;
let failed = 0;

const runTest = async (id: number) => {
  const proc = Bun.spawn(["bun", "test"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await proc.exited;
  completed++;
  if (exitCode === 0) {
    passed++;
  } else {
    failed++;
    console.error(`Run #${id} failed with exit code ${exitCode}`);
  }
  if (completed % 10 === 0 || completed === TOTAL_RUNS) {
    console.log(`Progress: ${completed}/${TOTAL_RUNS} completed (${passed} passed, ${failed} failed)`);
  }
};

const queue = Array.from({ length: TOTAL_RUNS }, (_, i) => i + 1);
const promises: Promise<void>[] = [];

for (let i = 0; i < CONCURRENCY; i++) {
  promises.push((async () => {
    while (queue.length > 0) {
      const id = queue.shift()!;
      await runTest(id);
    }
  })());
}

await Promise.all(promises);

console.log(`=== Verification Complete ===`);
console.log(`Total: ${TOTAL_RUNS}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

process.exit(failed > 0 ? 1 : 0);
