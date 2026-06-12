/**
 * Branded environment-variable lookup for the jeo rename compatibility window.
 *
 * Every runtime flag exists under two spellings: the current `JEO_*` name and
 * the legacy `JEO_*` name from before the rename. `jeoEnv("X")` reads
 * `JEO_X ?? JEO_X` in one place, replacing the inline double-read that was previously
 * copy-pasted at every read site. `env` is injectable for tests.
 */
export function jeoEnv(
  suffix: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env[`JEO_${suffix}`] ?? env[`JEO_${suffix}`];
}
