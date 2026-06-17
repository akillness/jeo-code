---
type: Sprint
title: Sprint 01 — 포맷 기반 (Format Foundation)
description: OKF 번들 스키마와 .jeo/memory 디렉토리 레이아웃, 프론트매터 규약, 적합성 검증기를 확정한다.
tags: [sprint, okf, schema, foundation]
timestamp: 2026-06-17T00:00:00Z
---

# 목표

jeo 메모리를 OKF 번들로 표현하기 위한 **스키마와 규약을 코드로 고정**한다.
이후 모든 스프린트가 이 계약 위에서 동작한다.

# 범위 (In scope)

- `.jeo/memory/` OKF 번들 레이아웃 확정([목표 아키텍처](/concepts/target-architecture.md) 참조).
- jeo `type` 어휘 정의: `RepoFact`, `Command`, `Gotcha`, `UserPreference`,
  `Reference`. (OKF는 중앙 등록을 요구하지 않으나 우리 생산자/소비자는 합의된
  값을 쓴다.)
- 프론트매터 파서/시리얼라이저(확장 키 round-trip 보존).
- OKF v0.1 적합성 검증기: 비예약 `.md`의 `type` 필수, 예약 파일 구조 점검.
- 개념 ID 계산(`.md`를 뗀 번들 기준 경로) 유틸.

# 범위 밖 (Out of scope)

- 증류 로직 변경(Sprint 02), 주입 변경(Sprint 03), 그래프(Sprint 04),
  기존 데이터 변환(Sprint 05).

# 산출물 (Deliverables)

- `src/agent/memory-okf.ts`(신규): 프론트매터 parse/serialize, 개념 ID,
  적합성 검증 함수. 기존 `memory.ts`는 아직 건드리지 않음.
- `test/memory-okf.test.ts`: 파싱·직렬화 round-trip, 적합성 통과/실패 케이스.

# 완료 기준 (Definition of Done)

1. 프론트매터 parse→serialize가 모르는 확장 키를 보존한다(round-trip 테스트 통과).
2. 적합성 검증기가 `type` 누락/빈 값을 거부하고, 모르는 `type`·추가 키·깨진
   링크·`index.md` 부재는 거부하지 않는다(관대한 소비 모델 테스트 통과).
3. 개념 ID가 OKF 규칙(`commands/bun-test.md` → `commands/bun-test`)을 만족.
4. `bun run typecheck` · `bun test test/memory-okf.test.ts` 그린.

# 인계

완료 시 [handoff.md](handoff.md)에 신규 모듈의 export 표면과 `type` 어휘 최종본,
미해결 결정(예: slug 규칙)을 기록한다.

# 작업

* [tasks.md](tasks.md) 체크리스트 참조.

# 참조

* [목표 아키텍처](/concepts/target-architecture.md)
* [OKF 명세 다이제스트](/concepts/okf-spec-digest.md)
