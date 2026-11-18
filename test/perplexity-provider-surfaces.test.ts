import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearConfigReadCache } from "../src/agent/state";
import { buildStatusDto, runStatusCommand } from "../src/commands/status";
import { runDoctorCommand } from "../src/commands/doctor";
import { runProviderCommand } from "../src/commands/provider";
import { buildOnboardingChoices } from "../src/tui/components/provider-picker";

const ISOLATED_ENV_KEYS = [
  "JEO_CONFIG_DIR",
  "HOME",
  "JEO_SESSION_DIR",
  "JEO_SHARED_AUTH_POOL_PATH",
  "JEO_DEFAULT_MODEL",
  "PERPLEXITY_API_KEY",
  "PPLX_API_KEY",
  "PERPLEXITY_OAUTH_TOKEN",
  "PERPLEXITY_COOKIES",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_OAUTH_TOKEN",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_OAUTH_TOKEN",
  "OLLAMA_HOST",
  "LMSTUDIO_BASE_URL",
] as const;

let rootDir = "";
let cfgDir = "";
let homeDir = "";
let workspaceDir = "";
let savedEnv: Record<string, string | undefined> = {};
let savedExitCode: number | undefined;
const savedFetch = globalThis.fetch;

async function writeConfig(cfg: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify(cfg, null, 2), "utf-8");
  clearConfigReadCache();
}

async function captureConsoleLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

beforeEach(async () => {
  savedEnv = {};
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-pplx-surface-"));
  homeDir = path.join(rootDir, "home");
  cfgDir = path.join(rootDir, "config");
  workspaceDir = path.join(rootDir, "workspace");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  process.env.HOME = homeDir;
  process.env.JEO_CONFIG_DIR = cfgDir;
  process.env.JEO_SESSION_DIR = path.join(rootDir, "sessions");
  process.env.JEO_SHARED_AUTH_POOL_PATH = path.join(rootDir, "pool", "cooldowns.json");
  clearConfigReadCache();
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  process.exitCode = savedExitCode ?? 0;
  for (const key of ISOLATED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  clearConfigReadCache();
  if (rootDir) {
    await fs.rm(rootDir, { recursive: true, force: true });
    rootDir = "";
  }
});

describe("jeo status Perplexity search-provider parity", () => {
  test("unconfigured perplexity reports ready=false, authKind='none', and prints 'Search Auth:   none'", async () => {
    await writeConfig({ providers: {}, defaultModel: "claude-sonnet-4-6" });

    const dto = await buildStatusDto(workspaceDir);
    expect(dto.searchProviders).toEqual([
      expect.objectContaining({
        name: "perplexity",
        ready: false,
        authKind: "none",
      }),
    ]);

    const output = stripAnsi(await captureConsoleLog(() => runStatusCommand([], workspaceDir)));
    expect(output).toContain("Search Auth:   none");
  });

  test("oauth.perplexity reports ready=true, authKind='oauth', excludes secrets, and prints Search Auth", async () => {
    const secretAccess = "pplx-oauth-secret-access-token-98765";
    const secretRefresh = "pplx-oauth-secret-refresh-token-54321";
    const secretEmail = "perplexity-user@example.com";

    await writeConfig({
      providers: {},
      defaultModel: "claude-sonnet-4-6",
      oauth: {
        perplexity: {
          access: secretAccess,
          refresh: secretRefresh,
          expires: Date.now() + 3600_000,
          email: secretEmail,
        },
      },
    });

    const dto = await buildStatusDto(workspaceDir);
    expect(dto.searchProviders).toEqual([
      expect.objectContaining({
        name: "perplexity",
        ready: true,
        authKind: "oauth",
        loggedIn: true,
      }),
    ]);

    const serializedDto = JSON.stringify(dto);
    expect(serializedDto).not.toContain(secretAccess);
    expect(serializedDto).not.toContain(secretRefresh);
    expect(serializedDto).not.toContain(secretEmail);

    const jsonOutput = await captureConsoleLog(() => runStatusCommand(["--json"], workspaceDir));
    expect(jsonOutput).not.toContain(secretAccess);
    expect(jsonOutput).not.toContain(secretRefresh);
    expect(jsonOutput).not.toContain(secretEmail);
    const parsedJson = JSON.parse(jsonOutput);
    expect(parsedJson.searchProviders).toEqual([
      expect.objectContaining({
        name: "perplexity",
        ready: true,
        authKind: "oauth",
      }),
    ]);

    const humanOutput = stripAnsi(await captureConsoleLog(() => runStatusCommand([], workspaceDir)));
    expect(humanOutput).toContain("Search Auth:   perplexity (oauth)");
  });

  test("providers.perplexity reports ready=true, authKind='api_key', excludes key, and prints Search Auth", async () => {
    const secretKey = "pplx-SECRET-API-KEY-123456";
    await writeConfig({
      providers: { perplexity: secretKey },
      defaultModel: "claude-sonnet-4-6",
    });

    const dto = await buildStatusDto(workspaceDir);
    expect(dto.searchProviders).toEqual([
      expect.objectContaining({
        name: "perplexity",
        ready: true,
        authKind: "api_key",
      }),
    ]);

    const serializedDto = JSON.stringify(dto);
    expect(serializedDto).not.toContain(secretKey);

    const humanOutput = stripAnsi(await captureConsoleLog(() => runStatusCommand([], workspaceDir)));
    expect(humanOutput).toContain("Search Auth:   perplexity (api_key)");
  });
});

describe("jeo doctor Perplexity search-provider parity", () => {
  test("unconfigured perplexity reports searchProviders status='skipped', excludes perplexity from oauth, and prints Search providers section", async () => {
    await writeConfig({ providers: {}, defaultModel: "gpt-4o" });
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

    const jsonOut = await captureConsoleLog(() => runDoctorCommand(["--json"]));
    const report = JSON.parse(jsonOut);
    expect(report.searchProviders).toEqual([
      expect.objectContaining({
        name: "perplexity",
        credential: "none",
        status: "skipped",
        detail: expect.stringContaining("PERPLEXITY_API_KEY"),
      }),
    ]);
    expect(report.oauth.some((o: { provider: string }) => o.provider === "perplexity")).toBe(false);

    const humanOut = stripAnsi(await captureConsoleLog(() => runDoctorCommand([])));
    expect(humanOut).toContain("Search providers (web_search #1 priority):");
    expect(humanOut).toMatch(/perplexity\s+not configured/);
  });

  test("oauth.perplexity reports searchProviders status='ok', includes perplexity in oauth, and prints Search providers + OAuth tokens", async () => {
    await writeConfig({
      providers: {},
      defaultModel: "gpt-4o",
      oauth: {
        perplexity: {
          access: "pplx-oauth-token",
          refresh: "pplx-refresh-token",
          expires: Date.now() + 3600_000,
          email: "searcher@example.com",
        },
      },
    });
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

    const jsonOut = await captureConsoleLog(() => runDoctorCommand(["--json"]));
    const report = JSON.parse(jsonOut);
    expect(report.searchProviders).toEqual([
      expect.objectContaining({
        name: "perplexity",
        credential: "oauth",
        status: "ok",
        detail: expect.stringContaining("web_search #1 priority"),
      }),
    ]);
    expect(report.oauth).toContainEqual(
      expect.objectContaining({
        provider: "perplexity",
        refreshable: true,
        email: "searcher@example.com",
      }),
    );

    const humanOut = stripAnsi(await captureConsoleLog(() => runDoctorCommand([])));
    expect(humanOut).toContain("Search providers (web_search #1 priority):");
    expect(humanOut).toMatch(/perplexity\s+ok\s+OAuth · web_search #1 priority/);
    expect(humanOut).toContain("OAuth tokens:");
    expect(humanOut).toContain("searcher@example.com");
  });

  test("providers.perplexity reports searchProviders status='ok' with credential='api_key'", async () => {
    await writeConfig({
      providers: { perplexity: "pplx-test-key" },
      defaultModel: "gpt-4o",
    });
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

    const jsonOut = await captureConsoleLog(() => runDoctorCommand(["--json"]));
    const report = JSON.parse(jsonOut);
    expect(report.searchProviders).toEqual([
      expect.objectContaining({
        name: "perplexity",
        credential: "api_key",
        status: "ok",
        detail: expect.stringContaining("web_search #1 priority"),
      }),
    ]);

    const humanOut = stripAnsi(await captureConsoleLog(() => runDoctorCommand([])));
    expect(humanOut).toContain("Search providers (web_search #1 priority):");
    expect(humanOut).toMatch(/perplexity\s+ok\s+API key · web_search #1 priority/);
  });
});

describe("jeo provider Perplexity search-provider parity", () => {
  test("list shows search providers section with ready / not configured status", async () => {
    await writeConfig({ providers: {}, defaultModel: "claude-sonnet-4-6" });
    const unconfiguredOut = stripAnsi(await captureConsoleLog(() => runProviderCommand(["list"])));
    expect(unconfiguredOut).toContain("Search providers (web_search #1 priority):");
    expect(unconfiguredOut).toContain("perplexity  [not configured]");

    process.env.PPLX_API_KEY = "pplx-from-env";
    clearConfigReadCache();
    const configuredOut = stripAnsi(await captureConsoleLog(() => runProviderCommand(["list"])));
    expect(configuredOut).toContain("Search providers (web_search #1 priority):");
    expect(configuredOut).toContain("perplexity  [ready]");
  });

  test("test perplexity without credentials prints NOT READY guidance and sets exitCode=1 (never 'No provider')", async () => {
    await writeConfig({ providers: {}, defaultModel: "claude-sonnet-4-6" });

    const out = await captureConsoleLog(() => runProviderCommand(["test", "perplexity"]));
    expect(out).not.toContain("No provider 'perplexity'");
    expect(out).toContain("Probing perplexity (built-in search provider · web_search #1 priority)");
    expect(out).toContain("credential: MISSING");
    expect(out).toContain("status    : NOT READY");
    expect(process.exitCode).toBe(1);
  });

  test("test perplexity with PERPLEXITY_API_KEY prints OK and leaves exitCode unset", async () => {
    await writeConfig({ providers: {}, defaultModel: "claude-sonnet-4-6" });
    process.env.PERPLEXITY_API_KEY = "pplx-live-test-key";
    clearConfigReadCache();

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const out = await captureConsoleLog(() => runProviderCommand(["test", "perplexity"]));
    expect(out).not.toContain("No provider 'perplexity'");
    expect(out).toContain("Probing perplexity (built-in search provider · web_search #1 priority)");
    expect(out).toContain("credential: API key");
    expect(out).toContain("status    : OK — web_search prioritizes Perplexity automatically.");
    expect(fetchCalls).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  test("test perplexity with oauth.perplexity prints OK and leaves exitCode unset", async () => {
    await writeConfig({
      providers: {},
      defaultModel: "claude-sonnet-4-6",
      oauth: {
        perplexity: {
          access: "pplx-oauth-access",
          email: "user@example.com",
        },
      },
    });

    const out = await captureConsoleLog(() => runProviderCommand(["test", "perplexity"]));
    expect(out).toContain("Probing perplexity (built-in search provider · web_search #1 priority)");
    expect(out).toContain("credential: OAuth");
    expect(out).toContain("status    : OK — web_search prioritizes Perplexity automatically.");
    expect(process.exitCode).toBe(0);
  });

  test("test perplexity with PERPLEXITY_COOKIES prints OK and leaves exitCode unset", async () => {
    await writeConfig({ providers: {}, defaultModel: "claude-sonnet-4-6" });
    process.env.PERPLEXITY_COOKIES = "__Secure-next-auth.session-token=test";
    clearConfigReadCache();

    const out = await captureConsoleLog(() => runProviderCommand(["test", "perplexity"]));
    expect(out).toContain("Probing perplexity (built-in search provider · web_search #1 priority)");
    expect(out).toContain("Cookies (PERPLEXITY_COOKIES)");
    expect(out).toContain("status    : OK — web_search prioritizes Perplexity automatically.");
    expect(process.exitCode).toBe(0);
  });

  test("test anthropic without key reports built-in provider instead of 'No provider' and sets exitCode=1", async () => {
    await writeConfig({ providers: {}, defaultModel: "claude-sonnet-4-6" });

    const out = await captureConsoleLog(() => runProviderCommand(["test", "anthropic"]));
    expect(out).not.toContain("No provider 'anthropic'");
    expect(out).toContain("'anthropic' is a built-in provider");
    expect(out).toContain("check it with 'jeo doctor'");
    expect(process.exitCode).toBe(1);
  });

  test("test unknown provider still reports 'No provider' and sets exitCode=1", async () => {
    await writeConfig({ providers: {}, defaultModel: "claude-sonnet-4-6" });

    const out = await captureConsoleLog(() => runProviderCommand(["test", "nonexistent-provider-id"]));
    expect(out).toContain("No provider 'nonexistent-provider-id'");
    expect(process.exitCode).toBe(1);
  });
});

describe("provider-picker onboarding choices", () => {
  test("buildOnboardingChoices mentions perplexity in the api-key hint", () => {
    for (const unicode of [true, false]) {
      const choices = buildOnboardingChoices(unicode);
      const apiKeyChoice = choices.find(c => c.value === "api-key");
      expect(apiKeyChoice).toBeDefined();
      expect(apiKeyChoice!.hint).toContain("perplexity");
    }
  });
});
