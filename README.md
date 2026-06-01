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

## MVP — jeo ledger (P3, 동작 검증 완료)

`ledger/review/cleanup`을 잇는 크로스-plan 원장 CLI (Bun, 외부 의존성 0). 루프:

```text
register → review(gate) → checkpoint → sweep(cleanup) → status
```

```sh
bun ledger/jeo-ledger.ts init
bun ledger/jeo-ledger.ts register G001 --title "..." --brief "..."
bun ledger/jeo-ledger.ts review G001 --status CLEAR --evidence "..."
bun ledger/jeo-ledger.ts checkpoint G001 --goal g1 --status complete --evidence "..."
bun ledger/jeo-ledger.ts sweep G001 --evidence "..."
bun ledger/jeo-ledger.ts status            # 또는 --json
```

plan은 review=CLEAR + 모든 goal=complete + sweep≥1 일 때만 `verified`. 원장은 append-only(`.jeo/ledger.jsonl`), 상태는 이벤트 폴딩으로 도출.

- 스킬 진입점: [`skills/jeo/SKILL.md`](skills/jeo/SKILL.md) (GJC customDirectories로 `/skill:jeo` 노출)
- 이벤트 스키마: [`ledger/schema.md`](ledger/schema.md)
- 고정 계약: [`.ouroboros/seeds/seed_jeo-mvp.yaml`](.ouroboros/seeds/seed_jeo-mvp.yaml)
- 검증: init→register→review→checkpoint→sweep→link→status E2E + 음성 케이스 통과 (verdict=verified)

## 분석 1차 자료

- 원본 레포 README + `docs/codebase-overview.md`
- 로컬 설치 소스: `@gajae-code/coding-agent@0.2.2` (`~/.bun/install/global/node_modules/@gajae-code/coding-agent/src`)
- 본 분석 환경 자체가 `gjc` 런타임에서 수행됨 (런타임 동작 1차 검증 가능)

## License

분석 문서는 MIT. 원본 gajae-code 역시 MIT(© Yeachan-Heo).
