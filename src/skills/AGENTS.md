<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# skills

## Purpose
Skill configuration catalog containing markdown guidelines for Socratic specs, planning consensus, and team execution.

## Key Files
| File | Description |
|------|-------------|
| `catalog.ts` | Loader and parser mapping custom skill files (`*.md`) into agent launch prompts |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- Custom skill prompts are loaded from the project directory (`.joc/skills/`) or global directory (`~/.joc/skills/`) and combined with the default catalog.

## Dependencies

### Internal
- `src/agent/` (prompts are injected into the agent system context)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
