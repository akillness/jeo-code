---
type: Reference
title: okf_mem 번들 사용법
description: OKF 기반 jeo 메모리 전환 계획 번들의 작업 루프와 규약.
tags: [okf, memory, plan, sprint]
---

# okf_mem 번들 사용법

## 이 번들은 무엇인가

jeo의 메모리를 OKF 포맷으로 관리하도록 재설계하는 **계획 문서 묶음**이자,
그 자체가 OKF v0.1 적합 번들인 도그푸딩 산출물입니다. 코드를 바꾸기 전,
"무엇을/어떤 순서로/어떤 증거로 검증하며" 진행할지를 스프린트별로 고정합니다.

## 디렉토리 레이아웃

```
docs/okf_mem/
├── index.md                       # 번들 루트 진입점 (예약 파일, okf_version 선언)
├── log.md                         # 변경 이력 (예약 파일, ISO 8601 최신 우선)
├── README.md                      # 이 파일
├── concepts/                      # 배경 지식 개념 문서
│   ├── okf-spec-digest.md
│   ├── jeo-memory-current.md
│   ├── graphify-llm-wiki-patterns.md
│   └── target-architecture.md
└── sprint-0N-<name>/              # 스프린트별 폴더 (서로 다른 폴더에서 진행)
    ├── index.md                   # 스프린트 목표/범위/완료기준
    ├── tasks.md                   # 작업 체크리스트 (진행하며 갱신)
    └── handoff.md                 # 다음 스프린트로의 인계 (완료 시 채움)
```

## 작업 루프 (스프린트마다 반복)

1. **참조**: 직전 스프린트 폴더의 `handoff.md`와 번들 루트 [index.md](/index.md)를
   먼저 읽는다. 배경이 필요하면 [concepts/](/concepts/)를 연다.
2. **적재**: 해당 스프린트 `index.md`의 완료 기준(Definition of Done)을 확인하고
   `tasks.md` 체크리스트를 작업하며 상태를 갱신한다(`[ ]` → `[x]`).
3. **검증**: 각 태스크의 "증거(evidence)" 칸에 적힌 명령(`bun test`,
   `bun run typecheck` 등)을 실제 실행하고 결과를 기록한다.
4. **인계**: 스프린트를 닫을 때 `handoff.md`에 산출물 경로, 미해결 이슈,
   다음 스프린트가 가정해도 되는 사실을 적는다.
5. **기록**: 번들 루트 [log.md](/log.md)에 날짜별 항목을 추가한다.

## OKF 규약 (이 번들에 적용)

- 모든 비예약 `.md`는 YAML 프론트매터에 비어 있지 않은 `type`을 가진다.
- 상호 링크는 **번들 기준 절대 경로**(`/concepts/...`)를 우선 사용한다.
- `index.md`/`log.md`는 예약 파일명 — 개념 문서로 쓰지 않는다.
- 깨진 링크는 "아직 작성되지 않은 지식"일 수 있으므로 관용한다.

## 용어

| 용어 | 뜻 |
|------|-----|
| 번들(bundle) | 배포 단위가 되는 마크다운 디렉토리 |
| 개념(concept) | 파일 하나 = 개념 하나. ID는 `.md`를 뗀 번들 기준 경로 |
| 적재(ingest) | 세션/소스에서 지식을 개념 문서로 써 넣는 행위 |
| 증류(distill) | LLM이 전사를 요약해 durable 학습만 남기는 현행 단계 |
