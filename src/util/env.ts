/**
 * Branded environment-variable lookup for jeo runtime flags.
 *
 * Runtime flags use the canonical `JEO_*` spelling only.
 * `env` is injectable for tests.
 */
export function jeoEnv(
  suffix: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env[`JEO_${suffix}`];
}
