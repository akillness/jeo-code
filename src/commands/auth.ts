import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { readGlobalConfig, type StoredOAuth } from "../agent/state";
import { jeoEnv } from "../util/env";
import { listProviderModels } from "../ai/model-discovery";
import { writeModelCache } from "../ai/model-cache";
import {
  OAUTH_FLOWS,
  OAUTH_FLOW_REGISTRY,
  openInBrowser,
  interactiveLogin,
  loginOAuth,
  logoutOAuth,
  refreshOAuthToken,
  snapshotProvider,
  setApiKey,
  addApiKeyToPool,
  setOauthCredential,
  removeApiKeyFromPool,
  selectAuthAccount,
  clearAuthCooldown,
  isOAuthProvider,
  OAUTH_PROVIDERS,
  API_KEY_ONLY_PROVIDERS,
  type AuthProvider,
  type OAuthController,
  type AuthSnapshotAccount,
} from "../auth";

export async function runAuthCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "status") return runAuthStatus();
  if (sub === "login") return runAuthLogin(args.slice(1));
  if (sub === "import") return runAuthImport(args.slice(1));
  if (sub === "logout") return runAuthLogout(args.slice(1));
  if (sub === "refresh") return runAuthRefresh(args[1] as AuthProvider | undefined);
  if (sub === "pool") return runAuthPool(args.slice(1));
  if (sub === "use") return runAuthUse(args.slice(1));
  if (sub === "rotate") return runAuthRotate(args.slice(1));
  if (sub === "reset-cooldown") return runAuthResetCooldown(args[1] as AuthProvider | undefined);
  console.log(
    `Unknown auth subcommand: ${sub}\nUsage: jeo auth [status|login|logout|refresh|import|pool|use|rotate|reset-cooldown] [provider] ...`,
  );
  process.exitCode = 1;
}

// Every loginable provider: OAuth-capable ∪ API-key-only (keyless ollama/lmstudio excluded).
const CLOUD_PROVIDERS: readonly AuthProvider[] = [...OAUTH_PROVIDERS, ...API_KEY_ONLY_PROVIDERS];

/** True (and prints an error + sets exit code) when `p` is given but not a known provider. */
function rejectInvalidProvider(p: string | undefined): boolean {
  if (p !== undefined && !(CLOUD_PROVIDERS as readonly string[]).includes(p)) {
    console.log(`Unknown provider '${p}'. Use one of: ${CLOUD_PROVIDERS.join(", ")}.`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

function fmtExpiry(expires?: number): string {
  if (!expires) return "";
  const ms = expires - Date.now();
  if (ms <= 0) return " (expired — will auto-refresh)";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return ` (expires in ${mins}m)`;
  return ` (expires in ${Math.round(mins / 60)}h)`;
}

function fmtCooldown(blockedUntil?: number, reason?: string): string {
  if (!blockedUntil || blockedUntil <= Date.now()) return "";
  const secs = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
  const dur = secs < 60 ? `${secs}s` : `${Math.ceil(secs / 60)}m`;
  return ` [cooldown ${dur}${reason ? `: ${reason}` : ""}]`;
}

function formatAccountLine(acc: AuthSnapshotAccount): string {
  const marker = acc.active ? "*" : " ";
  const who = acc.email || acc.accountId || acc.projectId || acc.maskedToken;
  if (acc.kind === "api_key") {
    return `  ${marker} [${acc.index + 1}] api_key ${who}${fmtCooldown(acc.blockedUntil, acc.blockedReason)}`;
  }
  const mode = acc.dead ? "expired (no refresh)" : acc.hasRefresh ? "refreshable" : "manual";
  return `  ${marker} [${acc.index + 1}] ${who} (${mode}${fmtExpiry(acc.expires)})${fmtCooldown(acc.blockedUntil, acc.blockedReason)}`;
}

async function runAuthStatus(): Promise<void> {
  const cfg = await readGlobalConfig();
  console.log("\n=== jeo auth status ===");
  console.log("Provider     API key   OAuth");
  for (const p of CLOUD_PROVIDERS) {
    const snap = await snapshotProvider(p);
    const keyCount = snap.apiKeyPoolSize ?? (snap.apiKey ? 1 : 0);
    const key = p === "antigravity" ? "—" : keyCount > 1 ? `pool(${keyCount})` : snap.apiKey ? "set" : "—";
    let oauth = "—";
    if (p === "antigravity") {
      const fallback = snap.oauth ? snap : await snapshotProvider("gemini");
      if (fallback.oauth) {
        const count = snap.oauth ? (snap.poolSize ?? 1) : (fallback.poolSize ?? 1);
        oauth = snap.oauth
          ? `set (${count > 1 ? `pool:${count}, ` : ""}refreshable)${fmtExpiry(snap.oauthExpires)}${snap.oauthEmail ? ` <${snap.oauthEmail}>` : ""}`
          : `via gemini fallback${count > 1 ? ` (pool:${count})` : ""}`;
      }
    } else if (snap.oauth) {
      const count = snap.poolSize ?? 1;
      oauth = snap.oauthHasRefresh
        ? `set (${count > 1 ? `pool:${count}, ` : ""}refreshable)`
        : `set (${count > 1 ? `pool:${count}, ` : ""}manual)`;
      oauth += fmtExpiry(snap.oauthExpires);
      if (snap.oauthEmail) oauth += ` <${snap.oauthEmail}>`;
    }
    console.log(`  ${p.padEnd(11)} ${key.padEnd(9)} ${oauth}`);
    const multiAccounts = (snap.accounts ?? []).filter(
      a => (a.kind === "oauth" && (snap.poolSize ?? 0) > 1) || (a.kind === "api_key" && keyCount > 1) || (a.blockedUntil && a.blockedUntil > Date.now()),
    );
    for (const acc of multiAccounts) {
      console.log(`             ${formatAccountLine(acc)}`);
    }
  }
  console.log(`\nDefault model: ${cfg.defaultModel}`);
  console.log(`Ollama base:   ${cfg.ollamaBaseUrl ?? "—"}`);
  console.log(`OpenAI base:   ${cfg.openaiBaseUrl ?? "(api.openai.com/v1)"}`);
}

async function runAuthLogin(rest: string[]): Promise<void> {
  const tokenIdx = rest.indexOf("--token");
  const manualToken = tokenIdx >= 0 ? rest[tokenIdx + 1] : undefined;
  const isImport = rest.includes("--import");
  const replaceAll = rest.includes("--replace");
  const provider = rest.find(
    (a, i) => a !== "--token" && rest[i - 1] !== "--token" && a !== "--import" && a !== "--replace",
  ) as AuthProvider | undefined;

  if (rejectInvalidProvider(provider)) return;

  if (isImport) {
    if (provider !== "gemini") {
      console.log("[FAILED] Import is only supported for 'gemini' provider.");
      process.exitCode = 1;
      return;
    }
    return runAuthImport(["gemini"]);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const chosen = provider ?? (await selectProvider(rl));
  if (!chosen) {
    rl.close();
    return;
  }
  // API-key-only providers: store primary key, or append to pool when one already exists unless --replace.
  if ((API_KEY_ONLY_PROVIDERS as readonly string[]).includes(chosen)) {
    rl.close();
    if (manualToken) {
      const trimmed = manualToken.trim();
      if (replaceAll) {
        await removeApiKeyFromPool(chosen);
        await setApiKey(chosen, trimmed);
        console.log(`[SUCCESS] Replaced ${chosen.toUpperCase()}_API_KEY in ~/.jeo/config.json.`);
      } else {
        const res = await addApiKeyToPool(chosen, trimmed);
        console.log(
          res.poolSize > 1
            ? `[SUCCESS] ${res.added ? "Added" : "Kept"} ${chosen} API key in pool (${res.poolSize} keys, circular failover enabled).`
            : `[SUCCESS] Stored ${chosen.toUpperCase()}_API_KEY in ~/.jeo/config.json.`,
        );
      }
    } else {
      console.log(
        `Provider '${chosen}' is API-key only (no OAuth flow). Set ${chosen.toUpperCase()}_API_KEY, or run 'jeo auth login ${chosen} --token <key>'.`,
      );
    }
    return;
  }

  // Non-interactive paste path (`--token`): store as a manual bearer in the pool.
  if (manualToken) {
    rl.close();
    const res = await loginOAuth(chosen, manualToken.trim(), { replaceAll });
    console.log(
      `[SUCCESS] Stored manual OAuth bearer for ${chosen} (no auto-refresh${res.poolSize > 1 ? `; pool: ${res.poolSize} accounts` : ""}).`,
    );
    if (LIVE_MODEL_REPORT_PROVIDERS.has(chosen)) await reportLiveModels(chosen);
    return;
  }

  try {
    const { email, poolSize, added } = await interactiveOAuthLogin(chosen, rl, console.log, { replaceAll });
    const actionWord = replaceAll ? "replaced pool" : added ? "added to pool" : "updated in pool";
    console.log(`\n[SUCCESS] OAuth login complete for ${chosen}${email ? ` (${email})` : ""} (${actionWord}; pool: ${poolSize} account${poolSize === 1 ? "" : "s"}).`);
    console.log("Stored access + refresh tokens in ~/.jeo/config.json; jeo will auto-refresh and rotate on limits.");
    if (LIVE_MODEL_REPORT_PROVIDERS.has(chosen)) await reportLiveModels(chosen);
  } catch (err) {
    console.log(`\n[FAILED] ${(err as Error).message}`);
    console.log("Tip: paste the redirect URL when prompted, or use 'jeo auth login <provider> --token <bearer>'.");
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

const LIVE_MODEL_REPORT_PROVIDERS = new Set<AuthProvider>(["openai", "anthropic", "antigravity", "kimi"]);

async function reportLiveModels(provider: AuthProvider): Promise<void> {
  try {
    const result = await listProviderModels(
      provider,
      provider === "openai" ? { preferOAuth: true, codexCatalog: true } : { preferOAuth: true },
    );
    if (result.ok) {
      await writeModelCache([result]);
      console.log(`Live ${provider} models (${result.models.length}): ${result.models.join(", ")}`);
    } else {
      console.log(`[WARN] Could not verify live ${provider} models: ${result.error ?? "unknown error"} (non-fatal — login succeeded).`);
    }
  } catch (err) {
    console.log(`[WARN] Could not verify live ${provider} models: ${(err as Error).message} (non-fatal — login succeeded).`);
  }
}

async function runAuthImport(rest: string[]): Promise<void> {
  const provider = rest.find(a => a !== "--import") as AuthProvider | undefined;
  if (!provider) {
    console.log("Usage: jeo auth import <provider>");
    process.exitCode = 1;
    return;
  }
  if (rejectInvalidProvider(provider)) return;
  if (provider !== "gemini") {
    console.log("[FAILED] Import is only supported for 'gemini' provider.");
    process.exitCode = 1;
    return;
  }

  try {
    const credsPath = jeoEnv("GEMINI_CREDS_PATH") || path.join(os.homedir(), ".gemini", "oauth_creds.json");
    let content: string;
    try {
      content = await fs.readFile(credsPath, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[FAILED] Failed to read Gemini credentials file: ${msg}`);
      process.exitCode = 1;
      return;
    }

    let creds: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== "object") throw new Error("Expected JSON object");
      creds = parsed as Record<string, unknown>;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[FAILED] Failed to parse Gemini credentials JSON: ${msg}`);
      process.exitCode = 1;
      return;
    }

    if (typeof creds.access_token !== "string" || !creds.access_token) {
      console.log("[FAILED] Missing access_token in Gemini credentials.");
      process.exitCode = 1;
      return;
    }

    let email: string | undefined;
    if (typeof creds.id_token === "string") {
      const parts = creds.id_token.split(".");
      if (parts.length >= 2) {
        try {
          const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
          const payload: unknown = JSON.parse(atob(base64));
          if (payload && typeof payload === "object" && "email" in payload && typeof payload.email === "string") {
            email = payload.email;
          }
        } catch {}
      }
    }

    let expires =
      typeof creds.expiry_date === "number"
        ? creds.expiry_date
        : typeof creds.expiry_date === "string"
          ? parseInt(creds.expiry_date, 10)
          : undefined;
    if (expires !== undefined && Number.isNaN(expires)) expires = undefined;

    const imported: StoredOAuth = {
      access: creds.access_token,
      refresh: typeof creds.refresh_token === "string" ? creds.refresh_token : undefined,
      expires,
      email,
    };

    const res = await setOauthCredential("gemini", imported);

    console.log(
      `[SUCCESS] Imported OAuth credentials for gemini (pool: ${res.poolSize} account${res.poolSize === 1 ? "" : "s"}; also usable as Antigravity fallback).`,
    );
    if (email) {
      console.log(`Account email: ${email}`);
    }
    const expiryMsg = expires ? fmtExpiry(expires) : "";
    console.log(`Expiry status:${expiryMsg || " valid"}`);
    await reportLiveModels("antigravity");
  } catch (err: unknown) {
    console.log(`[FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/** Prompt object the OAuth manual-code fallback needs (a readline interface satisfies it). */
export interface OAuthPrompt {
  question(query: string, options?: { signal?: AbortSignal }): Promise<string>;
}

/**
 * Run the interactive OAuth login flow for a provider using an existing prompt
 * (readline) interface. Shared by `jeo auth login` and the REPL `/provider login`.
 */
export async function interactiveOAuthLogin(
  provider: AuthProvider,
  prompt: OAuthPrompt,
  log: (s: string) => void = console.log,
  opts?: { replaceAll?: boolean },
): Promise<{ email?: string; poolSize: number; added: boolean }> {
  if (!isOAuthProvider(provider)) {
    throw new Error(
      `Provider '${provider}' is API-key only (no OAuth flow) — set ${provider.toUpperCase()}_API_KEY or run 'jeo auth login ${provider} --token <key>'.`,
    );
  }
  const flow = OAUTH_FLOW_REGISTRY[provider];
  log(`\n=== OAuth login — ${flow.label} ===`);
  if (!flow.verifiedEndToEnd && flow.note) log(`Note: ${flow.note}`);
  for (const line of OAUTH_FLOWS[provider].instructions) log("  " + line);
  log("");

  const ac = new AbortController();
  const ctrl: OAuthController = {
    signal: ac.signal,
    onAuth: ({ url, instructions }) => {
      log(`Opening browser:\n  ${url}\n`);
      if (instructions) log(instructions + "\n");
      void openInBrowser(url);
    },
    onProgress: msg => log(`  … ${msg}`),
    onManualCodeInput: async () =>
      (await prompt.question("Paste redirect URL or code (or wait for the browser callback): ", { signal: ac.signal })).trim(),
  };
  try {
    return await interactiveLogin(provider, ctrl, opts);
  } finally {
    ac.abort();
  }
}

async function runAuthLogout(rest: string[]): Promise<void> {
  const clearAll = rest.includes("--all");
  const args = rest.filter(a => a !== "--all");
  const provider = args[0] as AuthProvider | undefined;
  const selector = clearAll ? undefined : args[1];

  if (rejectInvalidProvider(provider)) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const chosen = provider ?? (await selectProvider(rl, "logout"));
  rl.close();
  if (!chosen) return;
  const removed = await logoutOAuth(chosen, selector);
  if (selector) {
    console.log(removed ? `[SUCCESS] Removed OAuth account '${selector}' from ${chosen} pool.` : `No matching OAuth account '${selector}' in ${chosen} pool.`);
  } else {
    console.log(removed ? `[SUCCESS] Removed OAuth token(s) for ${chosen}.` : `No OAuth token stored for ${chosen}.`);
  }
}

async function runAuthRefresh(provider?: AuthProvider): Promise<void> {
  if (!provider) {
    console.log("Usage: jeo auth refresh <provider>");
    process.exitCode = 1;
    return;
  }
  if (rejectInvalidProvider(provider)) return;
  const result = await refreshOAuthToken(provider);
  console.log(result.refreshed ? `[SUCCESS] Refreshed ${provider} OAuth token.` : `[SKIP] ${provider}: ${result.reason}.`);
}

async function runAuthPool(rest: string[]): Promise<void> {
  const sub = rest[0]?.toLowerCase();
  if (!sub || sub === "list" || (CLOUD_PROVIDERS as readonly string[]).includes(sub)) {
    const target = sub && sub !== "list" ? (sub as AuthProvider) : (rest[1] as AuthProvider | undefined);
    if (target && rejectInvalidProvider(target)) return;
    const providers = target ? [target] : CLOUD_PROVIDERS;
    console.log("\n=== jeo auth pool ===");
    let any = false;
    for (const p of providers) {
      const snap = await snapshotProvider(p);
      const accounts = snap.accounts ?? [];
      if (accounts.length === 0) continue;
      any = true;
      console.log(`${p} (${accounts.length} credential${accounts.length === 1 ? "" : "s"}):`);
      for (const acc of accounts) console.log(formatAccountLine(acc));
    }
    if (!any) console.log("  (no stored credentials in any pool)");
    return;
  }

  if (sub === "add") {
    const provider = rest[1] as AuthProvider | undefined;
    const key = rest[2];
    if (!provider || rejectInvalidProvider(provider)) {
      if (!provider) {
        console.log("Usage: jeo auth pool add <provider> [<api-key>]");
        process.exitCode = 1;
      }
      return;
    }
    if (!key) {
      if (isOAuthProvider(provider)) {
        return runAuthLogin([provider]);
      }
      console.log("Usage: jeo auth pool add <provider> <api-key>");
      process.exitCode = 1;
      return;
    }
    const res = await addApiKeyToPool(provider, key);
    console.log(
      res.added
        ? `[SUCCESS] Added API key to ${provider} pool (total: ${res.poolSize}).`
        : `[SKIP] Key already present in ${provider} pool (total: ${res.poolSize}).`,
    );
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const provider = rest[1] as AuthProvider | undefined;
    const selector = rest[2];
    if (!provider || !selector) {
      console.log("Usage: jeo auth pool remove <provider> <index|email|key>");
      process.exitCode = 1;
      return;
    }
    if (rejectInvalidProvider(provider)) return;
    const removedOAuth = await logoutOAuth(provider, selector);
    if (removedOAuth) {
      console.log(`[SUCCESS] Removed OAuth account '${selector}' from ${provider} pool.`);
      return;
    }
    const removedKey = await removeApiKeyFromPool(provider, selector);
    if (removedKey.removed) {
      console.log(`[SUCCESS] Removed API key '${selector}' from ${provider} pool (remaining: ${removedKey.remaining}).`);
      return;
    }
    console.log(`[NOT FOUND] No matching credential '${selector}' in ${provider} pool.`);
    process.exitCode = 1;
    return;
  }

  if (sub === "next" || sub === "rotate") {
    return runAuthRotate(rest.slice(1));
  }
  if (sub === "use") {
    return runAuthUse(rest.slice(1));
  }
  if (sub === "reset" || sub === "reset-cooldown") {
    return runAuthResetCooldown(rest[1] as AuthProvider | undefined);
  }

  console.log(
    "Usage: jeo auth pool [list [provider] | add <provider> [key] | remove <provider> <index|email> | use <provider> <index|email|next> | next <provider> | reset [provider]]",
  );
  process.exitCode = 1;
}

async function runAuthUse(rest: string[]): Promise<void> {
  const provider = rest[0] as AuthProvider | undefined;
  const selector = rest[1];
  if (!provider || !selector) {
    console.log("Usage: jeo auth use <provider> <index|email|next>");
    process.exitCode = 1;
    return;
  }
  if (rejectInvalidProvider(provider)) return;
  const res = await selectAuthAccount(provider, selector);
  if (!res.selected) {
    console.log(`[FAILED] Could not select '${selector}' in ${provider} pool (pool size: ${res.total}).`);
    process.exitCode = 1;
    return;
  }
  console.log(`[SUCCESS] Active ${provider} account → [${res.index + 1}/${res.total}] ${res.label ?? ""}`);
}

async function runAuthRotate(rest: string[]): Promise<void> {
  const provider = rest[0] as AuthProvider | undefined;
  if (!provider) {
    console.log("Usage: jeo auth rotate <provider>");
    process.exitCode = 1;
    return;
  }
  if (rejectInvalidProvider(provider)) return;
  const res = await selectAuthAccount(provider, "next");
  if (!res.selected) {
    console.log(`[FAILED] No credentials stored for ${provider}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`[SUCCESS] Rotated ${provider} account → [${res.index + 1}/${res.total}] ${res.label ?? ""}`);
}

async function runAuthResetCooldown(provider?: AuthProvider): Promise<void> {
  if (rejectInvalidProvider(provider)) return;
  await clearAuthCooldown(provider);
  console.log(provider ? `[SUCCESS] Cleared cooldowns for ${provider}.` : "[SUCCESS] Cleared cooldowns for all providers.");
}

async function selectProvider(
  rl: ReturnType<typeof createInterface>,
  action = "login",
): Promise<AuthProvider | null> {
  console.log(`\nWhich provider do you want to ${action}?`);
  console.log("  1) anthropic   (real PKCE OAuth, verified end-to-end)");
  console.log("  2) openai      (real PKCE OAuth, Codex backend)");
  console.log("  3) gemini      (real Google OAuth, Cloud Code Assist)");
  console.log("  4) antigravity (Google Cloud Code Assist OAuth)");
  console.log("  5) kimi        (Kimi Code OAuth device authorization)");
  const ans = (await rl.question("Choose [1-5]: ")).trim();
  const map: Record<string, AuthProvider> = {
    "1": "anthropic",
    "2": "openai",
    "3": "gemini",
    "4": "antigravity",
    "5": "kimi",
  };
  const p = map[ans];
  if (!p) {
    console.log("Invalid choice.");
    return null;
  }
  return p;
}
