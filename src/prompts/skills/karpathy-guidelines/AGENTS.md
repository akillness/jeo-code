<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-10-16 -->

# karpathy-guidelines

## Purpose
Bundled SKILL.md for the `karpathy-guidelines` behavioral guardrails.

## Key Files
| File | Description |
|------|-------------|
| `SKILL.md` | The primary skill definition (Karpathy 4 principles, jeo-operationalized) |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Guidance-only skill: no executor, no file writes, no MCP tool.
- Changes here propagate into the system prompt via `KARPATHY_DISCIPLINE`.

### Testing Requirements
- Covered by `test/karpathy-skill-router.test.ts` (routing + prompt wiring).

## Dependencies

### Internal
- Referenced by `src/skills/catalog.ts` and `src/agent/engine.ts`.
- Source: `multica-ai/andrej-karpathy-skills` (MIT).

<!-- MANUAL: -->
