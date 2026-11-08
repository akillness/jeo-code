import { describe, test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildStatusDto, runStatusCommand } from "../src/commands/status";
import { createSession, appendMessage, updateSessionDraft } from "../src/agent/session";
import { writeWorkflowState } from "../src/agent/state";
import { writeGoalState } from "../src/agent/goal-verifier";

async function withIsolatedEnv(
  fn: (ctx: { cwd: string; homeDir: string; configDir: string }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-status-test-"));
  const cwd = path.join(root, "workspace");
  const homeDir = path.join(root, "home");
  const configDir = path.join(homeDir, ".config", "jeo");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });

  const prevHome = process.env.HOME;
  const prevConfig = process.env.JEO_CONFIG_DIR;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  const prevOpenai = process.env.OPENAI_API_KEY;

  process.env.HOME = homeDir;
  process.env.JEO_CONFIG_DIR = configDir;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    await fn({ cwd, homeDir, configDir });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevConfig === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevConfig;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenai;
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("credential-free status DTO and CLI (Tier 2 #7)", () => {
  test("buildStatusDto returns session, workflow, goal, and provider metadata while excluding all secrets", async () => {
    await withIsolatedEnv(async ({ cwd, configDir }) => {
      const secretApiKey = "sk-ant-SUPER-SECRET-KEY-99999";
      const secretOAuthAccess = "ya29.SUPER-SECRET-OAUTH-ACCESS";
      const secretOAuthRefresh = "1//SUPER-SECRET-OAUTH-REFRESH";
      const secretEmail = "private-operator@example.com";
      const secretTelegramToken = "123456:ABC-DEF-TELEGRAM-SECRET-TOKEN";
      const secretSlackBot = "xoxb-SLACK-SECRET-BOT-TOKEN";
      const secretSlackApp = "xapp-1-SLACK-SECRET-APP-TOKEN";
      const secretDraft = "unsent secret draft prompt with token sk-live-123";

      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify(
          {
            defaultModel: "claude-sonnet-4-6",
            providers: {
              anthropic: secretApiKey,
            },
            oauth: {
              antigravity: {
                access: secretOAuthAccess,
                refresh: secretOAuthRefresh,
                expires: Date.now() + 3600_000,
                email: secretEmail,
                projectId: "secret-gcp-project-id",
              },
            },
            notifications: {
              enabled: true,
              telegram: {
                botToken: secretTelegramToken,
                chatId: "998877",
              },
              slack: {
                botToken: secretSlackBot,
                appToken: secretSlackApp,
                channelId: "C01234567",
                allowedUserIds: ["U01234567"],
              },
            },
          },
          null,
          2
        ),
        "utf-8"
      );

      const sess = await createSession(cwd, "sess-status-1", "claude-sonnet-4-6");
      await appendMessage(sess.id, { role: "user", content: "Implement Tier 2 status command" }, cwd);
      await updateSessionDraft(sess.id, secretDraft, cwd);

      await writeWorkflowState(
        "ralplan",
        {
          active: true,
          current_phase: "approved",
          contract_id: "contract-xyz123",
          accepted_scope: ["Credential-free status DTO"],
          non_goals: ["Remote auth broker"],
          unresolved_criteria: ["Run test suite"],
        },
        cwd
      );

      await writeGoalState(
        {
          condition: "All status tests pass",
          setAt: Date.now(),
          verdicts: [{ at: Date.now(), verdict: "NOT_MET", gap: "Tests pending" }],
          pendingMutationVerification: true,
        },
        cwd
      );

      const dto = await buildStatusDto(cwd, { sessionId: "sess-status-1" });
      const serialized = JSON.stringify(dto);

      // Verify metadata presence
      expect(dto.defaultModel).toBe("claude-sonnet-4-6");
      expect(dto.sessions.total).toBe(1);
      expect(dto.sessions.selected?.id).toBe("sess-status-1");
      expect(dto.sessions.selected?.messageCount).toBe(1);
      expect(dto.workflow.contract_id).toBe("contract-xyz123");
      expect(dto.workflow.accepted_scope).toEqual(["Credential-free status DTO"]);
      expect(dto.workflow.next_action).toBe('jeo deep-interview "<project idea>"');

      expect(dto.goal.active).toBe(true);
      expect(dto.goal.pendingMutationVerification).toBe(true);
      expect(dto.daemon.channels.telegram).toBe(true);
      expect(dto.daemon.channels.slack).toBe(true);
      expect(dto.daemon.channels.discord).toBe(false);

      const anth = dto.providers.find(p => p.name === "anthropic");
      expect(anth?.ready).toBe(true);
      expect(anth?.authKind).toBe("api_key");

      const ag = dto.providers.find(p => p.name === "antigravity");
      expect(ag?.ready).toBe(true);
      expect(ag?.authKind).toBe("oauth");

      // Verify zero credential / secret leakage
      expect(serialized).not.toContain(secretApiKey);
      expect(serialized).not.toContain(secretOAuthAccess);
      expect(serialized).not.toContain(secretOAuthRefresh);
      expect(serialized).not.toContain(secretEmail);
      expect(serialized).not.toContain("secret-gcp-project-id");
      expect(serialized).not.toContain(secretTelegramToken);
      expect(serialized).not.toContain(secretSlackBot);
      expect(serialized).not.toContain(secretSlackApp);
      expect(serialized).not.toContain(secretDraft);

      // Verify CLI --json output matches DTO and is credential-free
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
      try {
        await runStatusCommand(["--json", "--session", "sess-status-1"], cwd);
      } finally {
        console.log = origLog;
      }
      const cliJson = logs.join("\n");
      expect(cliJson).not.toContain(secretApiKey);
      expect(cliJson).not.toContain(secretOAuthAccess);
      expect(cliJson).not.toContain(secretTelegramToken);
      const parsedCli = JSON.parse(cliJson);
      expect(parsedCli.workflow.contract_id).toBe("contract-xyz123");
    });
  });
});
