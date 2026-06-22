# Plan 06 — Computer Use in jeo

> Analysis of `gajae-code`'s `computer` tool and viable integration paths for jeo.
> Status: **Discussion / Pre-spec**

---

## 1. What gajae-code Built (reference implementation)

`gajae-code` implements a full desktop-automation stack across three layers:

```
model
  → packages/coding-agent/src/tools/computer.ts   (640 lines, Zod schemas, OpenAI action set)
  → packages/natives/                              (NAPI bindings, TypeScript↔Rust bridge)
  → crates/pi-natives/src/computer/               (Rust/macOS native, 7 sub-modules)
```

### 1.1 Action set (OpenAI computer-use schema)

| Action | Side-effecting | Notes |
|--------|---------------|-------|
| `screenshot` | No (read-only) | Returns PNG as `ImageContent`; drives all coordinate math |
| `click` / `double_click` | Yes | x,y in physical pixels of last screenshot |
| `move` | Yes | Cursor only |
| `drag` | Yes | Press, move, release |
| `scroll` | Yes | Logical delta at x,y |
| `type` | Yes | Unicode string injection |
| `keypress` | Yes | Named keys: return, tab, esc, arrow*, modifier* |
| `wait` | Yes (time) | Abort-aware delay |
| `batch` | Yes | Atomic sequence of the above; partial-failure reports step index |

Each action optionally takes `timeout` (seconds) and `include_screenshot` (post-action PNG).

### 1.2 Safety architecture — Fail-closed Supervisor

The most important primitive in the implementation:

```
SupervisorStatus.input_allowed() = hotkey_live AND heartbeat_fresh AND NOT suspended
```

- **`hotkey_live`** — a `CGEventTap` listener must be running and reporting itself alive.
- **`heartbeat_fresh`** — the tap must have ticked within 2 seconds (`HEARTBEAT_FRESH_MS`).
- **`NOT suspended`** — user has not pressed the kill-switch (global hotkey or TUI key).

If the event tap dies for any reason, `heartbeat_fresh` goes stale → input is immediately disabled.
The model can **never** call `reset()` — only the human can unlatch suspension.
On any non-success exit, `InputController::release_all()` fires to prevent stuck mouse buttons.

### 1.3 Executor gate — single authority

`execute_input()` is the **one function** all side-effecting actions pass through:

1. Supervisor check (fail-closed)
2. Accessibility TCC permission check
3. Display epoch match (prevents clicks on stale screenshot coordinates)
4. `release_all()` on any failure path

`bypass_guard.rs` is a compile-time test enforcing that `InputController`'s side-effect methods
are only referenced from `input.rs` and `executor.rs` — not from any other module.

### 1.4 Permissions (macOS TCC)

Two independent grants required:
- **Screen Recording** — `CGPreflightScreenCaptureAccess()` — required for `screenshot`
- **Accessibility** — `AXIsProcessTrusted()` — required for all input injection

The tool does non-prompting preflight checks and opens the correct System Settings pane if a
permission is missing.

### 1.5 Vision loop

Screenshots are returned as `ImageContent` (base64 PNG) alongside the text result.
`vision-guard.ts` silently drops image blocks when the active model doesn't support vision —
so the tool still works in text-only mode (no screenshots, coordinate actions only).

### 1.6 Audit log

Every action is appended as JSONL to `.computer-audit.jsonl` beside the session file
(best-effort; never fails the action if logging fails).

---

## 2. jeo's Constraints

| Constraint | Source |
|------------|--------|
| Zero native dependencies | `package.json` + README philosophy |
| Bun runtime | No Node.js `bindings`/`node-gyp`; Bun has partial NAPI support |
| Cross-platform goal | macOS + Linux (gajae-code is macOS-only) |
| Multi-provider | Not locked to Anthropic; vision requires a capable model |

A direct port of gajae-code's Rust/NAPI layer would break the zero-native-deps promise and
restrict jeo to macOS Apple Silicon. That is not the right default path.

---

## 3. Integration Options

### Option A — Bash harness (works today, zero new deps)

Use platform CLIs via jeo's existing `bash` tool:

```
macOS:  screencapture -x /tmp/jeo-screen.png  → read + base64 → ImageContent
        cliclick c:320,480   (click)
        cliclick t:"hello"   (type)
Linux:  scrot /tmp/jeo-screen.png
        xdotool click --x 320 --y 480 1
        xdotool type "hello"
```

**Pros:** No new code in jeo core; works immediately; cross-platform via env detection.
**Cons:** No supervisor kill-switch; screenshot as file (needs base64 injection into message);
no display epoch tracking; no batch atomicity; requires user to install `cliclick`/`xdotool`.

**Suitable for:** Experimental / power-user use. Not safe enough for autonomous loops.

---

### Option B — MCP computer-use server (recommended medium-term)

Connect jeo's existing MCP client to a computer-use MCP server:

- **Anthropic's `computer-use-demo`** Docker image exposes screenshot + input via MCP.
- **Playwright MCP** (`@playwright/mcp`) — browser-scoped computer use, cross-platform, no TCC.
- **Custom thin server** — a small `bun` process that wraps Option A with MCP JSON-RPC.

jeo already has `src/mcp/` infrastructure. Adding a computer-use MCP endpoint is
a configuration entry, not a code change to the agent loop.

**Pros:** Clean separation; no native deps in jeo; kill-switch lives in the server process;
swappable backends (native macOS vs. Playwright vs. remote).
**Cons:** Requires a running MCP server; network hop; server startup latency.

**Suitable for:** Production-quality computer use with proper safety isolation.

---

### Option C — Anthropic beta computer-use API tool

When provider is `anthropic`, inject `computer_use_20250124` as a beta tool type in the
API request. Claude handles its own action loop.

```typescript
// In src/ai/providers/anthropic.ts
if (settings.computerUse && provider === 'anthropic') {
  headers['anthropic-beta'] = 'computer-use-2025-01-24';
  tools.push({ type: 'computer_use_20250124', name: 'computer', display_width_px, display_height_px });
}
```

**Pros:** No implementation of input primitives; works on any OS.
**Cons:** Anthropic-only; requires a display; screenshots handled by Claude's loop, not jeo's.
**Suitable for:** Quick proof-of-concept on Anthropic provider.

---

### Option D — Pure-TypeScript supervisor pattern (safety primitive, provider-agnostic)

Borrow the **supervisor pattern** from gajae-code as a pure-TS module regardless of which
backend is used. The core logic is just atomics + timestamps — no OS dependency.

```typescript
// src/agent/computer-supervisor.ts
export class ComputerSupervisor {
  #suspended = false;
  #killSwitchLive = false;
  #lastHeartbeatMs = 0;

  get inputAllowed(): boolean {
    return this.#killSwitchLive
      && (Date.now() - this.#lastHeartbeatMs < HEARTBEAT_FRESH_MS)
      && !this.#suspended;
  }
  triggerStop() { this.#suspended = true; }
  reset() { this.#suspended = false; }        // user-only surface
  heartbeat() { this.#lastHeartbeatMs = Date.now(); }
}
```

The TUI can expose a kill-switch key (e.g., `Ctrl+\`) that calls `triggerStop()` and
never exposes `reset()` to the agent loop.

**This should be implemented for any Option above** — it's ~50 lines of pure TS.

---

## 4. Recommended Phased Approach

### Phase 1 — Safety primitive (1–2 days)
- Implement `ComputerSupervisor` in pure TypeScript (Option D)
- Add Ctrl+\ TUI binding → `triggerStop()`; surface supervisor status in HUD
- Unit-test the fail-closed logic (mirrors gajae-code's `supervisor.rs` tests)

### Phase 2 — Bash harness (2–3 days, optional/power-user)
- Add `jeo computer` command using bash tool + platform CLI detection
- Return screenshots as base64-encoded `ImageContent` injected into next message
- Guard on `supervisor.inputAllowed` before every action
- Audit log to `.jeo/computer-audit.jsonl`
- Opt-in via `computer.enabled: true` in config (default: `false`)

### Phase 3 — MCP bridge (1 week)
- Expose a `ComputerMcpServer` option in `src/mcp/`
- Support Playwright MCP as the default backend (cross-platform, no TCC)
- Optional: native macOS backend via thin Bun child-process wrapping `screencapture` + `cliclick`

### Phase 4 — Anthropic native (fast follow)
- Auto-inject `computer_use_20250124` when `provider=anthropic` + `computer.enabled=true`
- Let provider handle its own screenshot loop; jeo just surfaces the results in TUI

---

## 5. Key Design Decisions to Borrow from gajae-code

| Decision | Why it matters |
|----------|---------------|
| Fail-closed supervisor (not fail-open) | Model can never re-enable input; dead listener = safe |
| Model-cannot-reset suspension | Safety invariant; only user interaction unlatches |
| Display epoch tracking | Prevents coordinate mismatches when screen changes between screenshot and click |
| `release_all` on any failure | No stuck mouse buttons after abort |
| `include_screenshot` per-action | Model gets immediate feedback without a separate screenshot call |
| Audit log JSONL (best-effort) | Replay/debug without blocking the action |
| `vision-guard` fallback | Works in text-only mode; degrades gracefully without crashing |
| Bypass guard (structural test) | Enforce that side-effect code can't creep outside executor |

---

## 6. Open Questions

1. **Cross-platform input injection without native deps:** Is there a pure-JS/Bun solution, or
   is a child process to `cliclick`/`xdotool` acceptable for Phase 2?
2. **Vision model gate:** Should jeo auto-detect vision support and refuse `screenshot` if not
   available, or return a text description instead?
3. **Coordinate space contract:** gajae-code uses physical pixels from last screenshot. Should
   jeo store the last screenshot dimensions per-session and validate coordinates against them?
4. **Scope of computer use:** Full desktop (like gajae-code) or browser-only via Playwright first?
5. **MCP server lifecycle:** Should jeo auto-spawn a Playwright MCP child process, or require
   the user to start it separately?
