import * as fs from "node:fs/promises";
import * as path from "node:path";

import { IGNORED_DIRS } from "./tools";

interface ContextItem {
  filePath: string;
  displayPath: string;
  type: "cwd" | "nested" | "parent";
  depth?: number;
  distance?: number;
  candidateName: string;
}

export interface ProjectContextFile {
  path: string;
  content: string;
}

export const CONTEXT_CANDIDATES = ["JEO.md", "AGENTS.md", ".jeo/context.md", "CLAUDE.md"];
export const AGENT_GUIDANCE_DIRS = [".agents/rules", ".jeo/rules", ".agents/hooks", ".jeo/hooks"] as const;
const PER_CONTEXT_FILE_CHARS = 16_000;
const TOTAL_CONTEXT_CHARS = 64_000;
const BASE_CONTEXT_CHARS = 48_000;
const GUIDANCE_CONTEXT_CHARS = TOTAL_CONTEXT_CHARS - BASE_CONTEXT_CHARS;
const MAX_AGENT_GUIDANCE_FILES = 20;
const AGENT_GUIDANCE_EXTENSIONS = new Set([".md", ".json", ".jsonc", ".yaml", ".yml", ".toml"]);

// Per-file RAW content cache: absolute path → mtimeMs:size signature + raw text.
// loadProjectContext runs once per subagent spawn (team/ralph/autopilot); this skips
// re-reading every unchanged AGENTS.md / guidance file. The cheap fs.stat still runs
// each call, so an edit (new mtime/size) or deletion is caught immediately. Truncation
// is applied per call from the raw text, so a differing budget never pollutes the cache.
const fileContentCache = new Map<string, { sig: string; content: string }>();
const FILE_CONTENT_CACHE_CAP = 256;

async function readContextFile(filePath: string, displayPath: string, remainingChars: number): Promise<ProjectContextFile | null> {
  if (remainingChars <= 0) return null;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const sig = `${stat.mtimeMs}:${stat.size}`;
    let content: string;
    const cached = fileContentCache.get(filePath);
    if (cached && cached.sig === sig) {
      // LRU refresh so a hot file is evicted last.
      fileContentCache.delete(filePath);
      fileContentCache.set(filePath, cached);
      content = cached.content;
    } else {
      content = await fs.readFile(filePath, "utf-8");
      // Evict the oldest entry (Map preserves insertion order) once at capacity.
      if (fileContentCache.size >= FILE_CONTENT_CACHE_CAP) {
        const oldest = fileContentCache.keys().next().value;
        if (oldest !== undefined) fileContentCache.delete(oldest);
      }
      fileContentCache.set(filePath, { sig, content });
    }
    if (content.length <= 0) return null;
    const cap = Math.min(PER_CONTEXT_FILE_CHARS, remainingChars);
    const finalContent = content.length > cap ? content.slice(0, cap) + "\n…(truncated)" : content;
    return { path: displayPath.replace(/\\/g, "/"), content: finalContent };
  } catch {
    return null;
  }
}

async function collectTextFiles(rootDir: string, displayPrefix: string, maxDepth: number, out: Array<{ filePath: string; displayPath: string }>): Promise<void> {
  if (out.length >= MAX_AGENT_GUIDANCE_FILES || maxDepth < 0) return;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = await fs.readdir(rootDir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_AGENT_GUIDANCE_FILES) return;
    const filePath = path.join(rootDir, entry.name);
    const displayPath = `${displayPrefix}/${entry.name}`.replace(/\\/g, "/");
    if (entry.isDirectory()) {
      await collectTextFiles(filePath, displayPath, maxDepth - 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (AGENT_GUIDANCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push({ filePath, displayPath });
  }
}

interface WorkspaceScan {
  // Nested AGENTS.md found by the downward walk (depth 0..3, skipping IGNORED_DIRS).
  nested: Array<{ filePath: string; displayPath: string; depth: number }>;
  // Local (cwd-rooted) guidance files in canonical order: explicit oma-config/triggers
  // first, then `.agents/rules`, `.jeo/rules`, `.agents/hooks` buckets. Pre-dedupe/cap.
  localGuidance: Array<{ filePath: string; displayPath: string }>;
}

// Guidance roots relative to cwd, mirroring AGENT_GUIDANCE_DIRS order. Each is the
// directory collectTextFiles used to traverse (maxDepth 2).
const GUIDANCE_ROOTS = AGENT_GUIDANCE_DIRS.map((dir) => ({
  segs: dir.split("/"),
  prefix: dir,
}));

const EXPLICIT_GUIDANCE_FILES = [".agents/oma-config.yaml", ".agents/oma-config.yml", ".agents/hooks/core/triggers.json"];

// Module-level cache of the downward scan, keyed by resolved cwd. The scan is
// independent of $HOME (it only walks the cwd subtree), so caching by cwd is safe.
// Bounded LRU: a long-running session that scans many distinct cwds (subagents,
// worktrees, /view of other trees) must not grow this Map without bound.
const workspaceScanCache = new Map<string, WorkspaceScan>();
const WORKSPACE_SCAN_CACHE_CAP = 32;


function segsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isStrictPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length >= full.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== full[i]) return false;
  return true;
}

interface GuidanceCtx {
  bucket: number;
  prefix: string;
  remaining: number; // mirrors collectTextFiles maxDepth: root=2, then decremented
}

// Single downward traversal from resolvedCwd that, in ONE readdir per directory,
// collects BOTH nested AGENTS.md files and the local `.agents`/`.jeo` guidance files.
// Replaces the previous separate walkDown + per-root collectTextFiles recursions
// (which re-read the overlapping `.agents/rules` and `.agents/hooks` subtrees).
async function scanWorkspaceDownwards(resolvedCwd: string): Promise<WorkspaceScan> {
  const nested: WorkspaceScan["nested"] = [];
  const buckets: Array<Array<{ filePath: string; displayPath: string }>> = GUIDANCE_ROOTS.map(() => []);

  async function walk(dir: string, depth: number, relSegs: string[], nestedActive: boolean, guidance: GuidanceCtx | null): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const name = entry.name;
      const childPath = path.join(dir, name);
      if (entry.isDirectory()) {
        const childSegs = [...relSegs, name];
        let childGuidance: GuidanceCtx | null = null;
        const rootIdx = GUIDANCE_ROOTS.findIndex((r) => segsEqual(childSegs, r.segs));
        if (rootIdx >= 0) {
          childGuidance = { bucket: rootIdx, prefix: GUIDANCE_ROOTS[rootIdx].prefix, remaining: 2 };
        } else if (guidance && guidance.remaining >= 1) {
          childGuidance = { bucket: guidance.bucket, prefix: `${guidance.prefix}/${name}`, remaining: guidance.remaining - 1 };
        }
        const childNestedActive = nestedActive && !IGNORED_DIRS.includes(name);
        const childDepth = depth + 1;
        const nestedWantsDescend = childNestedActive && childDepth <= 3;
        const guidanceWantsDescend = childGuidance !== null;
        const ancestorWantsDescend = GUIDANCE_ROOTS.some((r) => isStrictPrefix(childSegs, r.segs));
        if (nestedWantsDescend || guidanceWantsDescend || ancestorWantsDescend) {
          await walk(childPath, childDepth, childSegs, childNestedActive, childGuidance);
        }
      } else if (entry.isFile()) {
        if (nestedActive && depth <= 3 && name === "AGENTS.md") {
          const displayPath = path.relative(resolvedCwd, childPath).replace(/\\/g, "/");
          nested.push({ filePath: childPath, displayPath, depth });
        }
        if (guidance && guidance.remaining >= 0 && AGENT_GUIDANCE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
          buckets[guidance.bucket].push({ filePath: childPath, displayPath: `${guidance.prefix}/${name}`.replace(/\\/g, "/") });
        }
      }
    }
  }

  await walk(resolvedCwd, 0, [], true, null);

  // Explicit cwd-rooted guidance files (kept as cheap stat checks, fixed order, first).
  const explicit: Array<{ filePath: string; displayPath: string }> = [];
  for (const rel of EXPLICIT_GUIDANCE_FILES) {
    const filePath = path.join(resolvedCwd, rel);
    try {
      const st = await fs.stat(filePath);
      if (st.isFile() && st.size > 0) explicit.push({ filePath, displayPath: rel.replace(/\\/g, "/") });
    } catch { /* optional */ }
  }

  return { nested, localGuidance: [...explicit, ...buckets.flat()] };
}

async function getWorkspaceScan(cwd: string): Promise<WorkspaceScan> {
  const resolvedCwd = path.resolve(cwd);
  const cached = workspaceScanCache.get(resolvedCwd);
  if (cached) {
    // LRU refresh: re-insert so the most-recently-used entry is evicted last.
    workspaceScanCache.delete(resolvedCwd);
    workspaceScanCache.set(resolvedCwd, cached);
    return cached;
  }
  const scan = await scanWorkspaceDownwards(resolvedCwd);
  // Evict the oldest entry (Map preserves insertion order) once at capacity.
  if (workspaceScanCache.size >= WORKSPACE_SCAN_CACHE_CAP) {
    const oldest = workspaceScanCache.keys().next().value;
    if (oldest !== undefined) workspaceScanCache.delete(oldest);
  }
  workspaceScanCache.set(resolvedCwd, scan);
  return scan;
}

/**
 * Invalidate the cached single-pass workspace scan. Pass a `cwd` to clear just that
 * entry (resolved), or omit to clear the entire cache. Call this after the workspace's
 * AGENTS.md / `.agents` / `.jeo` guidance files change on disk.
 */
export function invalidateWorkspaceScan(cwd?: string): void {
  if (cwd === undefined) {
    workspaceScanCache.clear();
    fileContentCache.clear();
    return;
  }
  // Per-cwd: drop just the downward scan. The per-file content cache is mtime/size
  // self-invalidating, so it needs no per-cwd eviction (a path's stale entry is
  // replaced on the next read once its mtime/size changes).
  workspaceScanCache.delete(path.resolve(cwd));
}

export async function discoverAgentGuidanceFiles(cwd = process.cwd()): Promise<Array<{ filePath: string; displayPath: string }>> {
  const scan = await getWorkspaceScan(cwd);
  const out: Array<{ filePath: string; displayPath: string }> = [...scan.localGuidance];
  const home = path.join(process.env.HOME || "", "");
  const homeRoots = [
    { rootDir: path.join(home, ".agents", "rules"), displayPrefix: "~/.agents/rules" },
    { rootDir: path.join(home, ".jeo", "rules"), displayPrefix: "~/.jeo/rules" },
    { rootDir: path.join(home, ".agents", "hooks"), displayPrefix: "~/.agents/hooks" },
    { rootDir: path.join(home, ".jeo", "hooks"), displayPrefix: "~/.jeo/hooks" },
  ];
  for (const root of homeRoots) {
    await collectTextFiles(root.rootDir, root.displayPrefix, 2, out);
  }
  const seen = new Set<string>();
  return out.filter(entry => {
    const key = entry.displayPath.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_AGENT_GUIDANCE_FILES);
}


// No assembled-result cache: the parent walk + downward scan (cached by workspaceScanCache)
// are cheap, and readContextFile skips re-reading unchanged file CONTENTS via its mtime/size
// cache. This keeps the result disk-truthful — a guidance/AGENTS.md edit is reflected on the
// next spawn — while still avoiding the dominant per-spawn cost (re-reading every file).
export async function loadProjectContext(cwd = process.cwd()): Promise<ProjectContextFile[]> {
  const result: ProjectContextFile[] = [];
  let baseChars = 0;
  let guidanceChars = 0;
  const addGuidanceFile = async (filePath: string, displayPath: string) => {
    const file = await readContextFile(filePath, displayPath, GUIDANCE_CONTEXT_CHARS - guidanceChars);
    if (!file) return;
    result.push(file);
    guidanceChars += file.content.length;
  };

  const resolvedCwd = path.resolve(cwd);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
  const collectedItems: ContextItem[] = [];

  // 0. User-global context files (~/.jeo/agent/AGENTS.md) — lowest precedence.
  // Native user files come first in the result so project files later take precedence.
  // Only jeo's own user config applies; foreign-provider user files are excluded (e.g.
  // ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md stay out — only ~/.jeo/* is loaded).
  if (home) {
    const userAgentFile = path.join(home, ".jeo", "agent", "AGENTS.md");
    try {
      const stat = await fs.stat(userAgentFile);
      if (stat.isFile() && stat.size > 0) {
        const file = await readContextFile(userAgentFile, "~/.jeo/agent/AGENTS.md", BASE_CONTEXT_CHARS - baseChars);
        if (file) {
          result.push(file);
          baseChars += file.content.length;
        }
      }
    } catch {
      // User-global file not found or unreadable; silently skip.
    }
  }
  // 1. CWD 및 부모 walk
  let curr = resolvedCwd;
  let distance = 0;
  while (true) {
    if (home && curr === home) {
      break;
    }

    for (const candidate of CONTEXT_CANDIDATES) {
      const filePath = path.join(curr, candidate);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile() && stat.size > 0) {
          const displayPath = path.relative(resolvedCwd, filePath).replace(/\\/g, "/");
          collectedItems.push({
            filePath,
            displayPath: displayPath || candidate,
            type: distance === 0 ? "cwd" : "parent",
            distance: distance === 0 ? undefined : distance,
            candidateName: candidate,
          });
        }
      } catch {
        // 무시
      }
    }

    let isGitRoot = false;
    try {
      const gitStat = await fs.stat(path.join(curr, ".git"));
      if (gitStat.isDirectory() || gitStat.isFile()) {
        isGitRoot = true;
      }
    } catch {
      // 무시
    }

    if (isGitRoot) {
      break;
    }

    const parent = path.dirname(curr);
    if (parent === curr) {
      break;
    }
    curr = parent;
    distance++;
  }

  // 2. CWD 하위 중첩 AGENTS.md 수집 (depth <= 3) — 캐시된 단일 스캔에서 읽음
  const scan = await getWorkspaceScan(resolvedCwd);
  for (const nf of scan.nested) {
    collectedItems.push({
      filePath: nf.filePath,
      displayPath: nf.displayPath,
      type: "nested",
      depth: nf.depth,
      candidateName: "AGENTS.md",
    });
  }

  // 3. 우선순위 정렬
  const typeOrder = { cwd: 1, nested: 2, parent: 3 };
  collectedItems.sort((a, b) => {
    if (a.type !== b.type) {
      return typeOrder[a.type] - typeOrder[b.type];
    }
    if (a.type === "cwd") {
      return CONTEXT_CANDIDATES.indexOf(a.candidateName) - CONTEXT_CANDIDATES.indexOf(b.candidateName);
    } else if (a.type === "nested") {
      if (a.depth !== b.depth) {
        return (b.depth ?? 0) - (a.depth ?? 0);
      }
      return a.displayPath.localeCompare(b.displayPath);
    } else {
      if (a.distance !== b.distance) {
        return (a.distance ?? 0) - (b.distance ?? 0);
      }
      return CONTEXT_CANDIDATES.indexOf(a.candidateName) - CONTEXT_CANDIDATES.indexOf(b.candidateName);
    }
  });

  // 중복 경로 제거 (Set 사용)
  const seenPaths = new Set<string>();
  const uniqueItems: ContextItem[] = [];
  for (const item of collectedItems) {
    const key = path.resolve(item.filePath);
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      uniqueItems.push(item);
    }
  }

  // 4. 예산 내에서 로드
  for (const item of uniqueItems) {
    if (baseChars >= BASE_CONTEXT_CHARS) {
      break;
    }
    const file = await readContextFile(item.filePath, item.displayPath, BASE_CONTEXT_CHARS - baseChars);
    if (!file) continue;
    result.push(file);
    baseChars += file.content.length;
  }

  // GJC/OMA parity: skill docs are loaded by `skills/catalog.ts`; hook/rule guidance is
  // separate project policy. Keep a reserved guidance budget so large root context files do
  // not completely crowd out `.agents` / `.jeo` rules and hooks.
  for (const entry of await discoverAgentGuidanceFiles(cwd)) {
    await addGuidanceFile(entry.filePath, entry.displayPath);
    if (guidanceChars >= GUIDANCE_CONTEXT_CHARS) break;
  }

  return result;
}

export function withProjectContext(systemPrompt: string, contextFiles: ProjectContextFile[]): string {
  if (!contextFiles || contextFiles.length === 0) {
    return systemPrompt;
  }

  let contextBlock = "<project_context>\n\nProject-specific instructions and guidelines:\n";
  for (const file of contextFiles) {
    contextBlock += `\n<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n`;
  }
  contextBlock += "</project_context>";

  return `${systemPrompt}\n\n${contextBlock}`;
}
