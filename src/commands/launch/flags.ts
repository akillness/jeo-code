import * as fs from "node:fs";
import * as path from "node:path";
import { type ProviderName, type ModelRole, type ThinkLevel, catalogMetadata, PROVIDER_NAMES } from "../../ai";

export interface LaunchFlags {
  list: boolean;
  resume: boolean;
  resumeId?: string;
  noSession: boolean;
  noTui: boolean;
  /** Explicit step cap from --max-steps; 0 = dynamic (process-driven budget that
   *  keeps extending while the turn shows progress — no hardcoded step ceiling). */
  maxSteps: number;
  message: string;
  tmux: boolean;
  worktree?: string;
  model?: string;
  provider?: ProviderName;
  modelRole?: ModelRole;
  thinking?: ThinkLevel;
  errors: string[];
  print?: boolean;
  appendSystemPromptRaw?: string;
  appendSystemPrompt?: string;
  noSkills: boolean;
  skills?: string;
  noTools: boolean;
  tools?: string;
  systemPromptRaw?: string;
  systemPrompt?: string;
}

function takeValue(args: string[], index: number, inlinePrefix: string): { value?: string; nextIndex: number } {
  const current = args[index]!;
  if (current.startsWith(inlinePrefix)) return { value: current.slice(inlinePrefix.length), nextIndex: index };
  const next = args[index + 1];
  if (next && !next.startsWith("-")) return { value: next, nextIndex: index + 1 };
  return { nextIndex: index };
}

export function isProviderName(input: string | undefined): input is ProviderName {
  // Validate against the canonical registry, not a hand-maintained subset — the
  // old 5-name list silently rejected every OpenAI-compat provider (groq,
  // deepseek, openrouter, …) at `/agents <role> provider <name>`.
  return input !== undefined && (PROVIDER_NAMES as readonly string[]).includes(input);
}

export function isThinkingLevel(input: string | undefined): input is ThinkLevel {
  return input === "minimal" || input === "low" || input === "medium" || input === "high" || input === "xhigh";
}


export function fastThinkingLevelForModel(modelId: string): ThinkLevel | undefined {
  const supported = catalogMetadata(modelId)?.thinking ?? [];
  if (supported.includes("minimal")) return "minimal";
  if (supported.includes("low")) return "low";
  // Digit-count agnostic (gemini-10+ / 2.6+ stay reasoning) — mirrors the gates in
  // gemini.ts and inferCatalogMetadata. Last resort for prefixed ids (models/gemini-…)
  // the catalog lookup above misses; catalogued ids already returned via thinking caps.
  const g = modelId.toLowerCase().match(/gemini-(\d+)(?:\.(\d+))?/);
  if (g && (Number(g[1]) >= 3 || (Number(g[1]) === 2 && Number(g[2] ?? 0) >= 5))) return "minimal";
  return undefined;
}

export function parseFlags(args: string[], cwd: string = process.cwd()): LaunchFlags {
  const flags: LaunchFlags = { list: false, resume: false, noSession: false, noTui: false, maxSteps: 0, message: "", tmux: false, errors: [], print: false, noSkills: false, noTools: false };
  const rest: string[] = [];
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a === "--list") {
      flags.list = true;
    } else if (a === "-p" || a === "--print") {
      flags.print = true;
      flags.noTui = true;
    } else if (a === "--tmux") {
      flags.tmux = true;
    } else if (a === "--worktree") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags.worktree = next;
        i++;
      }
    } else if (a.startsWith("--worktree=")) {
      flags.worktree = a.slice("--worktree=".length);
    } else if (a === "--no-session") {
      flags.noSession = true;
    } else if (a === "--no-tui") {
      flags.noTui = true;
    } else if (a === "--max-steps" || a.startsWith("--max-steps=")) {
      const { value, nextIndex } = takeValue(args, i, "--max-steps=");
      const n = parseInt(value ?? "", 10);
      if (Number.isFinite(n) && n > 0) flags.maxSteps = n;
      i = nextIndex;
    } else if (a === "--model" || a.startsWith("--model=")) {
      const { value, nextIndex } = takeValue(args, i, "--model=");
      if (value) flags.model = value;
      else flags.errors.push("--model requires a value");
      i = nextIndex;
    } else if (a === "--provider" || a.startsWith("--provider=")) {
      const { value, nextIndex } = takeValue(args, i, "--provider=");
      const normalized = value?.toLowerCase();
      if (isProviderName(normalized)) flags.provider = normalized;
      else flags.errors.push("--provider must be one of: anthropic, openai, gemini, ollama");
      i = nextIndex;
    } else if (a === "--thinking" || a.startsWith("--thinking=")) {
      const { value, nextIndex } = takeValue(args, i, "--thinking=");
      const normalized = value?.toLowerCase();
      if (isThinkingLevel(normalized)) flags.thinking = normalized;
      else flags.errors.push("--thinking must be one of: minimal, low, medium, high, xhigh");
      i = nextIndex;
    } else if (a === "--smol" || a === "--slow" || a === "--plan") {
      flags.modelRole = a.slice(2) as ModelRole;
    } else if (a === "--resume" || a === "--continue" || a === "-c") {
      flags.resume = true;
      const next = args[i + 1];
      if (next && UUID_REGEX.test(next)) {
        flags.resumeId = next;
        i++;
      }
    } else if (a.startsWith("--resume=") || a.startsWith("--continue=") || a.startsWith("-c=")) {
      flags.resume = true;
      const eqIdx = a.indexOf("=");
      const val = a.slice(eqIdx + 1);
      if (UUID_REGEX.test(val)) {
        flags.resumeId = val;
      } else {
        rest.push(val);
      }
    } else if (a === "--append-system-prompt" || a.startsWith("--append-system-prompt=")) {
      const { value, nextIndex } = takeValue(args, i, "--append-system-prompt=");
      if (value) flags.appendSystemPromptRaw = value;
      else flags.errors.push("--append-system-prompt requires a value");
      i = nextIndex;
    } else if (a === "--no-skills") {
      flags.noSkills = true;
    } else if (a === "--skills" || a.startsWith("--skills=")) {
      const { value, nextIndex } = takeValue(args, i, "--skills=");
      if (value) flags.skills = value;
      else flags.errors.push("--skills requires a value");
      i = nextIndex;
    } else if (a === "--no-tools") {
      flags.noTools = true;
    } else if (a === "--tools" || a.startsWith("--tools=")) {
      const { value, nextIndex } = takeValue(args, i, "--tools=");
      if (value) flags.tools = value;
      else flags.errors.push("--tools requires a value");
      i = nextIndex;
    } else if (a === "--system-prompt" || a.startsWith("--system-prompt=")) {
      const { value, nextIndex } = takeValue(args, i, "--system-prompt=");
      if (value) flags.systemPromptRaw = value;
      else flags.errors.push("--system-prompt requires a value");
      i = nextIndex;
    } else {
      rest.push(a);
    }
  }
  flags.message = rest.join(" ").trim();

  if (flags.print && !flags.message) {
    flags.errors.push("-p/--print requires a message argument");
  }

  if (flags.appendSystemPromptRaw) {
    if (flags.appendSystemPromptRaw.startsWith("@")) {
      const filePath = flags.appendSystemPromptRaw.slice(1);
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      try {
        flags.appendSystemPrompt = fs.readFileSync(absPath, "utf8");
      } catch (err) {
        flags.errors.push(`failed to read system prompt file: ${(err as Error).message}`);
      }
    } else {
      flags.appendSystemPrompt = flags.appendSystemPromptRaw;
    }
  }
  if (flags.systemPromptRaw) {
    if (flags.systemPromptRaw.startsWith("@")) {
      const filePath = flags.systemPromptRaw.slice(1);
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      try {
        flags.systemPrompt = fs.readFileSync(absPath, "utf8");
      } catch (err) {
        flags.errors.push(`failed to read system prompt file: ${(err as Error).message}`);
      }
    } else {
      flags.systemPrompt = flags.systemPromptRaw;
    }
  }

  return flags;
}

export function matchSkillGlob(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (!p.includes("*")) {
    return p === n;
  }
  const escaped = p.replace(/[.+^${}()|[\\\]]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, ".*") + "$";
  const regex = new RegExp(regexStr);
  return regex.test(n);
}

export function filterToolMap(
  tools: Record<string, any>,
  allowlist: string[]
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const name of allowlist) {
    if (name in tools) {
      result[name] = tools[name];
    }
  }
  return result;
}

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "read   {filePath, lineRange?, raw?} — read a file; lines are prefixed `LINEhh|` (hh = 2-char content anchor; the | is a separator, not file bytes)",
  write: "write  {filePath, content}         — create/overwrite a file",
  edit: "edit   {filePath, editBlock}       — ≔A..B replace lines (append read anchors for safety: ≔12ab..15cd — rejected with fresh content if the lines changed); ≔A+ insert after line A; ≔$ append EOF (payload on next line). NEVER copy the `LINEhh|` prefixes into SEARCH blocks or payloads",
  bash: "bash   {command, timeoutMs?, cwd?, env?} — run a shell command (cwd: subdir; env: extra vars)",
  find: "find   {globPattern}               — find files by name",
  search: "search {pattern, globPattern?, ignoreCase?, context?, maxMatches?} — grep (context: N lines around each match)",
  ls: "ls     {dirPath}                   — list a directory's entries (dirs first)",
};

export function buildToolProtocol(allowedTools: Set<string>): string {
  const lines: string[] = ["You have these tools (call exactly ONE per step):"];
  let num = 1;
  for (const name of ["read", "write", "edit", "bash", "find", "search", "ls"]) {
    if (allowedTools.has(name)) {
      lines.push(`${num}. ${TOOL_DESCRIPTIONS[name]}`);
      num++;
    }
  }
  lines.push(`${num}. done   {reason?}                   — call when the task is fully implemented AND verified`);
  lines.push("");
  lines.push("Reply with STRICT JSON only — no code fences. You MAY include an optional leading");
  lines.push('"reasoning" string (one short sentence on your plan, shown live to the user) before "tool":');
  lines.push('{ "reasoning": "<one short sentence>", "tool": "<name>", "arguments": { ... } }');
  lines.push("Tool calibration: scale calls to difficulty — one for a known fact, a few for a normal task, more only when evidence is genuinely missing. Locate before you open: search/find first, then read the hit, instead of guessing paths.");
  return lines.join("\n");
}
