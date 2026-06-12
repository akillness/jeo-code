# Changelog

All notable changes to **jeo-code** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The README mirrors the latest 5 entries — regenerate with `bun run changelog:sync`.

## [Unreleased]
_Self-contained `.jeo` namespace for skills/hooks/rules, live next-prompt input box, role-targeted model/thinking picker, hardened Ctrl-C / Ctrl+O._

### Added
- Live next-prompt input box in the TUI — text typed during a running turn stays in the same query surface instead of a separate queued row.
- jeo discovers skills from its own `~/.jeo/agent/skills` (+ project `.jeo/agent/skills`) and resolves hooks/rules under `.jeo` instead of referencing `.gjc`.
- Config-driven custom subagent roles: a non-bundled id declaring `title`/`description`/`prompt` becomes a first-class role at runtime.
- Ctrl+O mid-turn detail view: flush the full last reply + tool output into scrollback.

### Changed
- Unified model targeting: `/model` can now set default thinking, pick a model, apply it to the default agent or any subagent role, and set that target's thinking level in one flow.
- `/model` picker now shows DEFAULT/role badges with each target's thinking level, and the post-pick action menu uses the unified Set-as-role format plus an OpenAI Codex role preset.
- Canonicalized runtime naming on `.jeo` and `JEO_` only.

### Fixed
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

[Unreleased]: https://github.com/akillness/jeo-code/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/akillness/jeo-code/releases/tag/v0.4.1
[0.4.0]: https://github.com/akillness/jeo-code/releases/tag/v0.4.0
[0.3.0]: https://github.com/akillness/jeo-code/releases/tag/v0.3.0
[0.2.1]: https://github.com/akillness/jeo-code/releases/tag/v0.2.1
[0.2.0]: https://github.com/akillness/jeo-code/releases/tag/v0.2.0
[0.1.0]: https://github.com/akillness/jeo-code/releases/tag/v0.1.0
