import { readGlobalConfig } from "../agent/state";
import { resolveCredential, snapshotProvider, type AuthProvider, type Credential } from "../auth";
import { resolveProvider } from "../ai";
import { resolveModelId } from "../ai/model-registry";
import { meter } from "../tui/components/meter";
import { size } from "../tui/terminal";
import chalk from "chalk";
import { extractChatgptAccountId, CODEX_RESPONSES_URL } from "../ai/providers/openai-responses";

interface ProbeResult {
  status: "ok" | "fail" | "skipped";
  detail: string;
  latencyMs?: number;
}

const APP_NAME = "joc";
const PROBE_TIMEOUT_MS = 4000;

async function timedFetch(url: string, init: RequestInit): Promise<{ res: Response; latencyMs: number }> {
  const start = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, latencyMs: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeOpenAi(credential: Credential, baseUrl: string | undefined): Promise<ProbeResult> {
  // ChatGPT/Codex OAuth can't use api.openai.com — verify the Codex backend instead.
  // A deliberately-unsupported model returns 400 *after* auth but *before* any generation,
  // so it confirms connectivity + credentials without burning subscription credit.
  if (credential.kind === "oauth") {
    const accountId = extractChatgptAccountId(credential.token);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${credential.token}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      accept: "text/event-stream",
    };
    if (accountId) headers["chatgpt-account-id"] = accountId;
    try {
      const { res, latencyMs } = await timedFetch(CODEX_RESPONSES_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "joc-doctor-probe", input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }], stream: true, store: false }),
      });
      if (res.ok || res.status === 400) return { status: "ok", detail: "POST codex/responses (Codex backend reachable)", latencyMs };
      if (res.status === 401 || res.status === 403) return { status: "fail", detail: `Codex auth rejected (${res.status})`, latencyMs };
      return { status: "fail", detail: `POST codex/responses ${res.status}`, latencyMs };
    } catch (err) {
      return { status: "fail", detail: `network error: ${(err as Error).message}` };
    }
  }
  const base = (baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const token = credential.kind === "api_key" ? credential.token : "no-key";
  try {
    const { res, latencyMs } = await timedFetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { status: "ok", detail: `GET ${base}/models 200`, latencyMs };
    return { status: "fail", detail: `GET ${base}/models ${res.status}`, latencyMs };
  } catch (err) {
    return { status: "fail", detail: `network error: ${(err as Error).message}` };
  }
}

async function probeGemini(credential: Credential): Promise<ProbeResult> {
  if (credential.kind === "none") {
    return { status: "skipped", detail: "no credential (run 'joc setup' or 'joc auth login gemini')" };
  }
  const key = credential.kind === "api_key" ? credential.token : "";
  const url = credential.kind === "oauth"
    ? "https://generativelanguage.googleapis.com/v1beta/models"
    : `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  try {
    const { res, latencyMs } = await timedFetch(url, {
      headers: credential.kind === "oauth"
        ? { authorization: `Bearer ${credential.token}` }
        : {},
    });
    if (res.ok) return { status: "ok", detail: "GET /v1beta/models 200", latencyMs };
    return { status: "fail", detail: `GET /v1beta/models ${res.status}`, latencyMs };
  } catch (err) {
    return { status: "fail", detail: `network error: ${(err as Error).message}` };
  }
}

async function probeAnthropic(credential: Credential): Promise<ProbeResult> {
  if (credential.kind === "none") {
    return { status: "skipped", detail: "no credential (run 'joc setup' or 'joc auth login anthropic')" };
  }
  // GET /v1/models verifies auth without burning credit and without depending on a
  // (possibly retired) model id — the old 1-token POST 404'd whenever the probe model
  // was deprecated.
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (credential.kind === "oauth") {
    headers.authorization = `Bearer ${credential.token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = credential.token;
  }
  try {
    const { res, latencyMs } = await timedFetch("https://api.anthropic.com/v1/models?limit=1", { headers });
    if (res.ok) return { status: "ok", detail: "GET /v1/models 200", latencyMs };
    if (res.status === 401 || res.status === 403) {
      return { status: "fail", detail: `auth rejected (${res.status})`, latencyMs };
    }
    return { status: "fail", detail: `GET /v1/models ${res.status}`, latencyMs };
  } catch (err) {
    return { status: "fail", detail: `network error: ${(err as Error).message}` };
  }
}

async function probeOllama(baseUrl: string): Promise<ProbeResult> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    const { res, latencyMs } = await timedFetch(`${base}/api/tags`, { method: "GET" });
    if (res.ok) return { status: "ok", detail: `GET ${base}/api/tags 200`, latencyMs };
    return { status: "fail", detail: `GET ${base}/api/tags ${res.status}`, latencyMs };
  } catch (err) {
    return { status: "fail", detail: `network error: ${(err as Error).message}` };
  }
}

function colorStatus(status: ProbeResult["status"], label: string): string {
  if (status === "ok") return chalk.green(label);
  if (status === "skipped") return chalk.yellow(label);
  return chalk.red(label);
}

function formatRow(provider: string, credKind: string, result: ProbeResult): string {
  const status =
    result.status === "ok" ? "  OK  " :
    result.status === "skipped" ? " SKIP " :
    " FAIL ";
  const latency = result.latencyMs !== undefined ? `${result.latencyMs}ms` : "—";
  // Visual latency bar (relative to a 2s baseline) for OK probes.
  const bar = result.status === "ok" && result.latencyMs !== undefined ? `  ${meter(result.latencyMs, 2000, 12)}` : "";
  return `  ${provider.padEnd(10)} ${credKind.padEnd(16)} [${colorStatus(result.status, status)}] ${latency.padEnd(7)} ${result.detail}${bar}`;
}

export async function runDoctorCommand(args: string[] = []): Promise<void> {
  const strict = args.includes("--strict");
  const json = args.includes("--json");
  const config = await readGlobalConfig();
  const resolvedModel = await resolveModelId(config.defaultModel);
  const defaultProvider = resolveProvider(resolvedModel);
  const ollamaBase = config.ollamaBaseUrl ?? "http://localhost:11434";

  // --- Gather (probes run concurrently → ~1× the slowest timeout, not N×) ---
  const probes: { name: string; credKind: string; result: ProbeResult }[] = [];
  const cloud = ["anthropic", "openai", "gemini"] as AuthProvider[];
  const cloudProbes = await Promise.all(
    cloud.map(async provider => {
      const credential = await resolveCredential(provider);
      let result: ProbeResult;
      if (provider === "openai") result = await probeOpenAi(credential, config.openaiBaseUrl);
      else if (provider === "gemini") result = await probeGemini(credential);
      else result = await probeAnthropic(credential);
      return { name: provider, credKind: credential.kind, result };
    })
  );
  const ollamaResult = await probeOllama(ollamaBase);
  for (const p of cloudProbes) probes.push(p);
  probes.push({ name: "ollama", credKind: "none (local)", result: ollamaResult });

  const oauthHealth: { provider: string; refreshable: boolean; expiresInMin?: number; email?: string }[] = [];
  for (const p of ["anthropic", "openai", "gemini"] as AuthProvider[]) {
    const snap = await snapshotProvider(p);
    if (!snap.oauth) continue;
    oauthHealth.push({
      provider: p,
      refreshable: !!snap.oauthHasRefresh,
      expiresInMin: snap.oauthExpires ? Math.round((snap.oauthExpires - Date.now()) / 60000) : undefined,
      email: snap.oauthEmail,
    });
  }

  const defaultProbe = probes.find(p => p.name === defaultProvider);
  const ready = defaultProbe?.result.status === "ok";

  // --- JSON output mode (CI / scripting) ---
  if (json) {
    const report = {
      app: APP_NAME,
      bunVersion: Bun.version,
      defaultModel: { configured: config.defaultModel, resolved: resolvedModel, provider: defaultProvider },
      ollamaBaseUrl: ollamaBase,
      openaiBaseUrl: config.openaiBaseUrl ?? null,
      terminal: {
        cols: size().cols,
        rows: size().rows,
        colorLevel: chalk.level
      },
      providers: probes.map(p => ({
        name: p.name,
        credential: p.credKind,
        status: p.result.status,
        latencyMs: p.result.latencyMs ?? null,
        detail: p.result.detail,
      })),
      oauth: oauthHealth,
      ready,
    };
    console.log(JSON.stringify(report, null, 2));
    if (strict && !ready) process.exit(1);
    return;
  }

  // --- Human output ---
  console.log("");
  console.log(`=== ${APP_NAME} doctor ===`);
  console.log("");
  console.log(`Bun runtime:    v${Bun.version}`);
  console.log(`Default model:  ${config.defaultModel}${resolvedModel !== config.defaultModel ? ` → ${resolvedModel}` : ""} → ${defaultProvider}`);
  console.log(`Config:         ${process.env.HOME}/.joc/config.json`);
  if (config.openaiBaseUrl) console.log(`OpenAI base:    ${config.openaiBaseUrl}`);
  console.log(`Ollama base:    ${ollamaBase}`);

  const termSize = size();
  const tuiVerdict = termSize.cols < 40 
    ? `${termSize.cols}x${termSize.rows} ${chalk.red("(too narrow for ASCII art)")}` 
    : `${termSize.cols}x${termSize.rows} ${chalk.green("(ASCII art enabled)")}`;
  console.log(`Terminal size:  ${tuiVerdict}`);
  console.log(`Color support:  Level ${chalk.level} (${chalk.level > 0 ? chalk.green("enabled") : "disabled"})`);
  console.log("");

  console.log("Provider connectivity:");
  console.log(`  ${"Provider".padEnd(10)} ${"Credential".padEnd(16)} ${"Status".padEnd(8)} ${"Latency".padEnd(7)} Detail`);
  console.log(`  ${"-".repeat(75)}`);
  for (const p of probes) console.log(formatRow(p.name, p.credKind, p.result));

  console.log("");
  const oauthLines = oauthHealth.map(o => {
    let detail = o.refreshable ? "refreshable" : "manual (no refresh)";
    if (o.expiresInMin !== undefined) detail += o.expiresInMin <= 0 ? ", expired (auto-refresh on next call)" : `, expires in ${o.expiresInMin}m`;
    if (o.email) detail += `, ${o.email}`;
    return `  ${o.provider.padEnd(10)} ${detail}`;
  });
  if (oauthLines.length) {
    console.log("OAuth tokens:");
    for (const line of oauthLines) console.log(line);
    console.log("");
  }

  // Final verdict
  if (ready) {
    console.log(`${chalk.green("[READY]")} Default model '${config.defaultModel}' is reachable.`);
  } else if (defaultProbe?.result.status === "skipped") {
    console.log(
      `${chalk.red("[NOT READY]")} Default model '${config.defaultModel}' resolves to '${defaultProvider}', ` +
      `but no credential is configured. Run 'joc setup' or 'joc auth login ${defaultProvider}'.`
    );
  } else {
    console.log(
      `${chalk.red("[NOT READY]")} Default model '${config.defaultModel}' probe failed: ${defaultProbe?.result.detail ?? "unknown"}.`
    );
  }

  if (strict && !ready) {
    process.exit(1);
  }
}
