import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runAuthCommand } from "../src/commands/auth";
import { getStoredOAuth, resolveCredential } from "../src/auth/storage";

function createJwt(email: string): string {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ email }));
  const signature = "dummy-signature";
  return `${header}.${payload}.${signature}`;
}

test("import command persists a credential readable by storage helpers", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-import-"));
  const configDir = path.join(tmpDir, ".joc");
  await fs.mkdir(configDir, { recursive: true });

  const credsPath = path.join(tmpDir, "oauth_creds.json");
  const idToken = createJwt("user@example.com");

  await fs.writeFile(
    credsPath,
    JSON.stringify({
      access_token: "ACC_TOKEN_1",
      refresh_token: "REF_TOKEN_1",
      expiry_date: 1900000000000,
      id_token: idToken,
    }),
    "utf-8"
  );

  const prevConfigDir = process.env.JOC_CONFIG_DIR;
  const prevCredsPath = process.env.JOC_GEMINI_CREDS_PATH;
  process.env.JOC_CONFIG_DIR = configDir;
  process.env.JOC_GEMINI_CREDS_PATH = credsPath;

  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    // Test: joc auth import gemini
    await runAuthCommand(["import", "gemini"]);
    expect(process.exitCode ?? 0).toBe(0);

    const stored = await getStoredOAuth("gemini");
    expect(stored).toBeDefined();
    expect(stored?.access).toBe("ACC_TOKEN_1");
    expect(stored?.refresh).toBe("REF_TOKEN_1");
    expect(stored?.expires).toBe(1900000000000);
    expect(stored?.email).toBe("user@example.com");

    expect(logs.some(l => l.includes("[SUCCESS] Imported OAuth credentials"))).toBe(true);
    expect(logs.some(l => l.includes("Account email: user@example.com"))).toBe(true);

    // Test: joc auth login gemini --import (should run the same thing)
    logs.length = 0;
    await runAuthCommand(["login", "gemini", "--import"]);
    // Bun quirk: `process.exitCode = undefined` cannot CLEAR a value a prior
    // test file set (the setter ignores undefined), so "undefined" is
    // unobservable in a full-suite run — assert "no failure" like line 51.
    expect(process.exitCode ?? 0).toBe(0);
    expect(logs.some(l => l.includes("[SUCCESS] Imported OAuth credentials"))).toBe(true);
  } finally {
    console.log = originalLog;
    process.exitCode = 0;
    process.env.JOC_CONFIG_DIR = prevConfigDir;
    process.env.JOC_GEMINI_CREDS_PATH = prevCredsPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("corrupt file → exitCode 1", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-import-"));
  const configDir = path.join(tmpDir, ".joc");
  await fs.mkdir(configDir, { recursive: true });

  const credsPath = path.join(tmpDir, "oauth_creds.json");
  await fs.writeFile(credsPath, "corrupt-json{invalid", "utf-8");

  const prevConfigDir = process.env.JOC_CONFIG_DIR;
  const prevCredsPath = process.env.JOC_GEMINI_CREDS_PATH;
  process.env.JOC_CONFIG_DIR = configDir;
  process.env.JOC_GEMINI_CREDS_PATH = credsPath;

  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    await runAuthCommand(["import", "gemini"]);
    expect(process.exitCode).toBe(1);
    expect(logs.some(l => l.includes("[FAILED]"))).toBe(true);
  } finally {
    console.log = originalLog;
    process.exitCode = 0;
    process.env.JOC_CONFIG_DIR = prevConfigDir;
    process.env.JOC_GEMINI_CREDS_PATH = prevCredsPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("missing file → exitCode 1", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-import-"));
  const configDir = path.join(tmpDir, ".joc");
  await fs.mkdir(configDir, { recursive: true });

  const credsPath = path.join(tmpDir, "non_existent_file.json");

  const prevConfigDir = process.env.JOC_CONFIG_DIR;
  const prevCredsPath = process.env.JOC_GEMINI_CREDS_PATH;
  process.env.JOC_CONFIG_DIR = configDir;
  process.env.JOC_GEMINI_CREDS_PATH = credsPath;

  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    await runAuthCommand(["import", "gemini"]);
    expect(process.exitCode).toBe(1);
    expect(logs.some(l => l.includes("[FAILED]"))).toBe(true);
  } finally {
    console.log = originalLog;
    process.exitCode = 0;
    process.env.JOC_CONFIG_DIR = prevConfigDir;
    process.env.JOC_GEMINI_CREDS_PATH = prevCredsPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("auto-import fallback populates storage when joc has none", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-import-"));
  const configDir = path.join(tmpDir, ".joc");
  await fs.mkdir(configDir, { recursive: true });

  // Create empty initial global config.json
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ providers: {}, defaultModel: "claude-sonnet-4-5" }),
    "utf-8"
  );

  const credsPath = path.join(tmpDir, "oauth_creds.json");
  const idToken = createJwt("fallback@example.com");

  await fs.writeFile(
    credsPath,
    JSON.stringify({
      access_token: "FALLBACK_ACC",
      refresh_token: "FALLBACK_REF",
      expiry_date: Date.now() + 600_000,
      id_token: idToken,
    }),
    "utf-8"
  );

  const prevConfigDir = process.env.JOC_CONFIG_DIR;
  const prevCredsPath = process.env.JOC_GEMINI_CREDS_PATH;
  process.env.JOC_CONFIG_DIR = configDir;
  process.env.JOC_GEMINI_CREDS_PATH = credsPath;

  const logs: string[] = [];
  const originalLog = console.log;
  const originalErr = console.error;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  // The transparent-import notice goes to STDERR so --json stdout stays parseable.
  console.error = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    // Call resolveCredential
    const cred = await resolveCredential("gemini");
    expect(cred.kind).toBe("oauth");
    expect(cred.kind === "oauth" && cred.token).toBe("FALLBACK_ACC");

    // Verify it saved
    const stored = await getStoredOAuth("gemini");
    expect(stored).toBeDefined();
    expect(stored?.access).toBe("FALLBACK_ACC");
    expect(stored?.refresh).toBe("FALLBACK_REF");
    expect(stored?.email).toBe("fallback@example.com");

    expect(logs.some(l => l.includes("[NOTICE] Transparently imported Gemini OAuth credentials"))).toBe(true);
  } finally {
    console.log = originalLog;
    console.error = originalErr;
    process.env.JOC_CONFIG_DIR = prevConfigDir;
    process.env.JOC_GEMINI_CREDS_PATH = prevCredsPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
