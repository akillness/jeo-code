import { readGlobalConfig } from "../agent/state";
import { resolveCredential, snapshotProvider, type AuthProvider, type Credential } from "../auth";
import { resolveProvider, describeProvider } from "../ai";

import { effectiveCredentialForProvider } from "../ai/model-manager";
import { resolveModelId } from "../ai/model-registry";
import { meter } from "../tui/components/meter";
import { size } from "../tui/terminal";
import { formatForgeBox, scaleForgeWidth } from "../tui/components/forge";
import { renderMarkdownTables } from "../tui/components/markdown-table";
import { supportsUnicode } from "../tui/components/capability";
import { visibleWidth, truncateToWidth } from "../tui/components/width";
import chalk from "chalk";
import { extractChatgptAccountId, CODEX_RESPONSES_URL } from "../ai/providers/openai-responses";
import { resolveTierModel, tierModelPool, cheapestCredentialed } from "../agent/prompt-router";

interface ProbeResult {
  status: "ok" | "fail" | "skipped";
  detail: string;
  latencyMs?: number;
}

const APP_NAME = "jeo";
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

const NO_OPENAI_CREDENTIAL_DETAIL = "no credential (run 'jeo setup' or 'jeo auth login openai')";

async function probeOpenAi(credential: Credential, baseUrl: string | undefined): Promise<ProbeResult> {
  if (credential.kind === "none" && !baseUrl) {
    return { status: "skipped", detail: NO_OPENAI_CREDENTIAL_DETAIL };
  }
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
        body: JSON.stringify({ model: "jeo-doctor-probe", input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }], stream: true, store: false }),
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
    return { status: "skipped", detail: "no credential (run 'jeo setup' or 'jeo auth login gemini')" };
  }
  // OAuth tokens are served via Cloud Code Assist (the REAL call path) — probe
  // loadCodeAssist there; the public generativelanguage list rejects them.
  if (credential.kind === "oauth") {
    const { getGeminiCliHeaders } = await import("../ai/providers/gemini");
    try {
      const { res, latencyMs } = await timedFetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
          ...getGeminiCliHeaders(),
        },
        body: JSON.stringify({ metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
      });
      if (res.ok) return { status: "ok", detail: "POST cloudcode-pa /v1internal:loadCodeAssist 200 (Cloud Code Assist)", latencyMs };
      return { status: "fail", detail: `POST cloudcode-pa /v1internal:loadCodeAssist ${res.status}`, latencyMs };
    } catch (err) {
      return { status: "fail", detail: `network error: ${(err as Error).message}` };
    }
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${credential.token}`;
  try {
    const { res, latencyMs } = await timedFetch(url, { headers: {} });
    if (res.ok) return { status: "ok", detail: "GET /v1beta/models 200", latencyMs };
    return { status: "fail", detail: `GET /v1beta/models ${res.status}`, latencyMs };
  } catch (err) {
    return { status: "fail", detail: `network error: ${(err as Error).message}` };
  }
}

async function probeAnthropic(credential: Credential): Promise<ProbeResult> {
  if (credential.kind === "none") {
    return { status: "skipped", detail: "no credential (run 'jeo setup' or 'jeo auth login anthropic')" };
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

/**
 * Build the "Provider connectivity" table as a box-drawn GFM table (jeo's forge/
 * markdown-table renderer — the same component that boxes tables in assistant
 * output) sized to the LIVE terminal width, so it never hard-wraps on a narrow
 * terminal. The old layout used a fixed 75-col separator and fixed `padEnd`
 * columns that broke (wrapped mid-row) on anything narrower than ~80 cols and
 * never shrank OR grew with the terminal. Only the free-text Detail column is
 * width-capped; the other columns size naturally off their own short, fixed-
 * shape content.
 */
function providerTableLines(
  probes: { name: string; credKind: string; result: ProbeResult }[],
  cols: number,
  unicode: boolean,
): string[] {
  const escape = (s: string) => s.replace(/\|/g, "\\|");
  const statusLabel = (s: ProbeResult["status"]) => (s === "ok" ? "OK" : s === "skipped" ? "SKIP" : "FAIL");
  const header = ["Provider", "Credential", "Status", "Latency", "Detail"];
  const rows = probes.map(p => {
    const latency = p.result.latencyMs !== undefined ? `${p.result.latencyMs}ms` : "—";
    // Visual latency bar (relative to a 2s baseline) for OK probes.
    const bar = p.result.status === "ok" && p.result.latencyMs !== undefined ? ` ${meter(p.result.latencyMs, 2000, 12)}` : "";
    return [
      escape(p.name),
      escape(p.credKind),
      colorStatus(p.result.status, statusLabel(p.result.status)),
      latency,
      escape(p.result.detail) + bar,
    ];
  });
  // 5 columns → fixed box-drawing overhead (borders + 1-space padding on each side)
  // is `3*5 + 1 = 16` display columns; whatever's left over after the other four
  // columns' natural (content-driven) widths goes to Detail.
  const colWidth = (i: number) => Math.max(visibleWidth(header[i]!), ...rows.map(r => visibleWidth(r[i]!)));
  const overhead = 16;
  const fixedWidth = colWidth(0) + colWidth(1) + colWidth(2) + colWidth(3);
  const minDetailWidth = 8;
  // Provider/Credential/Status/Latency are fixed-shape and can't shrink below their
  // own content width — a grid table can't fit under `overhead + fixedWidth +
  // minDetailWidth` cols no matter how tight Detail is capped. Below that floor, fall
  // back to a stacked one-block-per-provider list (each line truncated to `cols`)
  // instead of drawing a table that overflows and tears the terminal.
  if (cols < overhead + fixedWidth + minDetailWidth) {
    const out: string[] = [];
    for (const p of probes) {
      const latency = p.result.latencyMs !== undefined ? `${p.result.latencyMs}ms` : "—";
      const head = `${p.name} · ${p.credKind} · [${colorStatus(p.result.status, statusLabel(p.result.status))}] ${latency}`;
      out.push(truncateToWidth(head, cols));
      out.push(truncateToWidth(`  ${p.result.detail}`, cols));
    }
    return out;
  }
  const detailBudget = Math.max(minDetailWidth, cols - overhead - fixedWidth);
  const md = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map(r => `| ${r.join(" | ")} |`),
  ].join("\n");
  return renderMarkdownTables(md, { unicode, maxColWidth: detailBudget }).split("\n");
}

export async function runDoctorCommand(args: string[] = []): Promise<void> {
  const strict = args.includes("--strict");
  const json = args.includes("--json");
  const config = await readGlobalConfig();
  const resolvedModel = await resolveModelId(config.defaultModel);
  const defaultProvider = resolveProvider(resolvedModel);
  const ollamaBase = config.ollamaBaseUrl ?? "http://localhost:11434";

  // Routing diagnostic (design doc §7 risk #2): routing.enabled without roles.smol
  // used to mean routePrompt()'s LLM-escalation path silently never fired. It no
  // longer unconditionally gives up — it now falls back to the cheapest CREDENTIALED
  // catalog model as the ambiguous-prompt classifier (same live MODEL_CATALOG lookup
  // resolveTierModel's trivial-tier auto-select already uses), and only skips
  // escalation entirely when that fallback ALSO resolves to defaultModel (nothing
  // cheaper is credentialed) or nothing qualifies at all. Mirror that exact condition
  // here so this note stays accurate instead of unconditionally claiming escalation
  // "will never fire" — see prompt-router.ts's warnOnce/SMOL_UNCONFIGURED_WARNING_KEY
  // for the matching runtime-side guard. Surface it here proactively, at onboarding
  // time, instead of only mid-session on the first qualifying turn.
  const routingEnabled = !!config.routing?.enabled;
  const smolConfigured = !!config.roles?.smol;
  const routingNotes: string[] = [];
  if (routingEnabled && !smolConfigured) {
    const escalationFallback = cheapestCredentialed(config);
    if (!escalationFallback || escalationFallback === config.defaultModel) {
      routingNotes.push(
        "routing is enabled but roles.smol is unset — LLM escalation for ambiguous prompts will never fire; heuristic-only tier resolution applies every turn. Set roles.smol to enable escalation.",
      );
    }
  }

  // Proactive credential-readiness check for every model routing could actually pick —
  // mirrors launch.ts's runTurn per-turn veto gate (v0.7.51) but surfaced at onboarding/
  // doctor time instead of only reactively on a session's first qualifying turn. Catches
  // `roles.smol`/`roles.slow`/`routing.tiers.*.model` pointed at a provider the user never
  // logged into (or whose credential was since removed). `standard` only checked when
  // explicitly configured — its unconfigured fallback is `defaultModel`, already covered
  // by the provider-connectivity probes above.
  if (routingEnabled) {
    const tierCandidates: { tier: string; model: string | undefined }[] = [
      { tier: "trivial", model: config.routing?.tiers?.trivial?.model || config.roles?.smol },
      { tier: "standard", model: config.routing?.tiers?.standard?.model || config.roles?.medium || config.roles?.high },
      { tier: "high", model: config.routing?.tiers?.high?.model || config.roles?.high || config.roles?.medium },
      { tier: "complex", model: config.routing?.tiers?.complex?.model || config.roles?.xhigh || config.roles?.slow },
    ];
    for (const { tier, model } of tierCandidates) {
      if (!model) continue;
      const provider = resolveProvider(model);
      const status = await describeProvider(provider, config);
      if (!status.ready) {
        routingNotes.push(
          `routing.tiers.${tier} resolves to '${model}' (${provider}) which has no usable credential — run 'jeo auth login ${provider}' or reconfigure that tier/role for a provider you're logged into.`,
        );
      }
    }
  }

  // Routing PREVIEW (long-term visibility for cross-provider auto-select, v0.7.56):
  // for each tier, show what resolveTierModel() ACTUALLY resolves to right now —
  // explicitly configured, legacy role-tier, auto-selected (cheapest/strongest
  // credentialed, computed live off MODEL_CATALOG), or the defaultModel fallback
  // (no credentialed alternative, or "standard" which never auto-selects). Purely
  // informational — never affects ready/--strict, same contract as routingNotes.
  const routingPreview: { tier: string; model: string; provider: string; source: string }[] = [];
  if (routingEnabled) {
    // Legacy role-tier fallback per tier, mirroring resolveTierModel's OWN precedence
    // (not just the id it happens to already show up under `routing.tiers.*.model`) —
    // so e.g. a `roles.medium`-only config correctly shows "configured", not
    // "auto-selected", for `standard`.

    for (const tier of ["trivial", "standard", "high", "complex"] as const) {
      const legacyRole =
        tier === "trivial" ? config.roles?.smol
        : tier === "standard" ? config.roles?.medium || config.roles?.high
        : tier === "high" ? config.roles?.high || config.roles?.medium
        : config.roles?.xhigh || config.roles?.slow;
      const explicit = config.routing?.tiers?.[tier]?.model || legacyRole;
      const model = resolveTierModel(tier, config);
      const provider = resolveProvider(model);
      // crossProviderPoolPick (prompt-router.ts) is tried BEFORE every tier's own
      // cheapest/strongest/mid-tier fallback, so a non-empty pool always wins over
      // those once the flag is on — `.length > 0` alone is enough to know the pool,
      // not the tier-specific fallback, produced `model`.
      const pooled = !explicit && model !== config.defaultModel && !!config.routing?.crossProviderPool && tierModelPool(tier, config).length > 0;
      const source = explicit
        ? "configured"
        : model === config.defaultModel
          ? "defaultModel"
          : pooled
            ? "auto-selected: cross-provider pool"
            : tier === "trivial"
              ? "auto-selected: cheapest credentialed"
              : tier === "high"
                ? "auto-selected: strongest mid-tier credentialed"
                : "auto-selected: strongest credentialed";
      routingPreview.push({ tier, model, provider, source });
    }
  }


  // --- Gather (probes run concurrently → ~1× the slowest timeout, not N×) ---
  const probes: { name: string; credKind: string; result: ProbeResult }[] = [];
  const cloud = ["anthropic", "openai", "gemini"] as AuthProvider[];
  const cloudProbes = await Promise.all(
    cloud.map(async provider => {
      const rawCredential = await resolveCredential(provider);
      let credential = rawCredential;
      let result: ProbeResult;
      try {
        credential = effectiveCredentialForProvider(
          provider,
          rawCredential,
          config,
          provider === defaultProvider ? config.defaultModel : provider,
        );
        if (provider === "openai") result = await probeOpenAi(credential, config.openaiBaseUrl);
        else if (provider === "gemini") result = await probeGemini(credential);
        else result = await probeAnthropic(credential);
      } catch (err) {
        result = { status: "fail", detail: (err as Error).message };
      }
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
      ...(routingEnabled ? { routing: { enabled: true, smolConfigured, preview: routingPreview, ...(routingNotes.length ? { notes: routingNotes } : {}) } } : {}),

    };
    console.log(JSON.stringify(report, null, 2));
    if (strict && !ready) process.exit(1);
    return;
  }

  // --- Human output ---
  const termSize = size();
  // LIVE terminal width — every panel below is sized off this, not a fixed guess, so
  // the report reflows (never hard-wraps/tears) whatever the terminal's current size is.
  const cols = Math.max(20, termSize.cols);
  const unicode = supportsUnicode();

  const tuiVerdict = termSize.cols < 40 
    ? `${termSize.cols}x${termSize.rows} ${chalk.red("(too narrow for ASCII art)")}` 
    : `${termSize.cols}x${termSize.rows} ${chalk.green("(ASCII art enabled)")}`;
  const headerLines = [
    `Bun runtime:    v${Bun.version}`,
    `Default model:  ${config.defaultModel}${resolvedModel !== config.defaultModel ? ` → ${resolvedModel}` : ""} → ${defaultProvider}`,
    `Config:         ${process.env.HOME}/.jeo/config.json`,
  ];
  if (config.openaiBaseUrl) headerLines.push(`OpenAI base:    ${config.openaiBaseUrl}`);
  headerLines.push(`Ollama base:    ${ollamaBase}`);
  headerLines.push(`Terminal size:  ${tuiVerdict}`);
  headerLines.push(`Color support:  Level ${chalk.level} (${chalk.level > 0 ? chalk.green("enabled") : "disabled"})`);

  console.log("");
  // gjc/forge-style bordered card, width-scaled off the live terminal (same
  // formatForgeBox + scaleForgeWidth the interactive TUI's tool cards use) so the
  // panel reflows cleanly on any width instead of raw unbounded console.log lines.
  // scaleForgeWidth floors at 24 (its own minimum readable card width, shared by
  // every forge card app-wide) — below `24 + 2 border cols`, the box itself would
  // be wider than the terminal, so fall back to plain unboxed lines instead.
  if (cols >= 26) {
    for (const line of formatForgeBox(
      { title: `${APP_NAME} doctor`, lines: headerLines },
      { width: scaleForgeWidth(cols - 2), unicode, color: chalk.level > 0 },
    )) console.log(line);
  } else {
    console.log(`=== ${APP_NAME} doctor ===`);
    for (const line of headerLines) console.log(truncateToWidth(line, cols));
  }
  console.log("");

  console.log("Provider connectivity:");
  for (const line of providerTableLines(probes, cols, unicode)) console.log(line);

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
  // Routing diagnostic: informational only — never affects ready/strict exit logic.
  if (routingEnabled) {
    if (routingNotes.length) {
      for (const note of routingNotes) console.log(`${chalk.yellow("[routing]")} ${note}`);
    } else {
      console.log(`${chalk.green("[routing]")} enabled, roles.smol configured — LLM escalation available on ambiguous prompts.`);
    }
    console.log("Routing preview (what each tier resolves to right now):");
    for (const p of routingPreview) {
      console.log(`  ${p.tier.padEnd(9)} → ${p.model} (${p.provider}) ${chalk.dim(`[${p.source}]`)}`);
    }

    console.log("");
  }

  // Final verdict
  if (ready) {
    console.log(`${chalk.green("[READY]")} Default model '${config.defaultModel}' is reachable.`);
  } else if (defaultProbe?.result.status === "skipped") {
    console.log(
      `${chalk.red("[NOT READY]")} Default model '${config.defaultModel}' resolves to '${defaultProvider}', ` +
      `but no credential is configured. Run 'jeo setup' or 'jeo auth login ${defaultProvider}'.`
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
