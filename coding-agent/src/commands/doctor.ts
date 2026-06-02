import { readGlobalConfig } from "../agent/state";
import { resolveCredential, type AuthProvider, type Credential } from "../auth";
import { resolveProvider } from "../ai";

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
  const base = (baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const token = credential.kind === "oauth" || credential.kind === "api_key" ? credential.token : "no-key";
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
  // Anthropic has no free model-listing endpoint; verify auth by issuing a
  // 1-token request that returns quickly without burning meaningful credit.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (credential.kind === "oauth") {
    headers.authorization = `Bearer ${credential.token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = credential.token;
  }
  try {
    const { res, latencyMs } = await timedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (res.ok) return { status: "ok", detail: "POST /v1/messages 200 (1-token probe)", latencyMs };
    if (res.status === 401 || res.status === 403) {
      return { status: "fail", detail: `auth rejected (${res.status})`, latencyMs };
    }
    return { status: "fail", detail: `POST /v1/messages ${res.status}`, latencyMs };
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

function formatRow(provider: string, credKind: string, result: ProbeResult): string {
  const status =
    result.status === "ok" ? "  OK  " :
    result.status === "skipped" ? " SKIP " :
    " FAIL ";
  const latency = result.latencyMs !== undefined ? `${result.latencyMs}ms` : "—";
  return `  ${provider.padEnd(10)} ${credKind.padEnd(16)} [${status}] ${latency.padEnd(7)} ${result.detail}`;
}

export async function runDoctorCommand(_args: string[] = []): Promise<void> {
  const config = await readGlobalConfig();
  const defaultProvider = resolveProvider(config.defaultModel);

  console.log("");
  console.log(`=== ${APP_NAME} doctor ===`);
  console.log("");
  console.log(`Bun runtime:    v${Bun.version}`);
  console.log(`Default model:  ${config.defaultModel} → ${defaultProvider}`);
  console.log(`Config:         ${process.env.HOME}/.joc/config.json`);
  if (config.openaiBaseUrl) console.log(`OpenAI base:    ${config.openaiBaseUrl}`);
  console.log(`Ollama base:    ${config.ollamaBaseUrl ?? "http://localhost:11434"}`);
  console.log("");

  console.log("Provider connectivity:");
  console.log(`  ${"Provider".padEnd(10)} ${"Credential".padEnd(16)} ${"Status".padEnd(8)} ${"Latency".padEnd(7)} Detail`);
  console.log(`  ${"-".repeat(75)}`);

  const probes: { name: string; credKind: string; result: ProbeResult }[] = [];

  for (const provider of ["anthropic", "openai", "gemini"] as AuthProvider[]) {
    const credential = await resolveCredential(provider);
    let result: ProbeResult;
    if (provider === "openai") {
      // OpenAI-compat local servers are reachable even with kind:"none"
      result = await probeOpenAi(credential, config.openaiBaseUrl);
    } else if (provider === "gemini") {
      result = await probeGemini(credential);
    } else {
      result = await probeAnthropic(credential);
    }
    probes.push({ name: provider, credKind: credential.kind, result });
  }
  const ollamaResult = await probeOllama(config.ollamaBaseUrl ?? "http://localhost:11434");
  probes.push({ name: "ollama", credKind: "none (local)", result: ollamaResult });

  for (const p of probes) console.log(formatRow(p.name, p.credKind, p.result));

  console.log("");

  // Final verdict
  const defaultProbe = probes.find(p => p.name === defaultProvider);
  if (defaultProbe?.result.status === "ok") {
    console.log(`[READY] Default model '${config.defaultModel}' is reachable.`);
  } else if (defaultProbe?.result.status === "skipped") {
    console.log(
      `[NOT READY] Default model '${config.defaultModel}' resolves to '${defaultProvider}', ` +
      `but no credential is configured. Run 'joc setup' or 'joc auth login ${defaultProvider}'.`
    );
  } else {
    console.log(
      `[NOT READY] Default model '${config.defaultModel}' probe failed: ${defaultProbe?.result.detail ?? "unknown"}.`
    );
  }
}
