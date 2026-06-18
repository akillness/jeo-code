# Directory Update Log

## 2026-06-17
* **Sprint 03 완료**: 검색/참조 구현 — `src/agent/memory.ts`에 개념 단위
  검색(`loadConcepts`/`scoreConcept`/`searchConcepts`)과 예산 인지
  우선순위 선택 주입(`memoryPromptSection(cwd, query?)`: high-confidence core
  우선 → 쿼리 관련도 → 낮은 우선순위부터 드롭, mid-string 절단 폐지) 추가.
  `index.md`는 `- [title](/relpath) — description` 점진적 공개 형식으로 강화.
  `launch.ts`가 one-shot 작업 텍스트를 쿼리로 주입. `test/memory-search-okf.test.ts`
  (8 pass) + index 설명 회귀. `bun run typecheck` 그린, `bun test` 1547 pass/0 fail,
  `jeo --tmux` smoke OK·battery 6/6. [인계](/sprint-03-search-reference/handoff.md)에
  검색 API·주입 정책 기록 → Sprint 04(graphify) 진입 가능.
* **Sprint 03 리뷰(ponytail)**: 중복/죽은 코드 제거 — `loadConcepts`의
  파일워크+파싱을 `loadConceptsFromBundle`로 단일화해 `rebuildIndex`가 재사용,
  TYPE_LAYOUT 그룹핑을 `groupByTypeLayout`(섹션 순서 단일 출처)로 합쳐
  `renderConcepts`/`rebuildIndex` 중복 제거, 미사용 `loadBundleMemory`(호출처 0,
  budget-select 경로로 대체된 죽은 코드) 삭제. 동작 보존 — `bun run typecheck`
  그린, `bun test` 1547 pass/0 fail, `jeo --tmux` smoke OK·battery 6/6.
* **Sprint 01 완료**: 포맷 기반 구현 — `src/agent/memory-okf.ts`(프론트매터
  parse/serialize 확장키 round-trip, `conceptId`/`slugify`, OKF v0.1 적합성
  검증기) + `test/memory-okf.test.ts`(18 pass). `memory.ts` 미변경.
  `bun run typecheck` / `bun test test/memory-okf.test.ts` 그린.
  [인계](/sprint-01-format-foundation/handoff.md)에 export 표면·`type` 어휘·
  slug 규칙 기록 → Sprint 02 진입 가능.


* **Initialization**: okf_mem 계획 번들 생성. OKF v0.1 적합 구조로
  [index.md](/index.md), [README](/README.md), 4개 [concepts](/concepts/) 문서,
  5개 스프린트 폴더(각 `index.md`/`tasks.md`/`handoff.md`)를 작성.
* **Creation**: 배경 개념 정리 — [OKF 명세 다이제스트](/concepts/okf-spec-digest.md),
  [jeo 현행 메모리](/concepts/jeo-memory-current.md),
  [graphify+llm-wiki 패턴](/concepts/graphify-llm-wiki-patterns.md),
  [목표 아키텍처](/concepts/target-architecture.md).
* **Plan**: Sprint 01→05 (포맷 기반 → 적재/증류 → 검색/참조 → 그래프 레이어 →
  마이그레이션/롤아웃) 순서로 인계 체인을 정의.
