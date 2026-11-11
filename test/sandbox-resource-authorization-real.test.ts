import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGrantAuthority } from "../src/agent/sandbox/authority";
import { createSandboxPolicy } from "../src/agent/sandbox/policy";
import { createSandboxSupervisor } from "../src/agent/sandbox/supervisor";

// Exercise real OS containment and real authority transitions, not a simulated backend.
test.skipIf(process.platform !== "darwin")("skill resources require human approval, remain read-only, and disappear on revocation", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-resource-authorization-")));
  const workspace = path.join(root, "workspace");
  const skills = path.join(root, "skills");
  const secret = path.join(root, "secret.txt");
  const stateDirectory = path.join(root, "authority");
  const config = { backend: "native" as const };
  const sessionKey = "resource-authorization";
  const actor = { origin: "terminal" as const, sessionKey };
  await Promise.all([fs.mkdir(workspace), fs.mkdir(skills)]);
  await fs.writeFile(path.join(skills, "SKILL.md"), "APPROVED-SKILL");
  await fs.writeFile(secret, "PRIVATE-SECRET");
  const policy = await createSandboxPolicy({ sessionKey, revision: 0, cwd: workspace, config, privatePaths: [stateDirectory] });
  const supervisor = createSandboxSupervisor({ policy });
  try {
    const authority = await createGrantAuthority({ sessionKey, cwd: workspace, config, supervisor, allowedUserIds: [], stateDirectory });
    const readSkill = () => supervisor.exec(["/bin/cat", path.join(skills, "SKILL.md")]);
    expect((await readSkill()).success).toBe(false);
    const request = await authority.requestAccess(skills, "ro");
    await expect(authority.approve(request.id, { origin: "model", sessionKey })).rejects.toThrow("UNAUTHORIZED");
    expect((await readSkill()).success).toBe(false);
    expect((await authority.approve(request.id, actor)).status).toBe("approved");
    const approved = await readSkill();
    expect(approved.success).toBe(true);
    expect(approved.output).toContain("APPROVED-SKILL");
    expect((await supervisor.exec(["/bin/cat", secret])).success).toBe(false);
    expect((await supervisor.exec(["/bin/sh", "-c", `printf bad > ${JSON.stringify(path.join(skills, "mutated"))}`])).success).toBe(false);
    expect(await fs.stat(path.join(skills, "mutated")).catch(() => undefined)).toBeUndefined();
    expect((await authority.revoke(actor)).gone).toBe(true);
    expect((await readSkill()).success).toBe(false);
  } finally {
    await supervisor.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
