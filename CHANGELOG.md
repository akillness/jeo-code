# Changelog

All notable changes to **jeo-code** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The README mirrors the latest 5 entries — regenerate with `bun run changelog:sync`.

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
