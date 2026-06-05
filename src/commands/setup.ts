import { createInterface } from "node:readline/promises";
import { saveGlobalConfig, readGlobalConfig, type Config } from "../agent/state";
import {
  interactiveLogin,
  getStoredOAuth,
  OAUTH_FLOW_REGISTRY,
  openInBrowser,
  type AuthProvider,
  type OAuthController,
} from "../auth";
import {
  normalizeBaseUrl,
  chooseDefaultModel,
  recommendedModelsFor,
  buildSetupSummary,
} from "./setup-helpers";

/** Print a model choice's advisory warning + "did you mean" suggestions, if any. */
function reportModelChoice(r: { warning?: string; suggestions: string[] }): void {
  if (r.warning) console.log(`  ${r.warning}`);
  if (r.suggestions.length) console.log(`  Did you mean: ${r.suggestions.join(", ")}?`);
}

type ProviderChoice = "anthropic" | "openai" | "gemini" | "ollama" | "lmstudio" | "openai-compatible";

const DEFAULT_MODELS: Record<ProviderChoice, string> = {
  anthropic: "claude-3-5-sonnet-20241022",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  ollama: "ollama/llama3.1:8b",
  lmstudio: "openai/local-model",
  "openai-compatible": "openai/local-model",
};

const DEFAULT_BASE_URLS: Partial<Record<ProviderChoice, string>> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234/v1",
  "openai-compatible": "http://localhost:8000/v1",
};

async function listOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return [];
    const data = (await r.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map(m => m.name);
  } catch {
    return [];
  }
}

async function listOpenAiCompatibleModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const r = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { data?: { id: string }[] };
    return (data.data ?? []).map(m => m.id);
  } catch {
    return [];
  }
}

export async function runSetupCommand(): Promise<void> {
  const current = await readGlobalConfig();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n=== @jeo-code CLI Configuration (joc setup) ===");
  console.log("Configure providers, API keys / OAuth tokens, and default model.\n");

  console.log("Available provider types:");
  console.log("  1) anthropic           — Claude (API key or OAuth bearer)");
  console.log("  2) openai              — GPT (API key or OAuth bearer)");
  console.log("  3) gemini              — Google AI Studio (API key or OAuth bearer)");
  console.log("  4) ollama              — local Ollama (no auth)");
  console.log("  5) lmstudio            — local LM Studio (OpenAI-compatible)");
  console.log("  6) openai-compatible   — custom OpenAI-compatible (vLLM, llama-cpp-server, ...)");
  console.log("  7) skip                — keep existing values, just change defaults\n");

  const sel = (await rl.question("Configure which provider? [1-7]: ")).trim();
  const map: Record<string, ProviderChoice | "skip"> = {
    "1": "anthropic", "2": "openai", "3": "gemini",
    "4": "ollama",    "5": "lmstudio", "6": "openai-compatible",
    "7": "skip",
  };
  const choice = map[sel] ?? "skip";

  const next: Config = JSON.parse(JSON.stringify(current)) as Config;
  next.providers = next.providers || {};
  next.oauth = next.oauth || {};

  if (choice === "anthropic" || choice === "openai" || choice === "gemini") {
    const authMode = (
      await rl.question("Auth mode: (b)rowser OAuth login, (t)oken paste, or api (k)ey? [b]: ")
    ).trim().toLowerCase();
    if (authMode === "t") {
      const tok = await rl.question(`${choice} OAuth bearer token: `);
      if (tok.trim()) next.oauth[choice] = tok.trim();
    } else if (authMode === "k") {
      const key = await rl.question(`${choice} API key [${current.providers[choice] ? "********" : "None"}]: `);
      if (key.trim()) next.providers[choice] = key.trim();
    } else {
      const flow = OAUTH_FLOW_REGISTRY[choice as AuthProvider];
      if (!flow.verifiedEndToEnd && flow.note) console.log(`Note: ${flow.note}`);
      const ctrl: OAuthController = {
        onAuth: ({ url, instructions }) => {
          console.log(`Opening browser:\n  ${url}\n`);
          if (instructions) console.log(instructions + "\n");
          void openInBrowser(url);
        },
        onProgress: msg => console.log(`  … ${msg}`),
        onManualCodeInput: async () =>
          (await rl.question("Paste redirect URL or code (or wait for the browser callback): ")).trim(),
      };
      try {
        const { email } = await interactiveLogin(choice as AuthProvider, ctrl);
        const stored = await getStoredOAuth(choice as AuthProvider);
        if (stored) next.oauth[choice] = stored;
        console.log(`[SUCCESS] OAuth login complete for ${choice}${email ? ` (${email})` : ""}.`);
      } catch (err) {
        console.log(`[FAILED] OAuth login: ${(err as Error).message}`);
        console.log("Falling back — you can paste an API key instead.");
        const key = await rl.question(`${choice} API key [skip]: `);
        if (key.trim()) next.providers[choice] = key.trim();
      }
    }
    console.log(`\nRecommended ${choice} models:`);
    for (const m of recommendedModelsFor(choice)) console.log(`  - ${m}`);
    const dm = await rl.question(`Default model for ${choice} [${recommendedModelsFor(choice)[0]?.split(" ")[0] ?? DEFAULT_MODELS[choice]}]: `);
    const picked = chooseDefaultModel(dm, choice);
    reportModelChoice(picked);
    next.defaultModel = picked.model || DEFAULT_MODELS[choice];
  } else if (choice === "ollama") {
    const url = await rl.question(`Ollama base URL [${current.ollamaBaseUrl || DEFAULT_BASE_URLS.ollama}]: `);
    next.ollamaBaseUrl = normalizeBaseUrl(url, current.ollamaBaseUrl || DEFAULT_BASE_URLS.ollama!);
    console.log(`Probing models at ${next.ollamaBaseUrl} …`);
    const models = await listOllamaModels(next.ollamaBaseUrl!);
    if (models.length) {
      console.log("Detected local Ollama models:");
      models.slice(0, 20).forEach((m, i) => console.log(`  - ${m}`));
      const def = await rl.question(`Default model (ollama/<name>) [${"ollama/" + (models[0] ?? "llama3.1:8b")}]: `);
      next.defaultModel = def.trim() || `ollama/${models[0] ?? "llama3.1:8b"}`;
      reportModelChoice(chooseDefaultModel(next.defaultModel, "ollama"));
    } else {
      console.log("  (no models detected — Ollama not reachable, defaulting to llama3.1:8b)");
      const picked = chooseDefaultModel(await rl.question(`Default model [${DEFAULT_MODELS.ollama}]: `), "ollama");
      reportModelChoice(picked);
      next.defaultModel = picked.model || DEFAULT_MODELS.ollama;
    }
  } else if (choice === "lmstudio" || choice === "openai-compatible") {
    const dflt = DEFAULT_BASE_URLS[choice]!;
    const url = normalizeBaseUrl(await rl.question(`Base URL [${dflt}]: `), dflt);
    const key = (await rl.question(`API key (optional, blank for none): `)).trim();
    // Reuse the openai slot for compat (loop.ts treats OpenAI URL when openai key is set).
    // To not collide, keep an explicit override field via env-style.
    next.providers.openai = key || next.providers.openai;
    process.env.OPENAI_BASE_URL = url; // session hint
    console.log(`Probing models at ${url} …`);
    const models = await listOpenAiCompatibleModels(url, key);
    if (models.length) {
      console.log("Detected models:");
      models.slice(0, 20).forEach(m => console.log(`  - ${m}`));
      const def = await rl.question(`Default model (openai/<name>) [openai/${models[0]}]: `);
      next.defaultModel = def.trim() || `openai/${models[0]}`;
      reportModelChoice(chooseDefaultModel(next.defaultModel, "openai"));
    } else {
      console.log("  (no models detected — endpoint not reachable yet)");
      const picked = chooseDefaultModel(await rl.question(`Default model [${DEFAULT_MODELS[choice]}]: `), "openai");
      reportModelChoice(picked);
      next.defaultModel = picked.model || DEFAULT_MODELS[choice];
    }
    // Persist base URL by writing it to the config via a non-typed field — adopt a small extension.
    (next as Config & { openaiBaseUrl?: string }).openaiBaseUrl = url;
  }

  const level = (await rl.question(`Thinking level (low/medium/high) [${current.thinkingLevel || "medium"}]: `)).trim();
  next.thinkingLevel = (level || current.thinkingLevel || "medium") as "low" | "medium" | "high";

  rl.close();

  // Drop empty oauth/providers to keep config tidy.
  if (next.oauth && !next.oauth.anthropic && !next.oauth.openai && !next.oauth.gemini) delete next.oauth;

  await saveGlobalConfig(next);
  console.log("\n[SUCCESS] Configuration saved to ~/.joc/config.json");
  for (const line of buildSetupSummary(next)) console.log(line);
  console.log("");
}
