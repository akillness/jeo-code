import { readGlobalConfig } from "../agent/state";
import { listAliases, resolveModelId } from "../ai/model-registry";
import { resolveProvider } from "../ai/model-manager";

async function probeOllama(baseUrl: string): Promise<string[]> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return [];
    const data = (await r.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map(m => `ollama/${m.name}`);
  } catch {
    return [];
  }
}

async function probeOpenAiCompat(baseUrl: string): Promise<string[]> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return [];
    const data = (await r.json()) as { data?: { id: string }[] };
    return (data.data ?? []).map(m => `openai/${m.id}`);
  } catch {
    return [];
  }
}

export async function runModelsCommand(_args: string[] = []): Promise<void> {
  const config = await readGlobalConfig();
  console.log("\n=== joc models ===");
  const resolved = await resolveModelId(config.defaultModel);
  console.log(`Default model: ${config.defaultModel}${resolved !== config.defaultModel ? ` → ${resolved}` : ""} → ${resolveProvider(resolved)}`);

  const aliases = await listAliases();
  console.log("\nAliases (use as the model id; config overrides built-ins):");
  for (const [alias, target] of Object.entries(aliases)) {
    console.log(`  ${alias.padEnd(10)} → ${target}`);
  }

  const ollamaBase = config.ollamaBaseUrl ?? "http://localhost:11434";
  const ollama = await probeOllama(ollamaBase);
  console.log(`\nLocal Ollama (${ollamaBase}):`);
  if (ollama.length) for (const m of ollama.slice(0, 30)) console.log(`  ${m}`);
  else console.log("  (none reachable)");

  if (config.openaiBaseUrl) {
    const compat = await probeOpenAiCompat(config.openaiBaseUrl);
    console.log(`\nOpenAI-compatible (${config.openaiBaseUrl}):`);
    if (compat.length) for (const m of compat.slice(0, 30)) console.log(`  ${m}`);
    else console.log("  (none reachable)");
  }
  console.log("\nSet a default with 'joc setup' or JOC_DEFAULT_MODEL=<id>.");
}
