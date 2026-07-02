# Changelog

All notable changes to **jeo-code** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The README mirrors the latest 5 entries — regenerate with `bun run changelog:sync`.

## [0.7.28] - 2026-07-02
_gajae-code 0.7.9–0.7.10 OAuth + model-execution parity: generic long rate-limit windows are retried (never fatal), retry waits are abort-cancellable, Codex prompt caching via session correlation, and the Kimi Code device-flow OAuth is completed end-to-end (catalog, gating, discovery, tests)._

### Fixed
- **Generic 429 rate limits with a long server `Retry-After` were treated as FATAL — gajae 0.7.10 (#1370) keeps them retryable, and now jeo does too.** The old behavior failed fast on any 429 whose server-directed delay exceeded a hard-coded 5-minute budget, and silently compressed every honored `Retry-After` to 30s (retrying into a still-closed window). gjc's contract (verified against its `agent-session-retry-cap` tests): a transient rate limit honors the provider's wait IN FULL — even a ~3.1h `retry-after-ms=11180000` — while usage/quota/model-limit errors keep failing fast via `isUsageLimitError` → `defaultRetryable`. `withRetry` (`src/util/retry.ts`) now honors server-directed delays uncapped (the 30s `RATE_LIMIT_FLOOR_CAP_MS` only caps the SYNTHETIC escalating floor for server-silent 429s), and `resolveRetryOptions` no longer injects a default `rateLimitMaxServerDelayMs` — it remains available as explicit opt-in config (`retry.rateLimitMaxServerDelayMs`, added to the Config type + zod schema).
- **A long honored rate-limit wait is now user-cancellable.** `RetryOptions.signal` (new) aborts an in-progress backoff sleep: `resolveCall` threads the caller's ORIGINAL abort signal (Ctrl-C / turn abort) into the retry layer — distinct from the per-attempt fetch timeout, so one attempt's timeout can never cut short the next attempt's backoff, while Esc/Ctrl-C interrupts a multi-hour wait immediately instead of after the sleep elapses.
- **`isUsageLimitError` missed gajae's usage-exhaustion phrasings.** Added `model.?limit` / `message.?limit` / `limit for this model` / `out_of_credits` / Anthropic's account-level `request would exceed your account's rate limit` and the qualified `Resource has been exhausted (… quota/limit)` form (bare gRPC `resource exhausted` stays transient — deliberate jeo choice for Gemini windows that clear quickly). Without these, an out-of-credits 429 was retried on a pointless backoff ladder instead of failing fast to the model/credential-switch hint.
- **Anthropic 429s now carry their rate-limit response headers in the error detail** (gjc `getSafeAnthropicHeaderEvidence` parity): `retry-after`, `retry-after-ms`, and every `anthropic-ratelimit-*` header — including the decisive `anthropic-ratelimit-unified-overage-disabled-reason=out_of_credits`, which often arrives ONLY as a header. Without it an out-of-credits 429 read like a generic per-minute rate limit.

### Added
- **Kimi Code (Moonshot coding subscription) OAuth — completed end-to-end.** The device-code flow (`src/auth/flows/kimi.ts`, RFC 8628: `auth.kimi.com` device_authorization → poll with `authorization_pending`/`slow_down`/`expired_token`/`access_denied` semantics, X-Msh-* device headers, persisted `kimi-device-id`) now has: catalog entries for the Kimi Code models (`kimi-for-coding`, `kimi-k2.7-code`, `kimi/kimi-k2.5`, `kimi/kimi-k2-turbo-preview`, `kimi/kimi-k2` — 262k context, provider-qualified where canonicals collide with tencent's), a `KIMI_CODE_MODELS` export, OAuth gating (`oauthServesModel`: kimi OAuth serves ONLY the Kimi Code set; Moonshot API ids fall back to `KIMI_API_KEY` via `effectiveCredentialForProvider`, with an actionable error when no key exists), and an OAuth-only discovery fallback that lists exactly the Kimi Code models (`catalogOr`) instead of faking moonshot ids. The `kimiAdapter` dispatches on credential kind — OAuth → Anthropic-compatible `api.kimi.com/coding/v1/messages` with plain Bearer + X-Msh headers (no Claude-Code cloaking; gated by `shouldUseClaudeCodeOAuthShape`'s baseUrl check), api_key → the unchanged OpenAI-compatible `api.moonshot.ai/v1`.
- **Codex/Responses provider-side prompt caching (gjc parity — closes the `ponytail` note in `openai-responses.ts`).** New `CallOptions.sessionKey` threads a stable per-conversation key from `launch.ts` (the session id), `team.ts`, and `task-tool.ts` (per-run UUIDs) through the engine loop into every model call. `codexResponsesRequest` stamps it as `prompt_cache_key` in the body (both the OAuth Codex backend and the public `api.openai.com/v1/responses`) plus `session_id`/`conversation_id`/`x-client-request-id` correlation headers on the Codex backend (`normalizePromptCacheKey`: ≤64 chars verbatim, longer keys hashed `pc_*` — gjc `normalizeOpenAIResponsesPromptCacheKey` parity). An agent loop replays nearly-identical history each step, so cache hits cut both latency and billed input tokens.

### Verified
- `bun run typecheck` clean; full suite green — 2142 pass / 0 fail across 244 files (before the codex/kimi test additions), then targeted suites re-run green: `retry` (26), `rate-limit-handling` (5), `provider-errors`, `round-b`, `kimi-provider` (7 new), `kimi-oauth` (7 new), `codex-responses` (+3 new). The corrected rate-limit contract is pinned by tests that mirror gjc's own fixtures (3.1h retry-after honored + recovered; model-limit fails fast; mid-wait abort interrupts the sleep).

## [0.7.27] - 2026-07-02
_Extended-keyboard decode layer: Esc/Ctrl+C work again on kitty-protocol terminals, Shift+Enter breaks lines on every terminal incl. Windows, row/draft-aware Cmd+←→/↑↓ + Home/End/Ctrl+Home/End, Ctrl+V text-paste fallback. Plus Anthropic 5th-gen omp-parity: catalog-derived output budgets end thinking-vs-reply starvation; refusals fail fast at the transport and the recovery ladder strips replayed thinking blocks._

### Fixed
- **Esc and Ctrl+C went DEAD after 0.7.25's keyboard-protocol push — the reported "입력후 esc 키 (또 ctrl+c) 입력이 안되는 문제".** Root cause: `CSI >1u` (kitty disambiguate) makes the terminal re-encode Esc as `CSI 27u` and Ctrl+C as `CSI 99;5u` (xterm modifyOtherKeys=2: `CSI 27;5;99~`) — forms nothing in jeo decoded: readline saw an unknown sequence (key `name: undefined`), the raw-`\u0003` scans never matched, and the mid-turn harness classified both as "noise". New decode layer in `src/commands/launch/input.ts` — `matchExtendedKey`/`decodeExtendedKeys` (kitty CSI-u + xterm modifyOtherKeys → legacy bytes), `chunkHasCtrlC` (all three Ctrl+C encodings), `normalizeKeypress` (CSI-u keypress events → the `{name, ctrl, meta}` shape handlers match; includes the Bun quirk where an unknown CSI emits the literal STRING `"undefined"` as `key.name`) — wired into the prompt key filter, the footer/picker keypress handlers, the raw Ctrl+C byte scan, the pre-prompt typed-input drain, and the mid-turn ESC/Ctrl+C abort harness. Key-release reports (`:3`) and unknown functional codes are swallowed instead of leaking `[57376u`-style garbage into the draft. Cmd/Super+letter no longer types the bare letter.
- **Copy/paste reliability ("복사붙여넣기가 잘 동작안하는 경우"):** (1) Ctrl+V arrived as `CSI 118;5u` under the kitty protocol — binding dead; now normalized. (2) Ctrl+V with a TEXT clipboard was a silent no-op (binding was image-only); it now falls back to `readClipboardText()` (`pbpaste` / PowerShell `Get-Clipboard -Raw` / `wl-paste`/`xclip`/`xsel`) and inserts at the caret with paste-grade sanitation (ANSI stripped, line breaks → box sentinel — a multi-line clipboard can never self-submit). (3) A trailing `\r\n` outside a paste (Windows CRLF tails) forwarded BOTH bytes — the `\r` submitted and the `\n` leaked into the next prompt as a phantom break/submit; now folds to ONE Enter, including when the CRLF is split across stdin chunk reads (`crTail` filter state). (4) `disableKittyKeyboard()` now POPS the kitty keyboard-mode stack (`CSI <u`) instead of pushing a zero-flags entry that leaked onto the outer shell.
- **Shift+Enter coverage gaps.** `SHIFT_ENTER_SEQS` covered only 2 encodings (`CSI 27;2;13~`, `CSI 13;2u`); now every modified-Enter form breaks the line: kitty mods 2–6 (Shift/Alt/Ctrl combinations), the xterm modifyOtherKeys equivalents, and legacy alt-as-meta `ESC \r` (macOS Option+Enter, Windows Terminal Alt+Enter).
- **Adaptive-thinking turns died with "output budget exhausted" because `max_tokens` was the THINKING-LEVEL table (4k–32k), not the model's real output capacity.** On Anthropic adaptive models (Opus 4.6+, Sonnet/Fable/Mythos 5) thinking tokens are spent INSIDE `max_tokens`, so a deep-thinking step competed with its own visible reply inside a 16k–32k budget and could stop at `stop_reason=max_tokens` with zero content. New `resolveMaxOutputTokens(model, level)` (`src/ai/model-manager.ts`) resolves the CATALOG max-output (fable-5: 128k) capped by `JEO_MAX_OUTPUT_TOKENS` (default 64k); the thinking level keeps steering DEPTH via `reasoningEffort`/`output_config` only. Wired through `resolveCall`, both `launch.ts` engine call sites, and `task-tool.ts` subagent spawns.
- **Safety refusals were retried as "transient provider error" at the transport layer, burning 2 extra billed calls per recovery-ladder rung (observed: 392k input tokens for one refused turn).** A refusal is deterministic for identical conversation content. `isRefusalError` moved to `src/util/retry.ts` (re-exported from `provider-error.ts`) and `defaultRetryable` now fails fast on `stop_reason=refusal` / `finish_reason=content_filter` / Gemini `SAFETY`-family markers — the engine's bounded ladder (which MUTATES context between attempts) is the only retry layer. Same failing turn now costs 190k → recovers.
- **The refusal ladder could never recover when replayed thinking blocks were the classifier trigger.** Stage 2 ("context reset") only elided tool-result bodies; assistant turns kept `reasoningArtifacts`/`toolUse`, and `buildAnthropicMessages` resent the flagged model-authored thinking blocks verbatim — so a fable-5 turn re-refused through the whole ladder (reproduced deterministically at both 32k and 64k budgets, and at minimal thinking). New `stripReasoningArtifactsInPlace` (`src/agent/compaction.ts`) drops the native replay channel (display `reasoning` text survives) at stage 2, so the next request falls back to plain-text history. Verified live: the exact turn that previously exhausted the ladder now recovers at stage 2 and completes.
- **`LaunchTui.setLivePromptHighlight` test failed on hosts exporting `NO_COLOR`** (agent harnesses, some CI): `detectColorLevel` honors `NO_COLOR` before `FORCE_COLOR` (no-color.org contract), so the test's `FORCE_COLOR=3` never produced a colored theme. The test now pins `JEO_TUI_THEME=cosmic` and clears `NO_COLOR` for the constructor — deterministic on every host.

### Added
- **A line-break key on EVERY terminal — the Windows answer ("윈도우환경에 알맞는 단축키").** The lone-LF break rule (`\n` → line break) is now DEFAULT-ON (`JEO_MULTILINE=0` opts out): raw-mode Enter is always `\r`, so a bare `\n` can only be Ctrl+J (universal) or Ctrl+Enter (Windows Terminal/conhost) — both now insert a break with zero terminal configuration. Plus the Claude-Code `\`+Enter convention: Enter on a draft ending in `\` (caret at end) replaces the backslash with a line break — works even on terminals with no Shift+Enter protocol at all (conhost, Terminal.app).
- **Whole-draft jumps: Ctrl+Home/Ctrl+End (Windows/Linux) and Cmd+↑/Cmd+↓ (macOS kitty-protocol) move the caret to the start/end of the entire draft (`DOC_HOME_SEQS`/`DOC_END_SEQS`), complementing the row-aware Cmd+←/→ and Home/End from 0.7.25.** Sequences are consumed even when no readline is attached, so modifier-arrow params can never leak into the draft as literal text.
- `/hotkeys` documents the break keys, row/draft jumps, and the Ctrl+V text fallback (18 → 21 rows).

### Verified
- `bun run typecheck` clean; full suite green — 2104 pass / 0 fail across 240 files. New `test/extended-key-decode.test.ts`: 21 tests / 85 assertions across all six consumer layers (decoder, whole-string decode, Ctrl+C matcher, keypress normalizer, prompt filter, abort harness, clipboard paste command) — mutation-checked (flipping the ctrl-bit test reddens 6 tests).
- Live probes through the REAL implementation (Bun eval, no PTY): kitty Esc keypress normalizes to `escape`; all 3 Ctrl+C encodings detected; 7 break encodings → sentinel; Cmd+←/→ land on row boundaries; Ctrl+Home/Cmd+↓ land on draft edges; trailing and split CRLF fold to one Enter; `\`+Enter emits backspace+break; mid-turn kitty Esc aborts with "ESC pressed…", kitty Ctrl+C hard-exits; Cmd+C is swallowed as input yet visible as `meta+c` to the clear-input binding.
- Anthropic budget/refusal fixes: affected suites green (`model-manager`, `anthropic-stream`, `model-catalog`, `retry`, `provider-error`, `refusal-recovery`, `compaction`) with 6 new test cases; live E2E (fable-5, xhigh, OAuth) — the previously-blocked multi-step turn completes end-to-end, stage 2 logs "reset 2 tool result(s) and dropped thinking replay from 3 turn(s)".

## [0.7.26] - 2026-07-02
_Esc/Ctrl+C reliably clears the input box (fixes a gate the earlier reorder missed), and un-bracketed multi-line pastes no longer shred into premature per-line submits._

### Fixed
- **Esc (and meta-mapped Cmd+C) at the prompt intermittently did nothing.** A prior fix reordered the Esc check ahead of the `previewPending` reentrancy gate, but missed an earlier, more totalizing `!previewArmed || pickerActive` gate that Ctrl+C already bypassed (checked first) while Esc did not — so a fresh session's very first Esc after typing could be silently swallowed. The Esc/meta+C check now runs immediately after the Ctrl+C check, before that gate, mirroring Ctrl+C's existing precedent. Verified live in a real `jeo` TUI (tmux-driven keystrokes): 10/10 fresh-session repro attempts now clear the box; previously flaky.
- **Un-bracketed multi-line paste shredded into separate premature submits.** Terminals/paths that deliver a multi-line paste as ONE stdin chunk WITHOUT bracketed-paste markers (DECSET 2004) — e.g. a raw X11 primary-selection middle-click paste, some SSH clients, or a tmux `paste-buffer` binding without `-p` — hit `filterPromptInputChunk`'s bare `\r`/`\n` pass-through and had each embedded line submitted as its own message mid-composition instead of landing as one multi-line draft. Reproduced live: pasting `"first line\nsecond line\nthird line"` via an un-bracketed tmux paste immediately submitted line 1 to the model, leaving the rest to leak in as orphaned lines. Fixed with a guard in `src/commands/launch/input.ts`: outside an active bracketed paste, a linebreak with MORE data after it in the SAME synchronous chunk (impossible for a genuine standalone Enter keypress, which always arrives as the last byte of its read) now folds to the multi-line sentinel instead of submitting — matching the bracketed-paste contract (review the whole block, then press Enter once). A trailing linebreak with nothing after it is unaffected and still submits normally.

### Verified
- `bun run typecheck` clean; full suite green — 2077 pass / 0 fail across 239 files (4 new cases in `test/prompt-key-filter.test.ts` covering the un-bracketed paste guard, including a no-false-positive check for ordinary single-line typing).
- Both fixes reproduced and confirmed live in a real running `jeo --no-session` TUI inside tmux (not just unit tests): the exact 3-line un-bracketed paste that previously triggered a premature submit now stays as one multi-line draft, and Esc immediately clears it.

## [0.7.25] - 2026-07-02
_Shift+Enter now reliably distinguishable from Enter on kitty/WezTerm/iTerm2/xterm via modifyOtherKeys + kitty keyboard protocol; row-aware Home/End and Cmd+Left/Right in multi-row drafts._

### Added
- **modifyOtherKeys + kitty keyboard protocol on launch.** `enableModifyOtherKeys()` (`CSI >4;2m`) and `enableKittyKeyboard()` (`CSI >1u`) are sent to the terminal at REPL startup so Shift+Enter is distinguishable from plain Enter on every modern terminal that supports either protocol. Terminals that support neither silently ignore both sequences. Both modes are restored to defaults (`CSI >4;0m` / `CSI >0u`) on process exit via `process.once("exit", …)`. Four new exports in `src/tui/terminal.ts`: `enableModifyOtherKeys`, `disableModifyOtherKeys`, `enableKittyKeyboard`, `disableKittyKeyboard`.
- **Row-aware Home/End (and macOS Cmd+Left/Right) in multi-row input.** `ROW_HOME_SEQS` / `ROW_END_SEQS` sequences are now caught by `filterPromptInputChunk` _before_ the old whole-buffer `CURSOR_COMBO_REWRITES` path. `rowBoundaryOffset()` (new export in `input-box.ts`) walks the same `caretCells` grid as vertical navigation and jumps the caret to the start/end of the current **visual row**, degenerating to `0`/`length` on a single-row draft — matching macOS/editor convention of "start/end of THIS line".

### Verified
- `bun run typecheck` clean; full suite green — 2073 pass / 0 fail across 239 files — including two new test files: `test/row-boundary.test.ts` (9 cases for `rowBoundaryOffset`) and `test/row-home-end-filter.test.ts` (5 cases for filter-level row-aware Home/End).

## [0.7.24] - 2026-07-02
_OAuth callback page redesign with embedded jeo wordmark + Close button; memory budget O(n²)→O(n) incremental tracking fix._

### Added
- **OAuth callback page: jeo wordmark + Close button.** The post-login browser page now embeds the jeo synthwave wordmark as an inline WebP data URI (no static-asset pipeline required in a compiled binary), and gains an explicit `id="jeo-close"` button that calls `window.close()` immediately — the countdown timer remains as a fallback (bumped 3→5 s). Both success and failure pages now auto-close so OAuth tabs never linger.
- **`HEADER_BY_TYPE` lookup for memory budget tracking.** Extracted from `TYPE_LAYOUT` alongside the existing `DIR_BY_TYPE`, enabling incremental section-header length computation in `selectWithinBudget` without a full re-render.

### Fixed
- **`selectWithinBudget` O(n²)→O(n) budget tracking.** Extracted `renderConceptItem` and introduced per-type accumulated section-length tracking so each candidate's budget contribution is computed incrementally (header + item delta) rather than by re-rendering the entire accumulated selection. Produces identical truncation boundaries with O(n) work instead of O(n²); locked by a new regression test (`memory-search-okf.test.ts`) that verifies the exact 50-of-60 cutoff against a hand-computed derivation.
- **OAuth failure page now shows auto-close / Close button.** Previously the failure page intentionally suppressed `window.close()`; it now uses the same countdown + Close button as the success page so users are not stranded on an error screen.

### Verified
- `bun run typecheck` clean; full suite green — 2064 pass / 0 fail across 237 files — including the new `selectWithinBudget` incremental-budget regression test and updated OAuth callback page assertions (`id="jeo-countdown"`, `id="jeo-close"`, `window.close()` present on both success and failure pages).

## [0.7.23] - 2026-07-01
_Anthropic 5th-generation model catalog: adds Sonnet 5, Fable 5, and Mythos 5, promotes the 4.6 generation to 1M context / 128k output, and retires the superseded 4.5/3.5/4.1 ids. Bumps the default model to Sonnet 4.6, prices the new tiers, and fixes the thinking transport for Haiku 4.5 and every 5th-gen model._

### Added
- **Anthropic 5th-generation models.** New catalog entries `claude-sonnet-5`, `claude-fable-5` (most capable widely-released, adaptive thinking always on), and `claude-mythos-5` (limited-availability, callable by id). `inferCatalogMetadata` now recognizes the `fable`/`mythos` families, and the Anthropic version parser accepts dateless single-major ids (e.g. `claude-sonnet-5`).
- **1M context / 128k output for the 4.6 generation onward.** `claude-opus-4-6/4-7/4-8`, `claude-sonnet-4-6`, and all 5th-gen ids now advertise 1,000,000-token context and 128,000-token max output (Anthropic docs); dated pre-4.6 ids stay at 200k/64k.
- **Pricing for the new tiers.** Opus 4.8 (`$5`/`$25` per M), Fable/Mythos (`$10`/`$50`), and Sonnet 5 (`$2`/`$10`), ordered ahead of the generic Opus/Sonnet families so the newer tiers win.

### Fixed
- **Haiku 4.5 thinking transport.** Haiku 4.5 supports `budget_tokens` thinking but rejects `output_config.effort` ("This model does not support the effort parameter"), so it now uses the plain budget transport instead of its sonnet/opus 4.5 siblings' budget-effort mode.
- **Adaptive thinking display for 5th-gen models.** `display: "summarized"` is now enabled for every 5th-generation+ model (Sonnet 5, Fable 5, Mythos 5) in addition to Opus ≥ 4.7, so their reasoning streams instead of being silently omitted.
- **Gemini path no longer inherits a `claude-` model id.** A `claude-`-prefixed model falls back to `gemini-2.0-flash` on the Gemini transport instead of forwarding an incompatible id.

### Changed
- **Default model bumped to `claude-sonnet-4-6`.** Runtime default, setup defaults, recommended-model set, and the `sonnet`/`opus` aliases now point at the 4.6 generation.
- **Retired superseded ids.** Removed `claude-3-5-sonnet`, `claude-opus-4-1`, `claude-opus-4-5`, and `claude-sonnet-4-5` (plus their Antigravity `-thinking` variants) from the catalog.

### Verified
- `bun run typecheck` clean; full `bun test` suite green. Updated model-catalog, pricing, registry, and Anthropic-stream tests cover the new families, 1M/128k metadata, and the Haiku 4.5 transport.

## [0.7.22] - 2026-06-30
_gajae-code 0.7.3–0.7.8 parity sweep: terminal-bell notifications, a gruvbox-dark TUI theme, a resilient `jeo update` runtime check, and an ultragoal artifact gate. Ports the user-facing improvements from upstream gajae-code that jeo did not yet have, re-implemented to fit jeo's config, command, theming, and skill surfaces._

### Added
- **Terminal-bell notifications (`notify.bell` / `JEO_NOTIFY_BELL`).** gajae-code 0.7.8 (#1277) parity. Emits an ASCII BEL when an agent turn finishes so a backgrounded `jeo` session pings you. Off by default; opt in with `config.notify.bell` (per-event `onComplete`/`onAsk` refine it) or force with `JEO_NOTIFY_BELL=1`/`0`. Never fires for a cancelled turn, and a dead terminal never crashes the turn.
- **gruvbox-dark TUI theme.** New `JEO_TUI_THEME=gruvbox-dark` option alongside the existing themes.

### Fixed
- **`jeo update` no longer reports false failures from Bun tarball-extraction errors.** gajae-code 0.7.8 (#1280) parity. When the package manager exits nonzero but the active `jeo` on PATH actually reports the requested version, the update is treated as recovered (with a clear message and `recovered: true` in `--json`) instead of failing; genuine failures still exit 1.

### Changed
- **ultragoal artifact gate.** gajae-code 0.7.4 (#1163) parity. The completion report must cite concrete verification artifacts — exact commands and their observed results, plus changed-file paths tied to each acceptance criterion — and must explicitly mark any unverifiable criterion as unresolved rather than implying success.

## [0.7.21] - 2026-06-26
_Global llm-wiki vault integration, Gemini/Antigravity thinking indicators, generous file-reading windows, and autopilot flag validation. Adds a shared global wiki root configuration with a /wiki slash command, fires reasoning start signals up front for Gemini/Antigravity models, adjusts the large-file reading discipline to use generous windows, and validates autopilot goal and integer flags._

### Added
- **Global llm-wiki vault root configuration (wikiRoot / JEO_WIKI_ROOT).** Adds wikiRoot to the config schema and JEO_WIKI_ROOT env override. Consumed by resolveWikiRoot and normalizeWikiRoot. Injects the wiki root path into the system prompt and exports it to subagents and hooks.
- **/wiki [path|off] slash command.** Allows showing, setting, or clearing the global llm-wiki vault root interactively.
- **Gemini/Antigravity thinking indicators.** Fires onReasoningStart up front when thinking is requested (budget > 0) so the UI shows the thinking phase even before/without thought parts arriving.
- **In-name Gemini thinking depth markers.** Gemini thinking budget now overrides the unset floor when the model variant name itself encodes a thinking depth (e.g., -high, -low, -thinking).
- **Autopilot flag validation.** Validates --goal (must be min|max|gate) and positive integer flags (--timeout, --patience, --max) in autopilot commands.

### Changed
- **Generous file-reading windows.** Updates WORKING_DISCIPLINE to read large files (>500 lines) in generous windows (~250 lines per read) instead of tiny slices to avoid context bloat.
- **Autopilot score folding.** Refactors bestScoreFromLog to fold baseline and kept scores in a single pass.

### Verified
- bun run typecheck clean; full suite green. Added tests for wiki root resolution, /wiki slash command, Gemini thinking active/budget markers, and autopilot flag validation.

## [0.7.20] - 2026-06-26
_OKF concept-memory retrieval gains a hybrid reranker ported from memsearch. Injection priority no longer rides one raw keyword score — it fuses two complementary ranked channels by Reciprocal Rank Fusion (RRF): IDF-weighted lexical relevance (the sparse/BM25 channel, so rare discriminating terms steer recall) and concept-graph proximity (the local dense/semantic-neighbour channel, so a hub linked from multiple query hits surfaces even with no keyword of its own). All embedding-free and deterministic, layered atop the existing failure-first tier and pinned-invariant reserved budget._

### Added
- **IDF-weighted lexical scoring (`buildCorpusStats` / `tokenIdf`).** `src/agent/memory.ts` adds `CorpusStats` (corpus size + per-token document frequency) built once per retrieval pass, and BM25-style non-negative IDF `ln(1 + (N − df + 0.5)/(df + 0.5))`. `scoreConcept` now takes optional `stats` and scales each token's field weight (title ≫ tags ≫ type/description ≫ body) by its IDF, so a rare specific term outranks a concept hit only by common filler. Always > 0 for a present token, so the score-presence semantics the failure-gate and filters depend on are preserved; omitting `stats` keeps the raw field-weighted count.
- **Reciprocal Rank Fusion (`reciprocalRankFusion`, k=60).** Fuses several ranked id-lists into one score map — each list contributes `1/(k + rank)` summed across lists, rank-based (not score-based) so a strong lexical hit and a strong graph-proximity hit combine on equal, scale-free footing, and a concept ranked in BOTH channels rises above one strong in only one. Tunable `k`; an empty channel is a no-op.
- **Graph-proximity channel (`graphProximityOrder`).** Ranks concepts by how many distinct query-hit seeds reach them via 1-hop links (using the public `expandByGraph` API), the local stand-in for memsearch's dense-vector channel: a strongly-connected neighbour surfaces even when its own lexical score is weak. Input order breaks ties.

### Changed
- **`priorityOrder` fuses lexical ⊕ graph by RRF instead of raw score + a boolean `related` flag.** The failure-first and high-confidence "core" tiers are unchanged; below them, the prior `score`-then-`related` ordering is replaced by the fused RRF rank, with input order as the stable final tiebreak. `searchConcepts` now IDF-weights via `buildCorpusStats` too. The failure boost still only fires on an actual query hit (score > 0).

### Verified
- `bun run typecheck` clean; full suite green — 2022 pass / 0 fail across 234 files — including new `test/memory-search-okf.test.ts` cases (`buildCorpusStats` document-frequency counting, `scoreConcept` IDF scaling, a rare term outranking a higher raw-weight common term, `reciprocalRankFusion` cross-channel summation + tunable `k` + empty-channel no-op, graph proximity lifting a multiply-linked hub above an unlinked equal-score concept). `scripts/rrf-runtime-check.ts` drives the production `memoryPromptSection` against a real on-disk bundle.


## [0.7.19] - 2026-06-26
_The live model picker gains gajae-code's `/model` provider tabs, and skill invocation is consolidated onto a single `$` entrypoint. The picker now shows an `ALL` tab plus one tab per provider that `tab`/`shift+tab` cycles, and skills (including their declared aliases) are invoked only via `$` — the slash palette stays builtins-only._

### Added
- **`/model` live picker gets a provider/group tab bar (gajae-code parity).** `src/tui/components/select-list.ts` adds a synthetic `ALL_TAB` first tab plus one tab per distinct item `group`, a `tabList()`/`activeTab()`/`cycleTab()` API, and tab-scoped visibility in `computeVisible()`. `renderSelectList` gains a `showTabs` option that draws the tab bar (active tab highlighted) and a `tab provider` key hint; `renderLiveModelPicker` (`live-model-picker.ts`) enables it. `runLaunchCommand` (`src/commands/launch.ts`) wires the `tab` key (with `shift+tab` to step back) into the picker key handler.

### Changed
- **Skills are invoked ONLY via the `$` entrypoint — declared aliases become `$`-invocable, never `/` commands.** This reverses 0.7.18's slash-alias dispatch: `src/skills/catalog.ts` replaces `parseSkillSlashInvocation` with `getSkillByDollarToken` (resolve by exact name → exact declared alias without its leading `/` → unique name prefix), and `parseSkillInvocation` now also matches a declared alias, so `$obsidian-capture` loads the skill that declares `/obsidian-capture`. `runLaunchCommand` drops every `/`-alias dispatch path (one-shot and REPL), leaves `skillSlashDetails` empty so the slash menu stays builtins-only, and surfaces declared-alias tokens in `$` autocomplete via `resolvedSkillTokens`.

## [0.7.18] - 2026-06-26
_Slash-command discovery and the `/model` flow reach gajae-code parity. The slash palette/autocomplete now fuzzy-matches command names (with a description fallback for intent-style queries), resolved skills can contribute their own `/aliases` as real dispatchable commands, and `/model` runs gjc's two-menu target → reasoning flow so a picked model can be assigned to the default or any subagent role with its own thinking budget._

### Added
- **Slash completion gains gjc §2.1 fuzzy name matching with a description fallback.** `src/tui/components/autocomplete.ts` adds pure `fuzzyMatch`/`fuzzyScore` (exact 100 > startsWith 80 > includes 60 > subsequence `40 − gaps×5`, min 1) and a `fuzzyCommandHits` ranker, so `/mdl` → `/model` now completes while prefix-exact behaviour (`/mod` → `/model`) is preserved. When nothing matches a command name, both the autocomplete dropdown and `matchSlash` (`slash.ts`) fall back to a description substring match — `/oauth` → `/login`, `/clipboard` → `/dump` — gated to ≥2-char queries with a real substring hit to avoid flooding. New `SLASH_COMMAND_DESCRIPTIONS` map backs the fallback.
- **Resolved skills can contribute `/` slash commands, not just `$<name>`.** Every slash alias a resolved skill declares (frontmatter `aliases:`/`slash:`) becomes a real, dispatchable palette command grouped under "skills" — extending the slash menu, autocomplete, and previews. `runLaunchCommand` (`src/commands/launch.ts`) wires `skillSlashAliases`/`parseSkillSlashInvocation` so both the interactive REPL (`/obsidian-capture note`) and one-shot mode (`jeo "/obsidian-capture note"`) dispatch the owning skill, with built-in slash handlers always winning and first-declarer-wins alias scoping.
- **`buildThinkingLevelChoices` extracts the reasoning menu (gjc `#renderThinkingMenu`).** `src/tui/components/live-model-picker.ts` adds `THINKING_LEVEL_ORDER` and a pure `buildThinkingLevelChoices(current, { inheritLabel, tokenHint })` that renders `<level> — <description> (<tokens>)` with the current level flagged and an optional leading `inherit` row for role targets — fully unit-testable.

### Changed
- **`/model` runs gjc's two-menu target → reasoning flow.** After a model is picked, `applyPickedModelWithTarget` now shows `applyTargetChoices` ("Set as DEFAULT / EXECUTOR / …", which target uses the model) followed by the per-target reasoning menu. DEFAULT updates the active session model and default thinking; a subagent role writes `~/.jeo/config.json` (model + thinking, or inherit) without switching the chat model. Replaces the prior default-only assignment.

### Verified
- `bun run typecheck` clean; full suite green — 2009 pass / 0 fail across 234 files — including new `test/autocomplete.test.ts` cases (`fuzzyMatch` subsequence, `fuzzyScore` ranking, non-prefix subsequence completion, prefix-exact preservation, description-only fallback), `test/slash.test.ts` (`matchSlash` description fallback for intent queries), and `test/live-model-picker.test.ts` (`buildThinkingLevelChoices` ordering, token hints skipping minimal, `inherit` row only with a label, explicit role level outranking inherit).


## [0.7.17] - 2026-06-25
_Developer workflow parity (gjc `dev:link`/`dev:doctor`, adapted for jeo's zero-native-dep Bun runtime): the global `jeo` command can be linked to run this checkout's source hot to every edit, with a drift doctor that flags when `jeo` resolves to a compiled binary or an installed copy instead. README gains "Skill migration and bundled skill inspection" + "Development" sections. Also ships OKF concept-memory search/scoring with budget-aware injection and a round of workflow-prompt hardening (anti-punt, todo-first planning, verdict discipline) that keeps every loop escape hatch intact._

### Added
- **`bun run dev:link` / `dev:doctor` run the global `jeo` from this checkout's source.** New `scripts/dev-link.ts`: `link` symlinks `jeo` → `<repo>/src/cli.ts` into `~/.local/bin` (override `JEO_DEV_LINK_DIR`), refuses to proceed when another `jeo` shadows the managed link earlier on `PATH`, ensures the `#!/usr/bin/env bun` entry stays executable, and runs a `--version` smoke test; `doctor` classifies whatever `jeo` the current `PATH` resolves to as `linked` (this hot source), `drift` (a compiled binary or npm-installed copy — exit 1), or `missing`. Unlike gjc there is no `build:native` prerequisite — jeo has zero native deps, so a bare symlink to the shebang entry is fully functional. Pure helpers (`findShadowingJeo`, `classifyDevDoctor`, `splitPathEntries`, `defaultLinkDir`, `resolveJeoOnPath`) back the `dev:link`/`dev:doctor` `package.json` scripts.
- **OKF concept memory gains in-memory search, scoring, and budget-aware injection.** `src/agent/memory.ts` adds `loadConcepts`/`scoreConcept`/`searchConcepts` over the OKF concept bundle (`.jeo/memory`), `index.md` progressive disclosure, and a relevance-selected `memoryPromptSection` that fills the `MEMORY_INJECT_MAX_CHARS` budget by picking whole high-scoring concepts instead of mid-string truncation, plus `recordFailedAttempt` for failure-aware recall (docs/okf_mem sprint-03 Search & Reference).

### Changed
- **README documents skill migration/inspection and the dev workflow.** New "Skill migration and bundled skill inspection" section walks `jeo skills list` / `read <name>` / `sync --check` / `sync --force`, and a new "Development" section covers `dev:link`/`dev:doctor` and running from source — bringing the gajae-code README's targeted sections to jeo.
- **Workflow prompts (engine, goal-verifier, deep-interview, critic, architect) tightened against punting and false blocks.** The turn protocol now asks a multi-edit batch to name each change in its `reasoning` and a multi-file task to sketch a todo plan before the first edit, the `web_search` reflex re-searches when sources conflict, and OUTPUT_DISCIPLINE forbids punting with only a disclaimer/cutoff caveat/offer-to-search. The Goal Verifier judges the goal as written with positive per-requirement evidence (MET when satisfied, IMPOSSIBLE only when genuinely unsatisfiable); deep-interview stops filling ambiguity with assumptions yet still lowers its score when dimensions truly resolve; the critic treats softening as signal but never manufactures blocks; the architect notes a clean verdict ≠ no inspection and adds an `Inspected:` line. All escape hatches (single-use done latches, `MAX_RE_BLOCKS`, step-budget hard cap) are unchanged, so no new loop risk.

### Fixed
- **Attaching an image no longer pushes the input caret several columns past the `[image #N]` tag.** Terminals pad a dragged-and-dropped image path with their own surrounding spaces, and the Ctrl+V clipboard insert added its own separator, so the swapped-in tag ended up flanked by multiple spaces and the caret parked well past it (the "spacebar ×3" feel). The two attach paths now share one tested helper in `src/util/file-attachment.ts`: `normalizeImageTags` collapses the whitespace around every `[image #N]` to exactly one space (trimming line edges, idempotent), `insertImageTag` (Ctrl+V) inserts the tag single-spaced with the caret right after it, and `attachImagePaths` (drag-drop / submit-time) normalizes its output and returns the precise post-tag `cursor`. The live REPL parks the box caret at that offset, so it sits immediately after the tag's single trailing space — ready for the prompt.

### Verified
- **"Works beside your existing agent or bot" now reflects jeo's real interop surface (all four READMEs).** The table documents `--worktree <name>` (run in an isolated sibling git worktree — `src/commands/launch/tmux.ts` `resolveWorktree`) for the Codex/Claude/Claw rows and `jeo mcp serve` / `jeo mcp tools` (the MCP stdio tool contract — `src/commands/mcp.ts`) for the external-controller/bot row, instead of the prior generic "standard terminal/CLI interfaces" wording.
- `bun run typecheck` clean; full suite green — 1991 pass / 0 fail across 234 files — including the new `test/dev-link.test.ts` (target/link-dir resolution incl. `JEO_DEV_LINK_DIR` override, PATH splitting, earlier-on-PATH shadow detection, and doctor `linked`/`drift`/`missing` classification), the new `test/memory-search-okf.test.ts` (concept load/score/search, `index.md` disclosure, budget-aware relevance injection, failed-attempt recall), expanded `test/cycle-and-turn-budget.test.ts`, and expanded `test/file-attachment.test.ts` + `test/input-box.test.ts` (whitespace normalization around `[image #N]`, idempotence, `insertImageTag`/`caretAfterTag`/`attachImagePaths` caret offsets, and the end-to-end render proving the caret column lands right after the rendered tag). Real CLI runs verified `dev:link`/`dev:doctor` end-to-end against a temp link dir (symlink + `--version` smoke test, shadow-guard refusal, drift detection, `linked` after linking) and the macOS clipboard image reader end-to-end (`readClipboardImage` decoded a clipboard PNG via the `osascript` fallback).


## [0.7.16] - 2026-06-25
_Bundled skills get a safe installer: `jeo skills sync` materializes the built-in workflow skills into `~/.jeo/skills`, preserving local edits by default, with a CI-friendly `--check` drift report and a `--force` overwrite._

### Added
- **`jeo skills sync` installs and reconciles the bundled workflow skills into `~/.jeo/skills`.** New `syncBundledSkills(dir, { check, force })` (`src/commands/skills.ts`) reconciles the built-in `SKILLS` against a target dir — defaulting to `userSkillsDir()` (`~/.jeo/skills`, honoring `JEO_CONFIG_DIR`/`$HOME`, matching the highest-precedence flat dir in `skillDirs`). Missing skills are installed; a differing local copy is **preserved** by default (gjc `setup defaults` parity) unless `--force` overwrites it. `--check` is a pure drift report that writes nothing and sets a non-zero exit code on drift, so CI can gate on bundled-skill staleness. `--json` emits the structured `SkillSyncResult` (per-skill `status`/`action`, `drift`, `wrote`, `mode`). A new `bundledSkillFileContent` helper (`src/skills/catalog.ts`) defines the canonical on-disk bytes (raw `SKILL.md` when present, decorated render otherwise) shared by `sync` and the existing `--write` path. The `skills` command summary/usage (`src/cli/runner.ts`) and the list footer now advertise the subcommand.

### Verified
- `bun run typecheck` clean; full suite green — 1960 pass / 0 fail across 233 files — including the new `test/skills-sync.test.ts` (fresh install, idempotent re-run, `--check` drift report without writing, default-preserve vs `--force` overwrite, single-file reinstall, non-zero `--check` exit via `JEO_CONFIG_DIR`, and `--json` shape).


## [0.7.15] - 2026-06-25
_Rollback release: the runtime source and test suite are restored to the **0.7.9** state. The intervening 0.7.10–0.7.14 runtime changes (quiet-mode/`-q`, `/resume` transcript rework, `mutatedFiles` plumbing, Ollama `num_ctx`, tmux REPL reaping, and related engine/provider/TUI edits) are reverted. Published as a new version because npm cannot re-issue an existing version number; `latest` now serves code identical to 0.7.9._

### Changed
- **`src/` and `test/` reverted to the v0.7.9 tree.** Every runtime and test file is byte-identical to the `v0.7.9` tag; the post-0.7.9 test `test/mutated-files-artifacts.test.ts` is removed along with the feature it covered.

### Notes
- Release tooling (`scripts/ci-release-build-binaries.ts`, keeping the `bun-darwin-x64-baseline` target for older-CPU compatibility) and documentation history (this CHANGELOG, READMEs) are intentionally **not** rolled back, since they are not part of the user-facing runtime and reverting them would regress binary compatibility or erase the record of what was shipped.

## [0.7.14] - 2026-06-25
_Quieter, cleaner output: a new `-q`/`--quiet` flag strips launch banners and courtesy logs, `/resume` no longer dumps walls of raw escaped JSON into scrollback, and a turn that edits files now reliably surfaces those paths to orchestrators._

### Added
- **`-q`/`--quiet` suppresses startup chrome.** `jeo launch -q` (and one-shot `-p`) skips the welcome box, the "what's new" release notes, the `(plain output)` / resume-hint footers, and the background "session memory distilling" line — so piped, CI, and minimal-terminal runs get just the agent's output instead of the full interactive banner set. The flag is wired through the runner (`-q`/`--quiet` help + launch-only flag set) and `parseFlags`.

### Fixed
- **`/resume` no longer renders a wall of raw escaped JSON.** The transcript formatter extracts an embedded tool call from anywhere in an assistant message (mirroring the engine's own `extractJsonObject`) instead of only when the content begins with `{`, and distinguishes a genuine prose-prefixed call (followed by its `Tool [x] result`) from an illustrative JSON snippet quoted inside prose. Pre-call narration is kept (dimmed) and a leading `"reasoning"` field is surfaced clipped; the raw multi-line edit/write payloads never reach scrollback.
- **A turn that actually edits files now surfaces those paths, fixing the orchestrator "Agent finished but made zero valid code changes (finalArtifacts is empty)" failure.** `runAgentLoop` records every file a turn SUCCESSFULLY writes/edits and returns it as `AgentLoopResult.mutatedFiles` (repo-relative, sorted, de-duped; omitted when nothing mutated). The `task` subagent (`src/agent/task-tool.ts`) and the `team` executor (`src/commands/team.ts`) now derive their change set from this concrete list instead of an out-of-band tool counter, append a "Changed files (N): …" note to the subagent report, and base the parent UNVERIFIED/verify-independently audit on it — so a caller (or an external orchestrator like jeo-claw) collects the run's real code artifacts rather than inferring an empty change set after real edits. `.specify/` is also un-ignored in `.gitignore` so spec/plan artifacts written there are visible to a git-based artifact collector.

## [0.7.9] - 2026-06-24
_Local model providers actually run, and OAuth/login hygiene: Ollama requests now carry an explicit `num_ctx` so jeo's large system prompt no longer overflows Ollama's small default window (the "ollama 모델이 안 돌아간다" blocker), LM Studio reasoning models that emit the whole reply on the reasoning channel are recovered instead of dying empty, GGUF chat templates that can't render the `tools` array are retried with native tools stripped, the OAuth success tab auto-closes with a clear hint, the effective-credential picker prefers a verified OAuth login over a stray API key, and abandoned idle `jeo` tmux REPL sessions are reaped on launch._

### Added
- **Ollama requests send an explicit `num_ctx` so the prompt fits the loaded window.** Ollama loads a model with its small *server* default context (~2048/4096), ignoring the model's advertised `context_length`, unless the request supplies `num_ctx` — so jeo's large system prompt (tool protocol + AGENTS context) overflowed it and every turn died with HTTP 400 "the conversation no longer fits the model's context window." `resolveOllamaNumCtx` (`src/ai/providers/ollama.ts`) now resolves a window with precedence per-call/config → `OLLAMA_NUM_CTX` → `OLLAMA_CONTEXT_LENGTH` → `16384` default (zero/negative/non-numeric ignored) and threads it onto the `/api/chat` `options`. New `ollamaNumCtx` config field (`src/agent/state.ts`, `config-schema.ts`) + `numCtx` `CallOptions` (`src/ai/types.ts`) wired through `model-manager.ts`. The previously-missing `lmstudioBaseUrl` schema key is added too.
- **Stale `jeo` tmux REPL sessions are reaped on launch.** Each detached, long-idle `jeo launch` REPL pins tens of MB forever, so over days they pile up and aggregate RSS climbs. `selectReapableTmuxSessions`/`reapStaleTmuxSessions` (`src/commands/launch/tmux.ts`) sweep only jeo-owned (`@jeo-profile` marker), unattached, long-idle sessions — never the one just created — on each launch; opt out with `JEO_TMUX_REAP=0`. Abandoned REPLs persist their transcript to `.jeo/sessions/` and stay `--resume`-able, so reaping discards only the dead in-memory view.

### Fixed
- **LM Studio reasoning replies on the `reasoning` channel are recovered instead of dying empty.** Local OpenAI-compatible servers (LM Studio, …) running reasoning models routinely emit the WHOLE reply — including the `{"tool":…}` JSON — into `reasoning_content`/`reasoning` while leaving `content` empty, which otherwise died as a "returned no content" turn. The OpenAI adapter now recovers the answer from the reasoning channel (stripping leaked reasoning/tool-call scaffolding) before failing.
- **GGUF chat templates that can't render the `tools` array are retried with native tools stripped.** A jinja template error from passing the `tools` array (a common LM Studio 400) is detected (`isUnsupportedToolsError`) and the call is retried with native tools removed (`stripNativeTools`), falling back to JSON-in-prose tool calling. The strip path deliberately does *not* inject `response_format: json_object` (LM Studio rejects it — only `json_schema`/`text`).
- **The effective-credential picker prefers a verified OAuth login over a stray API key.** `effectiveCredential` (`src/ai/provider-status.ts`) now keeps the user's explicit OAuth login as the working path whenever the bundled adapter serves it end-to-end; an API key only wins for OpenAI OAuth (Codex-only) or an OAuth backend not yet verified end-to-end — mirroring the real call path instead of always letting the API key shadow OAuth.
- **The OAuth success tab auto-closes with a clear "you can close" hint.** The login-complete callback page now shows a 3-second countdown and calls `window.close()` (`src/auth/callback-server.ts`), with an explicit manual-close hint for OS-launched tabs the script can't close, and a clearer "return to the terminal — jeo is ready" message.

### Verified
- `bun run typecheck` clean; full suite green — 1952 pass / 0 fail across 232 files — including the new `test/ollama-num-ctx.test.ts` (`num_ctx` precedence + on-wire send), `test/openai-unsupported-tools.test.ts`, `test/provider-empty-completion.test.ts`, `test/tmux-reap.test.ts`, and updated provider-status/oauth/model-manager suites. Live Ollama probe confirmed: a ~6000-token prompt that returned HTTP 400 under the default window now succeeds with the explicit `num_ctx`.


## [0.7.8] - 2026-06-24
_Long-session performance & resource hygiene: the detached memory-distill worker now always terminates itself (closing the `jeo memory-distill` orphan pileup that pinned each session's transcript in RSS), the live reasoning/output block re-wraps only its trailing window (O(tail) per frame instead of O(len²) over a long stream), the team loop stops reprinting the todo guide every iteration, and the readline caret stays aligned after an image attach._

### Fixed
- **The detached memory-distill worker always terminates itself.** `runMemoryDistillCommand` now wraps its work in `try/finally` and calls an injected `exit` (defaulting to `process.exit`) on every path — success, broken payload, and missing payload. `distillSessionMemory` caps the LLM call with a `Promise.race` timeout, but the race only *rejects*; it never aborts the underlying fetch, so a stalled provider socket kept the child's event loop alive and the `jeo memory-distill` worker lingered forever — one orphan per session, each pinning the full transcript in RSS (the observed "jeo bun" CPU/memory creep). An explicit exit closes the socket and reclaims the process.
- **The live reasoning/output block re-wraps only its trailing window.** The wrap memo in `app.ts` keyed on the full (up-to-hundreds-of-KB) buffer, so every 120 ms tick and every stream delta copied + compared the whole growing string — O(len) per frame, O(len²) over a long reasoning/tool stream (the streaming slowdown). `liveBlockWrapKey` now slices the ≤16 KB tail first, then keys + wraps that: identical visible output, O(tail) per frame regardless of total size.
- **The team loop no longer reprints the todo guide every iteration.** `runTeamEngine` printed `formatRalphTodoGuide` once per task — O(N²) lines that climbed the embedded-terminal renderer's CPU on a long task list. The guide prints once up front; per-task progress lines carry the rest.
- **The readline caret stays aligned after an image attach.** Both the paste and Ctrl+V image-attach paths now call readline's internal `_refreshLine()` after swapping the `[image #n]` tag in (mirroring the slash/tab-completion accept paths), so the stale row/cursor model no longer offsets the real caret several columns on the next keystroke.

### Verified
- `bun run typecheck` clean; full suite green — 1914 pass / 0 fail across 229 files — including the new `runMemoryDistillCommand` always-exits assertions (success + no-payload paths) and the `liveBlockWrapKey` bounded-key / tail-collision tests.


## [0.7.7] - 2026-06-23
_Long-running-process hygiene & input robustness: backgrounded grandchildren (`next dev &`, daemons) are now reaped at the turn boundary via per-command process groups — closing the climbing `next-server` RSS leak — while the prompt gains recursive fuzzy `@path` search, ANSI-safe and idle-merged bracketed paste, a configurable OSC 52 clipboard cap, per-role ralplan model routing, and leaked-reasoning-tag stripping on salvaged answers._

### Added
- **Process-group reaper for backgrounded subprocesses (`src/agent/process-reaper.ts`).** `bashTool` now spawns each command as its own process-group leader (`Bun.spawn` `detached:true` on POSIX), so a backgrounded grandchild — `npm run dev &`, `next dev &`, a daemon, `nohup …` — joins that group and the whole subtree is reaped with a single `process.kill(-pgid)` at the turn boundary, **without ever touching jeo's own group**. This closes the leak where a reparented `next-server` survived every turn and the resident set climbed monotonically across a session. Reaping is precise (only groups jeo spawned, never a name-based `pkill`), O(1) (one group signal, no process-table scan), and deterministic (closed at the exact turn that creates it). A `unref`'d periodic sweep is a belt-and-suspenders net for turns that abort before cleanup; opt out with `JEO_KEEP_BACKGROUND=1`, tune the sweep with `JEO_REAP_INTERVAL_MS`.
- **Recursive fuzzy `@path` mention search (`src/commands/launch/mentions.ts`).** A bare `@frag` now walks the project tree (bounded by depth/scan/result caps, skipping `node_modules`/`.git`/build/VCS dirs) and ranks hits basename-prefix → substring → subsequence, then shallowest/shortest/alphabetical; a `@dir/` prefix lists that single directory. Autocomplete returns the matcher's pool as-is instead of re-filtering by strict prefix.

### Changed
- **ralplan draft passes route to their per-role configured model.** `runRalplanEngine` now resolves `planner`/`architect`/`critic` subagent models from config and threads each through `callRole`, so the Planner/Architect/Critic drafting + revision calls use their own model; the consensus critic gate continues to resolve its model independently.
- **OSC 52 clipboard copy exposes a configurable size cap and honest skip signal.** `copyTextToClipboard` reads `JEO_OSC52_MAX` for the base64 payload cap and returns `osc52SkippedTooLarge` when the remote (SSH/tmux) clipboard was skipped for an oversized payload, so the caller can warn instead of silently dropping the remote path; tmux DCS passthrough wrapping is documented.

### Fixed
- **Salvaged answers and `done` reasons strip leaked reasoning/tool-call markup.** `stripLeakedReasoningTags` (`src/ai/think-tags.ts`) removes `<think>…</think>` blocks, an unmatched `</think>` reasoning prefix, stray `<tool_call>`/`<parameter>`/`antml:*` scaffolding, and Harmony `<|channel|>` markers from a model's final visible text, so API-entered models that emit inline scaffolding no longer surface raw tags in the salvaged prose answer or the `done` reason.
- **Bracketed paste is ANSI-safe and idle-merged.** Pasted ANSI-colored terminal output is stripped of escape sequences and stray C0 control bytes across every paste path (`stripPasteEscapes`/`pasteEscapeLength`) so it no longer corrupts the input box; a partial paste marker split across stdin chunks is carried (`pasteMarkerTailLength`/`endsInPaste`); and the dropped-end-marker fallback is now **idle-based** (`pasteIdleDecision`, 250ms since the last buffered line) so a large paste streaming in over >250ms is never cut mid-paste.

### Verified
- `bun run typecheck` clean; touched suites pass — `test/process-reaper.test.ts`, `test/ralplan-draft-model.test.ts`, `test/prompt-key-filter.test.ts`, `test/launch-mentions.test.ts`, `test/clipboard.test.ts`, `test/think-tags.test.ts`, `test/engine-salvage.test.ts` (90 pass / 0 fail) covering group-kill target selection, alive/grace-window reaping, recursive fuzzy mention ranking, escaped-pipe-free paste sanitizing + partial-marker carry + idle merge, the OSC 52 cap/skip signal, per-role ralplan routing, and leaked-tag stripping on salvaged output.

## [0.7.6] - 2026-06-23
_Release & docs plumbing: the running version's release notes now travel inside the `--compile` single binary (so `/whats-new` works offline and from a global install), the in-TUI markdown table renderer stops splitting on escaped `\|` pipes, and the release pipeline gains a cross-compiled standalone-binary matrix — macOS/Linux **plus a first-class Windows x64 `.exe`** — built on one Linux runner and auto-attached to each GitHub release._

### Added
- **Cross-target standalone-binary release matrix (incl. Windows `.exe`).** New `scripts/ci-release-build-binaries.ts` compiles `src/cli.ts` for every release target via Bun's `--compile --target bun-<triple>`; since jeo has no native addons/workers, all targets (`darwin-arm64`/`-x64`, `linux-x64`/`-arm64`, `win32-x64`) cross-compile from a single Linux runner. Driven by `bun run build:binaries` / `build:win` (new `package.json` scripts) with `--targets <ids|all>`, `RELEASE_TARGETS` env, and `--dry-run` support. A new `release-binaries` job in `.github/workflows/npm-publish.yml` builds the full matrix, uploads them as a workflow artifact, and on a `release` event runs `gh release upload <tag> dist/jeo-* --clobber` to attach them.

### Changed
- **The running version's CHANGELOG is embedded into the compiled binary.** `loadBundledChangelog` (in `src/util/whats-new.ts`) now imports `CHANGELOG.md` with `{ type: "text" }`, so the release notes ship inside the `bun build --compile` single binary — where `import.meta.dir` resolves to the bunfs virtual root and the old two-levels-up on-disk path does not exist. The on-disk read remains as a dev fallback only when the embed is empty.

### Fixed
- **The in-TUI markdown table renderer no longer breaks a cell on an escaped `\|`.** `markdown-table.ts` now distinguishes a real cell separator from a literal pipe: `hasUnescapedPipe` drives row detection, `splitCells` walks the row character-by-character (turning `\|` into a literal `|` inside the cell instead of a column break and never stripping an escaped trailing pipe), and `isDelimiterRow` reuses that same escape-aware split. A table whose cells contain `\|` now renders with the correct column count.

### Verified
- `bun run typecheck` clean; the touched suites pass — `test/markdown-table.test.ts` and `test/release-binaries.test.ts` (14 pass / 0 fail) cover escaped-pipe cell splitting/delimiter detection, the Windows `.exe` target shape, `--targets`/env/`all` resolution, the per-target compile invocation, and the workflow's build+upload of every target.


## [0.7.5] - 2026-06-23
_Startup & loop latency: redundant re-reads that fired on every subagent spawn and every loop step are now memoized behind cheap `stat`-signature caches, so cold paths stay correct (edits/deletes still picked up immediately) while warm paths skip the disk and the re-parse. Targets the per-turn and per-spawn overhead that dominates perceived slowness in team/ralph/autopilot fan-outs._

### Changed
- **Project-context guidance files are cached by `mtimeMs:size` signature instead of re-read every spawn.** `readContextFile` (in `src/agent/context-files.ts`) now keeps a 256-entry LRU of raw file text keyed by a stat signature. The cheap `fs.stat` still runs every call, so an edit (new mtime/size) or deletion is caught immediately; truncation is reapplied per call from the raw text, so a differing budget never pollutes the cache. `loadProjectContext` runs once per subagent spawn (team/ralph/autopilot), so this removes the bulk of repeated AGENTS.md/guidance reads.
- **OKF memory concepts are parse-cached per file under the same stat-signature scheme.** `loadConcepts` (in `src/agent/memory.ts`) walks `.jeo/memory/` and parses every concept file; the new 256-entry cache skips the read+parse for unchanged files. The directory walk and per-file `stat` still run (new files appear, deleted files drop out), and every write path (`migrateLegacyMemory`, both `distillSessionMemory` branches) calls `invalidateConceptCache()` so a freshly written concept is never served stale.
- **Native tool schemas are derived once per turn, not rebuilt every step.** `runAgentLoop` (in `src/agent/engine.ts`) hoists `nativeToolSchemasFor(...)` out of the step loop since the active toolset is constant for the whole turn, eliminating a per-step list rebuild/reallocation.
- **Autopilot keeps the running `best` score in memory across iterations.** `cmdLoop` (in `src/autopilot.ts`) seeds `best` from `currentBest(s)` once and folds each kept step forward via the new exported `foldBest(goal, best, score)` helper, instead of re-reading and re-parsing the entire append-only log on every step. `foldBest` mirrors `currentBest`'s reduction exactly (NaN never becomes best; `min`/`max`/last-value semantics by goal) so the in-memory value can never diverge from a fresh log re-scan.

### Verified
- `bun run typecheck` clean; the touched suites pass — `test/context-files.test.ts`, `test/memory-distill-okf.test.ts`, and `test/autopilot-engine.test.ts` (43 pass / 0 fail) exercise cache hits, post-edit/post-delete invalidation, and `foldBest`/`currentBest` parity.

## [0.7.4] - 2026-06-22
_Per-session model isolation + REPL slash-handler testability: a running `jeo` session now pins the model it resolved at start, so a concurrent session running `/model` (which persists the global default) can no longer silently switch a different live session's model mid-run. The read-only code-inspection slashes (`/view`, `/diff`, `/find`, `/search`), the `/undo` git slash, and the `/history` view are extracted into pure, PTY-free handlers so their logic is unit-tested directly instead of buried in the REPL loop._

### Fixed
- **Per-session model selection no longer leaks between concurrent sessions.** The per-turn model now falls back to the model resolved at THIS session's start (a frozen snapshot) instead of re-reading the live global `defaultModel`. Previously a second `jeo` session running `/model` persisted the global default (`rememberModelPatch`), and the first session's next turn would silently pick up that write mid-run. Running sessions are now model-isolated — they never influence each other.

### Changed
- **Read-only code-inspection slash handlers are extracted into a pure module.** `/view`, `/diff`, `/find`, and `/search` move to `src/commands/launch/code-slash.ts` as self-contained async functions that take the raw input + cwd (and theme, for `/diff`) and return the lines to print — no closure-bound side effects. The REPL dispatch is now a thin `for (const line of await handle…) console.log(line)` adapter.
- **The `/undo` git slash and `/history` view are extracted for direct testing.** `handleUndoSlash` (in `src/commands/launch/git-slash.ts`) keeps its guard rail — it refuses any commit lacking the `[jeo] auto-commit:` prefix and any non-git tree — verifiable against a throwaway repo. `historyViewLines` (in `src/commands/launch/slash-views.ts`) makes the `/history [N|all]` banner/separator math and turn-count parsing pure over the in-memory transcript + terminal width.

### Verified
- `bun run typecheck` clean; full suite **1848 pass / 0 fail** (225 files), including the new `test/launch-code-slash.test.ts`, `test/launch-git-slash.test.ts`, and `test/session-model-isolation.test.ts`, plus expanded `test/launch-slash-views.test.ts` (`/history`) and `test/tui-welcome.test.ts` (banner width tracks cols across a resize).


## [0.7.3] - 2026-06-22
_Provider catalog: the Tencent Cloud MaaS (international) `knownModels` list is broadened from a 4-id DeepSeek/MiniMax set to the full live-verified line-up across five families — DeepSeek, MiniMax, Zhipu GLM, Moonshot Kimi, and Hunyuan. Because the host exposes no `/v1/models` route, this hand-maintained list is the model picker's source of truth for the offline fallback._

### Changed
- **Expanded the Tencent Cloud MaaS catalog to the full live-verified model line-up.** `OPENAI_COMPAT_PROVIDERS` (in `src/ai/providers/openai-compatible-catalog.ts`) now lists the complete Tencent `tokenhub-intl` set across five families — DeepSeek (`deepseek-v4-pro`, `deepseek-v4-pro-202606`, `deepseek-v4-flash`, `deepseek-v4-flash-202605`, `deepseek-v3.2`), MiniMax (`minimax-m3`, `minimax-m2.7`, `minimax-m2.5`), Zhipu GLM (`glm-5.2`, `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-5v-turbo`), Moonshot Kimi (`kimi-k2.6`, `kimi-k2.5`), and Hunyuan (`hy-mt2-plus`) — all served over the Anthropic Messages wire format and each verified live (2026-06) via `/v1/messages` probes (a completion or `FREE_QUOTA_EXHAUSTED` both prove the id is recognized). Since the host has no `/v1/models` route, this list is the picker's source of truth for the offline fallback.

### Verified
- `bun run typecheck` clean; full suite **1826 pass / 0 fail** (222 files), including `test/tencent-provider.test.ts` (provider registration, id routing, reasoning catalogue, discovery endpoint).


## [0.7.2] - 2026-06-22
_Workflow honesty + prompt-input testability: `ultragoal` acceptance criteria can now carry a trailing `{verify: <command>}` directive that makes a criterion **individually** provable (real PASS/FAIL instead of a blanket UNVERIFIED on a green suite), with a SUCCESS / PARTIAL / SUITE_GREEN / FAILED status taxonomy; the boxed prompt's full stdin→readline keystroke rewriter is extracted into a pure, PTY-free function so the "↓ cuts the lower text" fix and the rest of the wiring are unit-tested directly. Verified leak-free (`mem-probe`, 2000 turns, exit 0) with a fresh `jeo --tmux` boot battery (6/6)._

### Added
- **Per-criterion `{verify: <command>}` directive for `ultragoal`.** An acceptance criterion authored with a trailing `{verify: <shell command>}` is now INDIVIDUALLY verifiable — `parseCriterion` (in `src/agent/seed.ts`) splits the directive off the criterion text (round-tripping unmangled through the seed's JSON-encoded list), and `ultragoal` runs that command and records a real PASS/FAIL in the ledger. Criteria without a directive stay UNVERIFIED on a green suite (honest by default, strengthenable on demand). The overall report now uses a status taxonomy: **FAILED** (suite red OR any checked criterion failed), **SUCCESS** (every criterion individually verified and passed), **PARTIAL** (some verified, others still unverified), and **SUITE_GREEN** (green suite, nothing individually proven). The verdict (`ok`) now reflects `status !== "FAILED"` rather than the raw suite result.

### Changed
- **The boxed prompt's stdin→readline byte rewriter is extracted into a pure function.** `filterPromptInputChunk` (in `src/commands/launch/input.ts`) now holds the FULL keystroke wiring — bracketed-paste folding across chunks, mouse/terminal-report swallowing, Shift+Enter → hard-break SENTINEL, combo-key normalization, and the boundary-aware Up/Down box navigation — so it is testable WITHOUT a live readline/PTY. `launch.ts`'s live handler is now a thin adapter over it, eliminating the duplicated decision logic that previously diverged from its `boxVerticalNavAction` helper.

### Fixed
- **The "↓ cuts the lower text" multi-line draft regression is now covered by direct byte-stream tests.** A new `test/prompt-key-filter.test.ts` (16 cases) drives raw escape sequences through `filterPromptInputChunk` exactly as the live `kfDataHandler` does — asserting which bytes reach readline and how the caret/paste state mutate — the closest automated stand-in for live-terminal verification of the box-navigation fix shipped in 0.7.1.

### Verified
- `bun run typecheck` clean; full suite **1826 pass / 0 fail** (222 files).
- `scripts/mem-probe.ts` (2000 turns × 40 tools): no long-term leak (exit 0; settled heap floor flat at ~4.3 MB, net +0.49 MB, exit-listeners flat at 1).
- `scripts/tmux-verify.sh battery`: **6/6 PASSED** on a fresh `jeo --tmux` boot (boot, `/help`, unknown `$skill`, `/agents`, `$ultragoal`, unresolved `/command`).

## [0.7.1] - 2026-06-22
_TUI polish + provider breadth: the live forge-card border and forge mark now flow in the **active theme's** own neon palette instead of a fixed brand gradient, the boxed prompt's Up/Down keys no longer wipe a multi-line draft at its top/bottom edge, the Tencent Cloud MaaS catalog gains the live-verified DeepSeek/MiniMax/GLM model families (with catalog backfill for providers that expose no models-list endpoint), and the `jeo --tmux` smoke check drops a false-positive launcher-log grep. Verified leak-free (`mem-probe`, 2000 turns, exit 0) with a fresh `jeo --tmux` boot battery (6/6)._

### Added
- **Theme-derived forge flow palette.** `themeFlowPalette(theme)` builds a 3-stop neon palette (`accentShadow → accent → brightest stage-gradient end`) from the active TUI theme; the animated forge-card border and the forge mark now sweep the theme's own glow instead of the fixed brand `FORGE_FLOW_PALETTE`. Colorless/`mono` themes collapse to a single accent stop (the animation is already gated on color/TrueColor).
- **Expanded Tencent Cloud MaaS catalog.** Added live-verified model ids across DeepSeek (`deepseek-v4-pro`/`-202606`, `deepseek-v4-flash`/`-202605`, `deepseek-v3.2`), MiniMax (`minimax-m3`/`-m2.7`/`-m2.5`), and Zhipu GLM (`glm-5.2`/`5.1`/`5`). Ids were confirmed against live `/v1/messages` probes (the host exposes no `/v1/models` route).

### Fixed
- **The boxed prompt's Up/Down keys no longer wipe a multi-line draft at its edges.** A new `boxVerticalNavAction` classifier returns `move` (a visual row exists → reposition the caret), `swallow` (no row AND a genuine multi-line draft → keep the keystroke inside the box, since falling through to readline would recall input history and erase the draft — the "↓ cuts the lower text" bug), or `history` (no row on a soft-wrapped single line → fall through so ↑/↓ recall history at the edges).
- **Model-picker no longer pins API-key providers to a bare default when the models-list endpoint is absent.** `catalogOr` now backfills the static capability catalog for OAuth sources *and* for API-key providers whose models endpoint returns HTTP 404 (e.g. Tencent MaaS), so the picker shows the full known model set instead of a single default.
- **`scripts/tmux-verify.sh smoke` no longer false-fails on the benign non-TTY attach.** The launcher-log grep was pure false-positive surface (it re-flagged the harmless `not a terminal` attach message); a real pre-handoff crash already fails via the session-start timeout and a post-handoff crash shows in the captured frame, so the rendered frame is the authoritative signal.

### Verified
- `bun run typecheck` clean; full suite **1806 pass / 0 fail** (221 files).
- `scripts/mem-probe.ts` (2000 turns × 40 tools): no long-term leak (exit 0; settled heap floor flat at ~4.3 MB, exit-listeners flat at 1).
- `scripts/tmux-verify.sh battery`: **6/6 PASSED** on a fresh `jeo --tmux` boot (boot, `/help`, unknown `$skill`, `/agents`, `$ultragoal`, unresolved `/command`).

## [0.7.0] - 2026-06-22
_Adds an opt-in, fail-closed **computer-use** capability (a `computer` tool + `jeo computer` CLI for screenshot/click/type/keypress/scroll/drag/wait/batch), hardens the spec-first workflow against silent post-consensus plan edits and PID-reuse lock starvation, makes OAuth refresh degrade cleanly when the refresh token is dead, and teaches tool-arg JSON repair to tolerate unescaped control characters. Verified leak-free (`mem-probe`, 2000 turns, −447 bytes/turn slope) with a fresh `jeo --tmux` boot battery (6/6)._

### Added
- **Computer-use (opt-in, disabled by default).** A new `computer` agent tool and `jeo computer <action>` CLI execute desktop automation — `screenshot`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`, `wait`, and `batch` — via native OS tools (`screencapture`/`scrot`, `cliclick`/`xdotool`). It is gated behind `computer.enabled: true` in `~/.jeo/config.json` (off unless explicitly enabled) and a **fail-closed `ComputerSupervisor`**: side-effecting actions are blocked unless a live kill switch, a fresh heartbeat, and a non-suspended state all hold; read-only `screenshot`/`wait` are allowed. A new mid-turn **`Ctrl+\` kill switch** binding lets the operator suspend automation instantly, and every action is appended to `.jeo/computer-audit.jsonl`.
- **Tencent Cloud MaaS provider** (`tencent`, `TENCENT_API_KEY`), served over the Anthropic Messages wire format (`deepseek-v4-pro`/`-flash`, `minimax-m3`).

### Fixed
- **A plan can no longer be silently edited after the consensus critic's `[OKAY]` verdict (round-13).** `ralplan` now records a SHA-256 `consensus_hash` of the exact plan content the critic gated; `jeo approve` and `jeo team` recompute the on-disk plan's hash and refuse to proceed if it differs, directing the operator to re-run `ralplan` for a fresh review. A schema-valid post-verdict edit can no longer ride through approval/execution unreviewed.
- **The team/ultragoal run-lock no longer starves on PID reuse (round-13).** `process.kill(pid, 0)` alone treats a recycled dead pid as "alive" forever; the holder now heartbeats the lock's `at` timestamp on an unref'd interval and a contender treats the lock as stale when the pid is dead **or** the timestamp is older than a TTL (`JEO_RUN_LOCK_TTL_MS`, default 60s).
- **A dead OAuth refresh token now degrades cleanly instead of looping on a doomed refresh.** `refreshOAuthToken` classifies a refresh failure as *definitive* (`invalid_grant`/revoked/401-403) vs *transient* (timeout/network); a definitive failure clears the credential and falls back to an API key (or a logged-out state that prompts re-login), while a transient blip leaves the stale token untouched for the next sweep.
- **Tool-argument JSON repair now tolerates unescaped control characters.** A model that emits a literal newline/tab inside a string value (a frequent slip when an `edit`/`write` payload carries multi-line code) previously made the whole tool call unparseable; `tryParse` now layers a control-char escaper with the existing trailing-comma repair, never altering already-valid JSON.
- **A background crash no longer leaves the shell mute.** `src/cli.ts` installs `uncaughtException`/`unhandledRejection` handlers that synchronously restore the terminal (raw mode, bracketed paste) via a new `restoreTerminalState()` and print one clean error line instead of a raw stack dump over a broken REPL.
- Anthropic streaming now captures `stop_reason` from `message_start`.

### Changed
- **Memory and prompts now preserve failed approaches.** OKF memory gains a `FailedAttempt` concept type (one dead-end + its cause per entry), compaction is told to retain tried-and-failed approaches and unconfirmed hypotheses, and the executor/loop prompts add a reflect-on-failure directive ("state what the failure taught you, then change the tool/arguments"), a running task-state instruction, and an explicit "a passing test is not a met requirement" guard.

### Verified
- `bun run typecheck` clean; full suite **1798 pass / 0 fail** (221 files), including the new `computer`, `computer-supervisor`, `terminal-restore`, and `tencent-provider` suites plus consensus-hash and refresh-classification coverage.
- `scripts/mem-probe.ts` (2000 turns × 40 tools): no long-term leak (per-turn slope **−447 bytes/turn**, exit-listeners flat at 1, heap returns to baseline).
- `scripts/tmux-verify.sh battery`: **6/6 PASSED** on a fresh `jeo --tmux` boot (boot, `/help`, unknown `$skill`, `/agents`, `$ultragoal`, unresolved `/command`).

## [0.6.41] - 2026-06-21
_The non-streaming model path now inherits the v0.6.40 300s window: an unattended long-reasoning turn (compaction, ralplan, deep-interview, memory distill, goal-verify, subagent/autopilot steps) is no longer false-aborted at the old 120s wall cap. Re-verified leak-free (`mem-probe`, 2000 turns, −610 bytes/turn slope) with a fresh `jeo --tmux` boot battery (6/6)._

### Fixed
- **The non-streaming `call()` path no longer false-aborts a long completion at 120s — it now matches the 300s streaming idle window.** v0.6.40's wire heartbeat only re-armed the streaming watchdog (`manager.stream()`); the non-streaming twin `manager.call()` — taken by every `callLlm` WITHOUT an `onToken` consumer (`compaction`, `ralplan`, `deep-interview`, `memory` distill, `goal-verifier`, and subagent/autopilot engine steps) — kept a hard 120s wall cap, so the exact unattended long-reasoning turns the release meant to protect still aborted, exhausted the attempt budget, and stopped the turn. The cap is now 300s, matching `STREAM_IDLE_TIMEOUT_MS`, via a new env-overridable `callTimeoutMs()` helper (`JEO_CALL_TIMEOUT_MS`) mirroring the existing `streamIdleMs()`. A wire heartbeat can't help here — the path collects an opaque buffered body with no per-chunk signal — so a wall clock is the only correct lever; non-streaming `readSse` sites and `call()`'s buffered reads are deliberately left without an idle watchdog (it would false-abort a healthy opaque read).

### Verified
- `bun run typecheck` clean; full suite **1756 pass / 0 fail** (216 files), including the new `callTimeoutMs` default + `JEO_CALL_TIMEOUT_MS` override parsing tests in `test/round-b.test.ts`.
- `scripts/mem-probe.ts` (2000 turns × 40 tools): no long-term leak (per-turn slope **−610 bytes/turn**, exit-listeners flat at 1, heap returns to baseline).
- `scripts/tmux-verify.sh battery`: **6/6 PASSED** on a fresh `jeo --tmux` boot (boot, `/help`, unknown `$skill`, `/agents`, `$ultragoal`, unresolved `/command`).

## [0.6.40] - 2026-06-21
_Wire-level stream heartbeat: ANY bytes from the provider (SSE keepalive/ping, filtered events) now re-arm the idle watchdog — a connected-but-quiet stream can no longer trip a false `stream idle` retry. Default idle window raised to 300s so Ollama/llama.cpp model-load silence no longer exhausts retries and stops the turn._

### Fixed
- **A connected-but-quiet stream no longer trips a false `stream idle for <ms>ms (no chunk)` retry — wire-level heartbeat.** The v0.6.39 fix only counted reasoning/thinking deltas as activity, so a model that reasons server-side and streams NO thought tokens (only SSE keepalive/`ping` events, e.g. Anthropic `event: ping`, or events that never become a chunk) still looked stalled and got aborted+retried past the idle window. The SSE reader (`readLines`/`readSse`) now fires an `onStreamActivity` heartbeat on ANY bytes received from the provider — including keepalive comments and events filtered out before becoming a chunk or reasoning delta — threaded through every provider (`anthropic`, `openai`, `openai-responses`, `gemini`, `antigravity`, `ollama`). The idle watchdog re-arms while ANY wire activity advances and aborts only a genuinely dead socket (zero bytes for the idle window).
- **The default stream-idle window is now 300s (was 120s) so a silent local backend no longer false-aborts and stops the turn.** Root cause of the recurring `stream idle … (no chunk)` halt for local/slow providers: a backend like Ollama / llama.cpp emits ZERO bytes (no keepalive) during model load + prompt-eval before the first token, which on modest hardware or a large context routinely exceeds 120s — the wire heartbeat has nothing to fire on, the watchdog aborts an alive-but-quiet generation, each retry re-incurs the same slow first byte, the attempt budget exhausts, and the turn stops. The cap now only bites a genuinely dead stream after 5 minutes; `JEO_STREAM_IDLE_MS` overrides it and Ctrl-C remains the interactive escape.

## [0.6.39] - 2026-06-21
_A long "thinking" phase no longer trips a false stream-idle retry: reasoning/thinking deltas now act as a stream heartbeat, so a model that streams thought tokens past the idle window before any visible text is no longer mistaken for a stalled stream and retried (which discarded the in-progress reasoning). Re-verified leak-free (`mem-probe`, 2000 turns, −525 bytes/turn slope) with a fresh `jeo --tmux` boot battery (6/6)._

### Fixed
- **A long "thinking" phase no longer trips a false `stream idle for <ms>ms (no chunk)` retry.** Reasoning/thinking deltas are routed to `onReasoning` and never yielded as a stream chunk, so a model that streams thought tokens for longer than the idle window (default 120s) before emitting visible text looked stalled and got retried — discarding the in-progress reasoning. The per-chunk idle watchdog now treats reasoning activity as a heartbeat (`lastActivityAt`) and re-arms while thinking is actively streaming; it aborts only a genuinely silent stream. The `JEO_STREAM_IDLE_MS` override still covers models that reason fully server-side and stream no thought tokens at all.

### Verified
- `bun run typecheck` clean; full suite **1752 pass / 0 fail** (216 files), including the new `retryableStream` reasoning-heartbeat tests in `test/round-b.test.ts` (a silent-but-thinking stream stays alive; the watchdog still fires once reasoning activity stops).
- `scripts/mem-probe.ts` (2000 turns × 40 tools): no long-term leak (per-turn slope **−525 bytes/turn**, exit-listeners flat at 1, heap returns to baseline).
- `scripts/tmux-verify.sh battery`: **6/6 PASSED** on a fresh `jeo --tmux` boot (boot, `/help`, unknown `$skill`, `/agents`, `$ultragoal`, unresolved `/command`).

## [0.6.38] - 2026-06-21
_The OKF concept-bundle memory no longer silently drops what it learns: a legacy single-doc `MEMORY.md` (or a text-only distill fallback) can no longer shadow the concept bundle, break OKF conformance, or lose a turn's learnings — its content is folded into the concept merge and the stale blob is archived. Re-verified leak-free (`mem-probe`, 2000 turns, −570 bytes/turn slope) with a fresh `jeo --tmux` boot battery (6/6)._

### Fixed
- **A text-only distill fallback no longer loses the turn's learnings.** When the model returns no extractable JSON, `distillSessionMemory` used to write the raw text to a single-doc `MEMORY.md` blob — but `memoryPromptSection` injects that blob ONLY when the concept bundle is empty (concepts always win), so once any concept existed the fallback's learnings were recorded yet never injected. Now, if a concept bundle already exists, the dead blob is suppressed and the prior concepts are kept as the durable memory (`skipped: "distill produced no JSON; kept existing concept bundle (legacy blob suppressed)"`).
- **A lingering legacy `MEMORY.md` can no longer break OKF conformance.** A frontmatter-less single-doc `MEMORY.md` coexisting with the concept bundle made `validateBundle` non-conformant (`error: concept document missing YAML frontmatter block`) while the loader silently skipped it — an inconsistency that left the bundle permanently invalid (`migrateLegacyMemory` only runs on the explicit `jeo memory-migrate`). Distill now feeds the legacy doc's content into the concept-merge context so its learnings are absorbed, then archives it to `MEMORY.md.bak` on a successful JSON distill — off the active read path, with rollback preserved.
- **Concept enumeration skips non-concept blobs.** `existingConcepts` now skips any `.md` without YAML frontmatter, so a stray `MEMORY.md` can never be mis-parsed as a concept during the merge.

### Changed
- **Distill prompt enforces concept granularity.** The merge prompt now forbids a catch-all "Project Memory Bundle" mega-concept and instructs one concept per distinct fact/command/gotcha/preference, so the bundle grows as discrete, cross-linkable concepts.
- **Per-session injection budget raised** from 3,000 to 5,000 chars (`MEMORY_INJECT_MAX_CHARS`) so a healthy multi-concept bundle is injected in full.

### Verified
- `bun run typecheck` clean; full suite `1751 pass / 0 fail` (216 files).
- Memory/OKF suites `57 pass / 0 fail` across `memory`, `memory-okf`, `memory-distill-okf`, `memory-migration-okf`, `memory-search-okf`, `memory-graph-okf`.
- Live bundle proof: `validateBundle` flips `false (error: MEMORY.md)` → `true (no issues)` after the legacy archive, injection block intact (3,220 chars); bundle now holds discrete facts/commands/gotchas/preferences concepts + a valid `index.md`.
- `scripts/mem-probe.ts` (2000 turns × 40 tools) reports no long-term leak (−570 bytes/turn, exit-listeners flat at 1); `scripts/tmux-verify.sh battery` passes 6/6 on a fresh `jeo --tmux` boot.


## [0.6.37] - 2026-06-20
_Two dead-end fixes: the boxed prompt's ↑/↓ now recalls input history on a soft-wrapped one-liner (only a genuine multi-line draft gets in-box caret nav), and every terminating Spec-first stage (deep-interview, ralplan, team) now surfaces a user-visible answer instead of silently stalling — re-verified leak-free (`mem-probe`) with a fresh `jeo --tmux` boot._

### Fixed
- **The boxed prompt's ↑/↓ recalls input history again on a soft-wrapped line.** A long single line that the box wraps to several visual rows is no longer treated as multi-line: ↑/↓ fall through to readline's history recall (the dominant REPL expectation) instead of dragging the wrapped tail up a visual row. In-box vertical caret nav (textarea feel) is now gated behind a GENUINE multi-line draft — one carrying an explicit Shift+Enter / pasted break, stored as the private-use `MULTILINE_SENTINEL` — and still yields the arrows to an open slash list or the Ctrl+O history panel. New `isGenuineMultilineDraft` / `shouldBoxVerticalNav` helpers make the gate unit-testable independent of the live readline/PTY wiring.
- **Every terminating Spec-first workflow stage now surfaces a user-visible answer.** Three stages could previously reach a terminal state with no message explaining the outcome:
  - **`team`** routes all subagent output through the engine `log()`/`io.output` sink (zero raw `console.log` in `executeTaskWithAgent`) and prints a `<role> report:` header followed by every line of the subagent's reason on success.
  - **`deep-interview`** gates its `[Handoff Ready]` / `onProgress(complete)` signal on a real frozen seed: `freezeSeed` now returns `Promise<boolean>`, and a freeze failure emits `[HOLD]` and keeps the interview open instead of falsely claiming the requirement is crystallized.
  - **`ralplan`** reports a discarded revision: an invalid `[ITERATE]` revision now logs `discarding the revision; the [ITERATE] verdict stands` instead of silently surfacing the stale verdict.

### Verified
- `scripts/mem-probe.ts` (2000 LaunchTui turns) shows a flat post-GC heap — per-turn slope **−556 bytes/turn**, returning to its settled floor — with a single `exit` listener and zero `process` SIGINT/listener accumulation; `scripts/tmux-verify.sh smoke` boots `jeo --tmux` to a clean input box + model bar (EXIT 0). `bun run typecheck` is clean and `bun test` is **1751 pass / 0 fail** across 216 files, including the new `test/box-vertical-nav.test.ts` and the no-answer-deadend targeted suite (`team-run`/`team-schema`/`team-subagent`/`deep-interview`/`deep-interview-noninteractive`/`workflow-integrity`/`approve`/`parse-role-gate-verdict` → 71 pass / 0 fail).


## [0.6.36] - 2026-06-20
_When `jeo --tmux` flips the mouse on so you can drag-select, the drag now actually lands on the system clipboard — the in-session tmux profile sets `set-clipboard on` + a local `copy-command` on the CURRENT session only — plus `/help` documents the drag-to-copy and the Shift/Option-drag escape hatch, re-verified leak-free (`mem-probe`) with a fresh `jeo --tmux` boot._

### Fixed
- **A `--tmux` mouse drag-select now reaches the system clipboard instead of vanishing.** Turning the mouse on (so on-screen text can be selected) re-routes a drag into tmux copy-mode, where the selection used to die inside tmux's own buffer — `cmd/ctrl+v` got nothing. The launch path now applies the same clipboard repair to the CURRENT session that `tmuxProfileCommands` applies to jeo-owned sessions: new `currentTmuxClipboardCommands(env, deps)` emits `set-option set-clipboard on` (lets the copy-mode selection escape via OSC 52) and, when a local clipboard tool is on PATH, `set-option copy-command <tool>` (pipes the drag-select straight to `pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip` for terminals that don't honor OSC 52). Both are written **session-locally — never `-t` or `-g`** — so the user's other tmux sessions are untouched; `JEO_TMUX_PROFILE=0` opts out, and `copy-command` is skipped when no tool is found.

### Changed
- **`/help` documents the drag-to-copy behavior and its escape hatch.** Two hotkey rows now explain that a drag selects on-screen text (copies on `cmd/ctrl+c`, and auto-copies to the system clipboard under `--tmux`) and that **Shift-drag** (iTerm/macOS: **Option-drag**) forces the terminal's own selection when tmux owns the mouse.

### Verified
- `scripts/mem-probe.ts` (2000 LaunchTui turns) shows a flat post-GC heap — per-turn slope **−541 bytes/turn**, returning to its settled floor — with zero `process` SIGINT/listener accumulation; `scripts/tmux-verify.sh smoke` boots `jeo --tmux` to a clean input box + model bar (EXIT 0). `bun run typecheck` clean and `bun test` **1748 pass / 0 fail** across 215 files, including the new `currentTmuxClipboardCommands` session-local / no-tool / opt-out cases in `test/tmux.test.ts`.


## [0.6.35] - 2026-06-20
_The prompt's Ctrl+C now clears a non-empty input box on the first press and only exits on the next press of an empty box; plus app-driven system-clipboard copy (OSC 52 + local tool, tmux-aware), drag-and-drop image attachment, a Ctrl-L prompt re-anchor, and a SIGCONT resume repaint — verified leak-free (`mem-probe`) with a fresh `jeo --tmux` boot check._

### Added
- **System-clipboard COPY that survives SSH and tmux.** New `src/tui/clipboard.ts` puts text on the OS clipboard via OSC 52 (`ESC ] 52 ; c ; <base64> BEL`, wrapped in tmux DCS passthrough when inside tmux) with a local subprocess fallback (`pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip`). The tmux profile (`launch/tmux.ts`) now sets `copy-command` so a `mouse on` drag-select releases the copy-mode selection straight to the system clipboard — making `cmd+v` work even where the outer terminal can't capture the drag.
- **Drag-and-drop image attachment.** New `src/util/file-attachment.ts` recognises an image path dropped into the prompt (terminals deliver a drop as quoted/escaped text), validates it by magic bytes (not just extension), reads it, and rewrites the path token to the same `[image #N]` tag the Ctrl+V clipboard-image path uses — one consistent reference scheme for the model. Non-image / unreadable paths are left untouched.
- **`clearVisible()` (`src/tui/terminal.ts`)** — a Ctrl-L redraw that erases the visible screen and homes the cursor (`2J` + `H`) while PRESERVING scrollback (no `3J`), used to re-anchor a prompt whose in-place footer drifted after the screen scrolled. Hotkey help (`/help`) now documents Ctrl-L, Ctrl-V, and drag-drop.

### Changed
- **Prompt Ctrl+C clears before it exits.** At the idle prompt, a first Ctrl+C with typed text (or a pending clipboard image / queued pasted batch) now WIPES the box and keeps you at the prompt; a Ctrl+C on the already-empty box hard-exits (130). A pure, unit-tested `decideCtrlC(hasInput, msSinceLastCtrlC, collapseMs?)` plus a 50 ms collapse window funnels the four delivery paths of one physical press (footer keypress, `process`/`rl` SIGINT, raw `\u0003` byte) into a single logical action, so one press can never clear AND then exit. In-turn abort, EOF, and modal-picker Ctrl+C remain hard exits.
- **TUI repaints on resume from suspend (SIGCONT).** After `fg` brings jeo back from a Ctrl-Z / background stop, the live view now re-anchors itself instead of leaving a stale frame; the SIGCONT listener is registered only on non-Windows and removed on dispose (no listener leak).

### Verified
- `mem-probe` shows a flat post-GC heap (negative per-turn slope) with zero `process` SIGINT/listener accumulation, and `scripts/tmux-verify.sh smoke` boots `jeo --tmux` to a clean input box + model bar — full suite green (1747 tests) and `typecheck` clean.


## [0.6.34] - 2026-06-20
_Per-session model memory — each saved session now remembers the model it was last using and restores it on `/resume` — plus clearer `jeo --tmux` attach diagnostics, a tmux session-name double-dash fix, and a more robust no-leak probe gate._

### Added
- **Sessions remember their model (per-session model selection).** The session JSONL header now carries an optional `model` field: `createSession(cwd, id, model?)` pins it, `updateSessionModel(id, model)` rewrites it in place (no message loss, byte-identical no-op when unchanged), and `loadSession`/`listSessions` restore it. In `launch.ts`, every model change — the `/model` picker, a `model …` action, the OpenAI-compatible-endpoint setter, and live picker selections — is persisted into the active session via a best-effort `persistSessionModel()` (a header-rewrite failure never aborts the turn). On `/resume` (and `--resume`) the session's pinned model is restored unless the CLI explicitly pinned one (`--model`/role/provider wins), so each session can carry its own model independent of the global default. The `--resume` list and the resume picker surface the pinned model (`[provider/model]`).

### Changed
- **`jeo --tmux` reports a failed attach instead of vanishing.** A nonzero `tmux attach` exit (e.g. `open terminal failed: not a terminal` when stdout isn't a real TTY, a too-small client, or a transient server error) used to be swallowed — jeo returned 0 and left the freshly created session orphaned with no hint. The attach exit code is now surfaced and propagated to `process.exitCode`, and the message is honest about state: it advises `tmux attach -t <session>` only when the session is STILL live, and otherwise reports the session `ended before it could be attached` (so "reattach" is never misleading after an instant inner crash).
- **tmux session names no longer produce a double dash.** `tmuxSafeNamePart` now trims a trailing dash off the truncated head before appending the disambiguating hash, so a truncation boundary landing right after a `-` yields `name-<hash>` instead of an ugly `name--<hash>`.
- **`renameSession` shares one header-rewrite path.** Both the rename and the new model-pin go through a single internal `rewriteSessionHeader(id, mutate, cwd)` that locates the JSONL header, applies a mutator (returning `false` to skip the write when nothing changed), and rewrites the file in place — one place for the missing-file/missing-header error handling.

### Verified
- **No bun memory leak / slowdown.** `scripts/mem-probe.ts` drove 2000–4000 realistic LaunchTui turns: the post-GC heap keeps returning to a flat settled floor (~4.3 MB across turns 200→3400, net **+0.52 MB** vs baseline), with `exit`/`resize`/`SIGINT` process-listener counts stable (no accumulation). The probe's net-growth gate was hardened to measure the **settled floor** (min over the trailing half of samples) rather than the single final sample, since Bun's incremental GC leaves the per-sample heap bimodal — a final sample landing on a transient pre-collection peak was a measurement artifact, not retained memory.
- **`jeo --tmux` live.** `tmux-verify.sh smoke` OK + `battery` **6/6 PASSED** (boot, `/help`, unknown `$skill`, `/agents`, `$ultragoal`, unresolved `/command`).
- **Green gates.** `bun run typecheck` clean; `bun test` **1714 pass / 0 fail** (211 files), including the new per-session-model round-trip (`test/session.test.ts`) and tmux attach-failure / double-dash cases (`test/tmux.test.ts`).

## [0.6.33] - 2026-06-19
_A redesigned `jeo` forge mark — a hollow line-board crayfish/eyeglass emblem drawn as thick rounded-corner tubes (no letters, no DNA helix) — that now renders inside compact-scaled forge cards, plus a unified verification directive that adds gjc's test-quality contract, and a fresh `jeo --tmux` no-leak re-verification._

### Changed
- **The forge mark is a hollow line-board emblem now.** `FORGE_MARK_ART`, its grand `FORGE_MARK_ART_GRAND` hero variant, the claw-snap blink frames (`FORGE_MARK_FRAMES`), and every ASCII fallback (`*_ASCII`) were redrawn as the `>-<` silhouette of two pincer CLAWS (집게) whose top arms bend inward toward a narrow central eyeglass-frame (안경태) BRIDGE — each stroke a thick rounded-corner tube (`╭╮╰╯` + `─│`, ASCII `.-'|`) so the shape reads as a heavy neon outline instead of a filled block. The old wordmark glyphs (`J E O`) and the `╳` DNA double-helix nodes are gone; every line stays width-1 and equal-width so the blue→violet→pink flow gradient and the padding/centering math are untouched.
- **Forge cards render at a compact reduced width.** New `FORGE_SCALE` (1.2) + `scaleForgeWidth(available)` in `forge.ts` divide the caller's available column run down to a compact panel width (floored at 24). `app.ts` routes both the inline `flushForgeCard` and the static forge summary through it, so a card reads as a contained panel instead of stretching edge-to-edge with a dead right margin.
- **One source for the done-time verification directive.** New `VERIFICATION_DIRECTIVE` constant in `engine.ts` replaces the string that was duplicated verbatim in `executorSystemPrompt`'s default and `launch.ts`'s interactive prompt. It folds in gjc's `<verification>` test-quality contract — written tests must exercise observable behavior, edge values, branch conditions, invariants, and error handling, never asserting defaults or tautologies — and `prompts/agents/executor.md` gains a matching constraint line.

### Verified
- **No bun memory leak / slowdown.** `scripts/mem-probe.ts` drove 2000 realistic LaunchTui turns: post-GC heap returns to baseline (per-turn slope **−480 bytes/turn**, net +3.28 MB held flat), with `exit`/`resize`/`SIGINT` process-listener counts stable (no accumulation).
- **`jeo --tmux` live.** `scripts/tmux-verify.sh smoke` OK and `battery` **6/6 PASSED** (boot, `/help`, unknown `$skill` feedback, `/agents` roster, `$ultragoal` dispatch, unresolved `/command` report).
- **Green gates.** `bun run typecheck` clean; `bun test` **1710 pass / 0 fail** across 211 files.

## [0.6.32] - 2026-06-19
_Anthropic extended thinking is actually enabled now — the request finally sends a `thinking` block (adaptive for Opus/Sonnet 4.6+, budget for older), fixing reasoning on **opus-4-8** — plus a multi-token `/command`·`$skill` trigger highlight that paints every invocation and survives the trailing space, and a fresh `jeo --tmux` no-leak re-verification._

### Fixed
- **Anthropic extended thinking was never turned on — opus-4-8/4-7 reasoning is now actually requested.** The provider parsed and replayed thinking blocks on the *response* side and sent the `interleaved-thinking` beta, but `anthropicPayload` never put a `thinking` parameter in the *request* body, so the API treated every call as non-thinking and (for the internally-reasoning opus-4-7/4-8) returned signature-only/empty thought — reasoning effectively never activated. The request builder now selects a thinking transport per model (`anthropicThinkingMode` via `parseAnthropicVersion` on `claude-<family>-<major>-<minor>`): Anthropic **≥ 4.6 → adaptive** (`thinking: { type: "adaptive" }` with `display: "summarized"` gated to Opus **≥ 4.7** via `supportsAdaptiveThinkingDisplay`, depth riding `output_config.effort`, no `budget_tokens`); **4.5 → budget-effort** (`{ type: "enabled", budget_tokens, display: "summarized" }` + `output_config.effort`); **older → budget** (budget only). jeo's reasoning effort maps to the adaptive/effort literal via `anthropicAdaptiveEffort` (minimal/low/medium/high; xhigh folded to high upstream), `temperature` stays dropped on the thinking path, and the legacy `interleaved-thinking-2025-05-14` beta is filtered out for Opus ≥ 4.7 (`anthropicBetaHeader`) so it can't shadow the adaptive transport. Mirrors gjc's `inferThinkingControlMode` / `supportsAdaptiveThinkingDisplay` behavior.

### Changed
- **The trigger highlight now paints *every* `/command`·`$skill` token on the line and keeps it lit after the space.** New pure helpers in `slash.ts` — `allTriggerTokens(line)` (every whitespace-delimited `/`·`$` word, left-to-right, with code-point `start` offsets; paths like `src/cli` and `FOO$BAR` still excluded) and `committedTriggerToken(line)` (the leading invocation once a space follows, so the highlight no longer vanishes the instant you type a trailing space). `InputBoxOptions.highlight` accepts a multi-range `HighlightRange[]`, so a prompt mentioning several invocations lights each one (valid → neon green, no-match → pink) at once, independent of caret position.

### Verified
- **`jeo --tmux` has no bun memory leak and stays responsive.** A real `--tmux` session flooded with 200 `/command` keystrokes plus 80 SGR mouse-report sequences via `tmux send-keys` holds RSS bounded (159.8 → 161.5 MB peak → 161.4 MB settled, +1.5 MB and *decreasing* after the flood — no per-event linear growth) and the `tmux-verify.sh smoke` + `battery` (boot, `/help`, unknown `$skill`, `/agents`, `$ultragoal`, unresolved `/command`) all pass.
- **Full suite green:** `bun run typecheck` clean and `bun test` 1708 pass / 0 fail across 211 files (includes the extended `test/anthropic-stream.test.ts` adaptive/budget request-body coverage and the `test/slash.test.ts` / `test/input-box.test.ts` multi-token highlight tests).

## [0.6.31] - 2026-06-19
_Live "Thinking" indicator for signature-only reasoning models (Anthropic opus-4-7/4-8), a live color cue when a `/command` or `$skill` trigger is recognized in the prompt, and a rich gjc-style `/resume` session picker — plus a fresh `jeo --tmux` no-leak re-verification._

### Added
- **The prompt box now recolors the `/command` / `$skill` trigger token live as you type it.** While typing an invocation, the active trigger token (anywhere on the line, mention-style via `activeTriggerToken`) is repainted inside the input box so the user can SEE the trigger was recognized: a valid, matchable invocation turns neon green (`#39ff14`), while a typo with no match turns pink (`#ff6b81`) — a visual heads-up that it will be sent as plain text. Wired through a new `InputBoxOptions.highlight` ({start,end,paint}, code-point offsets over `Array.from(line)`) into both the idle prompt (`launch.ts` `previewLines`) and the mid-turn live box (`app.ts` `setLivePromptHighlight`, reset at each new turn). Scroll ellipses now use ANSI-safe `truncateToWidth` so a painted token never gets sliced mid-escape.
- **Rich `/resume` session picker (gjc parity).** A new `src/tui/components/session-picker.ts` renders a search/filter line, a scrolling window of multi-line entries (title + dimmed first-message preview + a `relative-time · size · N msgs` metadata line), a position indicator, and Del-to-delete / Enter-to-resume / Esc-to-cancel hints. `SessionSummary` now carries `sizeBytes` for the metadata line.

### Fixed
- **Signature-only reasoning models now show a live Thinking block while the model thinks.** Models that reason internally and stream a `signature` but NO `thinking_delta` text (claude-opus-4-7/4-8) opened a thinking block that produced zero visible deltas, so the TUI's dimmed live "Thinking" trace never appeared — the response wait read as a frozen "calling model …". The Anthropic stream adapter now fires a new display-only `onReasoningStart` signal the instant a `thinking` / `redacted_thinking` block opens, and the TUI renders a live `Thinking · Ns` block with a `(thinking…)` placeholder that is replaced the moment any real thought or answer text streams. Replay/artifact capture is unchanged.

### Verified
- **`jeo --tmux` has no bun memory leak and stays responsive.** A real `--tmux` session flooded with ~30,000 SGR mouse-report sequences via `tmux send-keys` plateaus in RSS (147 → 246 MB asymptotically: +83 / +12 / +3 / +0.2 / +0.4 MB per 6k-report round → no per-event linear growth) and stays responsive afterward (`/model` preview renders in 14 ms with the trigger highlight intact). The mouse-report swallow guard drops the reports instead of buffering/echoing them.
- **Full suite green:** `bun run typecheck` clean and `bun test` 1703 pass / 0 fail across 211 files (includes the new `test/input-box.test.ts`, `test/tui-app.test.ts`, and `test/session-picker.test.ts` highlight/picker coverage).

## [0.6.30] - 2026-06-19
_gjc-style intermediate-judgment guard classification extracted from the engine loop, plus a re-verification that `jeo --tmux` does not leak bun memory or slow down._

### Changed
- **Loop intermediate-judgment guards extracted into a classified module (`src/agent/loop-guards.ts`).** The mid-run "continue / self-correct / stop" decisions that were inlined across `engine.ts`'s `while` loop as scattered booleans and message strings are now a named `GuardState` discriminated-union taxonomy — jeo's descendant of gjc's `ultragoal-guard` `UltragoalGuardState` pattern. A single frozen `GUARD_LIMITS` object is the source of truth for every threshold (`MAX_REPEAT`, `MAX_FAILURES`, `MAX_REFUSAL_RETRIES`, `MAX_INVALID_CALLS`, `MAX_PARSE_BOUNCES`, `CYCLE_WINDOW`), and pure classifiers (`isVerificationSignal`, `repeatHint`, `nearestToolName`, `classifyDoneGate`) are now independently testable. `engine.ts` still owns all control flow (history mutation, `step++`, `continue`, `return finish(...)`) — only the JUDGMENT moved, so behavior is unchanged (net −19 lines in `engine.ts`). Removed the now-unused `src/agent/tool-registry.ts`.

### Verified
- **`jeo --tmux` has no bun memory leak and does not slow down.** An in-process probe streaming 5,000,000 SGR mouse-report escapes through `queuePromptInputChunk` (10 × 500k, `Bun.gc(true)` between batches) holds RSS flat (133.9 → 135.2 MB, slope ≈0.13 MB/round) with zero prompt-queue accumulation; a real `jeo --tmux` session flooded with 60k live mouse reports via `tmux send-keys` plateaus in RSS (129,456 → 129,472 KB). `jeo --tmux -p` end-to-end creates the profiled session, runs the turn, and tears down cleanly.
- **Full suite green:** `bun run typecheck` clean and `bun test` 1687 pass / 0 fail across 210 files (includes the new `test/loop-guards.test.ts`, 9 tests, and the signature-only Anthropic replay test).

## [0.6.29] - 2026-06-19
_Signature-only thinking-block replay (Anthropic opus-4-7/4-8), plus a tmux mouse-flood memory guard confirming `jeo --tmux` does not leak._

### Fixed
- **Anthropic thinking-block replay now covers signature-only artifacts.** Newer Opus models (opus-4-7/opus-4-8) think internally — tokens billed, a valid `signature` present — but return empty thinking text. The cross-turn replay required both `signature` AND `text`, so those models' reasoning was dropped between steps. Replay now sends a signed `thinking` block whenever a `signature` (or `redacted`) is present (text defaults to `""`), restoring multi-step reasoning continuity for signature-only models. API-key requests also send the `interleaved-thinking` + `prompt-caching-scope` betas so thinking+tools and scoped caching work outside OAuth.

### Added
- **`claude-opus-4-7` catalogued** (FULL thinking, 200k ctx) and a dynamic context-window fallback for uncatalogued ids (claude 200k / gpt-5 400k / gemini-3 1M).
- **tmux mouse-report-flood memory guard** (`test/mouse-report-filter.test.ts`): 100k SGR mouse-move reports through `queuePromptInputChunk` leave the prompt queue at zero accumulation — the regression guard for the "`jeo --tmux` slows down over time" concern.

### Verified
- **`jeo --tmux` has no bun memory leak.** The in-process lifecycle probe (`scripts/mem-probe.ts`, 3000 turns) reports a per-turn heap slope of ≈0 (returns to baseline, exit-listeners flat); a real `jeo --tmux` process plateaus in RSS under sustained mouse/resize/keystroke churn instead of climbing; and mouse reports are filtered (not buffered) with `activityLog` bounded to a 200-entry per-turn ring.

## [0.6.28] - 2026-06-19
_Signed thinking-block replay: native reasoning is now sent BACK to providers across steps/turns, restoring multi-step reasoning continuity (gajae parity)._

### Added
- **Provider-native reasoning replay across all three first-party providers.** jeo now captures each provider's opaque/signed reasoning artifact during streaming and replays it on later turns to the SAME provider+model, so the model keeps its chain of thought across tool steps instead of re-deriving it. New `Message.reasoningArtifacts` plus structured `Message.toolUse` / `toolResults` (stable ids) let capable adapters reconstruct **native** tool blocks (the key to continuity — plain-text tool feedback makes Claude strip prior thinking):
  - **Anthropic**: captures `signature_delta` + `redacted_thinking`; replays `thinking`(+signature) → `tool_use` → `tool_result` blocks (gated on same-model + thinking-enabled).
  - **OpenAI Responses**: requests `include: ["reasoning.encrypted_content"]` (store stays false), captures reasoning item id+encrypted_content, replays native `reasoning` + `function_call` + `function_call_output` items.
  - **Gemini**: captures per-part `thoughtSignature`, replays native `functionCall`(+thoughtSignature) / `functionResponse` parts (coalescing-safe). This was previously deferred — structured `toolUse` unblocks the functionCall binding.
- **Fail-safe strip-and-retry.** A 400 naming a thinking/signature/encrypted/reasoning field retries the step ONCE with artifacts stripped (plain history), so an expired signature or edited history can never wedge a turn. Per provider (Anthropic/OpenAI/Gemini).

### Changed
- **Reasoning artifacts ride the session record + token accounting.** `reasoningArtifacts` round-trips through session save/load (so `/resume` preserves replay continuity) and counts toward `estimateMessageTokens` (OpenAI encrypted blobs are KB-scale) so compaction/overflow stay honest. Markdown export is unchanged (artifacts are opaque). The engine's ~11 assistant-push sites are unified behind `pushAssistantTurn`, so every step (not just the final reply) carries its reasoning + artifacts. Antigravity is explicitly out of scope (no capture/replay; the provider-keyed match guard prevents any cross-adapter leakage).

## [0.6.27] - 2026-06-19
_Ponytail pass on the reasoning-tier mapper, plus a real-tmux verification of `jeo --tmux`._

### Changed
- **`thinkingToReasoningEffort` collapsed to its essential mapping (ponytail/YAGNI pass).** The four redundant pass-through branches (`minimal`/`low`/`medium`/`high` each returning themselves) are now a single `level === "xhigh" ? "high" : level` — behavior-identical (every level still maps to a genuine reasoning effort; only an unset level stays off), 8 fewer lines, fully covered by the existing `model-manager`/`round-b` contract tests. Reasoning continues to activate at EVERY thinking level (gajae parity).

### Fixed
- **`/agents <role> provider <name>` now accepts every registered provider and always shows a model list (jeo team role config).** Three compounding bugs surfaced via a real `jeo --tmux` session pinning a role to `groq`: (1) `isProviderName` was an unsound type guard hardcoding only 5 names (`anthropic|openai|gemini|antigravity|ollama`), so `/agents <role> provider groq` (and every other OpenAI-compat provider — deepseek, openrouter, mistral, …) was rejected as invalid usage; it now validates against the canonical `PROVIDER_NAMES` registry. (2) Live discovery only returns ids for a logged-in, reachable provider, and the catalog backfill applied only to OAuth-source providers — so an unconfigured API-key provider showed an EMPTY model list and silently pinned a bare default. (3) The 24 OpenAI-compat providers carry no capability-catalog rows, so even the catalog fallback was empty for them. The new `providerPickEntries` helper now climbs live ids → static catalog → the provider's known default model, so the list is never empty, and the source is labeled (`Live`/`Catalog … log in to list live models`). Verified end-to-end in a real tmux session (`#1 groq/llama-3.3-70b-versatile` listed and pinned). Covered by `test/provider-pick-entries.test.ts` and a new `isProviderName` regression test in `test/launch-flags.test.ts`.

### Verified
- **`jeo --tmux` session profile confirmed against the real `tmux` binary.** The gjc-parity profile (`mouse on`, `@jeo-profile`/`@jeo-branch`/`@jeo-project` markers, `set-clipboard on`, copy-mode `mode-style`) was exercised on an isolated `-L` socket using the exact `=name:` target syntax the launch code emits — every option set and read back correctly. `test/tmux.test.ts` passes 12/0 alongside the full 1645/0 suite.

## [0.6.26] - 2026-06-19
_The forge emblem is redrawn again as the mascot crayfish, foregrounding its signature pincer claws (집게)._

### Changed
- **Forge emblem redrawn as the mascot crayfish with raised pincer claws (집게).** The compact and grand forge marks (`FORGE_MARK_ART` / `_GRAND`) now read as the neon crayfish (가재) from `assets/character.png`, foregrounding its defining feature — two raised pincer claws on angled arms (`◣◣ ◢◢` jaws over `◆══╲ ╱══◆` arms) above the glowing eye/terminal cluster (`◉◉◉`) and a rounded carapace/tail. Purely pictographic and wordless (no embedded lettering), width-1 glyphs only so the TUI's padding/centering math stays exact; the blink frames snap the claws shut so the crayfish "clicks". Cross-checked against gajae-code's image-based crab/crayfish brand and the shared blue→violet→pink neon palette. The grand variant stays wide enough (30 cols) to keep the narrow-box compact fallback reachable.

## [0.6.25] - 2026-06-19
_Reasoning works at every thinking level (gajae parity), and the forge emblem is redrawn as the neon-lens coding wizard._

### Changed
- **Reasoning now activates at EVERY thinking level — no level restriction (gajae parity).** Previously the lowest tier disabled reasoning entirely: `thinkingToReasoningEffort` collapsed `minimal`→`low`, and the provider budgets treated `minimal`/unset effort as OFF, so picking the lowest level (or `/fast`) silently turned thinking off. `minimal` is now a genuine lightest reasoning effort threaded end to end — Anthropic (`minimal → 2000` budget_tokens), Gemini (`minimal → 2000`, clamped under the output cap), and Antigravity-Claude (`minimal → 2000`) all enable scaling-depth thinking for `minimal`/`low`/`medium`/`high`, matching gajae-code's `[Minimal, Low, Medium, High]` effort set. Only a fully UNSET effort stays non-thinking (the explicit off path). `xhigh` still maps to the deepest `high` tier the provider APIs accept.
- **Forge emblem redrawn as the mascot neon-lens coding wizard.** The compact and grand forge marks (`FORGE_MARK_ART` / `_GRAND`) now read as the character from `assets/character.png` — a pointed wizard hat with a twinkling star tip, the glowing asymmetric ◆/◇ neon lens eyes on a nose-bridge, and the violet gown shoulders cradling the glowing terminal screen the wizard holds (`◉◉◉`). Purely pictographic and wordless (no embedded lettering), width-1 glyphs only so the TUI's padding/centering math stays exact; the blink frames twinkle the star and wink the lenses.

## [0.6.24] - 2026-06-19
_`/provider` opens an interactive onboarding selector (OAuth vs API-compatible), and OpenAI-compatible backends gain per-vendor native-reasoning formats._

### Added
- **Interactive `/provider` onboarding selector (gjc parity).** A bare `/provider` (or `/login`) in a TTY now opens a picker — OAuth login (the common path) vs API-compatible endpoint setup — instead of printing static usage. New pure builders in `provider-picker.ts` (`buildOnboardingChoices` / `onboardingPicker` / `renderOnboardingPicker`); the scriptable/non-TTY path still falls through to the readiness panel unchanged, and a "Headless OAuth: paste the redirect URL or code" hint is shown for remote sessions.
- **Per-vendor native-reasoning formats for OpenAI-compatible providers.** A `reasoningFormat` setting (`openai` → `reasoning_effort`, `openrouter` → `reasoning:{effort}`, `qwen` → `enable_thinking`, `zai` → `thinking:{type:"enabled"}`) lets the OpenAI-compatible factory enable streamed reasoning per backend, so OpenRouter/Qwen/Z.ai models surface thinking like the first-party providers.

### Changed
- **`/provider` and `/login` descriptions** updated to mention the interactive selector and the headless paste flow.
- **ASCII-art / welcome rendering refactor** with refreshed tests (`ascii-art`, `pickers`, `tui-welcome`); the legacy `dna-claw-anim` animation test was retired.

## [0.6.23] - 2026-06-19
_Live reasoning/thinking streams in the TUI across every provider, three new OpenAI-compatible backends (LM Studio, xAI, Kimi) join the auth/discovery/catalog surface, and Gemini gains native function-calling._

### Added
- **Multi-provider reasoning/thinking streaming in the TUI.** Native reasoning is surfaced live (dimmed) and committed to scrollback for Anthropic (`thinking` deltas), OpenAI Codex/Responses (`reasoning*` deltas), OpenAI-compatible chat (`reasoning_content`/`reasoning`), Gemini & Antigravity (`thought` parts), and Ollama (`message.thinking`). A provider-agnostic `<think>…</think>` splitter routes inline chain-of-thought (DeepSeek-R1/Qwen-style local models) to the reasoning channel so it never pollutes the answer or the tool-call parse.
- **Three new OpenAI-compatible providers — LM Studio (keyless local), xAI/Grok (`XAI_API_KEY`), and Kimi/Moonshot (`KIMI_API_KEY`).** All route through a shared `makeOpenAICompatibleAdapter` factory and are wired into `/provider`, `jeo auth status/login`, model discovery, and the capability catalog.
- **Native Gemini function-calling (gjc parity).** Gemini now declares `functionDeclarations` and parses `functionCall` parts instead of the JSON-in-prose protocol — capable models stop fighting the `done` format, cutting wasted steps and stray "apology" prose from replies (verified live: a trivial reply dropped from 3 steps/14s to 1 step/2s).
- **Mid-turn `/command` and `$skill` dispatch** with a live command/skill preview while typing.

### Changed
- **API-key providers are first-class in the auth core.** `AuthProvider` now splits into the OAuth-capable subset (`OAuthProvider`) plus API-key-only providers (xai/kimi); these resolve through the standard `resolveCredential` path (`config.providers` / `<NAME>_API_KEY`) and model discovery now sends their key (a prior gap left discovery unauthenticated). `jeo auth login <xai|kimi> --token <key>` stores the API key.

### Fixed
- **Config-schema dropped a stored `xai` key on validation** (the providers schema was missing `xai`/`kimi`); both are now persisted.

## [0.6.22] - 2026-06-18
_Extended-thinking activation is now consistent across providers: a `low` session thinking level enables reasoning everywhere._

### Changed
- **Anthropic now enables extended thinking at `low` effort, matching Gemini and OpenAI.** Previously Anthropic disabled extended thinking for `low`/`minimal`/unset effort while Gemini (`thinkingConfig.thinkingBudget`) and OpenAI (`reasoning_effort`) kept reasoning on at `low`, so the same session thinking level produced thinking on some providers but not Anthropic. `anthropicThinkingBudget` now maps `low → 4000` budget_tokens (same tier as Gemini), with `medium → 10000` and `high → 24000` unchanged; only `minimal`/unset stay non-thinking so `/fast` and minimal thinking remain cheaper/faster across all providers.

### Added
- **Anthropic `low`-effort thinking-parity test** (`test/anthropic-stream.test.ts`) asserting `anthropicPayload` emits `thinking.budget_tokens` for low/medium/high and omits it for minimal/unset.

## [0.6.21] - 2026-06-18
_Session thinking level now reaches the provider's actual reasoning depth, not just the token ceiling._

### Fixed
- **`/thinking`, `--thinking`, and `/fast` now change real provider reasoning depth.** Previously a live session thinking change only adjusted the per-step `maxTokens` budget; the provider's reasoning effort (Anthropic `thinking.budget_tokens`, OpenAI `reasoning_effort`, Gemini `thinkingConfig.thinkingBudget`) still came from the global `~/.jeo/config.json` `thinkingLevel`. `reasoningEffort` is now threaded from the session level through `AgentLoopOptions` → `ChatOptions` → the model manager, so the session setting actually controls how deeply the model reasons. When unset it still falls back to the global config.

### Added
- **`thinkingToReasoningEffort` mapping test** locking the session-level → provider-tier contract (minimal/low → low, medium → medium, high/xhigh → high, unset → undefined).

## [0.6.20] - 2026-06-18
_Launch REPL internals decomposed into testable modules: `@mention` path completion, slash-command view renderers, and slash-command handlers extracted from the monolithic `launch.ts` into dedicated files with full unit-test coverage._

### Changed
- **`mentionPaths` / `currentAtLabel` extracted to `src/commands/launch/mentions.ts`.** The `@path` filesystem completion and footer label logic are now pure, `cwd`-parametric functions that can be unit-tested in isolation; `launch.ts` delegates to them via thin wrappers.
- **Slash-command view renderers extracted to `src/commands/launch/slash-views.ts`.** `hotkeysLines` and `contextUsageLines` are now pure functions (no I/O, no hidden state) returning `string[]`; verified with snapshot-style unit tests.
- **Slash-command handlers extracted to `src/commands/launch/slash-handlers.ts`.** `/usage`, `/tools`, `/hotkeys`, `/context` handlers are isolated behind a `SlashContext` interface, each returning a typed result — testable without spinning up the full REPL.

### Added
- **Unit tests for all extracted modules** (`test/launch-mentions.test.ts`, `test/launch-slash-views.test.ts`, `test/slash-handlers.test.ts`): 13 new tests, 79 assertions — mentionPaths directory traversal, case-insensitive filtering, unreadable-dir guard, currentAtLabel edge cases, context token tallies, singular/plural spacing, handler outputs.

## [0.6.19] - 2026-06-18

_Post-turn hooks run once per batch (not per edit), local hook reads are mtime-cached, tool-result formatting is parallelized, and wrapped colored text keeps its tint._

### Changed
- **Post-turn hooks execute ONCE per multi-call batch instead of once per result.** A project-wide checker hook (`tsc --noEmit`/lint/test) whose `match.tool` matched every edit in a batch previously re-ran N times sequentially — the dominant in-loop latency multiplier on multi-edit turns. `runPostTurnHooksForBatch` now groups the batch's calls, invokes each matching hook a single time, and runs distinct hooks concurrently. A hook matching several calls receives a back-compatible payload (`{event,tool,args,success,output}` plus a `calls[]` array of every matched call) so a payload-aware per-file hook can still iterate the changed files in one invocation; a single match keeps the exact legacy shape. The single-call `runPostTurnHooks` is retained as a thin wrapper for direct callers/tests.
- **Tool-result bodies are formatted in parallel.** The per-result loop that serialized body formatting (and any oversized-body spill to a disk artifact) is replaced by a `Promise.all` over the batch, so independent formatting/disk writes overlap.

### Performance
- **Local `.jeo/hooks.json` is mtime/size-cached.** The per-project hook override was re-read and re-parsed (`fs.readFile` + `JSON.parse`) on every `loadHooks` call — once per pre-tool check and once per post-turn batch. It is now cached keyed by absolute path → mtime/size (bounded LRU, cap 32) and only re-read when the file actually changes, so any external write is still picked up immediately without a stale serve.

### Fixed
- **Wrapped colored text keeps its color on every continuation row.** `wrapTextWithAnsi` is now SGR-stateful: a color opened before a wrap point is re-applied at the start of each continuation line and closed at its end, so a wrapped colored span stays tinted on every row (the reported "color breaks when the line wraps") instead of losing its tint after the first line — and never bleeds into the padding or box border. Plain uncolored text is left byte-for-byte unchanged.


## [0.6.18] - 2026-06-17
_Memory data-flow diagram and a README "Memory flow" section documenting the actual runtime behavior._

### Added
- **Editable memory data-flow diagram (`docs/diagrams/memory-flow.drawio`).** A draw.io swimlane diagram traces the OKF memory system's actual runtime behavior end to end: the **WRITE** lane (session-exit `spawnDetachedDistill` → `distillSessionMemory` → one JSON-mode LLM call → per-concept atomic upsert into `facts/`/`commands/`/`gotchas/`/`preferences/`, with a plain-text legacy fallback, then `rebuildIndex`/`updateLog`), the **STORE** lane (the typed concept bundle, `index.md`/`log.md`, the cross-link graph, and the legacy `MEMORY.md`/`.bak`), the **READ** lane (`memoryPromptSection` → `JEO_NO_MEMORY`/`JEO_MEMORY_LEGACY` gates → `loadConcepts` → `selectWithinBudget` priority order with 1-hop graph expansion → `frameMemory` injection-hardening → `<project_memory>` injection), and the one-shot idempotent **MIGRATION** lane (`jeo memory-migrate`).
- **README "Memory flow" section (all four languages).** A new section in `README.md` / `README.ko.md` / `README.ja.md` / `README.zh.md` explains the local-first distilled memory model and embeds a GitHub-renderable Mermaid version of the write/store/read/migration flow, links the editable `.drawio`, and documents the `JEO_NO_MEMORY` / `JEO_MEMORY_LEGACY` toggles and the migration's rollback path.

## [0.6.17] - 2026-06-17
_Legacy MEMORY.md migrates losslessly into the OKF concept bundle, with a one-shot command and a rollback toggle._

### Added
- **`jeo memory-migrate` — legacy memory → OKF bundle migration (OKF Sprint 05).** A one-shot, idempotent migration converts the legacy single-doc `.jeo/memory/MEMORY.md` into the type-partitioned OKF concept bundle: `parseLegacyMemory` maps each `## heading` to a concept type (commands/gotchas/preferences/repo-facts, unknown → RepoFact) and splits top-level bullets into concepts (`**title**: description` form recognized, indented continuation lines become the body — lossless), then `migrateLegacyMemory` writes each concept atomically under `facts/`/`commands/`/`gotchas/`/`preferences/`, (re)builds `index.md`/`log.md`, and renames the legacy doc to `MEMORY.md.bak` for rollback. Re-running is a no-op once the bundle has concepts. The bundle is the default read path; `JEO_MEMORY_LEGACY=1` is a new rollback toggle that ignores the bundle and reads the legacy doc (or its `.bak` backup) through the same injection-hardening, while `JEO_NO_MEMORY=1` still wins over everything.

## [0.6.16] - 2026-06-17
_OKF memory grows a concept cross-link graph: 1-hop search expansion, bundle lint, graphify-optional._

### Added
- **Concept cross-link graph for the memory bundle (OKF Sprint 04).** A new zero-dependency `src/agent/memory-graph.ts` treats the OKF bundle as a first-class link graph — nodes are concept IDs, edges are the markdown links a concept's body points at another concept, and broken links are tolerated (captured for lint, never thrown). It powers `buildConceptGraph` / `expandByGraph` / `resolveLinkTarget` / `lintConceptGraph` / `graphifyAvailable`. Memory injection now applies **1-hop graph expansion**: a concept the task query directly hits lifts its link-neighbours ahead of unrelated noise (still within `MEMORY_INJECT_MAX_CHARS`). New `lintMemoryBundle(cwd)` reports orphan concepts, broken links, and duplicate-title merge candidates. The optional `graphify` tool is a best-effort enrichment layer only — every feature runs fully on the built-in graph when it is absent (graceful degradation), and `graphify update` is never run against the markdown bundle.

## [0.6.15] - 2026-06-17
_Query-aware OKF memory injection with budget-priority selection, and a truthful end-of-turn Todos receipt._

### Added
- **Concept-level memory search & budget-aware injection (OKF Sprint 03).** `memoryPromptSection(cwd, query?)` now loads the OKF concept bundle and selects what to inject by priority — high-confidence core facts first, then query relevance (the one-shot task text is wired in as the query), then stable order — dropping whole lowest-priority concepts to fit `MEMORY_INJECT_MAX_CHARS` (3000) instead of truncating mid-string. New exported helpers `loadConcepts` / `scoreConcept` / `searchConcepts`. The `index.md` rebuild now emits progressive-disclosure `- [title](/relpath) — description` rows. Injection-hardening (DATA framing, fence neutralization) and the `MEMORY.md` fallback are retained.

### Changed
- **End-of-turn Todos receipt tells the truth.** A successful `finish` shows the Todos checklist fully complete so it agrees with the `done` badge (the model's last `todo` call often forgets to flip the final items, and the once-per-turn done gate can't force it); cancel/error finishes pass `ok:false` so any unfinished items stay honestly shown. The live frame is unchanged, so in-progress work still renders truthfully.


## [0.6.14] - 2026-06-16
_Memory distillation survives malformed model output, and stream-idle stalls retry instead of failing the turn._

### Fixed
- **Malformed `concepts` arrays no longer discard the whole distillation batch.** A text-only / small model can emit stray non-object array elements (`null`, strings, numbers) or non-string `type`/`title` fields. Each element is now validated and its persistence wrapped in a per-concept `try`/`catch`, so one bad concept is skipped instead of throwing out of the loop into the outer catch — which previously silently dropped every valid learning distilled in that run. Junk frontmatter fields (`description`/`tags`/`body`/`confidence`/`links`) are coerced to safe defaults so the written file stays OKF-conformant.
- **Per-chunk stream-idle stalls now retry instead of failing the turn.** A `stream idle for <ms>ms (no chunk)` stall (provider load or long time-to-first-token) is treated as transient and retried like a timeout, while the hard overall wall-clock cap (`stream exceeded the overall deadline`) still fails fast. The idle-stall error message now explains the cause and remediation.

### Added
- **`JEO_STREAM_IDLE_MS` opt-in override.** Reasoning workloads whose "thinking" phase can legitimately emit no visible token for longer than the 120s default can raise the per-chunk idle threshold without a code change.

## [0.6.13] - 2026-06-16
_`team` engine: concrete uncommitted-work reporting and stricter empty-run handling._

### Changed
- **`team` re-runs report concrete uncommitted work.** Instead of a speculative warning, the engine now probes the working tree with `git status --porcelain` and reports the actual uncommitted-file count, so you know whether real partial work is present before re-running on it.
- **`--strict-mutations` fails a no-op mutating run.** A mutating role that performed no write/edit/bash is now a hard failure (`stream:error`) rather than silently passing; a bash-only run stays an advisory `stream:warn` (new tone) so a passing advisory doesn't masquerade as an error.

## [0.6.12] - 2026-06-16
_OKF-backed memory distillation — session learnings become structured concept files._

### Added
- **OKF-backed memory distillation (OKF Sprint 02).** Session distillation now emits structured OKF v0.1 concept files — each with `type` / `title` / `description` / `body` / `tags` / `confidence` / `links` — filed into typed directories (unknown types fall back to `facts/`), deduped by title, merged with the existing concept bundle, then indexed and logged. The distiller prompts the model for a `{ concepts: [...] }` payload and parses it leniently (`tryExtractJsonObject`) so text-only providers still land. Builds on the 0.6.10 OKF format layer.

## [0.6.11] - 2026-06-16
_Larger reasoning budgets, and terminal capability-response sequences kept out of the prompt._

### Changed
- **Larger thinking-token budgets across every level.** `thinkingMaxTokens` is raised (minimal 1k→4k, low 2k→8k, default 4k→16k, high 8k→24k, xhigh 16k→32k), along with the Anthropic (medium 4k→10k, high 10k→24k) and Gemini (low→4k, medium→10k, high→24k) per-provider budgets — so each reasoning level actually gets room to think.

### Fixed
- **Terminal capability-response sequences no longer corrupt the prompt.** The mouse-report filter (0.6.7) now also swallows Device-Attributes / mode replies that the outer terminal sends when tmux probes it on attach, on both the idle keypress path and the live-turn raw-stdin drain.

## [0.6.10] - 2026-06-16
_OKF memory-format foundation and a hardened bashTool subprocess drain._

### Added
- **OKF (Open Knowledge Format) v0.1 foundation** — a standalone schema/format layer for jeo memory: YAML-frontmatter parse/serialize with extension-key round-trip, concept-ID computation, and a tolerant v0.1 conformance validator (`src/agent/memory-okf.ts`). Sprint 01 only — it does not touch the existing distill/inject pipeline yet, and adds zero native dependencies. Design notes live under `docs/okf_mem/`.

### Fixed
- **bashTool subprocess draining hardened.** A shared `drainPipe` reader plus reader-cancellation, a SIGTERM→SIGKILL kill timer, and a brief pipe-linger ensure stdout/stderr fully drain before teardown — no file-descriptor or child-process leak across the normal, timed-out, and abandoned lifecycles (the subprocess-leak probe stays at baseline).

## [0.6.9] - 2026-06-16
_Live streaming blocks size to their content and the viewport instead of a fixed rectangle._

### Changed
- **`Thinking` / tool `Output` live blocks size to their content.** The dimmed streaming trace and tool-output tail are now rendered by a single `renderLiveBlock` helper that shows only the most-recent lines, capped at ~30% of the terminal height — instead of a fixed blank-padded rectangle. A short stream no longer leaves dead "hole" rows, and a short terminal keeps the rows the heartbeat needs.
- Dropped the rounded-icon header image from the READMEs (the hero image and title stay).

## [0.6.8] - 2026-06-16
_OAuth loopback callback host pinned to `localhost` to match provider-registered redirect URIs._

### Fixed
- **OAuth loopback callback uses `localhost`** (not the `127.0.0.1` IP literal). Providers register their dynamic-loopback redirect URIs against `localhost`, so the callback host must match it exactly — an IP literal can mismatch the registered URI and break the Anthropic / Google / Antigravity login flows. The default is now documented in-code so it doesn't drift again.

## [0.6.7] - 2026-06-16
_Mouse-report input corruption fixed under `jeo --tmux`, and a full-width TUI at one consistent width._

### Fixed
- **Mouse reports no longer corrupt the prompt.** `jeo --tmux` enables tmux `mouse on` (so wheel-scroll reaches copy-mode), but the mouse-report bytes it delivers — X10 `ESC[M…` and SGR `ESC[<…M/m` — were landing in the input box as typed text (the "값 입력" digit spray when you click or scroll). A filter now swallows whole mouse-report sequences on both the idle keypress path and the live-turn raw-stdin drain, so they never reach readline.

### Changed
- **TUI fills the full terminal width.** The welcome banner, input box, user/forge cards, history panel, and status box now share one wrap-safe `cols - 1` width instead of capping at 100/120 columns — every box lines up, and a full-width row never trips the terminal's last-column autowrap. The welcome banner's separate proportional/centered modes are dropped in favor of this single width.

## [0.6.6] - 2026-06-16
_Vertical caret movement between input-box rows, a centered welcome banner, and a leaner `parseFlags`._

### Added
- **Vertical caret movement in the boxed prompt.** ↑/↓ inside a multi-line or wrapped draft now move the caret between the input box's visual rows (textarea feel) via `verticalCursorOffset`; an ↑/↓ at the top/bottom edge still falls through to readline history recall.

### Changed
- **Welcome banner is centered.**
- **`parseFlags` simplified** — duplicate `--flag` / `--flag=` branches collapsed into one (`takeValue()` already resolves both spellings), −40 lines with zero behavior change.

## [0.6.5] - 2026-06-16
_macOS combo-key editing in the boxed prompt, a fresh-start screen clear at launch, a proportional welcome banner, height-aware relayout — and `launch.ts` split into focused submodules._

### Added
- **macOS / fixterms combo keys in the boxed prompt.** Option+Left/Right (word jump) and Cmd+Left/Right (line start/end), plus Option/Cmd+Backspace, are normalized to the canonical control bytes Bun's readline already acts on — so the keys macOS users actually reach for now move the caret instead of doing nothing. Readline stays the single owner of the cursor; the box just repaints.
- **Fresh-start screen clear at launch.** The banner opens atop a cleared screen (erase screen + scrollback) on a TTY — never mid-turn, so tmux scrollback is never flooded.

### Changed
- **Welcome banner uses a natural, proportional hero width** instead of stretching into a mostly-empty rectangle on wide terminals; it shrinks gracefully (grand→compact claw) on narrow ones so the art keeps its shape and never clips.
- **`launch.ts` split into focused submodules** under `src/commands/launch/` (`flags`, `input`, `tmux`, `stream`, `workflow`) — a ~1000-line maintainability refactor with no behavior change; the public surface is re-exported unchanged.

### Fixed
- **Renderer relayouts on height change**, not just width — a terminal that grows/shrinks vertically now repaints correctly.
- **Pickers no longer leave typed filter text behind.** A `/model` · `/agents` picker that read keystrokes directly no longer queues its leftover filter text as the next prompt.

## [0.6.4] - 2026-06-16
_Branding, a responsive-resize fix, `/provider` realignment, and engine repeat-spin recovery._

### Added
- **Branding** — jeo-code icon set, favicon, social preview + README logo (#33).
- **Goal verifier** — turns are checked against the stated goal before completing, so a turn can't silently report done without meeting it.
- Dynamic resolution handling + jeo-tone text styling across the TUI.

### Changed
- **`/provider` aligned with gjc** — it's now onboarding/login only; switching the active model moves to `/model`.

### Fixed
- **Responsive resize no longer lags** — leading-edge throttle replaces the trailing debounce that never fired during a continuous drag, so the frame tracks the drag live and paints the final geometry exactly.
- **Engine recovers from repeat-spin** instead of cold-stopping the turn.
- Idle input box capped at 120 cols to match the live-turn box.

## [0.6.3] - 2026-06-16
_OAuth loopback reliability fix._

### Fixed
- **OAuth loopback redirect uses `127.0.0.1` instead of `localhost`** (RFC 8252 §7.3). `localhost` can resolve to IPv6 `::1` or be hosts-file-overridden, intermittently breaking the auth callback; the IP literal is reliable. Only the dynamic-loopback path changes — providers with a fixed redirect URI are unaffected (#30).

## [0.6.2] - 2026-06-16
_Interactive `/provider` picker, clearer animated status + labeled block/prose boundaries, and a transient empty-response retry._

### Added
- **Interactive `/provider` picker** (gjc-style) with a clean screen after login (#26).
- **Clearer visual structure** — unified labeled boundaries for thinking / reasoning / output blocks and a dimensional animated status line (#29, building on the labeled-boundary work).
- `docs/minimo/` — a plan to apply MiMo Code's memory & goal-management ideas to jeo (#28).

### Fixed
- **Retry transient empty-200 responses** (a 200 with an empty body) for stability — gjc parity (#27).

## [0.6.1] - 2026-06-16
_Live reasoning progress (no more frozen "calling model"), thinking-level fixes for Anthropic/Antigravity, and input-box/Ctrl+O TUI fixes._

### Added
- **Live reasoning progress.** Codex/OpenAI reasoning models now stream their thinking into the live frame (`reasoning.summary: "auto"` + `response.reasoning*.delta` events surfaced via `onReasoning`), and the status row reads `reasoning (model)…` / `thinking — reasoning, no token stream yet…` after a silent wait instead of a frozen `calling model (Ns)…`.

### Fixed
- Thinking level is now applied to the **Anthropic and Antigravity** providers (it was a silent no-op there).
- The **input box + caret stay in place after running a command** — no more vanishing box / caret parked at the reservation top.
- **Skill runs render a compact `[skill]` card** instead of dumping the injected `SKILL.md` into a user box.
- **Ctrl+O fold toggle** + incremental session durability across interruption.

### Changed
- Trimmed `fastThinkingLevelForModel` fallback to the real gap (ponytail pass); added a usage guide + demo video, linked from all READMEs.

## [0.6.0] - 2026-06-16
_TUI quality of life: durable input history (↑ recalls past queries across launches), clean `/resume` rendering, and a scrollable mid-turn Ctrl+O panel._

### Added
- **Durable input history.** ↑/↓ at the prompt now recall "이전에 사용한 쿼리" across launches, not just lines typed in the current run: submitted prompts persist to a per-workspace `.jeo/input-history` file (deduped, capped, best-effort) and hydrate readline's ring on the next launch. Composes with `/resume`, which already seeds the resumed session's own prompts into the ring. New `src/agent/input-history.ts` (`loadInputHistory`/`appendInputHistory`).

### Fixed
- **`/resume` dumped raw JSON and broke the TUI.** When a resumed session's assistant turn was stored as a ```json-fenced (or reasoning-decorated) tool call, the transcript renderer's naive `JSON.parse` failed and dumped the raw JSON block into the screen. `formatTranscript` now uses the engine's robust extractor (`tryExtractJsonObject`) and only treats a message as a tool call when it actually begins with `{` (after stripping a leading fence) — so fenced/decorated tool calls render as proper `✔ title` cards, prose that merely contains JSON stays prose, and no raw JSON ever leaks into the resumed view.
- **Ctrl+O while a turn runs cropped the detail panel** at "… N more line(s)", so a long reply / tool output (especially CJK) couldn't be read past the first screenful. The live panel now WINDOWS the content with `↑ N more above` / `↓ N more below` counters and is scrollable with ↑/↓ and PgUp/PgDn — every line is reachable, nothing is dropped, and short content still renders as a plain non-scrollable panel. The in-flight key harness routes arrow/PageUp/PageDown to a new `onScrollKey` hook (a no-op when the panel is closed, so those keys stay inert otherwise); `LaunchTui.scrollDetail()` clamps within `[0, max]` and guarantees the last line is reachable. Mirrors the 0.5.16 idle-prompt Ctrl+O fix for the mid-turn path.

## [0.5.16] - 2026-06-16
_`/resume` and Ctrl+O no longer corrupt the TUI — clean screen restore + scrollback expand._

### Fixed
- **`/resume` corrupted the screen on a TTY.** After picking a session the resumed transcript was dumped on top of whatever was on screen (picker remnants, the prior conversation, the live input frame), so replayed ANSI/forge boxes from the old session collided with the live layout. Resume now wipes the screen + scrollback and re-renders the welcome banner BEFORE replaying the transcript — the same proven path `/clear` uses — so the restored view is a single, intact screen (verified live: one input box, one status bar, no picker remnants).
- **Ctrl+O at the prompt crammed the last response into the ~10-row footer**, clipping long/CJK content with "… N more line(s)" and risking a garbled box. Ctrl+O now expands the full last assistant response into scrollback (clean `disarm → print → re-arm` path), so it is fully scrollable and the input box + typed draft restore without corruption. Removed the now-dead footer history-panel machinery (`promptHistoryLines`, `historyPreviewLines`).

## [0.5.15] - 2026-06-16
_`jeo update` now actually upgrades — bare command installs the latest release instead of just printing a manual command._

### Changed
- `jeo update` (bare) now performs the upgrade itself: when a newer release exists it runs the install (`bun install -g jeo-code@<latest>`, pinned to the resolved latest version so a stale global cache can't win) instead of printing "Run 'bun install -g jeo-code' to upgrade" and leaving the user to do it. `--check` is the new check-only mode; `--json` stays check-only for programmatic status (add `--install` to install in JSON mode); `--install` still forces an install. The check-only hint now points at `jeo update` itself.

## [0.5.14] - 2026-06-16
_`jeo --tmux` live-verification harness — repeatable stability + behavior checks._

### Added
- `scripts/tmux-verify.sh` (and `bun run verify:tmux`) codifies the launch → send-keys → capture → cleanup loop into one repeatable command, so stability and behavior of the interactive TUI can be checked without hand-rolled one-off bash. macOS-safe (no GNU `timeout`; a bash watchdog polls for the session). Boots jeo in a DETACHED tmux session inside a throwaway cwd (never edits the real repo) and only ever kills the session it created — a user's `jeo-main-*` session is never touched. Subcommands: `smoke` (boot + assert the input box and model bar render, no crash — the stability gate), `check "<input>" "<regex>" [--ansi] [--wait N]` (type input, assert the pane matches a pattern — the behavior primitive; captures scrollback so long output like `/help` still matches), and `capture` (dump the settled frame).

### Changed
- `jeo whats-new` (and the post-upgrade update notice) now default to the **5 most recent** releases instead of only the single latest entry, so the notes no longer look static/hardcoded across upgrades. `--all` still prints the full history. New shared constant `RECENT_RELEASE_COUNT` (`src/util/whats-new.ts`) is the single source of truth for both the command and the launch notice (the launch notice is capped to it too, so a large version jump no longer dumps a wall). Mirrors gjc's "Recent Changes" pattern (latest-N + a full toggle) and the README's latest-5 digest.

### Maintainer notes
- Internal refactors landed since 0.5.13 (no behavior change): centralized workflow name/engine dispatch (`WORKFLOW_NAMES`/`runWorkflowEngine`), a shared `statusBoxData()` for the inline/non-inline status frames, and a `normalizeSlashAlias()` helper. Also fixed a flaky test where the light-tool ledger line briefly carried an elapsed `(Nms)` suffix — that detail belongs on the forge cards, the ledger line is a clean single line again.

## [0.5.13] - 2026-06-15
_Workflow `/` commands actually run — `/deep-interview`, `/team`, `/ultragoal`, `/ralplan` dispatch by name._

### Fixed
- Workflow skills listed in the `/` menu didn't run: a bare `/name` only resolved when the skill's SKILL.md happened to self-reference that slash token (so `/ralplan` worked by luck while `/deep-interview` and `/ultragoal` returned "Unknown command"). `parseSkillInvocation` now resolves a plain `/word` against skill NAMES (exact, then unique prefix) — the same entrypoint as `$name` and `/skill:name` (gjc parity) — so `/deep-interview`, `/ralplan`, `/team`, `/ultragoal` (and any loaded skill) dispatch from the slash menu. Dotted (`/speckit.plan`) and nested (`/a/b`) tokens keep their alias/file-path resolution untouched, and built-in commands still take precedence.
- The four bundled workflows are now always listed in the `/` menu as `/deep-interview`, `/ralplan`, `/team`, `/ultragoal`, even when their SKILL.md declares no slash alias, so they are discoverable as well as runnable.

## [0.5.12] - 2026-06-15
_Yellow status animation while a process runs, and elapsed `(Nms)` on every completed tool card._

### Added
- The live status animation (spinner + activity gradient) turns amber/yellow while a tool/process is executing — "the agent is running/verifying a process" now reads at a glance, distinct from the cool thinking gradient (gjc `theme.fg("warning")` parity).
- Every completed tool card and light-tool ledger line now shows how long the tool ran, dim after the ✓/✗ glyph — `✓ Bash · (8ms)`, `✓ Read x.ts · (3ms)` (gjc duration-detail parity; sub-second as `Nms`, else `N.Ns`/`Nm Ns`).

## [0.5.11] - 2026-06-15
_Backspace on an empty prompt line no longer quits jeo._

### Fixed
- Pressing Backspace with an empty input line could terminate the process on some Bun builds: an empty-line Backspace is a no-op edit, but those builds turn it into a spurious readline `close`, which the REPL treats as a hard exit. The multi-line input filter now swallows a standalone Backspace (DEL `0x7f` / BS `0x08`) when the line buffer is already empty, so the byte never reaches readline and the close can't fire. Backspace with text in the buffer still deletes normally, and Ctrl-C / paste / Enter are untouched.

## [0.5.10] - 2026-06-15
_`/resume` transcript no longer dumps raw JSON for batched tool calls._

### Fixed
- Resuming a session that contains a BATCHED tool step (`{reasoning, tools:[…]}`) printed the raw JSON object into the transcript instead of a readable history. `formatTranscript` only recognized the single-call `{tool,arguments}` shape; the batch shape parsed to no `tool` field, fell through to the prose branch, and dumped the JSON. It now renders one compact `✔/✗ <tool> — <result>` ledger line per batched call (verdicts parsed in call order from the combined `Tool [x] result` message), matching how single calls already render. `/resume` and `/history` both go through this path, so both are fixed.

## [0.5.9] - 2026-06-15
_Bounded per-frame wrap for the live thinking/tool-output blocks — re-render cost no longer grows with stream length._

### Changed
- The live "thinking" and tool-output tail blocks only ever DISPLAY their last 6/8 wrapped rows, but they accumulate the whole step's text and were re-wrapping the FULL string on every 120ms repaint — so per-frame CPU and GC churn grew linearly with how much had streamed (a long reasoning trace or a chatty tool can reach hundreds of KB). The wrap input is now bounded to a fixed 16 KiB trailing window (`tailForWrap`), capping per-frame work at O(window) regardless of total size. The visible tail is byte-identical for normal multi-line content; an unbroken multi-hundred-KB blob still shows its genuine end. No memory leak existed (every live buffer — StreamRegion, ToolList, activityLog, forgeSummaries — is already ring-capped and the per-turn TUI instance is GC'd); this removes the one remaining O(stream-length) hot path in the repaint loop.

## [0.5.8] - 2026-06-15
_Native Opik observability for the turn loop (opt-in `JEO_OPIK`, pure-TS no-op when unset) + autopilot convergence tracking._

### Added
- Native Opik observability for the agent turn loop (opt-in via `JEO_OPIK`): each turn becomes one Opik trace, each step/tool a span, with token usage and the `completed` / `verified` / `efficiency` eval scores attached. Implemented in pure TypeScript over `fetch` — no Python, no `opik` npm package — per jeo's zero-native-dependency constraint. Hard invariants: an unset `JEO_OPIK` is a complete no-op (zero Opik HTTP calls); no tracer error ever escapes an events callback; the API key travels only in the `Authorization` header; and engine output is identical regardless of tracing outcome.

### Changed
- Autopilot convergence tracking: a "keep" (a provable min/max improvement or a gate pass) now counts as forward progress, and anything else extends the no-progress streak toward the convergence cap.

## [0.5.7] - 2026-06-15
_`/model` picker is default-only, `/clear` resets to the initial screen, ESC clears the input box, and a launch process-listener leak is fixed._

### Changed
- The `/model` model-action picker now offers ONLY the DEFAULT section: "Set model only" plus the default thinking levels. The per-role rows ("Set as EXECUTOR/PLANNER/ARCHITECT/CRITIC") and the "Apply OpenAI Codex role preset" entry are gone — role model and thinking are configured exclusively in `/agents` (and `/agents edit`). The default heading now points there (`roles → /agents`). This completes the 0.5.6 split: `/model` owns the default, `/agents` owns the roles. Dead helpers (`orderedModelRoles`, `applyOpenAiCodexRolePreset`, `CORE_MODEL_ACTION_ROLE_ORDER`) were removed with the menus.

### Added
- `/clear` now returns to the initial screen (fresh session view) and ESC clears the input box, matching the expected reset gestures.

### Fixed
- Launch no longer leaks process listeners: the prompt-scoped stdin `data`/`keypress` and stdout `resize` handlers are now tracked and drained on every exit path, so repeated `launch()` (e.g. the test harness) no longer accumulates listeners past Node's 10-listener default (`MaxListenersExceededWarning` + a real leak).

## [0.5.6] - 2026-06-15
_`/model` sets only the default thinking; per-role reasoning moved to `/agents`._

### Changed
- Thinking ownership split: `/model` now configures reasoning for the DEFAULT agent only, and per-role (subagent) thinking is owned by `/agents`. In the model-action picker the role rows offer just "Set model only" (the per-level thinking rows are gone), `/model subagent <role> thinking <level>` redirects to `/agents` instead of saving, and picking a role's model no longer prompts for a reasoning level. Set role reasoning via `/agents <role> thinking <level|inherit>` or the `/agents edit` picker. `/model thinking <level>` still sets the default, so nothing the default knob did is lost.

## [0.5.5] - 2026-06-15
_Full multi-line visibility — the input box scrolls to the caret and the submitted card shows every line._

### Fixed
- Full multi-line visibility for the multi-line input added in 0.5.4: the input box now scrolls so the caret row always stays in view as you move through a long draft (`…` markers flag rows hidden above/below, so no line is unreachable), and a submitted multi-line query renders ALL of its wrapped lines in the user card — the card lives in scrollback rather than the bounded live frame, so nothing is truncated.

## [0.5.4] - 2026-06-15
_Reliable multi-line input is ON by default — a paste fills the box and submits as one message._

### Changed
- Multi-line input is now enabled by default on any interactive TTY (no flag needed): a bracketed paste arrives as ONE buffer, fills the input box, and submits as a single message instead of being split into one message per line. The prompt's stdin is routed through a filter that rewrites line breaks to a private-use sentinel before `node:readline` sees them, avoiding the per-line submit/race. The lone-`\n` Shift+Enter rule stays opt-in via `JEO_MULTILINE=1` (it needs ghostty's `keybind = shift+enter=text:\n` and could misfire on terminals that send LF for Enter), and `JEO_NO_MULTILINE=1` fully disables the filter (reads stdin directly, exactly as before).

## [0.5.3] - 2026-06-15
_`$` chains multiple skills in one line (all run, in order), plus multi-line prompt input — paste-merge and gated Shift+Enter._

### Added
- Multi-skill `$` chaining: a leading run of `$skill` tokens now invokes every resolved skill in order, sharing the trailing text as one intent — `$ralplan $team build the auth flow` runs ralplan then team, both with intent "build the auth flow". A lone `$skill` is just a chain of one, so existing single invocations are unchanged. Prefixes still resolve (`$te $ultra …`), `$UPPERCASE` env-var tokens end the chain and pass through to the model, and unknown tokens are collected so several typos report together (`No skills: $nope, $bad.`) instead of one at a time. Applies to both the interactive prompt and one-shot `-p`/`/skill:` runs.
- Multi-line paste merges into ONE message: a pasted block with embedded newlines is submitted as a single prompt instead of being split into one message per line.
- Shift+Enter multi-line input (opt-in via `JEO_MULTILINE=1`): Shift+Enter inserts a real line break instead of submitting. Terminal-specific Shift+Enter encodings (ghostty legacy `\x1b[27;2;13~`, kitty `\x1b[13;2u`, and a lone `\n`) are rewritten to a private-use sentinel before `node:readline` sees them, so it works through tmux (extended-keys off) without mangling; default OFF reads stdin exactly as before.

### Changed
- The one-shot skill path was refactored to a shared `runOneSkillShot` runner so the single-invocation and chain paths execute identically (bundle workflow → engine; regular skill → agent turn).

## [0.5.2] - 2026-06-14
_`$skill` prompt invocation with prefix/fuzzy suggestions, and a per-session input-box hue (amber in cmd-mode)._

### Added
- `$skill` prompt invocation: typing `$<name>` runs a bundled/loaded skill directly. A unique prefix resolves precisely (`$te` → `$team`); an ambiguous prefix lists candidates (`Ambiguous skill '$te'. Did you mean: $team, …`); and an unknown `$word` lists the available skills (prefix-first, then fuzzy-subsequence) instead of silently sending the typo to the model. `$UPPERCASE` env-var-style tokens (e.g. `$HOME`) pass through untouched.
- Per-session input-box border hue: each newly opened jeo session gets a distinct border color so several concurrent sessions are tellable apart at a glance, and cmd-mode (`!`) overrides it with a caution amber so entering the shell escape is unmistakable.

## [0.5.1] - 2026-06-14
_cmd-mode `!<command>` shell escape — run a shell command without engaging the agent._

### Added
- gjc-parity cmd-mode shell escape: typing `!<command>` at the prompt runs the command directly in the shell and prints its output WITHOUT engaging the agent or touching conversation history (a REPL-style shell escape). Because the user is explicitly driving their own shell, the deep-interview mutation guard — which gates the AGENT's tools — does not apply; bare `!` prints a short usage hint.

## [0.5.0] - 2026-06-14
_Performance: workspace-scan, workflow-state, and DNA-Claw HUD caches; plus a credential-safety fix that never wipes OAuth over an invalid config._

### Fixed
- A schema-invalid `config.json` no longer wipes stored OAuth / provider credentials: the invalid config falls back to defaults while the credential block is preserved, so a bad config edit can't silently sign you out of every provider.

### Changed
- Workspace-tree scan is now LRU-cached per resolved cwd (cap 32), so a long session that touches many trees (subagents, worktrees, cross-tree `/view`) neither re-scans the same directory nor grows the cache without bound.
- Per-skill workflow-state JSON reads are mtime + size-validated cached. The mutation guard reads the workflow lock before every mutating tool, so re-reading and re-parsing each call was wasteful; the cache stays cross-process-safe — a write from another process bumps mtime/size and invalidates it, so an active interview lock can never be missed.
- DNA Claw HUD frames are memoized (LRU-capped) keyed on every input that affects output (grand/unicode/cols/color/level/phase/frame). The live HUD cycles a fixed ~60-frame set at ~120ms, so the 2nd+ cycle is now O(1) lookups instead of recomputing per-line ANSI gradients — lower steady-state HUD CPU.

## [0.4.9] - 2026-06-14
_Live-frame width-clamp (content-sized height) replaces the constant-height approach, typed text shows during a running turn, and a docs/AGENTS refresh._

### Fixed
- Typed text now appears in the input box DURING a running turn — keystrokes entered mid-turn render live in the prompt box (and as a pending steering card) instead of staying invisible until the turn ends.
- Live-frame anchor drift: 0.4.8's constant-height padding could grow the reserve and drift the cursor anchor by one row, reintroducing a duplicate model bar mid-turn. The live frame is content-sized again, and every rendered line is width-clamped to the terminal width so a long line (e.g. the model bar with a deep cwd) can't soft-wrap into a second physical row and desync the differential renderer's 1-line = 1-row accounting — keeping completed cards visible in scrollback above the live frame.
- Renderer `reset()` → `insertAbove()` ordering now erase-line-clears the old frame rows the inserted block did not cover (`occupied = max(prev, coverRows)`), closing the remaining duplicate-model-bar / orphaned-border case.

### Changed
- Regenerated every directory `AGENTS.md` guide and pruned stale working docs (the rolling improvements log, promo assets, and one-off review/analysis notes) so the tracked docs reflect the current tree.

## [0.4.8] - 2026-06-14
_Live-frame stability: constant-height live turn, renderer self-heal off-by-one fix, and frame-safe child-stdout sanitizing — no more duplicate model bar or torn escapes._

### Fixed
- The live turn now renders at a CONSTANT height: the in-flight tool-output / thinking block reserves a fixed row count (bottom-anchored, blank-padded at the top) and the whole frame is padded to exactly the terminal's rows. Streaming stdout growth no longer thrashes the frame height every 100ms — the height change that desynced the differential renderer and duplicated the model bar is gone.
- Renderer self-heal reset now remembers how many rows are physically on screen (`coverRows`), so a repaint of a SHORTER frame erase-line-clears the rows it no longer covers — fixing the persistent off-by-one that left a duplicate model bar / orphaned borders after a reset.
- Raw child stdout is sanitized before entering the live frame (`sanitizeForFrame`): carriage returns, erase-line/cursor-move escapes, OSC sequences, and incomplete trailing escapes are stripped (SGR color kept) so a streaming `bun test`'s `\r\x1b[2K` progress lines can no longer tear the renderer's own `\x1b[2K` (printing a literal "2K") or hijack the cursor.

## [0.4.7] - 2026-06-14
_Detached subagents + `subagent` control tool, live shaded in-flight output, registry-driven providers, fuller `read` budget, styled italics in the final report, and `gjc` retired._

### Added
- Detached subagents: `task {detached:true}` launches a background subagent and returns immediately; a new `subagent` control tool lists, inspects, awaits (optionally bounded), and cancels them (gjc parity, in-process turn-scoped registry — `cancelAll()` on teardown prevents background-promise leaks).
- Live shaded in-flight output: the running tool's stdout (bash) and native thinking deltas stream as a DIMMED bounded block above the status line, then flush UN-dimmed into scrollback once the model commits — gjc's "shaded until complete" effect.
- Update-check disk cache (`~/.jeo`): the update banner is instant from cache with a background refresh, and clears itself after an interim upgrade.

### Changed
- Provider registry bootstrap: `register-providers.ts` registers every built-in adapter; `model-manager` resolves adapters through the registry alone and no longer imports or names concrete providers — new built-ins register in one place.
- `read` default (no `lineRange`) now fills the model-visible output budget with WHOLE lines instead of a fixed 500-line cap, so a single read returns more of a file and forces far less needless pagination.
- Tool-output handling (model-visible budget, both-ends truncation, recoverable artifact spilling) extracted from `engine.ts` into `tool-output.ts`; `engine.ts` re-exports for compatibility.
- Final-report markdown: single `*italic*` / `_italic_` is now styled (list-bullet- and snake_case-safe), and a heading that follows content gets one blank line of breathing room above it.
- Mid-turn steering query now renders as a `user` card in scrollback; per-theme `userCard` palette and todo-card rendering refinements.

### Removed
- The `gjc` command and the bundled `gjc` skill — the skills catalog now ships five workflows (deep-interview, deep-dive, ralplan, team, ultragoal).

## [0.4.6] - 2026-06-14
_Width-correct forge cards for CJK/emoji, red borders on failed tool cards, aligned `ooo ralph` monitor HUD, and a per-theme user-card palette._

### Fixed
- Forge tool cards no longer tear their right border when the body contains CJK/Hangul/emoji: content wraps by DISPLAY width (wide glyphs count 2 columns) instead of code-point count, so a Korean line that previously rendered ~2× wide now stays inside the card at every width.
- The `ooo ralph` monitoring HUD box borders stay flush: every row is padded by display width (ANSI-aware) and the box auto-sizes to its widest row, replacing `String.padEnd` on colored strings that counted SGR escape bytes and spilled the right edge.

### Changed
- Failed forge tool cards now render with a red border (gjc-style state-encoded border) so failures pop out of scrollback at a glance; successful/neutral cards keep the theme accent identity.
- Every built-in theme now ships a `userCard` palette (accent/border/shadow/fill) for the mid-turn steering user card.
- `describeModel`/`resolveModelId` accept an already-read config to skip a redundant global-config read on the turn hot path.

## [0.4.5] - 2026-06-14
_First-class filesystem make/remove tools._

### Added
- `mkdir {dirPath}` tool: create a directory (parents included, idempotent) as a first-class tool instead of shelling out to `bash` — honors the deep-interview mutation lock and prefix-restricted roles.
- `delete {path, recursive?}` tool: remove a file (or a directory with `recursive:true`); refuses to wipe the working directory, treats a missing path as a soft error, and clears the file-freshness snapshot so a later write to the same path is not rejected as stale.

### Changed
- Read-only subagent lanes (planner/architect/critic) now also drop `mkdir`/`delete`, keeping review roles physically unable to mutate the repo.

## [0.4.4] - 2026-06-13
_Live subagent status mirroring, always-useful Ctrl+O activity tail, read lineRange crash guard._

### Added
- Per-turn activity-history ring (bounded at 200 plain-text entries): Ctrl+O now always answers "what has been happening" — the detail panel appends a timestamped `+N.Ns` recent-activity tail even before the first reply or tool detail exists.

### Changed
- The live status row now mirrors a delegated subagent's LATEST nested event (`EXECUTOR ✓ read src/…`) instead of a static `Task: executor …` title — a long `task` no longer reads as an opaque "calling model" stall.

### Fixed
- `read` no longer crashes with `spec.split is not a function` when the model passes a numeric/JSON `lineRange` (field bug, reproduced live twice): numbers are coerced, junk degrades to a polite selector error.

## [0.4.3] - 2026-06-13
_Readability pass for autopilot, subagent activity, and worked-history review._

### Added
- `jeo autopilot status` now renders a yellow ratchet status field with task, eval, score direction, keep/revert counts, patience, and the recommended next action.
- `/history` transcript output now adds turn headers and folds the first tool-result line into each tool activity row, so scrollback reads as user → activity → jeo instead of raw protocol traffic.

### Changed
- Subagent activity lines now render as an `AGENT` tree (`▸ ROLE`, `├─ ROLE`, `└─ ROLE`) in both TUI scrollback and non-TTY progress output for faster scanning.
- README command tables now call out `/history` and `autopilot` as first-class readable operation surfaces.
- Removed the standalone `jeo models` command/menu path; model discovery and assignment now stay inside `/model`, `/provider`, and setup/doctor flows.

## [0.4.2] - 2026-06-13
_Thinking-loop termination guarantees (cycle guard + turn wall-clock budget), unboxed live status without step counters, self-contained `.jeo` namespace, live next-prompt input card, role-targeted model/thinking picker._

### Added
- Agent-loop cycle guard: an A↔B tool-call ping-pong (re-reading one file ↔ re-running one command forever) now gets ONE corrective bounce, then a hard stop — the "stuck in thinking" spin the exact-repeat guard could never see.
- Turn wall-clock budget (`JEO_TURN_MAX_MS`, default 30 minutes, `0` disables): step budgets bound the COUNT of model calls, this bounds their total TIME — a turn that crosses it consolidates a wrap-up instead of spinning for hours.
- Live next-prompt input box in the TUI — text typed during a running turn stays in the same query surface instead of a separate queued row.
- jeo discovers skills from its own `~/.jeo/agent/skills` (+ project `.jeo/agent/skills`) and resolves hooks/rules under `.jeo` instead of referencing `.gjc`.
- Config-driven custom subagent roles: a non-bundled id declaring `title`/`description`/`prompt` becomes a first-class role at runtime.
- Ctrl+O mid-turn detail view: flush the full last reply + tool output into scrollback.
- `/fast [on|off|status]` slash command: enables minimal/low reasoning fast mode only when the active model advertises support.
- Task/team subagents now receive the same project context block as the parent agent, sourced from `JEO.md`, `AGENTS.md`, `.jeo/context.md`, `.agents/*`, and `.jeo/*` guidance — legacy `.gjc` context is not loaded.

### Changed
- Live status is UNBOXED: a flat `⠙ thinking · <live activity> ⟦esc⟧` row plus one dim metrics row replaces the bordered status box — the message is never trapped inside a border.
- Removed meaningless `step N/M` counters everywhere (status row, footer, plain-stream `[step N/M]` headers, nested subagent lines) along with step-driven `eta`/`evo %`: the dynamic step budget keeps extending the denominator, so the counters carried no information. The evolution stage track stays.
- Tool-call signature bookkeeping (repeat/cycle guards, step-budget novelty set) now stores fixed-size FNV digests instead of full JSON argument strings — a long turn's guard memory stays flat even when `write` calls embed whole file bodies.
- Unified model targeting: `/model` can now set default thinking, pick a model, apply it to the default agent or any subagent role, and set that target's thinking level in one flow.
- `/model` picker now shows DEFAULT/role badges with each target's thinking level, and the post-pick action menu uses the unified Set-as-role format plus an OpenAI Codex role preset.
- `/model` action selection now uses a Ralph-style nested sub-list: each DEFAULT/role header expands into selectable thinking rows, so target and thinking are chosen in one TUI screen.
- During a live reasoning turn, typed next-user text now renders as a styled pending `user` card with dark background while the normal input box remains editable.
- Update availability now renders as a yellow full-width field instead of a boxed card, matching the status-field TUI treatment.
- Removed the legacy `/models` slash-menu path; `/model` and `/provider` own interactive model selection.
- Canonicalized runtime naming on `.jeo` and `JEO_` only.

### Fixed
- jeo can no longer sit in "thinking" forever: every turn now terminates via the cycle guard, the wall-clock budget, or the existing step/repeat/failure guards — pathological spins consolidate a wrap-up instead of running unbounded.
- Ctrl-C now force-quits jeo immediately instead of being softened into an abort prompt.
- Done-time todo reconciliation gate — stale Todos can no longer survive a finished turn.
- MCP stdio framing for ralph tools.

## [0.4.1] - 2026-06-12
_TUI card parity polish + done-time todo reconciliation._

### Added
- gjc card parity: `⟦Ctrl+O for more⟧` clip hint, code highlighting in card bodies, and full tool output via Ctrl+O.

### Fixed
- Clip hint also covers summarize-stage markers.
- Done-time todo reconciliation gate so a finished turn's checklist reflects what actually completed.

## [0.4.0] - 2026-06-12
_Verified TUI, resilient engine, batch input, multilingual docs._

### Added
- Bracketed-paste batch input — a multi-line paste runs one command per line, in order (prompt_toolkit paste contract).
- jeo-ref transcript parity: Todo Write tree cards, line-numbered write previews, agent-name reasoning blocks, tree-style skill detail.
- Seed writer/parser round-trip integrity with a freeze-time assert.
- Slow-drip stream deadline + acceptance-criteria quality floor.

### Fixed
- Anthropic refusal recovery: context reset per the provider contract, neutral continuation note, OAuth/API-key guidance.
- Model discovery repaired against live endpoints (codex `client_version`, gemini pagination).

## [0.3.0] - 2026-06-02
_OAuth credentials + local Ollama provider._

### Added
- OAuth login (`jeo auth`) and a local Ollama provider.
- `jeo doctor`, multi-tool-call grouping, and CI/install hardening.

## [0.2.1] - 2026-06-02
_Setup and model configuration._

### Added
- `jeo setup` and `jeo models`; default Gemini 2.5-flash; verified real LLM turn.

## [0.2.0] - 2026-06-02
_Real LLM coding agent._

### Added
- Real LLM coding agent with provider + model configuration.

## [0.1.0] - 2026-06-01
_Initial release._

### Added
- Initial jeo-code agent and CLI.

[Unreleased]: https://github.com/akillness/jeo-code/compare/v0.4.5...HEAD
[0.4.5]: https://github.com/akillness/jeo-code/releases/tag/v0.4.5
[0.4.4]: https://github.com/akillness/jeo-code/releases/tag/v0.4.4
[0.4.3]: https://github.com/akillness/jeo-code/releases/tag/v0.4.3
[0.4.2]: https://github.com/akillness/jeo-code/releases/tag/v0.4.2
[0.4.1]: https://github.com/akillness/jeo-code/releases/tag/v0.4.1
[0.4.0]: https://github.com/akillness/jeo-code/releases/tag/v0.4.0
[0.3.0]: https://github.com/akillness/jeo-code/releases/tag/v0.3.0
[0.2.1]: https://github.com/akillness/jeo-code/releases/tag/v0.2.1
[0.2.0]: https://github.com/akillness/jeo-code/releases/tag/v0.2.0
[0.1.0]: https://github.com/akillness/jeo-code/releases/tag/v0.1.0
