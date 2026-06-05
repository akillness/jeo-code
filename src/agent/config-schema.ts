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
    thinkingLevel: z.enum(["low", "medium", "high"]).optional(),
    modelAliases: z.record(z.string()).optional(),
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
