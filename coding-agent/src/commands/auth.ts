import { createInterface } from "node:readline/promises";
import { readGlobalConfig, saveGlobalConfig, type Config } from "../agent/state";

type OauthProvider = "anthropic" | "openai" | "gemini";

interface OauthFlowDef {
  label: string;
  authorizeUrl: string;
  instructions: string[];
}

const FLOWS: Record<OauthProvider, OauthFlowDef> = {
  anthropic: {
    label: "Anthropic Console (Claude)",
    authorizeUrl: "https://console.anthropic.com/oauth/authorize",
    instructions: [
      "1) Open https://console.anthropic.com/settings/keys",
      "2) Create an OAuth token (or use a Claude Code session token from",
      "   https://claude.ai/settings — Manage API Keys → 'Use with Claude Code').",
      "3) Paste the bearer token below. It will be saved to ~/.joc/config.json with chmod 600.",
      "   The loop sends it as `Authorization: Bearer <token>` with anthropic-beta: oauth-2025-04-20.",
    ],
  },
  openai: {
    label: "OpenAI Platform",
    authorizeUrl: "https://platform.openai.com/api-keys",
    instructions: [
      "1) Open https://platform.openai.com/api-keys (or https://chatgpt.com/api/auth/session for OAuth).",
      "2) Create a session/bearer token. For ChatGPT-Plus OAuth, copy the access_token from the session JSON.",
      "3) Paste the bearer token below.",
    ],
  },
  gemini: {
    label: "Google AI Studio (Gemini)",
    authorizeUrl: "https://aistudio.google.com/app/apikey",
    instructions: [
      "1) Open https://aistudio.google.com/app/apikey",
      "2) Use 'gcloud auth print-access-token' for OAuth, or create a service-account bearer.",
      "3) Paste the access token below (it will be sent as Authorization: Bearer ...).",
    ],
  },
};

async function openInBrowser(url: string): Promise<void> {
  try {
    const cmd =
      process.platform === "darwin" ? ["open", url] :
      process.platform === "win32" ? ["cmd", "/c", "start", "", url] :
      ["xdg-open", url];
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    // ignore: user can copy/paste the URL manually
  }
}

export async function runAuthCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "status") {
    return runAuthStatus();
  }
  if (sub === "login") {
    return runAuthLogin(args[1] as OauthProvider | undefined);
  }
  if (sub === "logout") {
    return runAuthLogout(args[1] as OauthProvider | undefined);
  }
  console.log(`Unknown auth subcommand: ${sub}\nUsage: joc auth [login|logout|status] [provider]`);
  process.exitCode = 1;
}

async function runAuthStatus(): Promise<void> {
  const cfg = await readGlobalConfig();
  const rows: { provider: string; key: string; oauth: string; model?: string }[] = [];
  for (const p of ["anthropic", "openai", "gemini"] as OauthProvider[]) {
    rows.push({
      provider: p,
      key: cfg.providers[p] ? "set" : "—",
      oauth: cfg.oauth?.[p] ? "set" : "—",
    });
  }
  console.log("\n=== joc auth status ===");
  console.log("Provider     API key   OAuth token");
  for (const r of rows) {
    console.log(`  ${r.provider.padEnd(11)} ${r.key.padEnd(9)} ${r.oauth}`);
  }
  console.log(`\nDefault model: ${cfg.defaultModel}`);
  console.log(`Ollama base:   ${cfg.ollamaBaseUrl ?? "—"}`);
  console.log(`OpenAI base:   ${cfg.openaiBaseUrl ?? "(api.openai.com/v1)"}`);
}

async function runAuthLogin(provider?: OauthProvider): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const chosen = provider ?? (await selectProvider(rl));
  if (!chosen) {
    rl.close();
    return;
  }
  const flow = FLOWS[chosen];
  console.log(`\n=== joc auth login — ${flow.label} ===`);
  for (const line of flow.instructions) console.log(line);
  console.log("");
  const openIt = (await rl.question(`Open ${flow.authorizeUrl} in your browser now? [Y/n]: `)).trim().toLowerCase();
  if (openIt !== "n") await openInBrowser(flow.authorizeUrl);
  const token = (await rl.question("Paste OAuth bearer token (input hidden? no — copy carefully): ")).trim();
  rl.close();
  if (!token) {
    console.log("[ABORT] Empty token — nothing saved.");
    return;
  }
  const cfg = await readGlobalConfig();
  const next: Config = JSON.parse(JSON.stringify(cfg)) as Config;
  next.oauth = next.oauth ?? {};
  next.oauth[chosen] = token;
  await saveGlobalConfig(next);
  console.log(`[SUCCESS] OAuth token for ${chosen} saved to ~/.joc/config.json (chmod 600 best-effort).`);
}

async function runAuthLogout(provider?: OauthProvider): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const chosen = provider ?? (await selectProvider(rl, "logout"));
  rl.close();
  if (!chosen) return;
  const cfg = await readGlobalConfig();
  if (cfg.oauth?.[chosen]) {
    delete cfg.oauth[chosen];
    await saveGlobalConfig(cfg);
    console.log(`[SUCCESS] Removed OAuth token for ${chosen}.`);
  } else {
    console.log(`No OAuth token stored for ${chosen}.`);
  }
}

async function selectProvider(
  rl: ReturnType<typeof createInterface>,
  action: string = "login"
): Promise<OauthProvider | null> {
  console.log(`\nWhich provider do you want to ${action}?`);
  console.log("  1) anthropic\n  2) openai\n  3) gemini");
  const ans = (await rl.question("Choose [1-3]: ")).trim();
  const map: Record<string, OauthProvider> = { "1": "anthropic", "2": "openai", "3": "gemini" };
  const p = map[ans];
  if (!p) {
    console.log("Invalid choice.");
    return null;
  }
  return p;
}
