<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-07 | Updated: 2026-06-07 -->

# scripts

## Purpose
Utility scripts directory containing shell helpers for installation, uninstallation, and local checks.

## Key Files
| File | Description |
|------|-------------|
| `install.sh` | Bun global install script exposing `joc` globally and linking locally |
| `uninstall.sh` | Uninstall script removing global binaries and purifying local configuration |
| `smoke-test.sh` | Local health check executing basic commands to verify installation |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- Keep shell scripts POSIX-compliant.
- Do not mutate system configuration files directly without warning.

### Testing Requirements
- Run `bash scripts/smoke-test.sh` to quickly verify installation health.

## Dependencies

### External
- POSIX-compliant shell / Bash
- Bun (for local package linking)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
