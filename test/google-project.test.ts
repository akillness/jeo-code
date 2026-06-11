import { test, expect } from "bun:test";
import { discoverGoogleProjectId } from "../src/auth/flows/google-project";
import { resolveAntigravityProjectId } from "../src/ai/providers/antigravity";

type FetchCall = { url: string; init?: RequestInit };

function fetchScript(responses: Array<(url: string, init?: RequestInit) => Response | undefined>, calls: FetchCall[] = []): typeof fetch {
  let i = 0;
  return (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const handler = responses[Math.min(i, responses.length - 1)];
    i++;
    const res = handler(String(url), init);
    if (!res) throw new Error(`unexpected fetch: ${url}`);
    return res;
  }) as typeof fetch;
}

const noSleep = async () => {};
const cleanEnv = {} as Record<string, string | undefined>;

test("discoverGoogleProjectId: returns the existing Cloud Code Assist project", async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = fetchScript([
    url => url.includes(":loadCodeAssist")
      ? Response.json({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "managed-proj-1" })
      : undefined,
  ], calls);
  const id = await discoverGoogleProjectId("tok-a", { fetchImpl, sleep: noSleep, env: cleanEnv });
  expect(id).toBe("managed-proj-1");
  expect(calls.length).toBe(1);
  expect(calls[0].init?.headers).toMatchObject({ authorization: "Bearer tok-a" });
});

test("discoverGoogleProjectId: onboards the free tier and returns the provisioned project", async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = fetchScript([
    url => url.includes(":loadCodeAssist")
      ? Response.json({ allowedTiers: [{ id: "free-tier", isDefault: true }] })
      : undefined,
    url => url.includes(":onboardUser")
      ? Response.json({ done: true, response: { cloudaicompanionProject: { id: "provisioned-9" } } })
      : undefined,
  ], calls);
  const id = await discoverGoogleProjectId("tok-b", { fetchImpl, sleep: noSleep, env: cleanEnv });
  expect(id).toBe("provisioned-9");
  const onboardBody = JSON.parse(String(calls[1].init?.body));
  expect(onboardBody.tierId).toBe("free-tier");
});

test("discoverGoogleProjectId: polls a pending onboard operation until done", async () => {
  const fetchImpl = fetchScript([
    () => Response.json({ allowedTiers: [{ id: "free-tier", isDefault: true }] }),
    () => Response.json({ done: false, name: "operations/op-1" }),
    () => Response.json({ done: true, response: { cloudaicompanionProject: "late-proj" } }),
  ]);
  const id = await discoverGoogleProjectId("tok-c", { fetchImpl, sleep: noSleep, env: cleanEnv, maxPollAttempts: 3 });
  expect(id).toBe("late-proj");
});

test("discoverGoogleProjectId: onboarded workspace account without project gets the documented hint", async () => {
  const fetchImpl = fetchScript([
    () => Response.json({ currentTier: { id: "standard-tier" } }),
  ]);
  await expect(
    discoverGoogleProjectId("tok-d", { fetchImpl, sleep: noSleep, env: cleanEnv }),
  ).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/);
});

test("discoverGoogleProjectId: env project wins for onboarded accounts without a managed project", async () => {
  const fetchImpl = fetchScript([
    () => Response.json({ currentTier: { id: "standard-tier" } }),
  ]);
  const id = await discoverGoogleProjectId("tok-e", {
    fetchImpl,
    sleep: noSleep,
    env: { GOOGLE_CLOUD_PROJECT: "env-proj" },
  });
  expect(id).toBe("env-proj");
});

test("resolveAntigravityProjectId: lazy discovery runs once, persists, and caches per token", async () => {
  const prevProj = process.env.GOOGLE_CLOUD_PROJECT;
  const prevProjId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  try {
    let discoverCalls = 0;
    const persisted: string[] = [];
    const cred = { kind: "oauth" as const, provider: "gemini" as const, token: `tok-lazy-${Date.now()}` };
    const opts = {
      discover: async () => { discoverCalls++; return "lazy-proj"; },
      persist: async (id: string) => { persisted.push(id); },
    };
    expect(await resolveAntigravityProjectId(cred, opts)).toBe("lazy-proj");
    expect(await resolveAntigravityProjectId(cred, opts)).toBe("lazy-proj");
    expect(discoverCalls).toBe(1); // second call served from the in-process cache
    expect(persisted).toEqual(["lazy-proj"]);
  } finally {
    if (prevProj !== undefined) process.env.GOOGLE_CLOUD_PROJECT = prevProj;
    if (prevProjId !== undefined) process.env.GOOGLE_CLOUD_PROJECT_ID = prevProjId;
  }
});

test("resolveAntigravityProjectId: stored credential projectId short-circuits discovery", async () => {
  let discoverCalls = 0;
  const cred = { kind: "oauth" as const, provider: "gemini" as const, token: "tok-direct", projectId: "stored-proj" };
  const id = await resolveAntigravityProjectId(cred, { discover: async () => { discoverCalls++; return "x"; } });
  expect(id).toBe("stored-proj");
  expect(discoverCalls).toBe(0);
});

test("resolveAntigravityProjectId: discovery failure surfaces an actionable error", async () => {
  const prevProj = process.env.GOOGLE_CLOUD_PROJECT;
  const prevProjId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  try {
    const cred = { kind: "oauth" as const, provider: "gemini" as const, token: `tok-fail-${Date.now()}` };
    await expect(
      resolveAntigravityProjectId(cred, { discover: async () => { throw new Error("loadCodeAssist failed (HTTP 403)"); } }),
    ).rejects.toThrow(/auto-discovery failed.*joc auth login gemini/s);
  } finally {
    if (prevProj !== undefined) process.env.GOOGLE_CLOUD_PROJECT = prevProj;
    if (prevProjId !== undefined) process.env.GOOGLE_CLOUD_PROJECT_ID = prevProjId;
  }
});
