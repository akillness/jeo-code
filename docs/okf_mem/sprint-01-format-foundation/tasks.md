---
type: SprintTasks
---

# Sprint 01 작업 체크리스트

> 진행하며 `[ ]` → `[x]`로 갱신하고, 증거 칸에 실제 명령/결과를 적는다.

| # | 작업 | 증거(evidence) | 상태 |
|---|------|----------------|------|
| 1 | `.jeo/memory/` 번들 레이아웃 문서화(폴더/예약파일/개념 디렉토리) | [목표 아키텍처](/concepts/target-architecture.md)와 일치 확인 | [x] |
| 2 | jeo `type` 어휘 확정(RepoFact/Command/Gotcha/UserPreference/Reference) | `JEO_TYPES` 상수 + handoff.md 표 | [x] |
| 3 | `src/agent/memory-okf.ts` — 프론트매터 parse/serialize(확장 키 보존) | `bun test test/memory-okf.test.ts` 18 pass | [x] |
| 4 | 개념 ID 계산 유틸(`.md` 제거, 번들 기준 경로) | round-trip/conceptId 테스트 통과 | [x] |
| 5 | OKF v0.1 적합성 검증기(type 필수, 관대한 소비) | 통과/실패 케이스 테스트 통과 | [x] |
| 6 | `test/memory-okf.test.ts` 작성 | `bun test` 그린 (18 pass/0 fail) | [x] |
| 7 | 타입체크 통과 | `bun run typecheck` PASS | [x] |

## 메모

- 기존 `src/agent/memory.ts`는 이 스프린트에서 **건드리지 않는다**(병행 안정성).
- slug 규칙(kebab-case, 충돌 회피)은 결정 후 handoff에 남긴다.
