import { createInterface } from "node:readline/promises";
import { readGlobalConfig } from "../agent/state";
import {
  OAUTH_FLOWS,
  openInBrowser,
  loginOAuth,
  logoutOAuth,
  snapshotProvider,
  type AuthProvider,
} from "../auth";

export async function runAuthCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "status") return runAuthStatus();
  if (sub === "login") return runAuthLogin(args[1] as AuthProvider | undefined);
  if (sub === "logout") return runAuthLogout(args[1] as AuthProvider | undefined);
  console.log(`Unknown auth subcommand: ${sub}\nUsage: joc auth [login|logout|status] [provider]`);
  process.exitCode = 1;
}

async function runAuthStatus(): Promise<void> {
  const cfg = await readGlobalConfig();
  console.log("\n=== joc auth status ===");
  console.log("Provider     API key   OAuth token");
  for (const p of ["anthropic", "openai", "gemini"] as AuthProvider[]) {
    const snap = await snapshotProvider(p);
    const key = snap.apiKey ? "set" : "—";
    const oauth = snap.oauth ? "set" : "—";
    console.log(`  ${p.padEnd(11)} ${key.padEnd(9)} ${oauth}`);
  }
  console.log(`\nDefault model: ${cfg.defaultModel}`);
  console.log(`Ollama base:   ${cfg.ollamaBaseUrl ?? "—"}`);
  console.log(`OpenAI base:   ${cfg.openaiBaseUrl ?? "(api.openai.com/v1)"}`);
}

async function runAuthLogin(provider?: AuthProvider): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const chosen = provider ?? (await selectProvider(rl));
  if (!chosen) {
    rl.close();
    return;
  }
  const flow = OAUTH_FLOWS[chosen];
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
  await loginOAuth(chosen, token);
  console.log(`[SUCCESS] OAuth token for ${chosen} saved to ~/.joc/config.json (chmod 600 best-effort).`);
}

async function runAuthLogout(provider?: AuthProvider): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const chosen = provider ?? (await selectProvider(rl, "logout"));
  rl.close();
  if (!chosen) return;
  const removed = await logoutOAuth(chosen);
  console.log(removed
    ? `[SUCCESS] Removed OAuth token for ${chosen}.`
    : `No OAuth token stored for ${chosen}.`);
}

async function selectProvider(
  rl: ReturnType<typeof createInterface>,
  action: string = "login"
): Promise<AuthProvider | null> {
  console.log(`\nWhich provider do you want to ${action}?`);
  console.log("  1) anthropic\n  2) openai\n  3) gemini");
  const ans = (await rl.question("Choose [1-3]: ")).trim();
  const map: Record<string, AuthProvider> = { "1": "anthropic", "2": "openai", "3": "gemini" };
  const p = map[ans];
  if (!p) {
    console.log("Invalid choice.");
    return null;
  }
  return p;
}
