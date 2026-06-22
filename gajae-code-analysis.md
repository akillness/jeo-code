# gajae-code Repository Analysis
**URL:** https://github.com/Yeachan-Heo/gajae-code  
**Cloned:** 2026-06-22 (depth 50)  
**Analysis covers:** commits from ~2026-06-19 through 2026-06-22 (HEAD)

---

## Repository Overview

`gajae-code` is a TypeScript/Rust monorepo for an AI coding agent ("gjc" / Gajae Code). It is architecturally similar to `jeo-code` but is a distinct product. The repo uses Bun for the TypeScript packages and Cargo for native Rust crates.

### Monorepo Structure

| Layer | Location | Description |
|-------|----------|-------------|
| TypeScript packages | `packages/` | `coding-agent`, `ai`, `agent`, `tui`, `gajae-code`, `bridge-client`, `stats`, `utils`, `natives`, `orchestration-token-benchmark`, `typescript-edit-benchmark` |
| Rust crates | `crates/` | `pi-ast`, `pi-iso`, `pi-natives`, `pi-shell`, `brush-builtins-vendored`, `brush-core-vendored` |
| Python tooling | `python/` | Supporting scripts |
| Config | root | `biome.json` (formatter/linter), `Cargo.toml`, `bun.lock`, `.fallowrc.jsonc` |
| Docs | `docs/` | `keybindings.md`, changelog, issues tracker |
| Docker | root | `Dockerfile`, `Dockerfile.robogjc` (robot agent variant) |

---

## Current Version: 0.6.5 (released 2026-06-21)

---

## Recent Git Activity (Last ~30 Commits)

### HEAD – 2026-06-22

| Hash | Time (KST) | Author | Summary |
|------|-----------|--------|---------|
| `67513ad` | 00:50 | Yeachan-Heo | style: biome-format guarded-writer destructure in state-runtime write path |
| `babb4a9` | 00:41 | Yeachan-Heo | **fix**: return lock-owned state revision from guarded writer so active-state sync is race-safe (resolves #20) |
| `598d3ea` | 00:30 | Yeachan-Heo | docs(issues): track post-lock stamped-revision re-read race follow-up from 0.6.5 review |
| `5bd5952` | 23:46 | Yeachan-Heo | **fix**: reflect written state revision so active-state/HUD sync isn't stale-skipped; update guard tests for #951 bash behavior |

### 2026-06-21 (v0.6.5 release day)

| Hash | Time (KST) | Author | Summary |
|------|-----------|--------|---------|
| `98a2624` | 23:15 | Yeachan-Heo | chore: bump version to 0.6.5 |
| `a0ad9b7` | 23:13 | Yeachan-Heo | docs(changelog): record unreleased changes for 0.6.5 |
| `c29d49b` | 23:12 | Yeachan-Heo | chore: gitignore session-scoped `.gjc/_session-*` workflow state |
| `5432b85` | 22:52 | Bellman | **fix**: never block bash tools in the planning-phase mutation guard (#951) |
| `044ef31` | 22:29 | Bellman | Merge PR #950 — Harden skill-state hooks |
| `ae87e22` | 22:23 | Yeachan-Heo | **fix**: forced/authoritative state write must survive corrupt prior state |
| `616bfa6` | (PR #950) | Yeachan-Heo | **feat**: harden skill-state hooks (writer revision policy, Stop force-ask, HUD reconcile, fd-dup guard) |
| `3f3eeb2` | 18:18 | Bellman | **feat(keybindings)**: migrate global debug shortcut into registry (Phase 2, #939) |
| `d83eb0d` | 15:48 | Bellman | test: include `migrate` in CLI surface golden (#944) |
| `211bec6` | 14:52 | Bellman | **feat(migrate)**: import skills and MCP servers safely (#944) |
| `f09d021` | 14:25 | Bellman | **fix(research-plan)**: reject counterexample-only claims regardless of `dropCondition` wording (#942) |
| `0a9fdd1` | 10:54 | Bellman | fix: isolate session-scoped test state (#938) |
| `448b804` | 10:12 | Bellman | **fix**: bound computer screenshot inline images |
| `b362f32` | 08:43 | Bellman | **feat**: add research plan ledger spike (#933) |
| `39005e0` | 07:30 | Bellman | test: scope plugin activation state tests to sessions (#931) |
| `a2577aa` | 06:24 | Bellman | **fix**: tolerate missing session env in guard reads (#930) |
| `7f9682d` | 04:50 | Bellman | test: isolate Hermes smoke state root |
| `b592d4e` | 03:32 | Bellman | **feat(keybindings)**: pasteImage SSOT + default-collision diagnostics (Phase 1, #925) |
| `b20f352` | 03:29 | Bellman | test: set session ids for scoped state tests (#927) |
| `a78a1de` | 02:51 | Bellman | **feat(gjc)**: scope workflow state by session |
| `56c8970` | 00:09 | Bellman | refactor: trim bundled agents to four canonical role agents (#922) |
| `4a972aa` | 00:08 | Bellman | docs: document standalone MCP boundaries (#923) |

### 2026-06-20 (v0.6.4)

| Hash | Time | Author | Summary |
|------|------|--------|---------|
| `f16b77a` | — | Yeachan-Heo | fix(ai): align root-test model expectations after 0.6.4 |
| `a6de20b` | 22:39 | Yeachan-Heo | chore: bump version to 0.6.4 |
| `6f10eee` | 22:37 | Yeachan-Heo | Merge dev into main: v0.6.4 patch (stability fixes, #894 stream fix, Windows tmux, ComputerController binding) |

---

## Key Changes in Detail

### 1. Session-Scoped Workflow State (`a78a1de`, `c29d49b`)

All GJC workflow state — skill state, plans, specs, ledgers — was moved from a flat `.gjc/` directory to per-session paths `.gjc/_session-{id}/`. This prevents concurrent or resumed sessions from colliding on shared workflow state. The new paths are gitignored.

**Files changed:** `packages/coding-agent/src/gjc-runtime/session-layout.ts`, `session-resolution.ts`

---

### 2. State Writer Race-Safety Fix (HEAD, `babb4a9`, `5bd5952`)

**Problem:** The guarded writer returned a `GuardedWriteResult` of `{ path, written }` but never included the actual revision number that was written under the lock. Callers checking whether to update in-memory active-state or the HUD were comparing against a stale revision, so they silently skipped the sync (the "stale-skip" false positive).

**Fix:** `GuardedWriteResult` now always carries a `revision: number` field — the lock-owned revision — so callers can make correct staleness decisions:

```typescript
// Before
| { path: string; written: true }
| { path: string; written: false; reason: "stale-skip" }

// After
| { path: string; written: true; revision: number }
| { path: string; written: false; reason: "stale-skip"; revision: number }
```

Four call-sites in `state-writer.ts` were updated (`writeGuardedResolvedJsonAtomic` and `writeGuardedWorkflowEnvelopeAtomic`, both forced and normal paths).

**Files changed:** `packages/coding-agent/src/gjc-runtime/state-writer.ts`, `state-runtime.ts`

---

### 3. Mutation Guard: bash Never Blocked (`5432b85`, PR #951)

**Problem:** Since 0.6.2, `bash` was included in `BLOCKED_TOOL_NAMES` inside `deep-interview-mutation-guard.ts`. This blocked read-only shell commands during `deep-interview`, `ralplan`, and `ultragoal` planning phases — unintended.

**Fix:** `bash` was removed from `BLOCKED_TOOL_NAMES` entirely. The set is now `{ "edit", "write", "ast_edit" }`. Product-code and `.gjc/**` mutation remain gated through the fully-pathed edit tools. Guard tests updated to assert bash is **never** blocked.

---

### 4. Skill-State Hooks Hardening (PR #950, `616bfa6`)

Four areas hardened under one PR:

| Area | Change |
|------|--------|
| **Writer revision policy** | Forced/authoritative state writes now survive corrupt prior state — the guarded CLI write path previously threw on corrupt JSON during the current-revision read; now handled gracefully |
| **Stop force-ask** | HUD reconciliation added to the Stop signal path |
| **HUD reconcile** | After any skill state write, the HUD is re-derived from the freshly written state rather than relying on stale in-memory view |
| **fd-dup guard** | File descriptor duplication guard added to prevent double-write side effects |

**Test coverage added:** `test/gjc-skill-state-hooks.test.ts` (+431 lines), `test/gjc-state-writer-policy.test.ts` (+263 lines), `test/skill-active-state.test.ts` (+260 lines), `test/tools/ask.test.ts` (+176 lines)

---

### 5. Keybindings Registry Migration (Phase 1 + 2, #925, #939)

A two-phase migration of hardcoded keyboard shortcuts into a data-driven registry:

- **Phase 1 (`b592d4e`):** `pasteImage` made a single source of truth; default-collision diagnostics added so conflicting key assignments are detected at startup.
- **Phase 2 (`3f3eeb2`):** The global `Shift+Ctrl+D` debug-overlay shortcut migrated into the registry as `tui.global.debug`, now remappable. `tui.ts` resolves it via `getKeybindings().matches()` instead of a hardcoded `matchesKey()` call.

**Files changed:** `packages/tui/src/keybindings.ts`, `packages/tui/src/tui.ts`, `docs/keybindings.md`

---

### 6. `migrate` Command for Skills and MCP Servers (`211bec6`)

New `gjc migrate` command that safely imports custom skills and MCP servers:

- **Skills:** reads source SKILL.md, refuses symlinked or unsafe destination paths before writing.
- **MCP servers:** collision-aware upsert behavior (does not overwrite existing entries without confirmation).
- CLI surface test updated to include `migrate` in the command golden list.

---

### 7. Research Plan Ledger Spike (`b362f32`, `f09d021`)

Experimental research-plan ledger feature added. A secondary fix (#942) tightened the acceptance criterion: counterexample-only claims are now rejected regardless of how `dropCondition` is worded (previously only rejected if `dropCondition` contained the literal word "counterexample").

---

### 8. Computer Screenshot Bounding (`448b804`)

Computer-use tool screenshots are now bounded in payload size before being sent as inline images, preventing oversized base64 blobs from exceeding provider message limits.

---

### 9. Bundled Agents Trimmed (#922)

The bundled agent roster was trimmed from a larger set down to exactly four canonical role agents: **planner**, **architect**, **critic**, **executor**. Matches the jeo-code/ooo canonical four-agent model.

---

### 10. v0.6.4 Fixes (2026-06-20)

From the `6f10eee` merge:

| Fix | Detail |
|-----|--------|
| Responses API multi-tool-call stream (#894) | Corrected stream-correlation bug for OpenAI Responses API when multiple tool calls arrive in one stream |
| Windows tmux launch (#895, #906) | Hardened Windows tmux root launch; fixed input regressions |
| ComputerController binding | `natives` package now ships the `ComputerController` binding export consumed by the computer tool |
| Welcome banner modes (#889, #892) | Added `startup.welcomeBannerMode = "square"` fallback; stopped treating `WT_SESSION` (Windows Terminal) as an automatic ASCII downgrade |
| Bash cancellation (#893) | Fixed descendant cleanup race when cancelling a bash tool call |

---

## Files Changed (Last 10 Commits, by Change Volume)

| File | +/- Lines | Topic |
|------|-----------|-------|
| `test/gjc-skill-state-hooks.test.ts` | +431 | Skill state hook tests |
| `src/gjc-runtime/state-writer.ts` | +246 / -246 | Guarded writer revision policy + race fix |
| `test/gjc-state-writer-policy.test.ts` | +263 new | Writer policy tests |
| `test/skill-active-state.test.ts` | +260 new | Active state tests |
| `src/gjc-runtime/state-runtime.ts` | +84 | Runtime integration of new writer API |
| `test/tools/ask.test.ts` | +176 | Ask tool tests |
| `src/skill-state/deep-interview-mutation-guard.ts` | -90 | Removed bash blocking |
| `src/hooks/skill-state.ts` | +147 | Skill state hook hardening |
| `src/gjc-runtime/ultragoal-runtime.ts` | +49 | Ultragoal runtime updates |
| `src/gjc-runtime/deep-interview-recorder.ts` | +63 | Recorder updates |
| `src/hooks/native-skill-hook.ts` | +36 | Native hook updates |
| `src/tools/ask.ts` | +46 | Ask tool hardening |
| `packages/tui/src/keybindings.ts` | +6 | Keybinding registry additions |
| `docs/keybindings.md` | +7 | Keybinding docs |
| `issues/state-runtime-stamped-revision-*.md` | +34 new | Issue tracking doc |

---

## Observations / Comparison with jeo-code

| Aspect | gajae-code | jeo-code |
|--------|-----------|---------|
| Runtime | Bun + Rust (Cargo) | Bun only |
| Language | TypeScript + Rust | TypeScript only |
| Workflow state | Session-scoped `.gjc/_session-{id}/` | `.jeo/state/` |
| Canonical agents | 4 (planner/architect/critic/executor) | 4 (same) |
| Mutation guard | `edit`, `write`, `ast_edit` blocked during planning | similar guard in `loop-guards.ts` |
| Keybindings | Registry-driven, migrating (Phase 1+2 in progress) | Not highlighted in AGENTS.md |
| Computer use | Yes (native binding, screenshot bounding) | Not mentioned |
| Research plans | Experimental ledger added | Not present |
| MCP | Yes — standalone MCP boundaries documented, `migrate` CLI | Yes — `src/mcp/` |
| Docker support | Yes (`Dockerfile`, `Dockerfile.robogjc`) | No |

---

## Summary

The last 48 hours of activity on `gajae-code` were dominated by a focused reliability push in the skill-state and session-state subsystems, culminating in v0.6.5:

1. **Session isolation** — all workflow state is now scoped per session, eliminating cross-session state collisions.
2. **Race fix in the guarded writer** — the lock-owned revision is now threaded back through `GuardedWriteResult` so active-state and HUD updates are never stale-skipped incorrectly.
3. **Mutation guard cleanup** — `bash` was erroneously blocked during planning phases since v0.6.2; removed.
4. **Massive new test coverage** — ~1,100+ new test lines across four new/expanded test files targeting the newly hardened paths.
5. **UX polish** — keybinding registry migration ongoing, computer screenshot size capping, `migrate` command for importing custom skills/MCP configs.
