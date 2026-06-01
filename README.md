# jeo-code

> 분석 대상: [Yeachan-Heo/gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`, MIT)
> 목적: gajae-code의 아키텍처/워크플로를 분석하고, `jeo-code` 방향성을 정리하기 위한 분석 레포.

`jeo-code`는 gajae-code(GJC)의 "작은 공개 표면 + 단단한 런타임" 철학을 분석하고,
거기에 **통합 프로젝트 원장(ledger) + 계획 리뷰 + 정리(cleanup) 워크플로**(`jeo` 라인)를
얹는 방향을 탐구하는 프로젝트다.

## 핵심 한 줄

gajae-code의 단일 유용 루프:

```text
deep interview -> ralplan -> team execution -> ultragoal verification
```

## 분석 문서 (docs/)

| 문서 | 내용 |
| --- | --- |
| [docs/01-architecture-analysis.md](docs/01-architecture-analysis.md) | 모노레포 패키지 경계, 런타임 플로우, 네이티브 레이어 |
| [docs/02-workflow-skill-surface.md](docs/02-workflow-skill-surface.md) | 4 스킬 + 4 역할 에이전트, 스킬/룰 디스커버리, 도구 표면 |
| [docs/03-jeo-code-plan.md](docs/03-jeo-code-plan.md) | jeo-code 차별화 방향, jeo 라인 통합, 로드맵 |
| [docs/04-autopilot-autoresearch.md](docs/04-autopilot-autoresearch.md) | `jeoc autopilot` 설계: autopilot×autoresearch 래칫, 네이밍 맵 |

## `jeoc` CLI (동작 검증 완료)

리브랜드: 바이너리 `jeoc`, 제품 `jeo-code`, 상태 `.jeoc/` (upstream `gjc`/`gajae-code`/`.gjc`의 리브랜드).
umbrella CLI: [`bin/jeoc.ts`](bin/jeoc.ts) → `jeoc autopilot` / `jeoc ledger`. 외부 의존성 0 (Node stdlib).

### `jeoc autopilot` — autopilot × autoresearch 래칫

`/skill:autopilot`(end-to-end 빌드)에 `/skill:autoresearch`의 규율(평가기 고정 · 한 번에 한 변경 · 점수 기반 keep/revert · append-only 로그 · baseline 우선 · 수렴/중단)을 이식.

```text
init(평가기 고정) → baseline → [ mutate(한 변경) → eval → 개선? keep : revert → log ] → 수렴/중단
```

```sh
jeoc autopilot init --task "make tests green" --eval "bash eval.sh" --goal min --patience 3
jeoc autopilot baseline
jeoc autopilot loop --runner "bash mutate.sh" --max 20 --on-revert "git checkout -- ."
jeoc autopilot status --json
```

- eval 계약: min/max goal은 `score: <num>` 출력, gate goal은 exit code(0=pass).
- 구현: [`src/autopilot.ts`](src/autopilot.ts) · 스킬 분기: [`skills/autopilot/SKILL.md`](skills/autopilot/SKILL.md) · 설계: [`docs/04-autopilot-autoresearch.md`](docs/04-autopilot-autoresearch.md)
- 검증: baseline 10 → 5로 래칫 → plateau revert×3 → 수렴 중단(best=5). 회귀 revert·gate·평가기 고정 모두 통과.

### `jeoc ledger` — 크로스-plan 원장 (ledger/review/cleanup)

```sh
jeoc ledger init
jeoc ledger register G001 --title "..." --brief "..."
jeoc ledger review G001 --status CLEAR --evidence "..."
jeoc ledger checkpoint G001 --goal g1 --status complete --evidence "..."
jeoc ledger sweep G001 --evidence "..."
jeoc ledger status            # 또는 --json
```

plan은 review=CLEAR + 모든 goal=complete + sweep≥1 일 때만 `verified`. append-only(`.jeoc/ledger.jsonl`), 상태는 이벤트 폴딩으로 도출.

- 구현: [`src/ledger.ts`](src/ledger.ts) · 스키마: [`ledger/schema.md`](ledger/schema.md) · 고정 계약: [`.ouroboros/seeds/`](.ouroboros/seeds/)

## 분석 1차 자료

- 원본 레포 README + `docs/codebase-overview.md`
- 로컬 설치 소스: `@gajae-code/coding-agent@0.2.2` (`~/.bun/install/global/node_modules/@gajae-code/coding-agent/src`)
- 본 분석 환경 자체가 `gjc` 런타임에서 수행됨 (런타임 동작 1차 검증 가능)

## License

분석 문서는 MIT. 원본 gajae-code 역시 MIT(© Yeachan-Heo).
