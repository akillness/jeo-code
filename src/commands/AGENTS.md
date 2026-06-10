<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# commands

## Purpose
Collection of CLI subcommand modules. Each module implements one command (e.g. `launch`, `deep-interview`, `ralplan`, `team`) as a free function.

## Key Files
| File | Description |
|------|-------------|
| `launch.ts` | The main interactive agent command (REPL, slash commands, autocomplete, live previews) |
| `setup.ts` | Step-by-step interactive picker for provider API keys, OAuth, or local models |
| `setup-helpers.ts` | Formatters and terminal prompt helper utilities for setup |
| `auth.ts` | Authenticates against cloud providers via browser PKCE |
| `doctor.ts` | Performs health checks on API keys, local Ollama, and network latency |
| `models.ts` | Prints model capability tables, aliases, local models, and checks credentials status |
| `deep-interview.ts` | Drives the Socratic requirements gathering loop until ambiguity <= 20% |
| `ralplan.ts` | Runs the planning pipeline and generates blueprint designs |
| `approve.ts` | Approves a plan, unlocking it for execution |
| `team.ts` | Drives the multi-agent task execution queue using subagent roles |
| `ultragoal.ts` | Verifies final work against acceptance criteria |
| `skills.ts` | Lists or describes custom project skills |
| `resume.ts` | Resumes a previous interactive session from history |
| `chat.ts` | Single-shot streaming conversation without tools |
| `evolve.ts` | Renders a simulation of TUI evolution stages |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- Every command must export `runXCommand(args: string[]): Promise<void>`.
- Keep command inputs, flags, and outputs compatible with `gjc` CLI options.

## Dependencies

### Internal
- `src/agent/` (calls agent tool loop and loads config/sessions)
- `src/ai/` (queries model discovery and catalog)
- `src/tui/` (builds TUI layout, select lists, and welcome animations)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
