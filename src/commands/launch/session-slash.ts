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
import { createSession, deleteSession, renameSession, loadSession, listSessions, sessionPath, resolveSessionRef } from "../../agent/session";
import { SessionPicker, renderSessionPicker } from "../../tui/components/session-picker";
import { formatTranscript } from "../../tui/components/transcript";

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
  /** Present only when changed (by `/session resume` restoring header.model). */
  sessionModel?: string;
  /** Present only when changed (by `/session resume` re-seeding retry state). */
  lastUserInput?: string;
  /** Present only when changed (by `/session resume` re-seeding retry state). */
  lastReply?: string;
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

  const result = (): SessionSlashResult => ({
    sessionId,
    ...(sessionModelChanged ? { sessionModel } : {}),
    ...(lastUserInput !== undefined ? { lastUserInput } : {}),
    ...(lastReply !== undefined ? { lastReply } : {}),
  });

  const tokens = input.substring(8).trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();

  const startFreshSession = async (verb: string): Promise<void> => {
    history.length = 1;
    if (!noSession) {
      sessionId = (await createSession(cwd, undefined, sessionModel)).id;
      advanceSessionBoxColor(); // distinct input-box hue per newly opened session
      console.log(`(${verb} — new session ${sessionId})`);
    } else {
      sessionId = undefined;
      console.log(`(${verb} — sessions disabled)`);
    }
  };

  if (sub === "new") {
    await startFreshSession("started fresh");
    return result();
  }
  if (sub === "drop" || sub === "delete") {
    if (sessionId) {
      const removed = await deleteSession(sessionId, cwd);
      console.log(removed ? `(deleted session ${sessionId})` : `(session ${sessionId} already gone)`);
    }
    await startFreshSession("dropped");
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
    const applyResume = async (rid: string): Promise<void> => {
      try {
        const { header, messages } = await loadSession(rid, cwd);
        history.length = 1;
        for (const m of messages) history.push(m);
        sessionId = rid;
        // Restore the model this session was last using (per-session model).
        if (header.model) { sessionModel = header.model; sessionModelChanged = true; }
        // Seed /retry + reply marker from the last user/assistant turn.
        lastUserInput = ""; lastReply = "";
        for (let k = history.length - 1; k >= 1; k--) {
          if (history[k]!.role === "user" && !lastUserInput) lastUserInput = String(history[k]!.content ?? "");
          if (history[k]!.role === "assistant" && !lastReply) lastReply = String(history[k]!.content ?? "");
          if (lastUserInput && lastReply) break;
        }
        // Seed readline's input history so ↑ in the prompt recalls THIS session's
        // prior prompts (not just lines typed in the current run). readline history
        // is newest-first; unshift in chronological order so the session's newest
        // prompt lands at the front (first ↑). Skip injected/framed messages.
        const rli = rl as unknown as { history?: string[] };
        if (Array.isArray(rli.history)) {
          const priorPrompts = history
            .filter(m => m.role === "user")
            .map(m => String(m.content ?? "").trim())
            .filter(c => c && !c.startsWith("Tool [") && !c.startsWith("[mid-turn steering") && !c.startsWith("[Earlier conversation summary]"));
          for (const p of priorPrompts) {
            if (rli.history[0] !== p) rli.history.unshift(p);
          }
        }
        // Clean restore: wipe the screen + scrollback BEFORE replaying the
        // transcript so it can't collide with picker remnants, the prior
        // conversation, or the live input frame — the "/resume corrupts the
        // TUI" fix. Same proven path as /clear; re-render the welcome banner
        // so the resumed view reads like a fresh, intact screen.
        if (process.stdout.isTTY) {
          disarmPreview();
          process.stdout.write(clearScreen());
          console.log(freshWelcomeLines().join("\n"));
        }
        const sep = "─".repeat(Math.min(48, Math.max(20, (process.stdout.columns ?? 80) - 1)));
        logLines([
          sep,
          `resumed session ${rid} · ${messages.length} message(s) (/history all for the full transcript)`,
          sep,
          ...formatTranscript(history, { maxTurns: 6, color: true, unicode: true }),
          sep,
        ]);
      } catch (err) {
        console.log(`! ${(err as Error).message}`);
      }
    };
    if (arg) {
      // gjc-parity: resolve `arg` as a full id OR a short id prefix before resuming.
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
    // Interactive gjc-style picker on a TTY: type to filter, ↑↓/PgUp/PgDn to
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
        try {
          const removed = await deleteSession(delId, cwd);
          console.log(removed ? `(deleted session ${delId})` : `(session ${delId} already gone)`);
        } catch (err) {
          console.log(`! delete failed: ${(err as Error).message}`);
        }
        if (delId === sessionId) await startFreshSession("dropped current session");
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
