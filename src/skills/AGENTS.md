<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# skills

## Purpose
Framework for discovering, loading, and executing workflow skills (both bundled and user-provided).

## Key Files
| File | Description |
|------|-------------|
| `catalog.ts` | Brief description of purpose |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Skills are primarily markdown files (`SKILL.md`).
- Ensure native workflow routing (e.g., `/skill ralplan` running `src/commands/ralplan.ts`) functions alongside simple prompt injection.

### Testing Requirements
- Test skill resolution order (user directory vs bundled).

### Common Patterns
- Direct slash invocation (`/skill deep-interview`) and CLI equivalent (`jeo deep-interview`).

## Dependencies

### Internal
- Reads from `src/prompts/skills/`.

### External
*(None)*

<!-- MANUAL: -->
