# 03 — Install Plan (bun-native install & distribution)

> Bun-native install today; a prebuilt single binary and package-manager
> distribution next, so `jeo` installs without a source checkout.

**Status:** `shipped` · **Last updated:** 2026-06-12 · **Tracking pass:** `docs/improvements.md` & `progress.txt`
≔73y5..74rt
- 2026-06-05 — plan created; M0 install (bun link) already shipped (§12, §16).
- 2026-06-11 — Single binary compilation (`bun build --compile`) and distribution shipped. `dist/jeo` is now the primary execution target.

---

## 1. Goal
One canonical, bun-native installer that auto-installs Bun, enforces the version
floor, registers the `jeo` bin, and prints a PATH hint; later, ship a prebuilt
binary and npm/Homebrew paths so non-bun users can install too.

## 2. Current State (cite evidence)
- **Top-level shim** `install.sh` delegates to the canonical installer:
  `exec sh scripts/install.sh --local "$@"`.
- **Canonical installer** `scripts/install.sh`: `require_bun` (auto-installs Bun,
  enforces `MIN_BUN_VERSION=1.3.14`) → `bun install` (deps) → `bun link` (registers the package in
  bun's global registry and exposes `jeo` at `${BUN_INSTALL:-~/.bun}/bin/jeo`) → compat symlink at
  `${JEO_INSTALL_DIR:-~/.local/bin}/jeo` → PATH hint. Modes: `--local` / `--source` / `--ref`.
- **Uninstall** `scripts/uninstall.sh`: removes both bins, unregisters from the bun global
  registry, `--purge` removes `~/.jeo/`.
- **Runtime guard**: `src/cli.ts` re-checks `Bun.semver.order(Bun.version, "1.3.14")` and
  sets `process.title`.
- **bun scripts**: `package.json` → `start` / `typecheck` / `test`.
- Verified end-to-end (passes 12, 16) incl. a real `ollama/qwen2.5:0.5b` run through the bun-linked binary.

## 3. Target State (gjc / pi-mono parity)
- **gjc**: `scripts/install.sh` (source-via-bun + prebuilt-binary modes) and a thin npm wrapper package
  `packages/gajae-code` (`bun install -g gajae-code`).
- **pi-mono**: npm-published CLI with shrinkwrap; release smoke-tests isolated npm + Bun installs.
- **jeo** decision: keep `bun link` as the dev/source path; add a **`bun build --compile` single binary**
  for zero-dependency installs, then an optional thin npm wrapper.

## 4. Design & Architecture
- Add `scripts/build-binary.sh`: `bun build src/cli.ts --compile --outfile dist/jeo` (+ `--target` matrix).
- Add `--binary` mode to `scripts/install.sh`: download/copy the prebuilt `jeo` into the install dir
  (skips `bun install`/`bun link`). Keep `--local`/`--source`/`--ref` unchanged.
- Optional `packages/jeo-code/` thin wrapper exposing `bin: jeo` for `bun install -g`/`npm i -g`.

## 5. Implementation Steps
- **Slice 1 — build-binary script + `--binary` install mode** (`scripts/build-binary.sh`,
  edit `scripts/install.sh`). → `executor`.
- **Slice 2 — CI release smoke test** (a script that installs into a temp dir via each mode and runs `jeo --version`). → `executor`.
- **Slice 3 — thin npm wrapper package** (deferred until a publish target exists).

## 6. Acceptance Criteria (testable)
- [ ] `bash scripts/build-binary.sh` produces `dist/jeo` that runs `jeo --version` → `jeo v0.1.0` with **no bun on PATH**.
- [ ] `sh scripts/install.sh --binary` installs that binary and `jeo --help` works.
- [ ] Existing `--local` (bun link) path remains green (re-run pass-16 e2e).
- [ ] Clean-env smoke test exits 0 for `--local` and `--binary`.

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| `bun --compile` misses runtime deps (zod/chalk) | Medium | compile bundles deps; smoke-test the binary in an env with **no** node_modules |
| Cross-arch binaries | Medium | start with host arch only; add `--target` matrix later |
| Two install mechanisms confuse users | Low | one installer, mode flags; README documents the default (`--local`) |

## 8. Verification Steps
```bash
bash scripts/build-binary.sh
env -i HOME=/tmp/h PATH=/usr/bin:/bin dist/jeo --version    # no bun on PATH
sh scripts/install.sh --binary && jeo --help
sh scripts/install.sh --local && jeo --version              # bun-link path unchanged
```

## 9. Long-term / Future
- Multi-arch release pipeline + checksums; Homebrew formula; `jeo update --self`.

## 10. Changelog
- 2026-06-05 — plan created; M0 install (bun link) already shipped (§12, §16).
