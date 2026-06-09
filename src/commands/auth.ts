import { createInterface } from "node:readline/promises";
import { readGlobalConfig } from "../agent/state";
import {
  OAUTH_FLOWS,
  OAUTH_FLOW_REGISTRY,
  openInBrowser,
  interactiveLogin,
  loginOAuth,
  logoutOAuth,
  refreshOAuthToken,
  snapshotProvider,
  type AuthProvider,
  type OAuthController,
} from "../auth";

export async function runAuthCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "status") return runAuthStatus();
  if (sub === "login") return runAuthLogin(args.slice(1));
  if (sub === "logout") return runAuthLogout(args[1] as AuthProvider | undefined);
  if (sub === "refresh") return runAuthRefresh(args[1] as AuthProvider | undefined);
  console.log(`Unknown auth subcommand: ${sub}\nUsage: joc auth [login|logout|refresh|status] [provider] [--token <bearer>]`);
  process.exitCode = 1;
}

const CLOUD_PROVIDERS: readonly AuthProvider[] = ["anthropic", "openai", "gemini"];
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

async function runAuthStatus(): Promise<void> {
  const cfg = await readGlobalConfig();
  console.log("\n=== joc auth status ===");
  console.log("Provider     API key   OAuth");
  for (const p of ["anthropic", "openai", "gemini"] as AuthProvider[]) {
    const snap = await snapshotProvider(p);
    const key = snap.apiKey ? "set" : "—";
    let oauth = "—";
    if (snap.oauth) {
      oauth = snap.oauthHasRefresh ? "set (refreshable)" : "set (manual)";
      oauth += fmtExpiry(snap.oauthExpires);
      if (snap.oauthEmail) oauth += ` <${snap.oauthEmail}>`;
    }
    console.log(`  ${p.padEnd(11)} ${key.padEnd(9)} ${oauth}`);
  }
  console.log(`\nDefault model: ${cfg.defaultModel}`);
  console.log(`Ollama base:   ${cfg.ollamaBaseUrl ?? "—"}`);
  console.log(`OpenAI base:   ${cfg.openaiBaseUrl ?? "(api.openai.com/v1)"}`);
}

async function runAuthLogin(rest: string[]): Promise<void> {
  const tokenIdx = rest.indexOf("--token");
  const manualToken = tokenIdx >= 0 ? rest[tokenIdx + 1] : undefined;
  const provider = rest.find((a, i) => a !== "--token" && rest[i - 1] !== "--token") as AuthProvider | undefined;

  if (rejectInvalidProvider(provider)) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const chosen = provider ?? (await selectProvider(rl));
  if (!chosen) {
    rl.close();
    return;
  }

  // Non-interactive paste path (`--token`): store as a manual bearer.
  if (manualToken) {
    rl.close();
    await loginOAuth(chosen, manualToken.trim());
    console.log(`[SUCCESS] Stored manual OAuth bearer for ${chosen} (no auto-refresh).`);
    return;
  }

  try {
    const { email } = await interactiveOAuthLogin(chosen, rl);
    console.log(`\n[SUCCESS] OAuth login complete for ${chosen}${email ? ` (${email})` : ""}.`);
    console.log("Stored access + refresh tokens in ~/.joc/config.json; joc will auto-refresh on expiry.");
  } catch (err) {
    console.log(`\n[FAILED] ${(err as Error).message}`);
    console.log("Tip: paste the redirect URL when prompted, or use 'joc auth login <provider> --token <bearer>'.");
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

/** Prompt object the OAuth manual-code fallback needs (a readline interface satisfies it). */
export interface OAuthPrompt {
  question(query: string): Promise<string>;
}

/**
 * Run the interactive OAuth login flow for a provider using an existing prompt
 * (readline) interface. Shared by `joc auth login` and the REPL `/provider login`.
 * Prints flow instructions, opens the browser, and resolves with the account email.
 */
export async function interactiveOAuthLogin(
  provider: AuthProvider,
  prompt: OAuthPrompt,
  log: (s: string) => void = console.log,
): Promise<{ email?: string }> {
  const flow = OAUTH_FLOW_REGISTRY[provider];
  log(`\n=== OAuth login — ${flow.label} ===`);
  if (!flow.verifiedEndToEnd && flow.note) log(`Note: ${flow.note}`);
  for (const line of OAUTH_FLOWS[provider].instructions) log("  " + line);
  log("");

  const ctrl: OAuthController = {
    onAuth: ({ url, instructions }) => {
      log(`Opening browser:\n  ${url}\n`);
      if (instructions) log(instructions + "\n");
      void openInBrowser(url);
    },
    onProgress: msg => log(`  … ${msg}`),
    onManualCodeInput: async () =>
      (await prompt.question("Paste redirect URL or code (or wait for the browser callback): ")).trim(),
  };
  return interactiveLogin(provider, ctrl);
}

async function runAuthLogout(provider?: AuthProvider): Promise<void> {
  if (rejectInvalidProvider(provider)) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const chosen = provider ?? (await selectProvider(rl, "logout"));
  rl.close();
  if (!chosen) return;
  const removed = await logoutOAuth(chosen);
  console.log(removed ? `[SUCCESS] Removed OAuth token for ${chosen}.` : `No OAuth token stored for ${chosen}.`);
}

async function runAuthRefresh(provider?: AuthProvider): Promise<void> {
  if (!provider) {
    console.log("Usage: joc auth refresh <provider>");
    process.exitCode = 1;
    return;
  }
  if (rejectInvalidProvider(provider)) return;
  const result = await refreshOAuthToken(provider);
  console.log(
    result.refreshed
      ? `[SUCCESS] Refreshed ${provider} OAuth token.`
      : `[SKIP] ${provider}: ${result.reason}.`
  );
}

async function selectProvider(
  rl: ReturnType<typeof createInterface>,
  action = "login"
): Promise<AuthProvider | null> {
  console.log(`\nWhich provider do you want to ${action}?`);
  console.log("  1) anthropic   (real PKCE OAuth, verified end-to-end)");
  console.log("  2) openai      (real PKCE OAuth, Codex backend)");
  console.log("  3) gemini      (real Google OAuth, Cloud Code Assist)");
  const ans = (await rl.question("Choose [1-3]: ")).trim();
  const map: Record<string, AuthProvider> = { "1": "anthropic", "2": "openai", "3": "gemini" };
  const p = map[ans];
  if (!p) {
    console.log("Invalid choice.");
    return null;
  }
  return p;
}
