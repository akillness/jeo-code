/**
 * `jeo provider …` — manage providers from the shell, not just from inside the REPL.
 *
 * The slash command (`/provider add …`) already existed, but it is only reachable from
 * an interactive session. Provisioning a machine, a CI runner, or a devcontainer means
 * scripting it, so the same registry is exposed as a real subcommand with the SAME
 * flags and the SAME planners (`provider-slash.ts`) — one implementation, two surfaces,
 * so they can never drift.
 *
 * Beyond parity this adds `jeo provider test <id>`, a live endpoint probe. Registering a
 * provider is cheap and silent; discovering at the first real inference call that the
 * base URL was wrong (or the key env var is not exported in THIS shell) is not. `add`
 * runs the probe automatically and reports the result without refusing the write — a
 * user may legitimately register an endpoint before the key exists.
 */
import { readGlobalConfig, saveConfigPatch } from "../agent/state";
import {
  applyCustomProviderPatch,
  formatCustomProviderList,
  formatPresetsCommand,
  looksLikePreset,
  parseProviderAddArgs,
  planProviderAdd,
  planProviderRemove,
  providerAddUsage,
} from "./launch/provider-slash";
import {
  credentialSourceOf,
  customProviderDef,
  customProviderDefs,
  normalizeProviderId,
} from "../ai/providers/custom-providers";
import { listProviderModels } from "../ai/model-discovery";
import { describeProvider } from "../ai/provider-status";

const USAGE = [
  "Usage: jeo provider <command>",
  "",
  "  list                                   Show registered custom providers",
  "  add --id <id> --base-url <url> [...]   Register an OpenAI/Anthropic-compatible provider",
  "  add --preset <preset> [--base-url <url>]",
  "  remove <id>                            Unregister a custom provider",
  "  presets                                List the built-in provider presets",
  "  test <id>                              Probe a provider's endpoint and credential",
  "",
  "Flags for add:",
  "  --id <id>            Routing prefix + config key (e.g. my-proxy → my-proxy/<model>)",
  "  --base-url <url>     API base URL (https://… or http://…)",
  "  --compat <protocol>  openai (default) | anthropic",
  "  --api-key-env <ENV>  Env var holding the key (default: <ID>_API_KEY)",
  "  --api-key <key>      Literal key, stored in ~/.jeo/config.json (prefer --api-key-env)",
  "  --model a,b          Known model ids for the offline pick-list",
  "  --label <name>       Display name",
  "  --force              Overwrite an existing provider with the same id",
].join("\n");

export async function runProviderCommand(args: string[]): Promise<void> {
  const sub = (args[0] ?? "").toLowerCase();
  switch (sub) {
    case "":
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    case "list":
    case "ls":
      return runList();
    case "presets":
    case "preset":
      console.log(formatPresetsCommand().join("\n"));
      return;
    case "add":
      return runAdd(args.slice(1));
    case "remove":
    case "rm":
    case "delete":
      return runRemove(args[1]);
    case "test":
    case "probe":
    case "check":
      return runTest(args[1]);
    default:
      console.log(`Unknown provider subcommand: ${sub}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

async function runList(): Promise<void> {
  console.log(formatCustomProviderList(await readGlobalConfig()).join("\n"));
}

async function runAdd(rest: string[]): Promise<void> {
  const parsed = parseProviderAddArgs(rest);
  if (!parsed.preset && looksLikePreset(rest[0])) parsed.preset = rest[0];

  const plan = planProviderAdd(parsed, await readGlobalConfig());
  console.log(plan.lines.join("\n"));
  if (plan.noop) {
    // A usage dump is informational; a rejected registration is a scripting failure and
    // must be visible to `set -e`. `--base-url`-less bare invocations print usage only.
    if (rest.length > 0) process.exitCode = 1;
    return;
  }

  if (plan.legacyOpenaiBaseUrl !== undefined) {
    const url = plan.legacyOpenaiBaseUrl;
    await saveConfigPatch(() => ({ openaiBaseUrl: url ?? undefined }));
  }
  if (plan.id && plan.config) {
    await saveConfigPatch(raw => ({
      customProviders: applyCustomProviderPatch(raw.customProviders, { addId: plan.id, addConfig: plan.config }),
    }));
    // Re-read so `withEnvOverlay` republishes the new provider into the runtime registry
    // before the probe below resolves its credential.
    await readGlobalConfig();
    console.log("");
    await probe(plan.id, { failOnError: false });
  }
}

async function runRemove(rawId: string | undefined): Promise<void> {
  const decision = planProviderRemove(rawId, await readGlobalConfig());
  console.log(decision.lines.join("\n"));
  if (!decision.removeId) {
    if (rawId) process.exitCode = 1;
    return;
  }
  await saveConfigPatch(raw => ({
    customProviders: applyCustomProviderPatch(raw.customProviders, { removeId: decision.removeId }),
  }));
  await readGlobalConfig();
}

async function runTest(rawId: string | undefined): Promise<void> {
  if (!rawId) {
    const ids = customProviderDefs().map(d => d.name);
    console.log(
      ids.length
        ? `Usage: jeo provider test <id>\nRegistered: ${ids.join(", ")}`
        : "No custom providers registered. Add one with 'jeo provider add --id <id> --base-url <url>'.",
    );
    process.exitCode = 1;
    return;
  }
  await probe(normalizeProviderId(rawId), { failOnError: true });
}

/**
 * Probe one provider: report its credential source, then try to list models at its
 * endpoint. Separating the two matters — "no key" and "wrong URL" need different fixes,
 * and a single "failed" line sends users down the wrong path.
 */
async function probe(id: string, opts: { failOnError: boolean }): Promise<void> {
  // A fresh config read republishes the custom set, so a provider added moments ago in
  // this same process is resolvable here.
  const cfg = await readGlobalConfig();
  const def = customProviderDef(id);
  if (!def) {
    const status = await describeProvider(id, cfg);
    if (!status.ready && status.kind === "none") {
      console.log(`No provider '${id}'. Run 'jeo provider list' or 'jeo provider add --id ${id} --base-url <url>'.`);
      if (opts.failOnError) process.exitCode = 1;
      return;
    }
    console.log(`'${id}' is a built-in provider — check it with 'jeo doctor'.`);
    if (opts.failOnError) process.exitCode = 1;
    return;
  }

  const source = credentialSourceOf(def);
  console.log(`Probing ${id} → ${def.baseUrl} (${def.protocol ?? "openai"})`);
  if (source === "none") {
    console.log(`  credential: MISSING — export ${def.apiKeyEnv}, or re-add with --api-key <key>.`);
  } else {
    console.log(`  credential: ${source === "env" ? `env ${def.apiKeyEnv}` : "stored in config"}`);
  }

  const result = await listProviderModels(id, { timeoutMs: 8000 });
  if (result.ok) {
    // Discovery already returns ids the router accepts; `qualify` only guards the case
    // where an endpoint echoes bare ids so the printed command is copy-pasteable.
    const qualify = (m: string) => (m.startsWith(`${id}/`) ? m : `${id}/${m}`);
    const shown = result.models.slice(0, 8).map(qualify);
    console.log(`  models    : ${result.models.length} discovered${result.fallback ? " (from the static catalog — the live list endpoint was unusable)" : ""}`);
    if (shown.length) console.log(`              ${shown.join(", ")}${result.models.length > shown.length ? ", …" : ""}`);
    const first = result.models[0];
    console.log(`  status    : OK — use it with 'jeo launch --model ${first ? qualify(first) : `${id}/<model>`}'`);
    return;
  }

  console.log(`  status    : FAILED — ${result.error ?? "no models returned"}`);
  console.log(
    source === "none"
      ? `  next      : set ${def.apiKeyEnv} and re-run 'jeo provider test ${id}'.`
      : `  next      : verify the base URL (a ${def.protocol === "anthropic" ? "/v1/models" : "/models"} route must exist under it) and that the key is valid for this endpoint.`,
  );
  if (opts.failOnError) process.exitCode = 1;
}
