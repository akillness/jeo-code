/**
 * `/session` slash-command handler extracted from launch.ts.
 *
 * Handles `/session [new|drop|delete|rename <title>|resume [id]|list|info]`
 * (default: list saved sessions + current-session summary). This block has
 * real mutable-state entanglement with the REPL's giant closure — sessionId,
 * sessionModel, lastUserInput, and lastReply are all reassigned inside it —
 * so the caller passes an explicit context object in and reads a result
 * object back out instead of this function closing over REPL state directly.
 */

import type { Message } from "../../agent/loop";
import type { TaskSubEvent } from "../../agent/task-tool";
import { createSession, deleteSession, renameSession, loadSession, listSessions, sessionPath, resolveSessionRef, type SessionTimelineEntry } from "../../agent/session";
import { SessionPicker, renderSessionPicker } from "../../tui/components/session-picker";
import { extractLastAssistantReply, formatTranscript } from "../../tui/components/transcript";
import { sanitizeForTerminal } from "../../tui/components/code-view";
import { importGjcSession, listGjcSessions, type GjcSessionLeaf } from "../../agent/gjc-session-import";
import { SelectList, renderSelectList, type SelectItem } from "../../tui/components/select-list";
import { formatForgeBox, scaleForgeWidth } from "../../tui/components/forge";
import { renderMarkdownBlock } from "../../tui/components/markdown-text";
import { wrapTextWordAware } from "../../tui/components/width";
import { accentPaint, accentShadowPaint, cardFillPaint, mutedPaint, resolveTheme, type EvolutionTheme } from "../../tui/components/themes";
import { supportsUnicode } from "../../tui/components/capability";
import { size as terminalSize } from "../../tui/terminal";
import chalk from "chalk";

export interface SessionSlashCtx {
  cwd: string;
  /** Mutated in place (length reset + push) — same array reference the caller holds. */
  history: Message[];
  noSession: boolean;
  sessionId: string | undefined;
  sessionModel: string | undefined;
  /** readline interface; only accessed via `(rl as unknown as {history?: string[]})`. */
  rl: unknown;
  advanceSessionBoxColor: () => void;
  disarmPreview: () => void;
  clearScreen: () => string;
  freshWelcomeLines: () => string[];
  logLines: (lines: string[]) => void;
  canSwitchSession?: () => boolean;
  onSessionCommitted?: (id: string | undefined, draft: string, model?: string | null) => void;
  /** Render the restored transcript in working-TUI surface mode when true. */
  tui?: boolean;
  /** Optional theme/width overrides for TUI session restore. */
  theme?: EvolutionTheme;
  cols?: number;
  unicode?: boolean;
  /** Defer cross-session restores until the caller has revoked its sandbox. */
  requestSessionRestart?: (id: string) => void;
  /** Restore editor-local references without changing canonical retry content. */
  promptHistoryText?: (message: Message) => string;
  /**
   * REPL's interactive list-picker runner (raw-mode keypress loop + repaint).
   * Not a pure module export — it closes over terminal/readline state owned
   * by the REPL, so the caller threads it through like the other REPL hooks.
   */
  runSelectPicker: (
    render: (cols: number, rows: number) => string[],
    onKey: (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean } | undefined) => boolean | undefined,
  ) => Promise<void>;
}

export interface SessionSlashResult {
  sessionId: string | undefined;
  /** A null value clears the prior session's model pin. */
  sessionModel?: string | null;
  /** Present only when changed (by `/session resume` re-seeding retry state). */
  lastUserInput?: string;
  /** Present only when changed (by `/session resume` re-seeding retry state). */
  lastReply?: string;
  /** Present only when changed (by `/session resume` restoring header.draft into
   *  the prompt box). */
  draft?: string;


}

interface GjcResumeRequest {
  sessionId?: string;
  leafId?: string;
  anyCwd: boolean;
  error?: string;
}

function parseGjcResumeArgument(arg: string): GjcResumeRequest | undefined {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  if (!tokens.some(token => token.toLowerCase().startsWith("gajae:"))) return undefined;

  let refToken: string | undefined;
  let anyCwd = false;
  for (const token of tokens) {
    if (token === "--any-cwd") {
      anyCwd = true;
      continue;
    }
    if (refToken !== undefined) {
      return { anyCwd, error: `Unexpected argument '${token}'.` };
    }
    refToken = token;
  }

  if (!refToken || !refToken.toLowerCase().startsWith("gajae:")) {
    return { anyCwd, error: "Use /resume gajae:<session-id>[#<leaf-entry-id>] [--any-cwd]." };
  }

  const reference = refToken.slice("gajae:".length);
  if (!reference) return { anyCwd };
  const pieces = reference.split("#");
  if (pieces.length > 2 || !pieces[0]) {
    return { anyCwd, error: "Malformed GJC reference. Use gajae:<session-id>[#<leaf-entry-id>]." };
  }

  return {
    sessionId: pieces[0],
    ...(pieces[1] ? { leafId: pieces[1] } : {}),
    anyCwd,
  };
}

function gjcResumeItems(pool: GjcSessionLeaf[]): SelectItem<GjcSessionLeaf>[] {
  return pool.map(item => ({
    value: item,
    label: `${item.sessionId}#${item.leafId || "(no-leaf)"}`,
    hint: item.selected ? "selected leaf" : item.cwd,
  }));
}

export interface SessionTimelineRenderOptions {
  color?: boolean;
  unicode?: boolean;
  /** Render persisted history in working-TUI surface mode (`"tui"`) vs `"ledger"`. */
  surface?: "ledger" | "tui";
  cols?: number;
  theme?: EvolutionTheme;
}

type SubagentSlotEntry =
  | { kind: "notice"; text: string }
  | { kind: "event"; runKey: string; event: TaskSubEvent }
  | { kind: "message"; runKey: string; role: string; message: Message; truncated?: boolean }
  | { kind: "incomplete"; runKey: string; role: string };

function subagentRunRoleLabel(firstEvent?: TaskSubEvent, fallbackRole?: string): string {
  const role = sanitizeForTerminal(firstEvent?.role || fallbackRole || "subagent") || "subagent";
  const detachedId = firstEvent?.detachedId ? sanitizeForTerminal(firstEvent.detachedId) : "";
  if (detachedId) return `${role}[${detachedId}]`;
  if (firstEvent?.index && firstEvent?.total) return `${role}[${firstEvent.index}/${firstEvent.total}]`;
  return role;
}

/** Replay only persisted records, in file order; the compacted model context is separate. */
export function renderSessionTimeline(
  timeline: readonly SessionTimelineEntry[],
  colorOrOpts: boolean | SessionTimelineRenderOptions = false,
): string[] {
  const opts: SessionTimelineRenderOptions =
    typeof colorOrOpts === "boolean" ? { color: colorOrOpts } : colorOrOpts;
  const color = opts.color ?? false;
  const unicode = opts.unicode !== false;
  const surface = opts.surface ?? "ledger";
  const cols = opts.cols ?? 80;
  const theme = opts.theme;
  const mdAccent = color
    ? (theme ? (s: string) => chalk.bold(accentPaint(theme)(s)) : (s: string) => chalk.bold(s))
    : (s: string) => s;
  const mdMuted = color
    ? (theme ? mutedPaint(theme) : (s: string) => chalk.dim(s))
    : (s: string) => s;

  const messages: Message[] = [];
  const slotEntries: SubagentSlotEntry[][] = [[]];
  const runs = new Map<string, { role: string; state: "running" | "done" | "incomplete" | "failed"; lastSlot: number }>();
  const earlyResponses = new Set(timeline.filter(e => e.type === "parent_response").map(e => e.id));
  const linkedMessages = new Map(timeline.flatMap(e => e.type === "message" && e.responseId ? [[e.responseId, e.message] as const] : []));

  for (const entry of timeline) {
    if (entry.type === "parent_response" || entry.type === "message") {
      if (entry.type === "message" && entry.responseId && earlyResponses.has(entry.responseId)) continue;
      const linked = entry.type === "parent_response" ? linkedMessages.get(entry.id) : undefined;
      if (entry.type === "parent_response" && entry.truncated && !linked) {
        slotEntries[messages.length]!.push({ kind: "notice", text: "  … (stored parent response truncated)" });
      }
      messages.push(linked ?? entry.message);
      slotEntries.push([]);
      continue;
    }

    const slot = messages.length;
    const entries = slotEntries[slot]!;
    if (entry.type === "subagent_event") {
      const e = entry.event;
      if (e.kind === "thinking") continue;
      const key = e.runId ?? e.detachedId ?? `${e.role}:${e.index ?? 0}`;
      const state = e.kind === "done"
        ? (e.success === false ? "incomplete" : "done")
        : e.kind === "error"
          ? "failed"
          : "running";
      runs.set(key, { role: e.role, state, lastSlot: slot });
      entries.push({ kind: "event", runKey: key, event: e });
    } else if (entry.message.role !== "system") {
      const key = entry.runId ?? `${entry.role}:msg`;
      if (!runs.has(key)) runs.set(key, { role: entry.role, state: "running", lastSlot: slot });
      else runs.get(key)!.lastSlot = slot;
      entries.push({ kind: "message", runKey: key, role: entry.role, message: entry.message, truncated: entry.truncated });
    }
  }

  for (const [key, run] of runs) {
    if (run.state === "running") {
      const targetSlot = slotEntries[run.lastSlot] ?? slotEntries[messages.length]!;
      targetSlot.push({ kind: "incomplete", runKey: key, role: run.role });
    }
  }

  const boxWidth = scaleForgeWidth(Math.max(24, cols - 1));
  const boxInnerCols = Math.max(16, boxWidth - 4);

  const renderSlot = (slotIdx: number): string[] => {
    const entries = slotEntries[slotIdx] ?? [];
    if (entries.length === 0) return [];

    if (surface !== "tui") {
      const out: string[] = [];
      for (const item of entries) {
        if (item.kind === "notice") {
          out.push(item.text);
        } else if (item.kind === "event") {
          const e = item.event;
          const detail = [e.detail, e.summary].filter(Boolean).join(" — ");
          out.push(`  subagent ${sanitizeForTerminal(e.role)} · ${e.kind}${e.success === false ? " (failed)" : ""}${detail ? `: ${sanitizeForTerminal(detail)}` : ""}`);
        } else if (item.kind === "incomplete") {
          out.push(`  subagent ${sanitizeForTerminal(item.role)} · no completion observed`);
        } else {
          const text = sanitizeForTerminal(item.message.content ?? "");
          const bounded = text.slice(0, 262144);
          out.push(`  subagent ${sanitizeForTerminal(item.role)} · ${item.message.role}`);
          const rendered = item.message.role === "assistant"
            ? renderMarkdownBlock(bounded, { color, unicode, accent: mdAccent, muted: mdMuted })
            : bounded;
          out.push(...(rendered || bounded).split("\n").map(line => `    ${line}`));
          if (bounded.length < text.length) out.push(`    … (${text.length - bounded.length} characters omitted)`);
          if (item.truncated) out.push("    … (stored message truncated)");
        }
      }
      return out;
    }

    // Working-TUI surface: group contiguous entries per subagent run inside the
    // chronological slot into bordered subagent cards matching LaunchTui.
    const tee = unicode ? "├─" : "|-";
    const end = unicode ? "└─" : "`-";
    const pipe = unicode ? "│ " : "| ";
    const ell = unicode ? "…" : "...";
    const paint = color && theme ? accentPaint(theme) : undefined;
    const paintShadow = color && theme ? accentShadowPaint(theme) : undefined;
    const fill = color && theme ? cardFillPaint(theme) : undefined;

    type Group = { kind: "notice"; text: string } | { kind: "run"; runKey: string; items: Exclude<SubagentSlotEntry, { kind: "notice" }>[] };
    const groups: Group[] = [];
    for (const item of entries) {
      if (item.kind === "notice") {
        groups.push(item);
        continue;
      }
      const last = groups[groups.length - 1];
      if (last && last.kind === "run" && last.runKey === item.runKey) {
        last.items.push(item);
      } else {
        groups.push({ kind: "run", runKey: item.runKey, items: [item] });
      }
    }

    const out: string[] = [];
    for (const grp of groups) {
      if (out.length > 0) out.push("");
      if (grp.kind === "notice") {
        out.push(grp.text);
        continue;
      }
      const runInfo = runs.get(grp.runKey);
      const firstEv = grp.items.find((it): it is Extract<SubagentSlotEntry, { kind: "event" }> => it.kind === "event")?.event;
      const fallbackRole = firstEv?.role ?? runInfo?.role ?? "subagent";
      const roleLabel = subagentRunRoleLabel(firstEv, fallbackRole);
      const hasIncomplete = grp.items.some(it => it.kind === "incomplete");
      const titleState = hasIncomplete
        ? "no completion observed"
        : runInfo?.state ?? "done";

      const boxLines: string[] = [];
      grp.items.forEach((it, idx) => {
        const branch = idx === grp.items.length - 1 ? end : tee;
        const cont = idx === grp.items.length - 1 ? "  " : pipe;
        if (it.kind === "event") {
          const e = it.event;
          const detail = [e.detail, e.summary].filter(Boolean).map(s => sanitizeForTerminal(String(s))).join(" — ");
          const raw = `${branch} ${e.kind}${e.success === false ? " (failed)" : ""}${detail ? `: ${detail}` : ""}`;
          const wrapped = wrapTextWordAware(raw, boxInnerCols, { continuationIndent: cont });
          boxLines.push(...wrapped);
        } else if (it.kind === "incomplete") {
          boxLines.push(`${branch} no completion observed`);
        } else {
          boxLines.push(`${branch} ${sanitizeForTerminal(it.role)} · ${it.message.role}`);
          const text = sanitizeForTerminal(it.message.content ?? "");
          const bounded = text.slice(0, 262144);
          const childBudget = Math.max(12, boxInnerCols - 2);
          const rendered = it.message.role === "assistant"
            ? renderMarkdownBlock(bounded, { color, unicode, maxWidth: childBudget, accent: mdAccent, muted: mdMuted })
            : wrapTextWordAware(bounded, childBudget).join("\n");
          for (const line of (rendered || bounded).split("\n")) {
            boxLines.push(...wrapTextWordAware(`${cont}${line}`, boxInnerCols, { continuationIndent: cont }));
          }
          if (bounded.length < text.length) boxLines.push(`${cont}${ell} (${text.length - bounded.length} characters omitted)`);
          if (it.truncated) boxLines.push(`${cont}${ell} (stored message truncated)`);
        }
      });

      out.push(
        ...formatForgeBox(
          { title: `subagent ${roleLabel} · ${titleState}`, lines: boxLines },
          {
            width: boxWidth,
            maxLines: Infinity,
            unicode,
            color,
            paint,
            paintShadow,
            fill,
            dim: color && titleState === "done",
          },
        ),
      );
    }
    return out;
  };

  const renderedSlots = Array.from({ length: messages.length + 1 }, (_, i) => renderSlot(i));
  return formatTranscript(messages, {
    color,
    unicode,
    surface,
    cols,
    theme,
    bodyLines: 2000,
    beforeMessage: index => renderedSlots[index]!,
    trailingLines: renderedSlots[messages.length]!,
  });
}

export function sessionPromptHistory(messages: readonly Message[], mapper?: (message: Message) => string): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = String(message.content ?? "").trim();
    if (!text || text.startsWith("Tool [") || text.startsWith("[mid-turn steering") || text.startsWith("[Earlier conversation summary]") || text.startsWith("[Interrupted tool execution]") || text.startsWith("Your last reply") || text.startsWith("The budget for this turn is exhausted") || text.startsWith("The step budget for this turn is exhausted") || text.startsWith("You are cycling through the same")) continue;
    const prompt = mapper ? mapper(message) : text;
    if (prompts[0] !== prompt) prompts.unshift(prompt);
  }
  return prompts;
}

export function sessionSwitchBlocked(input: string, pending: { images: number; lines: number; pastedLines: number; commands: number; partial: string; pasteActive: boolean }): boolean {
  return /^\/session\s+(?:new|drop|delete|resume)(?:\s|$)/i.test(input) &&
    !!(pending.images || pending.lines || pending.pastedLines || pending.commands || pending.partial || pending.pasteActive);
}

/**
 * Handle `/session [new|drop|delete|rename <title>|resume [id]|list|info]`
 * (default: list + current-session summary). Extracted verbatim from
 * launch.ts's inline REPL branch — the caller keeps the `input === "/session"`
 * guard and just calls this function.
 */
export async function runSessionSlash(input: string, ctx: SessionSlashCtx): Promise<SessionSlashResult> {
  const { cwd, history, noSession, rl, advanceSessionBoxColor, disarmPreview, clearScreen, freshWelcomeLines, logLines, runSelectPicker } = ctx;
  let sessionId = ctx.sessionId;
  let sessionModel = ctx.sessionModel;
  let sessionModelChanged = false;
  let lastUserInput: string | undefined;
  let lastReply: string | undefined;
  let draft: string | undefined;


  const result = (): SessionSlashResult => ({
    sessionId,
    ...(sessionModelChanged ? { sessionModel: sessionModel ?? null } : {}),
    ...(lastUserInput !== undefined ? { lastUserInput } : {}),
    ...(lastReply !== undefined ? { lastReply } : {}),
    ...(draft !== undefined ? { draft } : {}),
  });


  const tokens = input.substring(8).trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();
  const maySwitch = (): boolean => {
    if (ctx.canSwitchSession?.() !== false) return true;
    console.log("(session unchanged: send or clear pending input and attachments before switching)");
    return false;
  };

  const startFreshSession = async (verb: string): Promise<boolean> => {
    const nextId = noSession ? undefined : (await createSession(cwd, undefined, sessionModel)).id;
    if (!maySwitch()) {
      if (nextId) await deleteSession(nextId, cwd);
      return false;
    }
    history.length = 1;
    sessionId = nextId;
    ctx.onSessionCommitted?.(sessionId, "");
    if (sessionId) {
      advanceSessionBoxColor();
      console.log(`(${verb} — new session ${sessionId})`);
    } else console.log(`(${verb} — sessions disabled)`);
    lastUserInput = "";
    lastReply = "";
    draft = "";
    const rli = rl as { history?: string[] };
    if (Array.isArray(rli.history)) rli.history.length = 0;
    return true;
  };

  if (sub === "new") {
    if (!maySwitch()) return result();
    await startFreshSession("started fresh");
    return result();
  }
  if (sub === "drop" || sub === "delete") {
    if (!maySwitch()) return result();
    const oldId = sessionId;
    if (!await startFreshSession("dropped")) return result();
    if (oldId) {
      const removed = await deleteSession(oldId, cwd);
      console.log(removed ? `(deleted session ${oldId})` : `(session ${oldId} already gone)`);
    }
    return result();
  }
  if (sub === "rename") {
    const title = tokens.slice(1).join(" ").trim();
    if (!title) {
      console.log("Usage: /session rename <title>");
      return result();
    }
    if (!sessionId) {
      console.log("(sessions are disabled — nothing to rename)");
      return result();
    }
    try {
      await renameSession(sessionId, title, cwd);
      console.log(`(session renamed to '${title}')`);
    } catch (err) {
      console.log(`! rename failed: ${(err as Error).message}`);
    }
    return result();
  }
  if (sub === "resume") {
    const arg = tokens.slice(1).join(" ").trim();
    const applyResume = async (
      rid: string,
      loaded?: Awaited<ReturnType<typeof loadSession>>,
    ): Promise<void> => {
      try {
        const loadedSession = loaded ?? await loadSession(rid, cwd);
        if (!maySwitch()) return;
        if (rid !== sessionId && ctx.requestSessionRestart) {
          ctx.requestSessionRestart(rid);
          return;
        }
        const { header, messages, timeline } = loadedSession;
        history.length = 1;
        for (const m of messages) history.push(m);
        sessionId = rid;
        draft = header.draft ?? "";
        sessionModel = header.model;
        sessionModelChanged = true;
        ctx.onSessionCommitted?.(sessionId, draft, header.model ?? null);

        // Seed /retry + reply marker from the last user/assistant turn.
        lastUserInput = sessionPromptHistory(messages)[0] ?? "";
        lastReply = extractLastAssistantReply(messages);
        // Seed readline's input history so ↑ in the prompt recalls THIS session's
        // prior prompts (not just lines typed in the current run). readline history
        // is newest-first; unshift in chronological order so the session's newest
        // prompt lands at the front (first ↑). Skip injected/framed messages.
        const rli = rl as unknown as { history?: string[] };
        if (Array.isArray(rli.history)) {
          rli.history.splice(0, rli.history.length, ...sessionPromptHistory(timeline.filter(e => e.type === "message").map(e => e.message), ctx.promptHistoryText));
        }
        // Clean restore: wipe the screen + scrollback BEFORE replaying the
        // transcript so it can't collide with picker remnants, the prior
        // conversation, or the live input frame — the "/resume corrupts the
        // TUI" fix. Re-render the welcome banner with the resumed session & model
        // so the working TUI opens atop an intact, up-to-date header.
        const isTty = !!process.stdout.isTTY;
        const useTuiSurface = ctx.tui ?? isTty;
        const cols = ctx.cols ?? (isTty ? terminalSize().cols : 80);
        const unicode = ctx.unicode ?? supportsUnicode();
        const theme = ctx.theme ?? (useTuiSurface || isTty ? resolveTheme(process.env) : undefined);
        const color = isTty ? (theme?.color ?? true) : false;
        if (isTty) {
          disarmPreview();
          process.stdout.write(clearScreen());
          console.log(freshWelcomeLines().join("\n"));
        }
        const sepWidth = Math.min(Math.max(20, cols - 1), isTty ? Math.max(20, cols - 1) : 48);
        const sepGlyph = unicode ? "─" : "-";
        const sepRaw = sepGlyph.repeat(sepWidth);
        const sep = color && theme ? mutedPaint(theme)(sepRaw) : sepRaw;
        const modelTag = header.model ? ` · model ${header.model}` : "";
        const bannerRaw = `resumed session ${rid} · ${messages.length} message(s)${modelTag}`;
        const bannerLines = wrapTextWordAware(bannerRaw, Math.max(20, cols - 1))
          .map(line => (color && theme ? mutedPaint(theme)(line) : line));
        const body = renderSessionTimeline(timeline, {
          color,
          unicode,
          surface: useTuiSurface ? "tui" : "ledger",
          cols,
          theme,
        });
        console.log([sep, ...bannerLines, sep, ...body, sep].join("\n"));
      } catch (err) {
        console.log(`! ${(err as Error).message}`);
      }
    };
    const gjcRequest = parseGjcResumeArgument(arg);
    if (gjcRequest) {
      if (gjcRequest.error) {
        console.log(`! ${gjcRequest.error}`);
        return result();
      }

      const importOne = async (source: GjcSessionLeaf | undefined): Promise<void> => {
        if (!source) return;
        try {
          const imported = await importGjcSession({
            sessionId: gjcRequest.sessionId ?? source.sessionId,
            ...(gjcRequest.leafId || source.leafId ? { leafId: gjcRequest.leafId ?? source.leafId } : {}),
            cwd,
            anyCwd: gjcRequest.anyCwd,
          });
          console.log(
            `(imported GJC v5 session ${imported.sourceSessionId}#${imported.sourceLeafId} as Jeo session ${imported.sessionId}${imported.reused ? " (reused)" : ""})`,
          );
          await applyResume(imported.sessionId);
        } catch (err) {
          console.log(`! GJC /resume failed: ${(err as Error).message}`);
        }
      };

      if (gjcRequest.sessionId) {
        await importOne({
          rootPath: "",
          sourcePath: "",
          sessionId: gjcRequest.sessionId,
          leafId: gjcRequest.leafId ?? "",
          cwd,
          selected: false,
        });
        return result();
      }

      let sourcePool: GjcSessionLeaf[];
      try {
        sourcePool = await listGjcSessions({ cwd, anyCwd: gjcRequest.anyCwd });
      } catch (err) {
        console.log(`! GJC /resume listing failed: ${(err as Error).message}`);
        return result();
      }
      if (sourcePool.length === 0) {
        console.log("(no GJC v5 sessions for this workspace)");
        console.log("Usage: /resume gajae:<session-id>[#<leaf-entry-id>] [--any-cwd]");
        return result();
      }

      if (process.stdin.isTTY && process.stdout.isTTY) {
        const picker = new SelectList(gjcResumeItems(sourcePool));
        let selected: SelectItem<GjcSessionLeaf> | undefined;
        await runSelectPicker(
          (cols, rows) => renderSelectList(picker, {
            title: "Import a GJC v5 session",
            cols,
            rows: Math.max(8, rows),
            unicode: true,
            color: true,
          }),
          (ch, key) => {
            if (key?.name === "up") { picker.up(); return false; }
            if (key?.name === "down") { picker.down(); return false; }
            if (key?.name === "pageup") { picker.page(-1); return false; }
            if (key?.name === "pagedown") { picker.page(1); return false; }
            if (key?.name === "backspace") { picker.backspace(); return false; }
            if (key?.name === "escape" || (key?.ctrl && key.name === "c")) return true;
            if (key?.name === "return" || key?.name === "enter") {
              selected = picker.selected();
              return true;
            }
            if (ch && ch >= " " && !key?.ctrl && !key?.meta) picker.typeChar(ch);
            return false;
          },
        );
        await importOne(selected?.value);
        return result();
      }

      console.log("GJC v5 sessions — resume with /resume gajae:<session-id>[#<leaf-entry-id>]:");
      for (const source of sourcePool.slice(0, 20)) {
        const selected = source.selected ? " *" : "";
        console.log(` ${source.sessionId}#${source.leafId || "(no-leaf)"}${selected}  ${source.cwd}`);
      }
      console.log("Add --any-cwd to include sessions from other workspaces.");
      return result();
    }
    if (arg) {
      // Resolve `arg` as a full id OR a short id prefix before resuming.
      const resolved = await resolveSessionRef(arg, cwd);
      if (resolved.kind === "ambiguous") {
        console.log(`Ambiguous session id '${arg}' — matches: ${resolved.matches.slice(0, 5).join(", ")}${resolved.matches.length > 5 ? " …" : ""}. Use more characters or run with --resume (no value) to pick interactively.`);
        return result();
      }
      // "not-found" falls through with the raw arg so loadSession's existing
      // catch-driven "session not found" error message behavior is unchanged.
      await applyResume(resolved.kind === "ok" ? resolved.id : arg);
      return result();
    }
    // No id → only sessions with a real conversation are resumable (every launch
    // creates an empty session; those are noise).
    let pool = (await listSessions(cwd)).filter(s => s.messageCount > 0);
    if (pool.length === 0) {
      console.log("(no saved sessions with history)");
      return result();
    }
    // Interactive picker on a TTY: type to filter, ↑↓/PgUp/PgDn to
    // move, Enter resumes, Del deletes (press Del twice to confirm), Esc cancels.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      // Loop so a delete refreshes the list and re-opens the picker in place.
      for (;;) {
        const picker = new SessionPicker(pool);
        let action: { kind: "resume" | "delete"; id: string } | undefined;
        let confirmDeleteId: string | undefined;
        await runSelectPicker(
          (cols, rows) => renderSessionPicker(picker, {
            title: "Resume a session",
            cols,
            rows: Math.max(8, rows),
            unicode: true,
            color: true,
            confirmDeleteId,
          }),
          (ch, key) => {
            if (key?.name === "up") { confirmDeleteId = undefined; picker.up(); return false; }
            if (key?.name === "down") { confirmDeleteId = undefined; picker.down(); return false; }
            if (key?.name === "pageup") { confirmDeleteId = undefined; picker.page(-1); return false; }
            if (key?.name === "pagedown") { confirmDeleteId = undefined; picker.page(1); return false; }
            if (key?.name === "escape" || (key?.ctrl && key.name === "c")) return true;
            if (key?.name === "delete") {
              const sel = picker.selected();
              if (!sel) return false;
              if (confirmDeleteId === sel.id) { action = { kind: "delete", id: sel.id }; return true; }
              confirmDeleteId = sel.id;
              return false;
            }
            if (key?.name === "return" || key?.name === "enter") {
              const sel = picker.selected();
              if (sel) { action = { kind: "resume", id: sel.id }; return true; }
              return false;
            }
            confirmDeleteId = undefined;
            if (key?.name === "backspace") { picker.backspace(); return false; }
            if (ch && ch >= " " && !key?.ctrl && !key?.meta) picker.typeChar(ch);
            return false;
          },
        );
        if (!action) { console.log("(resume cancelled)"); break; }
        if (action.kind === "resume") { await applyResume(action.id); break; }
        // Delete: drop the file, refresh the pool, and re-open the picker.
        const delId = action.id;
        if (delId === sessionId && (!maySwitch() || !await startFreshSession("dropped current session"))) break;
        try {
          const removed = await deleteSession(delId, cwd);
          console.log(removed ? `(deleted session ${delId})` : `(session ${delId} already gone)`);
        } catch (err) {
          console.log(`! delete failed: ${(err as Error).message}`);
        }
        pool = pool.filter(s => s.id !== delId);
        if (pool.length === 0) { console.log("(no saved sessions with history)"); break; }
      }
      return result();
    }
    // Non-TTY fallback: static list (resume with /session resume <id>).
    console.log("Saved sessions — resume with /session resume <id>:");
    for (const s of pool.slice(0, 15)) {
      const marker = s.id === sessionId ? "*" : " ";
      console.log(` ${marker}${s.id}  (${s.messageCount} msgs)  ${s.title ? `[${s.title}] ` : ""}${s.preview}`);
    }
    return result();
  }
  if (sub === "list") {
    const sessions = await listSessions(cwd);
    if (sessions.length === 0) console.log("(no saved sessions)");
    for (const s of sessions) {
      const marker = s.id === sessionId ? "*" : " ";
      const title = s.title ? `[${s.title}] ` : "";
      console.log(` ${marker}${s.id}  (${s.messageCount} msgs)  ${title}${s.preview}`);
    }
    return result();
  }
  if (sub === "info") {
    if (!sessionId) {
      console.log("Session: disabled (--no-session)");
      return result();
    }
    const all = await listSessions(cwd);
    const current = all.find(s => s.id === sessionId);
    console.log("Session info:");
    console.log(`  id        ${sessionId}`);
    if (current?.title) console.log(`  title     ${current.title}`);
    console.log(`  file      ${sessionPath(sessionId, cwd)}`);
    console.log(`  started   ${current?.timestamp ?? "(this run)"}`);
    console.log(`  messages  ${current?.messageCount ?? Math.max(0, history.length - 1)} persisted · ${history.length - 1} in context`);
    console.log(`  workspace ${cwd}`);
    return result();
  }
  if (sub && sub !== "info") {
    console.log("Usage: /session [list|info|new|drop|rename <title>|resume [id]]");
    return result();
  }

  // Default: list sessions AND show current session info
  const sessions = await listSessions(cwd);
  if (sessions.length === 0) {
    console.log("(no saved sessions)");
  } else {
    console.log("Saved sessions:");
    for (const s of sessions) {
      const marker = s.id === sessionId ? "*" : " ";
      const title = s.title ? `[${s.title}] ` : "";
      console.log(` ${marker}${s.id}  (${s.messageCount} msgs)  ${title}${s.preview}`);
    }
  }
  if (sessionId) {
    const current = sessions.find(s => s.id === sessionId);
    console.log(`\nCurrent session: ${sessionId}${current?.title ? ` [${current.title}]` : ""}`);
  } else {
    console.log("\nCurrent session: disabled (--no-session)");
  }
  return result();
}
