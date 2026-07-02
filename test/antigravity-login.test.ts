import { test, expect } from "bun:test";
import { discoverAntigravityProjectId, antigravityClientSecret } from "../src/auth/flows/antigravity";
import { OAUTH_FLOW_REGISTRY } from "../src/auth/flows";

test("antigravityClientSecret uses env override then bundled default", () => {
  expect(antigravityClientSecret({ ANTIGRAVITY_OAUTH_CLIENT_SECRET: "custom" })).toBe("custom");
  expect(antigravityClientSecret({})).toBeTruthy();
});

test("discoverAntigravityProjectId uses Antigravity discovery metadata and user-agent", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return Response.json({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "ag-proj" });
  }) as typeof fetch;
  const mod = await import("../src/auth/flows/google-project");
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const id = await discoverAntigravityProjectId("tok");
    expect(id).toBe("ag-proj");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.metadata.ideType).toBe(mod.ANTIGRAVITY_DISCOVERY_METADATA.ideType);
    expect((calls[0].init?.headers as Record<string, string>)["User-Agent"]).toContain("antigravity/");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("oauth flow registry exposes a dedicated antigravity login", () => {
  expect(OAUTH_FLOW_REGISTRY.antigravity.verifiedEndToEnd).toBe(true);
  expect(OAUTH_FLOW_REGISTRY.antigravity.label).toContain("Antigravity");
});

test("discoverAntigravityProjectId: a reported tier without a project ONBOARDS instead of throwing the workspace hint", async () => {
  const prevFetch = globalThis.fetch;
  const prevProj = process.env.GOOGLE_CLOUD_PROJECT;
  const prevProjId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    if (String(url).includes(":loadCodeAssist")) {
      // gjc antigravity parity: workspace-style payload — a tier but NO project.
      return Response.json({ currentTier: { id: "standard-tier" } });
    }
    if (String(url).includes(":onboardUser")) {
      return Response.json({ done: true, response: { cloudaicompanionProject: "ag-onboarded" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as any;
  try {
    const id = await discoverAntigravityProjectId("tok-ws");
    expect(id).toBe("ag-onboarded");
    // No allowedTiers in the payload → onboards the legacy tier (gjc getDefaultTierId).
    const onboardBody = JSON.parse(String(calls[1].init?.body));
    expect(onboardBody.tierId).toBe("legacy-tier");
    expect(onboardBody.metadata.ideType).toBe("ANTIGRAVITY");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevProj !== undefined) process.env.GOOGLE_CLOUD_PROJECT = prevProj;
    if (prevProjId !== undefined) process.env.GOOGLE_CLOUD_PROJECT_ID = prevProjId;
  }
});
