import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { Usage } from "../ai/types";

export interface UsageScope {
  file: string;
  sessionId: string;
  role: "parent" | "child";
}
export interface UsageAttempt {
  onUsage(usage: Usage): void;
  finish(): void;
}


const scopes = new AsyncLocalStorage<UsageScope>();

export function withUsageScope<T>(scope: UsageScope, fn: () => T): T {
  return scopes.run(scope, fn);
}


export function withChildUsageScope<T>(fn: () => T): T {
  const scope = scopes.getStore();
  return scope ? scopes.run({ ...scope, role: "child" }, fn) : fn();
}

export function currentUsageScope(): UsageScope | undefined {
  return scopes.getStore();
}

export function createUsageAttempt(scope: UsageScope & { provider: string; model: string }): UsageAttempt {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  let snapshot: Usage = {};
  let finished = false;
  return {
    onUsage(usage: Usage): void {
      if (finished) return;
      if (typeof usage.servedModel === "string" && /^[\w.\-/:]+$/.test(usage.servedModel)) snapshot.servedModel = usage.servedModel;
      for (const [key, value] of Object.entries(usage)) {
        if (key === "outputTokens" && (scope.provider === "gemini" || scope.provider === "antigravity")) continue;
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          (snapshot as Record<string, number>)[key] = value;
        }
      }
    },
    finish(): void {
      if (finished) return;
      const usage = {
        ...(snapshot.inputUncachedTokens !== undefined ? { input: snapshot.inputUncachedTokens } : {}),
        ...(snapshot.outputTokens !== undefined ? { output: snapshot.outputTokens } : {}),
        ...(snapshot.cacheReadTokens !== undefined ? { cacheRead: snapshot.cacheReadTokens } : {}),
        ...(snapshot.cacheWriteTokens !== undefined ? { cacheWrite: snapshot.cacheWriteTokens } : {}),
        ...(snapshot.reasoningTokens !== undefined ? { reasoningTokens: snapshot.reasoningTokens } : {}),
      };
      const record = { type: "usage", version: 1, id, timestamp, sessionId: scope.sessionId, provider: scope.provider, model: snapshot.servedModel ?? scope.model, role: scope.role, usage, incomplete: true };
      try {
        mkdirSync(path.dirname(scope.file), { recursive: true, mode: 0o700 });
        appendFileSync(scope.file, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        console.error("Could not persist provider usage; session accounting is incomplete.");
        throw error;
      }
      finished = true;
    },
  };
}
