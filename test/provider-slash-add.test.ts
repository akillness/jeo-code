import { test, expect } from "bun:test";
import {
  applyCustomProviderPatch,
  formatCustomProviderList,
  formatPresetsCommand,
  looksLikePreset,
  parseProviderAddArgs,
  planProviderAdd,
  planProviderRemove,
} from "../src/commands/launch/provider-slash";
import type { Config } from "../src/agent/state";

const cfg = (over: Partial<Pick<Config, "customProviders" | "openaiBaseUrl">> = {}) =>
  ({ customProviders: undefined, openaiBaseUrl: undefined, ...over }) as Pick<Config, "customProviders" | "openaiBaseUrl">;

const args = (s: string) => parseProviderAddArgs(s.split(/\s+/).filter(Boolean));

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

test("flags parse, including aliases and repeated --model", () => {
  const p = args("--id acme --base-url https://api.acme.dev/v1 --compat Anthropic --api-key-env ACME_TOKEN --model a,b --model c --label ACME --force");
  expect(p.id).toBe("acme");
  expect(p.baseUrl).toBe("https://api.acme.dev/v1");
  expect(p.compat).toBe("anthropic");
  expect(p.apiKeyEnv).toBe("ACME_TOKEN");
  expect(p.models).toEqual(["a,b", "c"]);
  expect(p.label).toBe("ACME");
  expect(p.force).toBe(true);
  expect(p.unknown).toEqual([]);

  expect(args("--url https://x.dev/v1 --key-env X --name x").baseUrl).toBe("https://x.dev/v1");
  expect(args("--url https://x.dev/v1 --key-env X --name x").id).toBe("x");
});

test("positionals keep the previous release's leniency: a URL is a base URL, else a model", () => {
  const p = args("https://api.example.com/v1 gpt-4o-mini");
  expect(p.baseUrl).toBe("https://api.example.com/v1");
  expect(p.defaultModel).toBe("gpt-4o-mini");
});

test("`clear` is recognized and unknown flags are reported, not swallowed", () => {
  expect(args("clear").clear).toBe(true);
  expect(args("--id a --base-url https://a.dev/v1 --bogus").unknown).toEqual(["--bogus"]);
});

// ---------------------------------------------------------------------------
// planning: named custom providers
// ---------------------------------------------------------------------------

test("a named provider is registered with a normalized url and derived env var", () => {
  const plan = planProviderAdd(args("--id acme --base-url https://api.acme.dev/v1/ --model fast,smart"), cfg());
  expect(plan.noop).toBe(false);
  expect(plan.id).toBe("acme");
  expect(plan.config?.baseUrl).toBe("https://api.acme.dev/v1");
  expect(plan.config?.protocol).toBe("openai");
  expect(plan.config?.models).toEqual(["fast", "smart"]);
  expect(plan.selectModel).toBe("acme/fast");
  expect(plan.lines.join("\n")).toContain("Registered provider 'acme'");
  expect(plan.lines.join("\n")).toContain("ACME_API_KEY");
});

test("a literal key is stored but only ever displayed redacted", () => {
  const plan = planProviderAdd(args("--id acme --base-url https://api.acme.dev/v1 --api-key sk-live-abcdefghijkl"), cfg());
  expect(plan.config?.apiKey).toBe("sk-live-abcdefghijkl");
  const printed = plan.lines.join("\n");
  expect(printed).not.toContain("sk-live-abcdefghijkl");
  expect(printed).toContain("sk-l…ijkl");
});

test("invalid input is reported as printable lines, never thrown (the REPL must survive)", () => {
  expect(planProviderAdd(args("--id My/Proxy --base-url https://a.dev/v1"), cfg())).toMatchObject({ noop: true });
  expect(planProviderAdd(args("--id acme --base-url localhost:1234"), cfg()).lines.join()).toMatch(/include the scheme/);
  expect(planProviderAdd(args("--id acme"), cfg()).lines.join()).toMatch(/--base-url is required/);
  expect(planProviderAdd(args("--id acme --base-url https://a.dev/v1 --compat bedrock"), cfg()).lines.join()).toMatch(
    /'openai' or 'anthropic'/,
  );
  expect(planProviderAdd(args("--id acme --base-url https://a.dev/v1 --nope"), cfg()).lines.join()).toMatch(/Unknown flag/);
});

test("claiming a built-in provider id is refused with the fix, not silently accepted", () => {
  const reserved = planProviderAdd(args("--id openai --base-url https://a.dev/v1"), cfg());
  expect(reserved.noop).toBe(true);
  expect(reserved.lines.join()).toMatch(/reserved/);

  // A compiled-in CATALOG provider is not "reserved" but is still already usable.
  const builtin = planProviderAdd(args("--id groq --base-url https://a.dev/v1"), cfg());
  expect(builtin.noop).toBe(true);
  expect(builtin.lines.join()).toMatch(/already a built-in provider/);
  expect(builtin.lines.join()).toContain("GROQ_API_KEY");
});

test("re-adding an existing id needs --force, and --force overwrites cleanly", () => {
  const existing = cfg({ customProviders: { acme: { baseUrl: "https://old.acme.dev/v1" } } });

  const blocked = planProviderAdd(args("--id acme --base-url https://new.acme.dev/v1"), existing);
  expect(blocked.noop).toBe(true);
  expect(blocked.lines.join()).toMatch(/already exists/);
  expect(blocked.lines.join()).toMatch(/--force/);

  const forced = planProviderAdd(args("--id acme --base-url https://new.acme.dev/v1 --force"), existing);
  expect(forced.noop).toBe(false);
  expect(forced.config?.baseUrl).toBe("https://new.acme.dev/v1");
});

// ---------------------------------------------------------------------------
// planning: presets
// ---------------------------------------------------------------------------

test("a preset fills protocol, env var and models with one flag", () => {
  const plan = planProviderAdd(args("--preset glm"), cfg());
  expect(plan.noop).toBe(false);
  expect(plan.id).toBe("glm-proxy");
  expect(plan.config?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
  expect(plan.config?.apiKeyEnv).toBe("ZAI_API_KEY");
  expect(plan.config?.thinkingFormat).toBe("zai");
  expect(plan.config?.preset).toBe("glm");
  expect(plan.lines.join()).toContain("preset glm");
});

test("a parameterized preset surfaces the missing --base-url as guidance", () => {
  const plan = planProviderAdd(args("--preset vllm"), cfg());
  expect(plan.noop).toBe(true);
  expect(plan.lines.join()).toMatch(/--base-url/);
});

test("a bare preset name after `add` is accepted (looksLikePreset)", () => {
  expect(looksLikePreset("litellm")).toBe(true);
  expect(looksLikePreset("--id")).toBe(false);
  expect(looksLikePreset("definitely-not-a-preset")).toBe(false);
  expect(looksLikePreset(undefined)).toBe(false);
});

test("preset collisions honour --force the same way named providers do", () => {
  const existing = cfg({ customProviders: { "glm-proxy": { baseUrl: "https://api.z.ai/api/paas/v4" } } });
  expect(planProviderAdd(args("--preset glm"), existing).noop).toBe(true);
  expect(planProviderAdd(args("--preset glm --force"), existing).noop).toBe(false);
});

// ---------------------------------------------------------------------------
// legacy compatibility
// ---------------------------------------------------------------------------

test("the pre-existing no-id spelling still rebinds the built-in openai endpoint", () => {
  const plan = planProviderAdd(args("--base-url http://localhost:1234/v1/"), cfg());
  expect(plan.noop).toBe(false);
  expect(plan.legacyOpenaiBaseUrl).toBe("http://localhost:1234/v1");
  expect(plan.id).toBeUndefined();
  // …and points the user at the better, named alternative.
  expect(plan.lines.join()).toMatch(/registers it as its own provider/);
});

test("`/provider add clear` clears only the legacy base URL, never custom providers", () => {
  const plan = planProviderAdd(args("clear"), cfg({ customProviders: { acme: { baseUrl: "https://a.dev/v1" } } }));
  expect(plan.legacyOpenaiBaseUrl).toBeNull();
  expect(plan.id).toBeUndefined();
  expect(plan.lines.join()).toMatch(/custom providers are unaffected/);
});

test("legacy --compat anthropic without an id is refused (it would hijack openai/)", () => {
  const plan = planProviderAdd(args("--base-url https://claude.corp/v1 --compat anthropic"), cfg());
  expect(plan.noop).toBe(true);
  expect(plan.lines.join()).toMatch(/needs a named provider/);
});

test("bare `/provider add` prints the current legacy URL plus usage, and changes nothing", () => {
  const empty = planProviderAdd(args(""), cfg());
  expect(empty.noop).toBe(true);
  expect(empty.lines.join()).toMatch(/No OpenAI-compatible base URL set/);

  const set = planProviderAdd(args(""), cfg({ openaiBaseUrl: "http://localhost:1234/v1" }));
  expect(set.lines.join()).toContain("http://localhost:1234/v1");
});

// ---------------------------------------------------------------------------
// remove / list / patch
// ---------------------------------------------------------------------------

test("remove reports the endpoint it dropped and refuses built-ins", () => {
  const existing = cfg({ customProviders: { acme: { baseUrl: "https://a.dev/v1" } } });

  const ok = planProviderRemove("ACME", existing);
  expect(ok.removeId).toBe("acme");
  expect(ok.lines.join()).toContain("https://a.dev/v1");

  expect(planProviderRemove("groq", existing).removeId).toBeUndefined();
  expect(planProviderRemove("groq", existing).lines.join()).toMatch(/built-in provider and cannot be removed/);

  expect(planProviderRemove("ghost", existing).removeId).toBeUndefined();
  expect(planProviderRemove(undefined, existing).lines.join()).toMatch(/Usage: \/provider remove/);
  expect(planProviderRemove(undefined, cfg()).lines.join()).toMatch(/No custom providers registered/);
});

test("list shows the credential SOURCE (env vs config vs missing) without leaking the key", () => {
  const listed = formatCustomProviderList(
    cfg({
      customProviders: {
        withEnv: { baseUrl: "https://a.dev/v1", apiKeyEnv: "A_TOKEN" },
        withKey: { baseUrl: "https://b.dev/v1", apiKey: "sk-secret-abcdefgh", protocol: "anthropic" },
        missing: { baseUrl: "https://c.dev/v1" },
      },
    }),
    { A_TOKEN: "value" } as unknown as NodeJS.ProcessEnv,
  ).join("\n");

  expect(listed).toContain("env A_TOKEN");
  expect(listed).toContain("config sk-s…efgh");
  expect(listed).not.toContain("sk-secret-abcdefgh");
  expect(listed).toMatch(/MISSING \(set MISSING_API_KEY\)/);
  expect(listed).toContain("[anthropic]");
});

test("list guides a user with nothing registered", () => {
  const lines = formatCustomProviderList(cfg()).join("\n");
  expect(lines).toMatch(/No custom providers registered/);
  expect(lines).toMatch(/--preset/);
});

test("presets command renders the catalog", () => {
  const out = formatPresetsCommand().join("\n");
  expect(out).toMatch(/Provider presets/);
  expect(out).toContain("litellm");
  expect(out).toContain("vllm");
});

test("the config patch adds, removes, and collapses an empty map back to undefined", () => {
  const added = applyCustomProviderPatch(undefined, { addId: "a", addConfig: { baseUrl: "https://a.dev/v1" } });
  expect(added).toEqual({ a: { baseUrl: "https://a.dev/v1" } });

  const both = applyCustomProviderPatch(added, { addId: "b", addConfig: { baseUrl: "https://b.dev/v1" } });
  expect(Object.keys(both!)).toEqual(["a", "b"]);

  const removed = applyCustomProviderPatch(both, { removeId: "a" });
  expect(Object.keys(removed!)).toEqual(["b"]);

  // Emptying the map drops the key entirely instead of persisting `{}`.
  expect(applyCustomProviderPatch(removed, { removeId: "b" })).toBeUndefined();

  // The input object is never mutated (config patches must stay pure).
  expect(Object.keys(both!)).toEqual(["a", "b"]);
});
