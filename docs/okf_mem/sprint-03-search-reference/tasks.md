---
type: SprintTasks
---

# Sprint 03 작업 체크리스트

| # | 작업 | 증거(evidence) | 상태 |
|---|------|----------------|------|
| 1 | Sprint 02 handoff 읽고 개념 스키마/index 형식 확인 | 인계 반영 | [ ] |
| 2 | `index.md` 점진적 공개 생성/유지 함수 | index 갱신 테스트 | [ ] |
| 3 | 개념 검색(type/tags/title/본문 키워드, in-memory 스코어링) | 조회 테스트 | [ ] |
| 4 | `memoryPromptSection` 재설계: 핵심 + 관련 개념 선택 주입 | 예산 준수 테스트 | [ ] |
| 5 | 번들 부재 시 단일 MEMORY.md 폴백 | 폴백 테스트 | [ ] |
| 6 | injection-hardening 유지(DATA 프레이밍/펜스 중화) | 중화 테스트 | [ ] |
| 7 | `launch.ts:397/419` 와이어링 | `bun run typecheck` | [ ] |
| 8 | `test/memory-search-okf.test.ts` 작성 | `bun test` 그린 | [ ] |

## 메모

- 1차 검색은 외부 의존성 0(grep/in-memory). graphify는 Sprint 04에서 선택 강화.
- 주입 예산 초과 시 점수 낮은 개념부터 드롭.
