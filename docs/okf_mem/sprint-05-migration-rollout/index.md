---
type: Sprint
title: Sprint 05 — 마이그레이션/롤아웃 (Migration & Rollout)
description: 기존 단일 MEMORY.md를 OKF 번들로 변환하고 호환성·플래그·문서로 안전하게 롤아웃한다.
tags: [sprint, migration, rollout, compat, okf]
timestamp: 2026-06-17T00:00:00Z
---

# 목표

기존 `.jeo/memory/MEMORY.md`를 OKF 번들로 **무손실 변환**하고, 점진적 롤아웃과
롤백 경로를 갖춘 채 기본 동작으로 전환한다.

# 선행 입력

- 모든 이전 스프린트 handoff(01–04).
- [jeo 현행 메모리 시스템](/concepts/jeo-memory-current.md) — 보존할 강점.
- [목표 아키텍처](/concepts/target-architecture.md) — 호환성/안전 섹션.

# 범위 (In scope)

- 마이그레이션 도구: 기존 4-헤딩 `MEMORY.md`를 파싱해 개념 문서로 분해
  (헤딩→`type`, 불릿→개념). `index.md`/`log.md` 생성. 1회성·멱등.
- 호환 모드: 번들 존재 시 번들 사용, 없으면 단일 문서 폴백(Sprint 03 폴백과 통일).
- 플래그: `JEO_NO_MEMORY=1`(비활성, 유지). 필요 시 번들/레거시 전환 토글 추가
  검토(예: `JEO_MEMORY_LEGACY=1`)하되 기본은 번들.
- 문서 갱신: `src/agent/AGENTS.md` 또는 관련 문서에 새 메모리 모델 반영.
- 전체 회귀: `bun test` 전부 그린, `test/memory.test.ts` 의도 유지/이관.

# 범위 밖

- 새 기능 추가(이 스프린트는 통합/안전/문서에 집중).

# 산출물

- 마이그레이션 함수/서브커맨드(예: `jeo memory-migrate`) + 와이어링.
- `test/memory-migration-okf.test.ts`: 변환 무손실·멱등, 폴백, 플래그.
- 갱신된 문서.

# 완료 기준 (Definition of Done)

1. 기존 `MEMORY.md` 샘플이 OKF 적합 번들로 무손실 변환되고, 재실행해도 멱등.
2. 번들/레거시 폴백이 명확히 정의되고 테스트된다.
3. `JEO_NO_MEMORY=1` 및 (도입 시) 전환 토글이 동작한다.
4. `bun run typecheck` · `bun test`(전체) 그린.
5. 문서가 새 메모리 모델을 반영하고, [log.md](/log.md)에 롤아웃 기록.

# 인계

[handoff.md](handoff.md)에 최종 상태(기본 동작, 롤백 방법, 남은 후속 작업)를
기록하고 번들 루트 [log.md](/log.md)에 완료 항목을 추가한다.

# 작업

* [tasks.md](tasks.md)
