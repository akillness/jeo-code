---
type: SprintTasks
---

# Sprint 02 작업 체크리스트

| # | 작업 | 증거(evidence) | 상태 |
|---|------|----------------|------|
| 1 | Sprint 01 handoff 읽고 스키마/파서 export 확인 | 인계 사실 반영 | [x] |
| 2 | 증류 프롬프트를 개념 목록 산출(JSON)로 재작성 | 모의 산출 파싱 테스트 | [x] |
| 3 | `distillToBundle`: 개념 upsert(동일 ID 덮어쓰기 + confidence/last_verified) | upsert 테스트 | [x] |
| 4 | 다중-touch: 개념 + index.md + log.md 동시 갱신 | 3파일 갱신 테스트 | [x] |
| 5 | payload 원본 `.jeo/memory/raw/` 불변 보관 + 정리 정책 | raw 보관 테스트 | [x] |
| 6 | atomic write·detached·NO_MEMORY 회귀 보장 | 기존 `test/memory.test.ts` 그린 | [x] |
| 7 | `launch.ts`/`runner.ts` 와이어링 갱신 | `bun run typecheck` | [x] |
| 8 | `test/memory-distill-okf.test.ts` 작성 | `bun test` 그린 | [x] |

## 메모

- LLM 산출은 JSON 모드 권장(구조화). 파싱 실패 시 안전 폴백(증류 skip) 유지.
- injection-hardening: 개념 본문도 DATA로 프레이밍, 펜스 태그 중화 유지.
