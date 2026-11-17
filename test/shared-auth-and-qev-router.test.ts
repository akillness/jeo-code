import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { setOauthCredential, rotateCredential, clearAuthCooldown, resolveCredential } from "../src/auth/storage.ts";
import { syncOAuthFromJeopi } from "../src/auth/shared-pool-bridge.ts";
import { routePrompt } from "../src/agent/prompt-router.ts";

describe("shared OAuth pool bridge & qev route-model", () => {
  const dirs: string[] = [];
  const prevEnv = { ...process.env };

  afterEach(async () => {
    await clearAuthCooldown().catch(() => {});
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    Object.assign(process.env, prevEnv);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("records and respects shared 0600 cooldowns across provider aliases and syncs jeopi OAuth DB rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeo-shared-auth-"));
    dirs.push(dir);
    const sharedFile = join(dir, "pool", "cooldowns.json");
    const dbPath = join(dir, "agent.db");
    process.env.JEO_CONFIG_DIR = join(dir, "jeo-cfg");
    process.env.JEO_SHARED_AUTH_POOL_PATH = sharedFile;
    mkdirSync(process.env.JEO_CONFIG_DIR, { recursive: true });

    await setOauthCredential("openai", { access: "tok-a", refresh: "ref-a", email: "user1@example.com" });
    await setOauthCredential("openai", { access: "tok-b", refresh: "ref-b", email: "user2@example.com" });

    const rot = await rotateCredential("openai", { kind: "oauth", provider: "openai", token: "tok-a" }, { status: 429 });
    expect(rot.rotated).toBe(true);
    expect(rot.credential.token).toBe("tok-b");
    expect(statSync(sharedFile).mode & 0o777).toBe(0o600);

    // Sync active account from mock jeopi SQLite store without duplicating user1/user2
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT NOT NULL,
      disabled_cause TEXT DEFAULT NULL,
      identity_key TEXT DEFAULT NULL
    );`);
    db.prepare("INSERT INTO auth_credentials(provider, credential_type, data, disabled_cause) VALUES (?,?,?,?)").run(
      "openai-codex",
      "oauth",
      JSON.stringify({ access: "tok-c", refresh: "ref-c", email: "user3@example.com" }),
      null,
    );
    db.prepare("INSERT INTO auth_credentials(provider, credential_type, data, disabled_cause) VALUES (?,?,?,?)").run(
      "google-antigravity",
      "oauth",
      JSON.stringify({ access: "tok-del", refresh: "ref-del", email: "deleted@example.com" }),
      "deleted by user",
    );
    db.close();

    const syncRes = await syncOAuthFromJeopi({ agentDbPath: dbPath });
    expect(syncRes.imported).toBe(1);
    expect(syncRes.byProvider.openai).toBe(1);
    // Second sync should be idempotent
    const syncRes2 = await syncOAuthFromJeopi({ agentDbPath: dbPath });
    expect(syncRes2.imported).toBe(0);

    const cred = await resolveCredential("openai");
    expect(cred.token).not.toBe("tok-a");
  });

  it("escalates ambiguous prompts to local qev /v1/systemone before paid LLM classifier", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          model: "qev-0.8b-text-Q8_0",
          answers: {
            tier: {
              type: "choice",
              choice: "complex",
              probabilities: { trivial: 0.05, standard: 0.12, complex: 0.78, architectural: 0.05 },
            },
          },
        });
      },
    });
    try {
      process.env.JEO_QEV_URL = `http://127.0.0.1:${server.port}/v1/systemone`;
      const decision = await routePrompt("check this behavior", {
        defaultModel: "claude-sonnet-4-6",
        routing: { enabled: true, confidenceThreshold: 0.99 },
        roles: { complex: "claude-sonnet-4-6", architectural: "claude-opus-4-6" },
      } as any);
      expect(decision?.tier).toBe("complex");
      expect(decision?.source).toBe("llm");
    } finally {
      server.stop(true);
    }
  });
});
