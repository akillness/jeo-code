---
description: Per-prompt workflow order - openspace, rtk, semble, jev, then project memory
alwaysApply: true
---
<!-- JEO-WORKFLOWS:START -->
# Workflow Rules (openspace → rtk → semble → jev, then project memory)

Applies automatically to every prompt in every project. The user never has to
name these tools or run setup. Written and refreshed by `scripts/setup-workspace.py`;
re-running the installer updates this block in place.

## Per-prompt order

Run in this order. If a tool is missing, say so in one line and continue.

1. **openspace** — weighted prior / standalone fallback. When a Jev profile is enabled
   for this host, OpenSpace's local BM25 (`~/.agents/venvs/openspace/bin/python ~/.agents/skills/openspace/scripts/route_prompt.py --json "<prompt>"`)
   acts only as a weighted prior fed into Jev (do not treat a standalone OpenSpace hook
   note as final when Jev is active). When NO Jev profile is enabled, OpenSpace is the
   standalone skill router: load the named skill from any hook note, or run
   `~/.agents/venvs/openspace/bin/python ~/.agents/skills/openspace/scripts/route_prompt.py --explain "<prompt>"`
   (the system `python3` lacks the `openspace` module) and load the top match.
2. **rtk** — every shell command goes through the rtk hook; where the hook is not
   active, prefix the command with `rtk`.
3. **semble** — discovery before reading: `semble search "<query>" <path>`, then
   `semble find-related <file> <line> <path>`. No grep-and-read of whole files.
4. **jev** — only after steps 2 and 3 both ran for this prompt, and only when a Jev
   profile is enabled (`node ~/.agents/jev/jev-harness.mjs --profile "$JEV_PROFILE" status`).
   Then `route-skills --prefilter bm25 --top-k 3 "<task>"` is the unified skill router
   (combining `skills.json` metadata BM25, `SKILL.toon`/section excerpts, and OpenSpace's
   BM25 prior weights) and, before a risky action, `review` / `gate-tool`. Never run
   jev before rtk and semble; skip silently when no profile is enabled (step 1 openspace
   handles routing). Details: `jev-control-plane.md`.
5. **Route by query type** (below).

## Route by query type

- **Knowledge, past decisions, notes** → repo-local `knowledge/` (`knowledge/index.md`,
  `knowledge/work/active/`, paired to code via `.mex/context/knowledge-pairings.md`)
  and second-brain vault `/Users/jangyoung/vaults/jeo-second-brain`. Read `knowledge/index.md` or vault `index.md`
  first; `raw/**` is immutable. If neither is initialised, say "second-brain pending"
  and fall back to normal search.
- **Code structure, callers, impact, project conventions** → mex. Read
  `.mex/ROUTER.md` first when it exists (an empty `.mex/` means mex has not run:
  say so and use semble), then `mex-agent wiki for-code <nodeId>`,
  `mex-agent graph query ...`, and `mex-agent impact <symbol|file>` before editing.
  Use `mex-agent`, never bare `mex` (TeX Live ships a `mex`).
- **Meaning-based search when the exact name is unknown (Context Gate)** →
  - Past queries/work/concepts: `zg query "<q>" -g 'knowledge/**' -g '!knowledge/raw/**' -g '!knowledge/work/archive/**' --preview none --limit 5`, then read matched line ranges only.
  - Code only: `zg query "<q>" -g '!knowledge/**' --preview none --limit 8`, then confirm with `rg` or a file read. Exact identifiers go to `rg`, not `zg`.
  If `zg status --check-ready` fails, run `zg index` (incremental), then query.
- **Code graph / DB fallback (jeox via ../jeo-code)** — when `.mex/` is missing or mex is unavailable,
  `.jeo/db/jeo.db` is managed exclusively by `../jeo-code` (`jeo jeox` / `packages/jeo-mem`):
  `jeo jeox who-calls|what-calls|where-defined|impact <name>`, `jeo jeox query "<q>" -g GLOB...`,
  `jeo jeox build` to refresh. MCP hosts call the same via the `jeox` server
  (`jeox_where_defined`, `jeox_who_calls`, ...).
- **RDF / OWL / SHACL / ontology work** → the `open-ontologies` skill, via its CLI
  `batch -` mode. Start no network listener and register no MCP server on your own.
- **Improving this agent harness (rules, prompts, skills, hooks)** → harness2 method
  mode. `.harness2/workspace.json` maps the eight harness components to real files.

## Global Default vs Project Override

- **Global defaults** live in `~/.agents/rules/jeo-workflows.md` and `~/.agents/harness/workspace.json`.
  Every project inherits this workflow automatically unless overridden locally.
- **Per-project isolated workflow**: configuring `<project>/.harness2/workspace.json` with
  `"workflow": {"custom": true, ...}` (via `scripts/setup-workspace.py --custom-workflow`)
  isolates that project's pipeline order, Jev profile, and skill root so global refreshes
  preserve project-specific workflows untouched.

## Staying current

- After meaningful work: `mex-agent log "<note>"`, `mex-agent check`, `zg index`.
- Git post-commit hooks (`mex-agent watch` and the `zg index` block) and the
  second-brain cron schedules refresh memory without a command from the user.
- Re-running the installer refreshes rules, `.mex/`, the zvec index and the
  `.harness2/` manifest.
- **Single-source host skill isolation**: shared-root runtimes (`jeopi`, `omp`, `gjc`,
  `jeo`, `codex`, `opencode`, `cursor`, `kimi`) read `~/.agents/skills` and their own
  native root without scanning foreign `.claude/skills` or duplicating shared-root symlinks.
<!-- JEO-WORKFLOWS:END -->
