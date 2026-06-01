/**
 * jeoc auth — OAuth credential storage, mirroring gjc's auth-broker concept
 * (token store + bearer use). Stores access tokens per provider in
 * ~/.jeoc/auth.json (chmod 600). Providers send them as `Authorization: Bearer`.
 *
 * Obtaining tokens (browser PKCE / device flows) is documented in
 * docs/09-auth-oauth-local.md. This command stores a token you already hold
 * (e.g. `claude setup-token`, a Google OAuth access token) and reports status.
 *
 * Zero external dependencies.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTH_STORE, OAUTH_ENV, type ProviderName } from "./config.ts";

interface AuthEntry {
  token: string;
  refresh?: string;
  type: "oauth";
  obtained: string;
}
type AuthStore = Record<string, AuthEntry>;

const OAUTH_PROVIDERS: ProviderName[] = ["anthropic", "gemini", "openai"];

function readStore(): AuthStore {
  if (!fs.existsSync(AUTH_STORE)) return {};
  try {
    return JSON.parse(fs.readFileSync(AUTH_STORE, "utf8")) as AuthStore;
  } catch {
    throw new Error(`corrupt auth store at ${AUTH_STORE}`);
  }
}

function writeStore(store: AuthStore): void {
  fs.mkdirSync(path.dirname(AUTH_STORE), { recursive: true });
  fs.writeFileSync(AUTH_STORE, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(AUTH_STORE, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
}

function mask(t: string): string {
  return t.length <= 10 ? "****" : `${t.slice(0, 6)}…${t.slice(-4)} (len ${t.length})`;
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = "true";
      else {
        flags[key] = next;
        i++;
      }
    } else positionals.push(a);
  }
  return { positionals, flags };
}

export function runAuth(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const { flags } = parseArgs(rest);
  const die = (m: string): never => {
    console.error(`jeoc auth: ${m}`);
    process.exit(1);
  };

  switch (cmd) {
    case "login": {
      const provider = flags.provider as ProviderName | undefined;
      if (!provider || !OAUTH_PROVIDERS.includes(provider))
        die(`login requires --provider (${OAUTH_PROVIDERS.join("|")})`);
      if (!flags.token) die("login requires --token <oauth-access-token> (see docs/09-auth-oauth-local.md to obtain one)");
      const store = readStore();
      store[provider as string] = {
        token: flags.token,
        ...(flags.refresh ? { refresh: flags.refresh } : {}),
        type: "oauth",
        obtained: new Date().toISOString(),
      };
      writeStore(store);
      console.log(`jeoc auth: stored OAuth token for ${provider} → ${AUTH_STORE} (chmod 600)`);
      console.log(`  token ${mask(flags.token)}`);
      console.log(`  ✅ requests will now use Authorization: Bearer for ${provider}`);
      break;
    }
    case "logout": {
      const provider = flags.provider as string | undefined;
      const store = readStore();
      if (provider) {
        if (store[provider]) {
          delete store[provider];
          writeStore(store);
          console.log(`jeoc auth: removed OAuth token for ${provider}`);
        } else console.log(`jeoc auth: no stored token for ${provider}`);
      } else {
        writeStore({});
        console.log("jeoc auth: cleared all stored OAuth tokens");
      }
      break;
    }
    case "status": {
      const store = readStore();
      console.log("jeoc auth status\n");
      for (const p of OAUTH_PROVIDERS) {
        const envName = OAUTH_ENV[p].find((n) => process.env[n]);
        const stored = store[p];
        let line: string;
        if (envName) line = `env ${envName} (${mask(process.env[envName] as string)})`;
        else if (stored) line = `stored ${mask(stored.token)}  since ${stored.obtained}`;
        else line = "(none)";
        console.log(`  ${p.padEnd(10)} ${line}`);
      }
      console.log(`\n  store: ${fs.existsSync(AUTH_STORE) ? AUTH_STORE : "(not created)"}`);
      break;
    }
    case undefined:
    case "help":
    case "--help":
      console.log(
        [
          "jeoc auth — OAuth credential storage (Authorization: Bearer)",
          "",
          "  login --provider <anthropic|gemini|openai> --token <T> [--refresh R]",
          "  status",
          "  logout [--provider P]",
          "",
          "OAuth takes precedence over API keys for the same provider.",
          "Env tokens also work: ANTHROPIC_OAUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN / GEMINI_OAUTH_TOKEN / OPENAI_OAUTH_TOKEN.",
          "See docs/09-auth-oauth-local.md for browser/PKCE/device flows to obtain a token.",
        ].join("\n"),
      );
      break;
    default:
      die(`unknown subcommand: ${cmd} (try: jeoc auth help)`);
  }
}

if (import.meta.main) runAuth(process.argv.slice(2));
