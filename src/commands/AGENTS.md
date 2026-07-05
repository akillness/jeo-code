<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# commands

## Purpose
Concrete implementations of `jeo` subcommands (e.g., launch, setup, team, ultragoal).

## Key Files
| File | Description |
|------|-------------|
| `approve.ts` | `jeo approve <plan-path>` CLI + exported `approvePlan()` core (schema shape, known roles, persisted [OKAY] consensus, hash-vs-consensus match) — shared with the agent-facing `approve` tool (`src/agent/approve-tool.ts`) so the agent can flip a plan's `approved` flag itself; the identity restriction (human-only) was removed 2026-07 per explicit user direction, the content gate was not |
| `auth.ts` | Brief description of purpose |
| `chat.ts` | Brief description of purpose |
| `deep-interview.ts` | Brief description of purpose |
| `daemon.ts` | `jeo daemon status\|start\|stop\|reload` — manages the background Telegram notification/subagent-control daemon (`src/agent/notify/daemon-control.ts`) |
| `doctor.ts` | Brief description of purpose |

| `evolve-core.ts` | Brief description of purpose |
| `evolve.ts` | Brief description of purpose |
| `export.ts` | Brief description of purpose |
| `launch.ts` | The primary interactive/one-shot execution command |
| `mcp.ts` | Brief description of purpose |
| `notify.ts` | `jeo notify setup\|status` — pairs a Telegram bot (BotFather token + `getMe` verification, private-chat pairing via `getUpdates`) and reports masked settings + daemon state |

| `ooo-seed.ts` | Brief description of purpose |
| `ralplan.ts` | Brief description of purpose |
| `resume.ts` | Brief description of purpose |
| `session.ts` | Brief description of purpose |
| `setup-helpers.ts` | Brief description of purpose |
| `setup.ts` | Guided configuration command |
| `skills.ts` | Brief description of purpose |
| `state.ts` | Brief description of purpose |
| `status.ts` | Brief description of purpose |
| `team.ts` | `jeo team` — executes an approved ralplan plan step-by-step via the SAME `runSubagentOnce` core the `task`/`subagent` tools use; a contiguous run of steps sharing a plan `parallel_group` runs concurrently in isolated git worktrees (`runParallelGroup`), merged back in order (gjc `team` concurrency parity) |
| `ultragoal.ts` | Brief description of purpose |
| `update.ts` | Brief description of purpose |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Commands should handle their own specific setup but delegate core logic to `src/agent/` or `src/tui/`.
- Maintain clean separation between interactive (TTY) and non-interactive modes.

### Testing Requirements
- Mock standard streams (stdout/stdin) to test command outputs.

### Common Patterns
- Command handlers take parsed options, initialize context, and run the main loop or utility function.

## Dependencies

### Internal
- Connects `src/cli/` routing to `src/agent/` and `src/tui/`.

### External
*(None)*

<!-- MANUAL: -->
