---
type: SprintTasks
---

# Sprint 04 작업 체크리스트

| # | 작업 | 증거(evidence) | 상태 |
|---|------|----------------|------|
| 1 | Sprint 03 handoff 읽고 검색 API 확인 | 인계 반영 | [ ] |
| 2 | 개념 그래프 빌더(노드=개념ID, 간선=링크, 깨진 링크 관용) | 그래프 구축 테스트 | [ ] |
| 3 | 그래프 기반 검색 강화(1-hop/2-hop 후보 확장) | 확장 테스트 | [ ] |
| 4 | lint: orphan/broken/중복/모순 후보 | lint 테스트 | [ ] |
| 5 | 선택적 graphify 연동(가용 시) + 부재 폴백 | graceful degradation 테스트 | [ ] |
| 6 | Sprint 03 검색/주입과 통합 | `bun run typecheck` | [ ] |
| 7 | `test/memory-graph-okf.test.ts` 작성 | `bun test` 그린 | [ ] |

## 메모

- graphify는 코드 repo용 `update`가 아니라 마크다운 적재 경로를 쓴다.
- 권위 그래프와 구조 그래프를 절대 섞지 않는다(참고 패턴 규칙).
