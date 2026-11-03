import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalSandboxPath } from "../src/agent/sandbox/policy";

const forbiddenPaths = [
  { name: "backslash UNC share", input: String.raw`\\server.invalid\share\secret` },
  { name: "slash UNC share", input: "//server.invalid/share/secret" },
  { name: "mixed-separator UNC share", input: String.raw`\/server.invalid/share/secret` },
  { name: "extended UNC namespace", input: String.raw`\\?\UNC\server.invalid\share\secret` },
  { name: "slash extended UNC namespace", input: "//?/UNC/server.invalid/share/secret" },
  { name: "extended drive namespace", input: String.raw`\\?\C:\private\secret` },
  { name: "Win32 device namespace", input: String.raw`\\.\PhysicalDrive0` },
  { name: "slash device namespace", input: "//./pipe/authority" },
  { name: "NT device namespace", input: String.raw`\??\C:\private\secret` },
];

interface PathReport {
  input: string;
  value?: string;
  error?: string;
  calls: Array<{ operation: string; target: string }>;
  requests?: unknown[];
}

async function scenario(mode: string, inputs: string[]): Promise<PathReport[]> {
  const child = Bun.spawn([
    process.execPath, "--no-env-file",
    path.join(import.meta.dir, "fixtures", "sandbox-path-preflight.ts"),
    mode, JSON.stringify(inputs),
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout);
}

// Each batch gets its own child, so no platform or builtin spy enters Bun's
// shared test module registry. Every denied operation must fail before fs I/O.
for (const mode of ["canonical", "optional", "authority"] as const) {
  test(`Windows ${mode}: network and device paths fail before filesystem access`, async () => {
    const reports = await scenario(mode, forbiddenPaths.map(row => row.input));
    expect(reports.map(report => ({
      input: report.input, error: report.error, calls: report.calls,
      ...(mode === "authority" ? { requests: report.requests } : {}),
    }))).toEqual(forbiddenPaths.map(row => ({
      input: row.input, error: expect.stringMatching(/^SANDBOX_PATH:/), calls: [],
      ...(mode === "authority" ? { requests: [] } : {}),
    })));
  });
}

test("Windows relative paths inherited from a UNC working directory fail before filesystem access", async () => {
  const [report] = await scenario("inherited", ["relative.txt"]);
  expect(report!.error).toMatch(/^SANDBOX_PATH:/);
  expect(report!.calls.filter(call => call.operation !== "resolve")).toEqual([]);
});

test("Windows preflight preserves normalized local drive paths with either separator", async () => {
  const localPaths = [
    { input: String.raw`C:\workspace\one\..\entry.txt`, expected: String.raw`C:\workspace\entry.txt` },
    { input: "C:/workspace/normal.txt", expected: String.raw`C:\workspace\normal.txt` },
  ];
  const reports = await scenario("local", localPaths.map(row => row.input));
  expect(reports.map(report => ({ value: report.value, error: report.error })))
    .toEqual(localPaths.map(row => ({ value: row.expected, error: undefined })));
});

test("local canonicalization still resolves symlinks and missing descendants through their real ancestor", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-local-preflight-")));
  try {
    const target = path.join(root, "target");
    const alias = path.join(root, "alias");
    await fs.mkdir(target);
    await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await canonicalSandboxPath(alias)).toBe(target);
    expect(await canonicalSandboxPath(path.join(alias, "new", "child"), false))
      .toBe(path.join(target, "new", "child"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows root-relative permission paths use the authority workspace drive, not the parent process drive", async () => {
  const reports = await scenario("authority-drive", [String.raw`\data`, "/data"]);
  expect(reports.map(report => ({
    input: report.input,
    accessedPaths: report.calls.filter(call => call.operation === "realpath").map(call => call.target),
  }))).toEqual([
    { input: String.raw`\data`, accessedPaths: [String.raw`D:\data`] },
    { input: "/data", accessedPaths: [String.raw`D:\data`] },
  ]);
});
