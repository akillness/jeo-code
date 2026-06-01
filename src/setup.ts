/**
 * jeoc setup / jeoc models — provider+model onboarding and a small model registry,
 * mirroring gjc's `setup` flow and model registry.
 *
 * Zero external dependencies.
 */
import {
  applyConfig,
  resolveConfig,
  maskApiKey,
  DEFAULT_ENV,
  DEFAULT_MODEL,
  type ProviderName,
} from "./config.ts";

/** Curated known models per provider (advisory; any model id still works). */
export const KNOWN_MODELS: Record<ProviderName, string[]> = {
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-flash-latest"],
  anthropic: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-latest"],
  openai: ["gpt-4o", "gpt-4o-mini", "o4-mini"],
  mock: ["mock-1"],
};

const PROVIDERS: ProviderName[] = ["gemini", "anthropic", "openai", "mock"];

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = "true";
      else {
        flags[key] = next;
        i++;
      }
    } else positionals.push(a);
  }
  return { positionals, flags };
}

async function geminiListModels(apiKey: string): Promise<string[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
  return (data.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
}

export async function runModels(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const provider = (flags.provider as ProviderName) ?? resolveConfig().provider;
  if (flags.live === "true" && provider === "gemini") {
    const r = resolveConfig({ provider: "gemini" });
    if (!r.apiKey) {
      console.error("jeoc models --live: gemini needs an API key (GEMINI_API_KEY or `jeoc config set apiKey`)");
      process.exit(1);
    }
    try {
      const live = await geminiListModels(r.apiKey);
      console.log(`gemini models available to this key (${live.length}):`);
      for (const m of live) console.log(`  ${m}`);
    } catch (e) {
      console.error(`jeoc models --live: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }
  console.log(`known models for '${provider}' (default: ${DEFAULT_MODEL[provider]}):`);
  for (const m of KNOWN_MODELS[provider] ?? []) console.log(`  ${m}${m === DEFAULT_MODEL[provider] ? "  (default)" : ""}`);
  if (provider === "gemini") console.log("\n  tip: `jeoc models --live` lists exactly what your key can call.");
}

export function runSetup(argv: string[]): void {
  const { flags } = parseArgs(argv);
  const die = (m: string): never => {
    console.error(`jeoc setup: ${m}`);
    process.exit(1);
  };

  if (flags.help === "true") {
    console.log(
      [
        "jeoc setup — configure provider + model (writes .jeoc/config.json)",
        "",
        "  jeoc setup --provider gemini [--model gemini-2.5-flash] [--apiKey K] [--user|--project]",
        "",
        "providers: gemini | anthropic | openai | mock",
        "If --model is omitted the provider default is used. API key may also come from env",
        `(${PROVIDERS.filter((p) => DEFAULT_ENV[p].length).map((p) => DEFAULT_ENV[p][0]).join(", ")}).`,
      ].join("\n"),
    );
    return;
  }

  const provider = (flags.provider as ProviderName) ?? "gemini";
  if (!PROVIDERS.includes(provider)) die(`unknown provider '${provider}' (choose: ${PROVIDERS.join(", ")})`);
  const model = flags.model ?? DEFAULT_MODEL[provider];
  const scope = flags.user === "true" ? "user" : flags.project === "true" ? "project" : undefined;

  const updates: Record<string, unknown> = { provider, model };
  if (flags.apiKey) updates.apiKey = flags.apiKey;
  const target = applyConfig(updates, scope);

  const r = resolveConfig();
  console.log(`jeoc setup: configured ${provider}/${model} → ${target}`);
  console.log(`  apiKey   ${maskApiKey(r.apiKey)}  [source: ${r.apiKeySource}]`);
  if (provider !== "mock" && !r.apiKey) {
    const envs = DEFAULT_ENV[provider].join(" or ");
    console.log(`  ⚠️  no API key yet — set one of: export ${envs}=...  OR  jeoc config set apiKey <key>`);
  } else {
    console.log(`  ✅ ready — try: jeoc agent "list the files here and summarize"`);
  }
}
