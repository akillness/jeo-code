---
type: SprintTasks
---

# Sprint 05 작업 체크리스트

| # | 작업 | 증거(evidence) | 상태 |
|---|------|----------------|------|
| 1 | 이전 4개 handoff 읽고 통합 상태 확인 | 인계 반영 | [x] |
| 2 | 마이그레이션: 4-헤딩 MEMORY.md → 개념 문서 분해(멱등) | 무손실/멱등 테스트 | [x] |
| 3 | index.md/log.md 생성 | 생성 테스트 | [x] |
| 4 | 번들/레거시 폴백 통일 + (선택) 전환 토글 | 폴백/플래그 테스트 | [x] |
| 5 | `jeo memory-migrate` 서브커맨드 + 와이어링 | `bun run typecheck` | [x] |
| 6 | 문서 갱신(`src/agent/AGENTS.md` 등) | diff 확인 | [x] |
| 7 | 전체 회귀 | `bun test`(전체) 그린 | [x] |
| 8 | 루트 log.md에 롤아웃 기록 | [/log.md](/log.md) 항목 추가 | [x] |

## 메모

- 마이그레이션은 1회성·멱등: 이미 번들이면 변환 skip.
- 롤백: 레거시 토글 또는 백업된 단일 MEMORY.md 복원 경로 명시.
