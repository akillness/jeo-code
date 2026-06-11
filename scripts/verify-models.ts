/**
 * Live model verification: exercises each recent catalog model through the REAL
 * production path (createModelManager → routing → credential resolution → adapter
 * → retry). One tiny non-stream call per model; reports ok/fail per provider.
 *
 *   bun scripts/verify-models.ts                 # all authenticated providers
 *   bun scripts/verify-models.ts anthropic gemini
 *
 * Models with no usable credential are SKIPPED (not failed). Exit code is 1 only
 * when an authenticated provider's model fails for a non-rate-limit reason.
 */
import { createModelManager } from "../src/ai/model-manager";
import { snapshotProvider } from "../src/auth/storage";
import { CODEX_MODELS } from "../src/ai/model-catalog";

interface Target {
  provider: "anthropic" | "openai" | "gemini" | "antigravity" | "ollama";
  model: string;
}

/** Recent (current-generation) models per provider — the set users actually pick. */
const RECENT: Target[] = [
  { provider: "anthropic", model: "claude-haiku-4-5" },
  { provider: "anthropic", model: "claude-sonnet-4-5" },
  { provider: "anthropic", model: "claude-opus-4-5" },
  ...CODEX_MODELS.map(m => ({ provider: "openai" as const, model: m })),
  { provider: "gemini", model: "gemini-2.5-flash" },
  { provider: "gemini", model: "gemini-2.5-pro" },
  { provider: "gemini", model: "gemini-flash-latest" },
  { provider: "antigravity", model: "antigravity/gemini-3-pro-low" },
  { provider: "antigravity", model: "antigravity/claude-sonnet-4-5" },
  { provider: "ollama", model: "ollama/qwen2.5:0.5b" },
];

async function hasCredential(provider: Target["provider"]): Promise<boolean> {
  if (provider === "ollama") {
    try {
      const base = process.env.OLLAMA_HOST || "http://localhost:11434";
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }
  const snap = await snapshotProvider(provider === "antigravity" ? "gemini" : provider);
  return provider === "antigravity" ? Boolean(snap.oauth) : Boolean(snap.oauth || snap.apiKey);
}

function isRateLimit(msg: string): boolean {
  return /429|rate.?limit|quota|usage.?limit|exhausted|overloaded/i.test(msg);
}

async function main(): Promise<void> {
  const only = new Set(process.argv.slice(2).map(s => s.toLowerCase()));
  const manager = createModelManager();
  let hardFailures = 0;
  const rows: string[] = [];

  for (const t of RECENT) {
    if (only.size && !only.has(t.provider)) continue;
    if (!(await hasCredential(t.provider))) {
      rows.push(`SKIP  ${t.provider.padEnd(10)} ${t.model.padEnd(28)} (no credential)`);
      continue;
    }
    const started = Date.now();
    try {
      const reply = await manager.call(
        [{ role: "user", content: "Reply with exactly the single word: ok" }],
        { model: t.model, maxTokens: 16 },
      );
      const ms = Date.now() - started;
      const text = (reply ?? "").trim().slice(0, 40).replace(/\n/g, " ");
      const sane = text.length > 0;
      if (!sane) hardFailures++;
      rows.push(`${sane ? "OK  " : "FAIL"}  ${t.provider.padEnd(10)} ${t.model.padEnd(28)} ${ms}ms  "${text}"`);
    } catch (err) {
      const ms = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      if (isRateLimit(msg)) {
        rows.push(`RATE  ${t.provider.padEnd(10)} ${t.model.padEnd(28)} ${ms}ms  (rate/usage limited — credential + routing verified)`);
      } else {
        hardFailures++;
        rows.push(`FAIL  ${t.provider.padEnd(10)} ${t.model.padEnd(28)} ${ms}ms  ${msg.slice(0, 140)}`);
      }
    }
  }

  console.log(rows.join("\n"));
  console.log(`\n${hardFailures === 0 ? "All authenticated recent models verified." : `${hardFailures} hard failure(s).`}`);
  process.exit(hardFailures === 0 ? 0 : 1);
}

await main();
