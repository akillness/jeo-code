import { readGlobalConfig } from "../agent/state";
import { listAliases, resolveModelId } from "../ai/model-registry";
import { resolveProvider, resolveRoleModel } from "../ai/model-manager";
import { describeAllProviders } from "../ai/provider-status";
import { discoverModels } from "../ai/model-discovery";
import { formatLiveModels, formatCatalogTable, formatCanonicalCatalogTable, formatEnrichedModels } from "../tui/components/config-panel";
import { MODEL_CATALOG, fuzzyMatchCatalog, type ThinkLevel } from "../ai/model-catalog";
import { enrichAll, filterCapable, sortByCapability, knownCount } from "../ai/model-enrich";

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

export async function runModelsCommand(args: string[] = []): Promise<void> {
  const checkMode = args.includes("--check");
  const providerFilter = args.find(a => ["anthropic", "openai", "gemini", "ollama"].includes(a.toLowerCase()))?.toLowerCase();
  if (args.includes("--catalog")) {
    const query = args.find(a => !a.startsWith("--") && a.toLowerCase() !== "all");
    const rows = query ? fuzzyMatchCatalog(query) : [...MODEL_CATALOG];
    console.log("\n=== joc models --catalog ===");
    console.log(`Canonical models${query ? ` matching '${query}'` : ""}`);
    for (const line of formatCanonicalCatalogTable(rows)) console.log(line);
    console.log("\nProvider models");
    for (const line of formatCatalogTable(rows)) console.log(line);
    return;
  }
  if (args.includes("--caps")) {
    const cfg = await readGlobalConfig();
    const def = await resolveModelId(cfg.defaultModel);
    const thinkArg = args.find(a => a.startsWith("--thinking="))?.split("=")[1] as ThinkLevel | undefined;
    const filter = {
      thinking: thinkArg,
      images: args.includes("--images") ? true : undefined,
      minContext: args.includes("--long") ? 200_000 : undefined,
    };
    console.log("\n=== joc models --caps (live + capabilities) ===");
    const live = await discoverModels({ config: cfg, timeoutMs: 4000 });
    const enriched = sortByCapability(filterCapable(enrichAll(live), filter));
    const { known, unknown } = knownCount(enriched);
    for (const line of formatEnrichedModels(enriched, { current: def })) console.log(line);
    console.log(`\n${known} with known capabilities, ${unknown} unknown.`);
    return;
  }
  const config = await readGlobalConfig();
  console.log("\n=== joc models ===");
  const resolved = await resolveModelId(config.defaultModel);
  console.log(`Default model: ${config.defaultModel}${resolved !== config.defaultModel ? ` → ${resolved}` : ""} → ${resolveProvider(resolved)}`);
  console.log(`Role tiers: smol=${resolveRoleModel("smol", config)} · slow=${resolveRoleModel("slow", config)} · plan=${resolveRoleModel("plan", config)}`);

  const aliases = await listAliases();
  console.log("\nAliases (use as the model id; config overrides built-ins):");
  for (const [alias, target] of Object.entries(aliases)) {
    console.log(`  ${alias.padEnd(10)} → ${target.padEnd(22)} (${resolveProvider(target)})`);
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
  console.log("\nProvider credentials:");
  for (const status of await describeAllProviders(config)) {
    const base = status.baseUrl ? `  [${status.baseUrl}]` : "";
    console.log(`  ${status.name.padEnd(10)} ${status.ready ? "✓" : "·"} ${status.label}${base}`);
  }

  console.log("\nLive models (logged-in providers):");
  let live = await discoverModels({ config, timeoutMs: 4000 });
  if (providerFilter) live = live.filter(r => r.provider === providerFilter);
  if (checkMode) {
    for (const r of live) {
      const mark = r.ok ? "✓" : "✗";
      const detail = r.ok ? `${r.models.length} models (${r.source})` : `${r.error} (${r.source})`;
      console.log(`  ${mark} ${r.provider.padEnd(10)} ${detail}`);
    }
    return;
  }
  for (const line of formatLiveModels(live, { current: resolved, perProvider: 20 })) console.log(line);

  console.log("\nSet a default with 'joc setup' or JOC_DEFAULT_MODEL=<id>.");
}
