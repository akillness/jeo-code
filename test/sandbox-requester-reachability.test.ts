import { expect, test } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { parseMessengerConfig } from "../src/messenger/config";
import { nativeToolSchemasFor } from "../src/agent/tool-schemas";

function requesterOnlySchemas(root: string) {
  const config = parseMessengerConfig({
    cwd: path.join(root, "workspace"), sessionDir: path.join(root, "sessions"),
    sandbox: { image: "local-fixture-image", limits: { memoryBytes: 268435456, pids: 64, cpus: 1 } },
    toolNames: ["sandbox_request"], platforms: { discord: { allowedUserIds: ["operator"] } },
  }, root);
  return nativeToolSchemasFor(config.toolNames);
}

test("explicit Discord requester configuration permits requesting/status but exposes no human decision method", () => {
  const schemas = requesterOnlySchemas(os.tmpdir());
  expect(schemas.map(schema => schema.name).sort()).toEqual(["done", "sandbox_request"]);
  const requester = schemas.find(schema => schema.name === "sandbox_request");
  if (!requester) throw new Error("Configured requester missing from native schema");
  const actions = z.object({ enum: z.array(z.string()) }).parse(requester.parameters.properties.action);
  expect(actions.enum.sort()).toEqual(["request", "status"]);
  expect(Object.keys(requester.parameters.properties).sort()).toEqual(["action", "host", "mode"]);
});

const reportSchema = z.object({
  answer: z.string(), sessionKey: z.string(), cwd: z.string(), resource: z.string(),
  requests: z.array(z.object({
    tools: z.array(z.object({ function: z.object({ name: z.string(), parameters: z.object({ properties: z.record(z.unknown()) }) }) })).optional(),
    messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  })),
  mounts: z.array(z.object({ Source: z.string(), Destination: z.string(), RW: z.boolean() })),
  shutdownNonce: z.string().min(1),
  acknowledgements: z.array(z.object({ nonce: z.string(), gone: z.boolean() })),
  remainingContainers: z.array(z.string()), workerExit: z.number().int(),
});

async function scenario(mode: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-requester-reachability-")));
  const config = path.join(root, "config");
  const driver = path.join(root, "driver");
  await fs.mkdir(driver);
  let binary: string | undefined;
  if (process.env.JEO_TEST_CLI_BINARY !== undefined) {
    if (!path.isAbsolute(process.env.JEO_TEST_CLI_BINARY)) throw new Error("JEO_TEST_CLI_BINARY must be an absolute executable path");
    await fs.access(process.env.JEO_TEST_CLI_BINARY, constants.X_OK);
    const binaryDir = path.join(root, "isolated-binary");
    await fs.mkdir(binaryDir);
    binary = path.join(binaryDir, "jeo");
    await fs.copyFile(process.env.JEO_TEST_CLI_BINARY, binary);
    await fs.chmod(binary, 0o700);
  }
  const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "fixtures/sandbox-requester-reachability.ts"), mode, root], {
    cwd: driver, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", JEO_CONFIG_DIR: config, JEO_STATIC_MEMORY: "1", NO_COLOR: "1", ...(binary ? { JEO_TEST_CLI_BINARY: binary } : {}) },
  });
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    return reportSchema.parse(JSON.parse(stdout));
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}

function nativeResults(messages: Array<{ role: string; content: unknown }>, tool = "sandbox_request") {
  return messages.flatMap(message => {
    if (typeof message.content !== "string") return [];
    if (message.role === "tool") return [message.content];
    const prefix = `Tool [${tool}] result (ok):\n`;
    return message.content.startsWith(prefix) ? [message.content.slice(prefix.length)] : [];
  });
}

// Real Docker + resident CLI worker + native loopback provider. No provider/Discord credentials,
// no pulls, and no host-global config. Opt in with the existing terminal integration gate.
for (const mode of ["default", "restricted", "explicit"] as const) {
  test.skipIf(process.platform !== "darwin" || process.env.JEO_TEST_TERMINAL_FIFO !== "1")(`native requester: ${mode} Discord worker creates a parent-pending request without mounting the requested resource`, async () => {
    const report = await scenario(mode);
    expect(report.answer).toBe("REQUESTER_SCENARIO_FINISHED");
    expect(report.acknowledgements).toEqual([{ nonce: report.shutdownNonce, gone: true }]);
    expect(report.remainingContainers).toEqual([]);
    expect(report.workerExit).toBe(143);
    expect(JSON.stringify(report.requests)).not.toContain(report.shutdownNonce);
    const schemas = report.requests[0]!.tools ?? [];
    const names = schemas.map(schema => schema.function.name);
    expect(names).toContain("sandbox_request");
    expect(names.filter(name => /sandbox.*(?:approve|deny|revoke)/.test(name))).toEqual([]);
    const requester = schemas.find(schema => schema.function.name === "sandbox_request");
    if (!requester) throw new Error("Real provider did not receive requester schema");
    expect(z.object({ enum: z.array(z.string()) }).parse(requester.function.parameters.properties.action).enum.sort()).toEqual(["request", "status"]);
    if (mode === "restricted") expect(names.sort()).toEqual(["done", "read", "sandbox_request"]);
    if (mode === "explicit") expect(names.sort()).toEqual(["done", "sandbox_request"]);
    const outputs = nativeResults(report.requests.at(-1)!.messages);
    const request = z.object({ request: z.object({ id: z.string(), sessionKey: z.string(), host: z.string(), mode: z.string(), status: z.string() }), grants: z.array(z.unknown()) }).parse(JSON.parse(outputs[0]!));
    expect(request.request).toMatchObject({ sessionKey: report.sessionKey, host: report.resource, mode: "ro", status: "pending" });
    expect(request.grants).toEqual([]);
    const status = z.object({ grants: z.array(z.unknown()), requests: z.array(z.unknown()), blocked: z.boolean() }).parse(JSON.parse(outputs[1]!));
    expect(status).toMatchObject({ grants: [], requests: [request.request], blocked: false });
    if (mode === "restricted") expect(nativeResults(report.requests.at(-1)!.messages, "read").join("\n")).toContain("ISOLATED_WORKSPACE_READ-7c19");
    // Docker's effective mounts independently prove that requesting was not granting.
    expect(report.mounts.filter(mount => mount.Destination === "/workspace")).toEqual([expect.objectContaining({ Source: report.cwd, RW: true })]);
    expect(report.mounts.some(mount => mount.Source === report.resource || mount.Source === path.dirname(report.resource))).toBe(false);
  }, 75_000);
}

test.skipIf(process.platform !== "darwin" || process.env.JEO_TEST_TERMINAL_FIFO !== "1")("native requester: no-tools refuses an unadvertised request rather than silently granting a permission exception", async () => {
  const report = await scenario("disabled");
  expect(report.answer).toBe("REQUESTER_SCENARIO_FINISHED");
  expect(report.requests[0]!.tools?.map(schema => schema.function.name)).toEqual(["done"]);
  expect(JSON.stringify(report.requests.at(-1)!.messages)).toMatch(/Unknown tool.*sandbox_request/);
  expect(report.mounts.some(mount => mount.Source === report.resource || mount.Source === path.dirname(report.resource))).toBe(false);
}, 75_000);
