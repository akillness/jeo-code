<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# scripts

## Purpose
Utility, maintenance, and installation scripts for `jeo-code`. Contains standalone operational tools that don't belong in the core runtime.

## Key Files
| File | Description |
|------|-------------|
| `deepinit.ts` | Brief description of purpose |
| `dev-link.ts` | `dev:link`/`dev:doctor` — symlink the global `jeo` to this checkout's `src/cli.ts` (PATH-shadow guarded, `--version` smoke test) and report linked/drift/missing source resolution |
| `evolution-schedule.sh` | Brief description of purpose |
| `install.sh` | Global installation script for macOS/Linux |
| `smoke-test.sh` | Basic sanity verification script |
| `sync-changelog.ts` | Brief description of purpose |
| `uninstall.sh` | Uninstallation script |
| `verify-models.ts` | Tests connectivity and model availability across providers |

## Subdirectories
*(None)*

## For AI Agents

### Working In This Directory
- Shell scripts should be POSIX compliant where possible, or explicitly declare `#!/bin/bash`.
- TypeScript scripts should be executable via `bun run`.
- Keep scripts standalone with minimal complex dependencies.

### Testing Requirements
- Run shell scripts manually or via `bun test` wrappers if available.

### Common Patterns
- Direct OS-level interactions (file copying, symlinking, env checks).

## Dependencies

### Internal
- May invoke `jeo` binary or `src/cli.ts`.

### External
- System utilities (bash, curl, rm, ln).
- Bun runtime.

<!-- MANUAL: -->
