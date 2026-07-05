<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# test

## Purpose
Comprehensive unit and integration test suites for the `jeo-code` project. Ensures correctness of the agent loop, tool execution, TUI rendering, and CLI commands.

## Key Files
| File | Description |
|------|-------------|
| `abort.test.ts` | Brief description of purpose |
| `accurate-token-cache.test.ts` | Brief description of purpose |
| `agents-panel-thinking.test.ts` | Brief description of purpose |
| `animation.test.ts` | Brief description of purpose |
| `ansi-width.test.ts` | Brief description of purpose |
| `anthropic-stream.test.ts` | Brief description of purpose |
| `antigravity-login.test.ts` | Brief description of purpose |
| `antigravity.test.ts` | Brief description of purpose |
| `approve.test.ts` | Brief description of purpose |
| `approve-tool.test.ts` | Agent-facing `approve` tool (`createApproveTool`): explicit/defaulted planPath, missing-state error, and the shared content gate (consensus/hash) surfacing through `ToolResult` |
| `ascii-art.test.ts` | Brief description of purpose |
| `autocomplete.test.ts` | Brief description of purpose |
| `autopilot-status.test.ts` | Brief description of purpose |
| `bash-fixups.test.ts` | Brief description of purpose |
| `capability.test.ts` | Brief description of purpose |
| `category-index.test.ts` | Brief description of purpose |
| `changelog-sync.test.ts` | Brief description of purpose |
| `chat-flags.test.ts` | Brief description of purpose |
| `cli-runner.test.ts` | Brief description of purpose |
| `code-view.test.ts` | Brief description of purpose |
| `codex-responses.test.ts` | Brief description of purpose |
| `color.test.ts` | Brief description of purpose |
| `compaction-touched-files.test.ts` | Brief description of purpose |
| `compaction.test.ts` | Brief description of purpose |
| `config-panel.test.ts` | Brief description of purpose |
| `config-save.test.ts` | Brief description of purpose |
| `config-schema.test.ts` | Brief description of purpose |
| `context-files.test.ts` | Brief description of purpose |
| `cost-dirty.test.ts` | Brief description of purpose |
| `ctrl-o-detail.test.ts` | Brief description of purpose |
| `custom-subagent-roles.test.ts` | Brief description of purpose |
| `cycle-and-turn-budget.test.ts` | Brief description of purpose |
| `deep-interview-noninteractive.test.ts` | Brief description of purpose |
| `deep-interview.test.ts` | Brief description of purpose |
| `dna-claw-anim.test.ts` | Brief description of purpose |
| `doctor.test.ts` | Brief description of purpose |
| `dollar-skill.test.ts` | Brief description of purpose |
| `done-verification-guard.test.ts` | Brief description of purpose |
| `duration.test.ts` | Brief description of purpose |
| `edit-freshness.test.ts` | Blind-edit guard (no-anchor line-range edit requires a same-session read first) and SEARCH-mismatch recovery excerpts; also covers that a write/edit after an EXTERNAL on-disk change now overwrites rather than rejecting (2026-07: stale-read clobber guard removed) |
| `engine-multitool.test.ts` | Brief description of purpose |
| `engine-salvage.test.ts` | Brief description of purpose |
| `engine-spill.test.ts` | Brief description of purpose |
| `engine.test.ts` | Brief description of purpose |
| `env-helper.test.ts` | Brief description of purpose |
| `evolution.test.ts` | Brief description of purpose |
| `evolve.test.ts` | Brief description of purpose |
| `export-html.test.ts` | Brief description of purpose |
| `footer-polish.test.ts` | Brief description of purpose |
| `footer.test.ts` | Brief description of purpose |
| `forge-status.test.ts` | Brief description of purpose |
| `gemini-import.test.ts` | Brief description of purpose |
| `gemini-stream.test.ts` | Brief description of purpose |
| `gemini.test.ts` | Brief description of purpose |
| `google-project.test.ts` | Brief description of purpose |
| `gradient-status.test.ts` | Brief description of purpose |
| `hashline-lite.test.ts` | Brief description of purpose |
| `hashline-remap.test.ts` | Brief description of purpose |
| `hints.test.ts` | Brief description of purpose |
| `hooks.test.ts` | Brief description of purpose |
| `hud.test.ts` | Brief description of purpose |
| `image-attachments.test.ts` | Brief description of purpose |
| `input-box.test.ts` | Brief description of purpose |
| `install-script.test.ts` | Brief description of purpose |
| `launch-approve-wiring.test.ts` | Source-text-level check that launch.ts's `KNOWN_TOOLS`/per-turn `fullTools` wire the `approve` tool (module-local closures, not exported — mirrors `engine-computer-wiring.test.ts`'s pattern) |
| `launch-flag-aliases.test.ts` | Brief description of purpose |
| `launch-flags.test.ts` | Brief description of purpose |
| `launch-repl-eof.test.ts` | Brief description of purpose |
| `launch-role-model.test.ts` | Brief description of purpose |
| `launch-skill-native.test.ts` | Brief description of purpose |
| `launch-toggles.test.ts` | Brief description of purpose |
| `layout.test.ts` | Brief description of purpose |
| `leak-guards.test.ts` | Brief description of purpose |
| `live-model-picker.test.ts` | Brief description of purpose |
| `markdown-text.test.ts` | Brief description of purpose |
| `mcp.test.ts` | Brief description of purpose |
| `memory.test.ts` | Brief description of purpose |
| `meter.test.ts` | Brief description of purpose |
| `model-catalog-compat.test.ts` | Brief description of purpose |
| `model-catalog.test.ts` | Brief description of purpose |
| `model-discovery.test.ts` | Brief description of purpose |
| `model-enrich.test.ts` | Brief description of purpose |
| `model-manager.test.ts` | Brief description of purpose |
| `model-picker.test.ts` | Brief description of purpose |
| `model-provider-mapping.test.ts` | Brief description of purpose |
| `model-recency.test.ts` | Brief description of purpose |
| `model-registry-alias.test.ts` | Brief description of purpose |
| `model-registry.test.ts` | Brief description of purpose |
| `model-roles.test.ts` | Brief description of purpose |
| `model-routing.test.ts` | Brief description of purpose |
| `monitoring.test.ts` | Brief description of purpose |
| `mutation-guard.test.ts` | Brief description of purpose |
| `new-input-first.test.ts` | Brief description of purpose |
| `oauth-lock.test.ts` | Brief description of purpose |
| `oauth.test.ts` | Brief description of purpose |
| `ollama-url.test.ts` | Brief description of purpose |
| `openai-local-base-url.test.ts` | Brief description of purpose |
| `openai-reasoning.test.ts` | Brief description of purpose |
| `openai-responses.test.ts` | Brief description of purpose |
| `output-minimizer.test.ts` | Brief description of purpose |
| `parse-role-gate-verdict.test.ts` | Brief description of purpose |
| `perf-fixes.test.ts` | Brief description of purpose |
| `pickers.test.ts` | Brief description of purpose |
| `post-turn-feedback.test.ts` | Brief description of purpose |
| `provider-empty-completion.test.ts` | Brief description of purpose |
| `provider-error-taxonomy.test.ts` | Brief description of purpose |
| `provider-error.test.ts` | Brief description of purpose |
| `provider-errors.test.ts` | Brief description of purpose |
| `provider-model-id.test.ts` | Brief description of purpose |
| `provider-status.test.ts` | Brief description of purpose |
| `qualify-model.test.ts` | Brief description of purpose |
| `rate-limit-handling.test.ts` | Brief description of purpose |
| `read-budget.test.ts` | Brief description of purpose |
| `refusal-recovery.test.ts` | Brief description of purpose |
| `repeat-bounce-and-trim.test.ts` | Brief description of purpose |
| `retry.test.ts` | Brief description of purpose |
| `review-fixes.test.ts` | Brief description of purpose |
| `round-b.test.ts` | Brief description of purpose |
| `section.test.ts` | Brief description of purpose |
| `seed-roundtrip.test.ts` | Brief description of purpose |
| `select-list.test.ts` | Brief description of purpose |
| `session-command.test.ts` | Brief description of purpose |
| `session-export.test.ts` | Brief description of purpose |
| `session.test.ts` | Brief description of purpose |
| `setup-helpers.test.ts` | Brief description of purpose |
| `skill-echo-guard.test.ts` | Brief description of purpose |
| `skill-picker.test.ts` | Brief description of purpose |
| `skills-command.test.ts` | Brief description of purpose |
| `skills-config.test.ts` | Brief description of purpose |
| `skills-vercel-compat.test.ts` | Brief description of purpose |
| `skills.test.ts` | Brief description of purpose |
| `slash.test.ts` | Brief description of purpose |
| `smoke.test.ts` | Brief description of purpose |
| `spawn-gate-lite.test.ts` | Brief description of purpose |
| `sse.test.ts` | Brief description of purpose |
| `state-command.test.ts` | Brief description of purpose |
| `status-bar.test.ts` | Brief description of purpose |
| `steering.test.ts` | Brief description of purpose |
| `step-budget.test.ts` | Brief description of purpose |
| `step-timeline.test.ts` | Brief description of purpose |
| `stream-events.test.ts` | Brief description of purpose |
| `stream-status.test.ts` | Brief description of purpose |
| `streaming-reasoning.test.ts` | Brief description of purpose |
| `subagent-apply-target.test.ts` | Brief description of purpose |
| `subagent-bash-allowlist.test.ts` | Brief description of purpose |
| `subagent-detached.test.ts` | Brief description of purpose |
| `subagent-live-activity.test.ts` | Brief description of purpose |
| `subagents-setting.test.ts` | Brief description of purpose |
| `subagents.test.ts` | Brief description of purpose |
| `task-tool.test.ts` | Brief description of purpose |
| `team-run.test.ts` | Brief description of purpose |
| `team-schema.test.ts` | Brief description of purpose |
| `team-subagent.test.ts` | Brief description of purpose |
| `themes.test.ts` | Brief description of purpose |
| `tmux.test.ts` | Brief description of purpose |
| `todo-card.test.ts` | Brief description of purpose |
| `todo-done-gate.test.ts` | Brief description of purpose |
| `todo-tool.test.ts` | Brief description of purpose |
| `tokenizer.test.ts` | Brief description of purpose |
| `tools-fs.test.ts` | Brief description of purpose |
| `transcript.test.ts` | Brief description of purpose |
| `transitions.test.ts` | Brief description of purpose |
| `tui-app.test.ts` | Brief description of purpose |
| `tui-components.test.ts` | Brief description of purpose |
| `tui-evolution.test.ts` | Brief description of purpose |
| `tui-frame-width.test.ts` | Brief description of purpose |
| `tui-renderer.test.ts` | Brief description of purpose |
| `tui-welcome.test.ts` | Brief description of purpose |
| `update-box.test.ts` | Brief description of purpose |
| `update-cache.test.ts` | Brief description of purpose |
| `update-command.test.ts` | Brief description of purpose |
| `usage.test.ts` | Brief description of purpose |
| `verify-100.ts` | Brief description of purpose |
| `web-search.test.ts` | Brief description of purpose |
| `width.test.ts` | Brief description of purpose |
| `workflow-integrity.test.ts` | Brief description of purpose |
| `worktree.test.ts` | Brief description of purpose |
| `write-parallel.test.ts` | Brief description of purpose |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Use `bun:test` for all testing utilities (`test`, `expect`, `mock`, `spyOn`).
- Tests should execute quickly; mock external API calls (e.g., LLM providers, OAuth) unless it's a specific e2e integration test.
- Use explicit assertions and descriptive test names.

### Testing Requirements
- Run all tests with `bun test`.
- Individual files can be run via `bun test test/<filename>.test.ts`.

### Common Patterns
- Mocking stdout/stderr for TUI and command output validation.
- Extensive use of temporary directories (`fs.mkdtemp`) for isolated filesystem operations.

## Dependencies

### Internal
- Validates the entire `src/` directory.

### External
- `bun:test`

<!-- MANUAL: -->
