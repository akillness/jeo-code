<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-11 | Updated: 2026-06-14 -->

# .github

## Purpose
GitHub-hosted automation for `jeo-code`: continuous integration and the npm publication pipeline. Defines how the project is built, type-checked, tested, and released to the npm registry.

## Key Files
*(See subdirectories)*

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `workflows/` | GitHub Actions workflow definitions (CI, npm publish) |

### workflows/
| File | Description |
|------|-------------|
| `npm-publish.yml` | Builds with Bun, runs `typecheck` + `bun test`, verifies npm token, and publishes to npm with provenance on release or manual `workflow_dispatch` |

## For AI Agents

### Working In This Directory
- Workflows pin tool versions explicitly (`bun-version: 1.3.14`, `node-version: 22`); keep these in sync with the runtime the project actually targets.
- The publish job is gated on `release: published` or a non-dry-run `workflow_dispatch`; never loosen these conditions without explicit intent.
- `NPM_TOKEN` must be a publish-capable npm Automation/granular token; the workflow fails fast with an explanatory error if it is not.
- Keep `id-token: write` permission for provenance attestation during publish.

### Testing Requirements
- Validate YAML changes with `actionlint` or by triggering a `workflow_dispatch` dry run (`dry_run: true`).
- Publication steps run `bun run typecheck` and `bun test` as gates — mirror those locally before changing them.

### Common Patterns
- Setup actions (`actions/checkout@v4`, `oven-sh/setup-bun@v2`, `actions/setup-node@v4`) followed by frozen-lockfile install (`bun install --frozen-lockfile`).
- Fail-fast guard steps that emit `::error` annotations explaining remediation (e.g., npm 2FA/token guidance).

## Dependencies

### Internal
- Runs the project's `typecheck` and `test` scripts from `package.json`.

### External
- GitHub Actions runners (`ubuntu-latest`), Bun, Node, npm registry.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
