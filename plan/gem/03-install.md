# 03 — Install Plan (hybrid uv & bun-native distribution for gem)

> Hybrid Python/uv packaging wrapping a Bun-native agent execution binary.
> Fully installable via `uv tool install` or `pip install`, with fallback local dev linking.

**Status:** `planned` · **Owner:** Agent · **Last updated:** 2026-06-05 · **Tracking pass:** `docs/improvements.md §M6`

---

## 1. Goal
Provide a seamless, multi-ecosystem installer. Python developers should be able to run `uv tool install gem-ai` (or `pip install gem-ai`) and get a working `gem` command. Node/Bun developers can run `bun link`. The installation layer must automatically check for Bun, enforce version requirements, compile the native binary, and set up system paths.

## 2. Current State (cite evidence)
- `jeo-code/install.sh` is a pure bash script that runs `bun install` and symlinks `coding-agent/src/cli.ts` to `~/.local/bin/joc`.
- There is no Python packaging (`pyproject.toml` or `setup.py`) or integration with `uv` (Python packaging manager).
- Developers must have Bun pre-installed; there is no auto-installer or pre-compiled single-binary compilation script in the base repo.

## 3. Target State (gjc / pi-mono parity)
- **gjc:** Exposes `install.sh` wrapping `bun install` and `bun link`, distributing via npm package `gajae-code`.
- **ooo** (`Ouroboros`): Distributes via `pip install Ouroboros-ai` (managed by `uv`/pip) with a native Textual/Python monitor and modular runtimes.
- **gem** decision: Adopt a **hybrid packaging** model. We write a `pyproject.toml` so that `uv` can install `gem`. The python entrypoint acts as a lightweight launcher that automatically bootstraps the Bun runtime, installs JS/TS dependencies, compiles the TS codebase into a single binary, and forwards arguments. For development, a `bun link` pathway remains first-class.

## 4. Design & Architecture
Project structure:
```
gem-project/
├── pyproject.toml         # uv tool description; defines console_scripts: gem = "gem_cli:main"
├── package.json           # Bun project description
├── gem_cli/               # Python wrapper package
│   ├── __init__.py
│   └── main.py            # Python launcher: probes bun -> compiles TS -> spawns Bun binary
├── coding-agent/          # TS/Bun coding agent codebase
│   └── src/cli.ts
└── scripts/
    ├── install.sh         # Bash-native full installer
    └── build.sh           # Bun compiler script
```

Spawning flow:
```
[User runs: gem launch]
        │
        ▼
[gem_cli/main.py] ──(Checks Bun PATH)──▶ [Not Found] ──▶ Auto-installs Bun
        │
        ├──────────────────────────────▶ [Found]
        ▼
[Spawns compiled Bun binary or bun run src/cli.ts --with-args]
```

## 5. Implementation Steps
- **Slice 1 — Python Wrapper & Launcher** (`pyproject.toml`, `gem_cli/main.py`, `gem_cli/__init__.py`):
  Write the Python launcher script that probes for Bun, downloads it if missing, and executes `bun run coding-agent/src/cli.ts` or the compiled binary.
- **Slice 2 — Binary Compactor** (`scripts/build.sh`, edit `package.json`):
  Write the build script that executes `bun build coding-agent/src/cli.ts --compile --outfile dist/gem` for the target platform.
- **Slice 3 — Unified Installer** (`scripts/install.sh`, edit `install.sh`):
  Update `install.sh` to support virtualenv setup via `uv sync` if run in Python environments, or Bun global link if run in JS environments.

## 6. Acceptance Criteria (testable)
- [ ] Running `uv tool install .` from the project root installs the `gem` command to `~/.local/bin/` (or uv bin directory).
- [ ] Executing `gem --version` prints `gem v0.1.0` and correctly routes to the Bun runtime under the hood.
- [ ] Uninstalling via `pip uninstall gem-ai` or `uv tool uninstall gem-ai` cleanly removes all binary launchers.
- [ ] If Bun is missing, the Python launcher prompts the user and successfully auto-installs Bun to `~/.bun/bin/`.

## 7. Risks & Mitigations
| Risk | Severity | Mitigation |
|------|----------|-----------|
| Python subprocess spawning adds command startup latency | Low | The Python script does minimal imports, checks only for on-disk binary existence, and uses `os.execvp` to replace the Python process entirely with the Bun process, eliminating extra process overhead. |
| Portability of `bun --compile` on older Linux kernels | Medium | Provide a fallback to `bun run coding-agent/src/cli.ts` if the compiled binary fails to execute. |

## 8. Verification Steps
```bash
# Verify python packaging
uv venv
source .venv/bin/activate
uv pip install -e .
gem --help

# Verify compiled binary
bun run scripts/build.sh
./dist/gem --version
```

## 9. Long-term / Future
- Distribute compiled binaries to PyPI as wheels for multiple architectures to bypass compiler runs on the user's machine.
- Integrate Homebrew and Apt formula packages.

## 10. Changelog
- 2026-06-05 — Plan drafted.
