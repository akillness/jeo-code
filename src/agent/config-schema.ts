import { z } from "zod";

/**
 * Runtime validation for `~/.joc/config.json`. Previously the file was
 * `JSON.parse`d and cast straight to `Config` — a wrong-typed field (e.g. a
 * numeric `defaultModel`) slipped through untyped and surfaced as a confusing
 * downstream failure. `parseConfig` turns that into a clear, actionable signal.
 */
const StoredOAuthSchema = z.object({
  access: z.string(),
  refresh: z.string().optional(),
  expires: z.number().optional(),
  accountId: z.string().optional(),
  email: z.string().optional(),
  projectId: z.string().optional(),
});

const OAuthEntry = z.union([z.string(), StoredOAuthSchema]);

export const ConfigSchema = z
  .object({
    providers: z
      .object({
        anthropic: z.string().optional(),
        openai: z.string().optional(),
        gemini: z.string().optional(),
      })
      .default({}),
    oauth: z
      .object({
        anthropic: OAuthEntry.optional(),
        openai: OAuthEntry.optional(),
        gemini: OAuthEntry.optional(),
      })
      .optional(),
    ollamaBaseUrl: z.string().optional(),
    openaiBaseUrl: z.string().optional(),
    defaultModel: z.string().min(1),
    thinkingLevel: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    modelAliases: z.record(z.string()).optional(),
    /**
     * Provider retry budgets (gjc parity). `requestMaxRetries` counts retries
     * (not the initial request) for a provider request; `maxDelayMs` caps backoff.
     * `maxRetries`/`streamMaxRetries` are accepted for gjc-config compatibility.
     */
    retry: z
      .object({
        requestMaxRetries: z.number().int().min(0).optional(),
        streamMaxRetries: z.number().int().min(0).optional(),
        maxRetries: z.number().int().min(0).optional(),
        maxDelayMs: z.number().int().min(0).optional(),
        rateLimitRetries: z.number().int().min(0).optional(),
        rateLimitMinDelayMs: z.number().int().min(0).optional(),
      })
      .optional(),
    /**
     * Per-subagent-role overrides (gjc role-agent parity). Keyed by role id
     * (executor / planner / architect / critic); each may pin a model and/or a
     * step budget. Tolerant of unknown keys.
     */
    subagents: z
      .record(
        z.object({
          model: z.string().optional(),
          // Tolerated, informational provider tag (model ids are persisted provider-qualified)
          provider: z.enum(["anthropic", "openai", "gemini", "ollama"]).optional(),
          maxSteps: z.number().int().min(1).optional(),
        }),
      )
      .optional(),
    /** Model role tiers (smol/slow/plan); each falls back to defaultModel. */
    roles: z
      .object({
        smol: z.string().optional(),
        slow: z.string().optional(),
        plan: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export type ValidatedConfig = z.infer<typeof ConfigSchema>;

/** Validate parsed JSON against the config schema. Returns a tagged result, never throws. */
export function parseConfig(raw: unknown): { ok: true; config: ValidatedConfig } | { ok: false; message: string } {
  const result = ConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, config: result.data };
  const issue = result.error.issues[0];
  const where = issue?.path?.length ? issue.path.join(".") : "config";
  return { ok: false, message: `${where}: ${issue?.message ?? "invalid"}` };
}
