<h1 align="center">jeo-code · <code>jeoc</code></h1>

<p align="center">
  An <b>autopilot × autoresearch ratchet</b> CLI + cross-plan ledger —
  a <a href="https://github.com/Yeachan-Heo/gajae-code">gajae-code</a> rebrand study.
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code/releases"><img alt="release" src="https://img.shields.io/github/v/release/akillness/jeo-code?sort=semver&color=blue"></a>
  <a href="https://github.com/akillness/jeo-code/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/akillness/jeo-code/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun-black?logo=bun">
  <img alt="deps" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen">
  <img alt="tests" src="https://img.shields.io/badge/tests-7%20passing-brightgreen">
</p>

---

`jeoc` keeps the gajae-code philosophy — **small public surface, hardened runtime** —
and adds one idea: make the [autopilot](skills/autopilot/SKILL.md) build loop
**prove** every change with a frozen evaluator, keeping only measured improvements
(the [autoresearch](docs/04-autopilot-autoresearch.md) ratchet).

> Naming map (rebrand of gajae-code): `gjc` → **`jeoc`**, `gajae-code` → **`jeo-code`**, `.gjc/` → **`.jeoc/`**.

## Install

Requires [Bun](https://bun.sh) `>=1.0`. The CLI has **zero runtime dependencies**.

```sh
# A) global install from GitHub
bun install -g github:akillness/jeo-code
jeoc --version            # 0.1.0

# B) from source (clone + link)
git clone https://github.com/akillness/jeo-code
cd jeo-code
bun link                  # registers the global `jeoc` binary
jeoc --version

# C) no install — run straight from a checkout
bun bin/jeoc.ts --version
```

Uninstall: `bun rm -g jeo-code` (or `bun unlink` from the source dir).

## Quickstart

```sh
jeoc help                 # top-level usage
jeoc autopilot help
jeoc ledger help
```

## `jeoc autopilot` — autopilot × autoresearch ratchet

The autopilot end-to-end build loop, hardened with autoresearch discipline:
frozen evaluator · mandatory baseline · one change per step · keep-if-improved /
revert-otherwise · append-only log · convergence/stop.

```text
init(freeze eval) → baseline → [ mutate(one change) → eval → keep|revert → log ] → converge/stop
```

```sh
# 1. freeze the contract (eval + goal become immutable for the session)
jeoc autopilot init --task "make tests green" --eval "bash eval.sh" --goal min --patience 3

# 2. record a baseline score
jeoc autopilot baseline

# 3a. manual: after YOU (or an agent) make one change
jeoc autopilot step --change "add index" --on-revert "git reset --hard HEAD~1"

# 3b. autonomous: a runner makes one change each iteration
jeoc autopilot loop --runner "bash mutate.sh" --max 20 --on-revert "git checkout -- ."

# 4. inspect
jeoc autopilot status --json
```

**eval contract** — `min`/`max` goals: the eval command prints `score: <number>`
(last match wins; `min` keeps lower, `max` keeps higher). `gate` goal: the eval
command's exit code decides (`0` = pass = keep).

State lives in `.jeoc/autopilot/{session.json, log.jsonl}` (log is append-only;
reverted attempts stay as evidence).

## `jeoc ledger` — cross-plan ledger (ledger / review / cleanup)

```sh
jeoc ledger init
jeoc ledger register G001 --title "..." --brief "..."
jeoc ledger review     G001 --status CLEAR --evidence "..."
jeoc ledger checkpoint G001 --goal g1 --status complete --evidence "..."
jeoc ledger sweep      G001 --evidence "..."
jeoc ledger status     # or --json
```

A plan is `verified` only when review = `CLEAR`, all goals `complete`, and ≥1
cleanup sweep. Append-only (`.jeoc/ledger.jsonl`); state is derived by folding events.
Schema: [`ledger/schema.md`](ledger/schema.md).

## Develop & test

```sh
bun test          # 7 end-to-end smoke tests (autopilot ratchet, revert, gate, ledger)
bun bin/jeoc.ts   # run the CLI from source
```

| Path | What |
| --- | --- |
| [`bin/jeoc.ts`](bin/jeoc.ts) | umbrella CLI (`autopilot` / `ledger`) |
| [`src/autopilot.ts`](src/autopilot.ts) | ratchet engine |
| [`src/ledger.ts`](src/ledger.ts) | cross-plan ledger |
| [`skills/autopilot/SKILL.md`](skills/autopilot/SKILL.md) | `/skill:autopilot` branch (jeoc) |
| [`test/smoke.test.ts`](test/smoke.test.ts) | `bun test` suite |

## Analysis docs

| 문서 | 내용 |
| --- | --- |
| [docs/01-architecture-analysis.md](docs/01-architecture-analysis.md) | gajae-code 모노레포 경계, 런타임 플로우, 네이티브 레이어 |
| [docs/02-workflow-skill-surface.md](docs/02-workflow-skill-surface.md) | 4 스킬 + 4 역할 에이전트, 디스커버리, 도구 표면 |
| [docs/03-jeo-code-plan.md](docs/03-jeo-code-plan.md) | jeo-code 방향성, 로드맵 |
| [docs/04-autopilot-autoresearch.md](docs/04-autopilot-autoresearch.md) | `jeoc autopilot` 설계 + 네이밍 맵 |

> docs 01/02 describe the **real upstream gajae-code** (`gjc`) and intentionally keep its original names.

## License

MIT — see [LICENSE](LICENSE). Derivative study of
[Yeachan-Heo/gajae-code](https://github.com/Yeachan-Heo/gajae-code) (MIT).
