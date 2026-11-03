import { expect, test } from "bun:test";
import { createMessengerActivityEvents } from "../src/messenger/activity";
import { createMessengerGateway } from "../src/messenger/gateway";
import type { MessengerAdapter, MessengerConfig, MessengerMessage } from "../src/messenger/types";
import { selectDiscordModel } from "../src/messenger/model-selection";

const message: MessengerMessage = { platform: "discord", accountId: "bot", channelId: "channel", senderId: "owner", messageId: "1", text: "hello", direct: false, mentioned: true };
const config: MessengerConfig = { cwd: "/tmp", sessionDir: "/tmp", toolNames: [], platforms: { discord: { tokenEnv: "TOKEN", allowedUserIds: ["owner"], allowedChannelIds: ["channel"] } } };

test("progress events expose steps and tool outcomes but never arguments or errors", () => {
  const lines: string[] = [];
  const events = createMessengerActivityEvents(line => lines.push(line));
  events.onStep!(2);
  events.onAssistant!("secret", { tool: "bash", arguments: { command: "secret" } });
  events.onToolResult!("bash", false, "secret");
  events.onNotice!("retry secret");
  events.onAssistant!("", { tool: "done", arguments: {} });
  expect(lines).toEqual(["Step 2 · Thinking", "Step 2 · Running bash", "Step 2 · bash failed", "Retrying after a provider error"]);
});

test("progress never forwards model reasoning, credentials, arguments, or results", () => {
  const lines: string[] = [];
  const events = createMessengerActivityEvents(line => lines.push(line));
  const privateText = "customer@example.com Bearer abcdef token=xyz";
  events.onStep!(3);
  events.onAssistant!(JSON.stringify({ reasoning: privateText, tool: "bash", arguments: { command: privateText } }), { tool: "bash", arguments: { command: privateText } });
  events.onToolResult!("bash", true, privateText);
  events.onNotice!(privateText);
  expect(lines).toEqual(["Step 3 · Thinking", "Step 3 · Running bash", "Step 3 · bash finished"]);
  expect(lines.join(" ")).not.toContain(privateText);
});

test("gateway finalizes progress with the actual reply outcome", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const calls: Array<[string | undefined, string | undefined]> = [];
    const adapter: MessengerAdapter = {
      platform: "discord", start: async () => {}, send: async () => {},
      activity: async (_message, text, _signal, final) => { calls.push([text, final]); },
    };
    const gateway = createMessengerGateway(config, [adapter], async (_message, _signal, report) => {
      report?.("Step 1 · Running read");
      await Bun.sleep(10);
      if (outcome === "failure") throw new Error("private error");
      return "answer";
    }, { activityIntervalMs: 0 });
    await gateway.handle(message);
    expect(calls[0]).toEqual(["Starting request", undefined]);
    expect(calls.at(-1)).toEqual([undefined, outcome]);
  }
});

test("gateway reports model selection failures actionably without disclosing discovery errors", async () => {
  for (const scenario of ["unsupported", "discovery", "other"] as const) {
    const delivered: string[] = [];
    const adapter: MessengerAdapter = { platform: "discord", start: async () => {}, send: async (_message, text) => { delivered.push(text); } };
    const gateway = createMessengerGateway(config, [adapter], async () => {
      if (scenario === "other") throw new Error("secret-other");
      return selectDiscordModel(undefined, {
        config: { providers: {}, defaultModel: scenario === "unsupported" ? "gemini-3-flash" : "gpt-5", thinkingLevel: "medium" },
        list: async () => { throw new Error("secret-discovery"); },
      });
    });
    await gateway.handle(message);
    expect(delivered).toEqual([scenario === "other"
      ? "The request could not be completed. Please try again."
      : "Discord could not verify a model. Ask the operator to configure an explicit Discord model, check provider credentials and live model discovery, then restart the messenger service."]);
    expect(delivered.join(" ")).not.toContain("secret");
  }
});
