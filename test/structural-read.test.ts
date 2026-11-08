import { describe, test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readTool, summarizeTypeScriptStructure } from "../src/agent/tools";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-struct-read-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("structural read summaries (Tier 2 #6)", () => {
  const sampleTs = [
    'import * as path from "node:path";',
    "",
    "export interface UserRecord {",
    "  id: string;",
    "  name: string;",
    "  roles: string[];",
    "}",
    "",
    "export type UserId = string;",
    "",
    "export enum RoleKind {",
    "  Admin,",
    "  Member,",
    "}",
    "",
    "export class UserService {",
    "  private cache = new Map<string, UserRecord>();",
    "",
    "  constructor(private readonly prefix: string) {}",
    "",
    "  async findUser(id: UserId): Promise<UserRecord | undefined> {",
    "    const key = `${this.prefix}:${id}`;",
    "    return this.cache.get(key);",
    "  }",
    "}",
    "",
    "export async function formatUserLabel(user: UserRecord): Promise<string> {",
    "  const base = path.basename(user.name);",
    "  return `${user.id}:${base}`;",
    "}",
    "",
    "export const DEFAULT_TIMEOUT_MS: number = 5000;",
  ].join("\n");

  test("summarizeTypeScriptStructure emits AST declarations with exact 1-indexed recovery ranges and anchors", () => {
    const res = summarizeTypeScriptStructure(sampleTs, "src/user-service.ts");
    expect(res.supported).toBe(true);
    expect(res.declarations.length).toBeGreaterThanOrEqual(8);

    const fnDecl = res.declarations.find(d => d.kind === "function" && d.name === "formatUserLabel");
    expect(fnDecl).toBeDefined();
    expect(fnDecl!.startLine).toBe(27);
    expect(fnDecl!.endLine).toBe(30);
    expect(fnDecl!.startAnchor).toMatch(/^[a-z][0-9a-z]$/);
    expect(fnDecl!.endAnchor).toMatch(/^[a-z][0-9a-z]$/);
    expect(fnDecl!.signature).toContain("export async function formatUserLabel(user: UserRecord): Promise<string>");
    expect(fnDecl!.signature).not.toContain("path.basename");

    const methodDecl = res.declarations.find(d => d.kind === "method" && d.name === "UserService.findUser");
    expect(methodDecl).toBeDefined();
    expect(methodDecl!.startLine).toBe(21);
    expect(methodDecl!.endLine).toBe(24);
  });

  test("readTool summary mode emits structural summary and exact range recovery restores full implementation lines", async () => {
    await withTempDir(async dir => {
      const file = path.join(dir, "service.ts");
      await fs.writeFile(file, sampleTs, "utf-8");

      const sumRes = await readTool("service.ts", undefined, dir, false, true);
      expect(sumRes.success).toBe(true);
      expect(sumRes.output).toContain("[structural summary: service.ts");
      expect(sumRes.output).toContain("[function] export async function formatUserLabel");
      expect(sumRes.output).not.toContain("path.basename(user.name)");

      // Selector string "summary" also triggers structural summary mode
      const selectorRes = await readTool("service.ts", "summary", dir);
      expect(selectorRes.success).toBe(true);
      expect(selectorRes.output).toBe(sumRes.output);

      // Recover exact lines for formatUserLabel (27-30)
      const rangeRes = await readTool("service.ts", "27-30", dir, false, true);
      expect(rangeRes.success).toBe(true);
      expect(rangeRes.output).toContain("export async function formatUserLabel");
      expect(rangeRes.output).toContain("path.basename(user.name)");
      expect(rangeRes.output).not.toContain("[structural summary:");
    });
  });

  test("raw:true bypasses structural summary mode and returns verbatim bytes", async () => {
    await withTempDir(async dir => {
      const file = path.join(dir, "service.ts");
      await fs.writeFile(file, sampleTs, "utf-8");

      const rawRes = await readTool("service.ts", "summary", dir, true, true);
      expect(rawRes.success).toBe(true);
      expect(rawRes.output).toBe(sampleTs);
    });
  });

  test("unsupported file extensions fall back truthfully to anchored line output", async () => {
    await withTempDir(async dir => {
      const md = "# Title\n\nSome markdown content.\n";
      await fs.writeFile(path.join(dir, "README.md"), md, "utf-8");

      const res = await readTool("README.md", undefined, dir, false, true);
      expect(res.success).toBe(true);
      expect(res.output).toContain("[structural summary fallback: README.md is not a supported TypeScript/JavaScript source file; showing anchored lines]");
      expect(res.output).toContain("# Title");
    });
  });
});
