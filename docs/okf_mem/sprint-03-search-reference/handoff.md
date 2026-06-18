---
type: SprintHandoff
---

# Sprint 03 → 04 인계

> Sprint 03 완료. 주입이 "전체 번들 렌더 후 mid-string 절단"에서 **개념 단위
> 검색·우선순위·예산 선택 주입**으로 전환되었고, `index.md`는 설명을 포함한
> 점진적 공개 형식이 되었다.

## 상태

- [x] 완료

## 확정된 사실

- **검색 API** (`src/agent/memory.ts`, 모두 export):
  - `loadConcepts(cwd): Promise<Concept[]>` — 번들의 모든 개념 문서를 구조화해
    로드. 예약 파일(index.md/log.md)·`raw/`·프론트매터 없는 파일은 제외.
    `Concept = { type, title, description, body, tags[], confidence, relPath }`.
  - `scoreConcept(concept, tokens[]): number` — 토큰별 필드 가중치 합:
    **title +5, tags +3, type +2, description +2, body +1**. 토큰은 쿼리를
    소문자화해 `[a-z0-9]+` 중 길이 ≥ 3만 distinct 추출(`tokenize`, 내부).
  - `searchConcepts(concepts, query): { concept, score }[]` — score > 0만
    내림차순. 0점(무관)은 드롭.
- **주입 선택 정책** (`memoryPromptSection(cwd, query?)`):
  - 우선순위(`priorityOrder`, 내부): **(1) high-confidence "core" 우선** →
    (2) 쿼리 관련 점수 내림차순 → (3) 입력 순서(안정 타이브레이크).
  - `selectWithinBudget`: 우선순위대로 개념을 통째로 누적, 그룹 렌더가
    `MEMORY_INJECT_MAX_CHARS`(3,000)를 넘지 않을 때까지 선택 — **낮은 우선순위
    부터 드롭**. 개념 중간을 자르지 않는다. 단 하나도 안 들어가면 최상위 1개는
    보장(백스톱 캡이 추가로 하드 절단).
  - 쿼리 소스: `launch.ts`가 one-shot 작업 텍스트(`flags.message`)를 넘긴다.
    인터랙티브 부팅은 쿼리 없음 → core(=high-confidence)가 우선 주입된다.
- **`index.md` 점진적 공개**: 항목이 `- [title](/<relpath>.md) — <description>`
  형식(설명 추가). 그룹은 TYPE_LAYOUT 순서 + 미지 type은 말미(lenient).
  매 증류 후 전체 재생성(`rebuildIndex`).
- **폴백/하드닝 회귀 없음**: 번들 부재 시 단일 `MEMORY.md` 주입 유지.
  injection-hardening(DATA 프레이밍 + `<…project_memory>` 펜스 중화)은 선택된
  개념 본문에도 동일 적용.

## 산출물 경로

- `src/agent/memory.ts` — `loadConcepts`/`scoreConcept`/`searchConcepts`
  (export), `priorityOrder`/`selectWithinBudget`/`renderConcepts`/
  `groupByTypeLayout`(내부, 섹션 순서의 단일 출처), `memoryPromptSection(cwd,
  query?)` 재설계, `rebuildIndex`는 `loadConceptsFromBundle`+`groupByTypeLayout`
  재사용으로 중복 제거. (ponytail 리뷰: 미사용 `loadBundleMemory` 삭제 —
  budget-select 경로로 대체되어 호출처 0이던 죽은 코드.)
- `src/commands/launch.ts` — `memoryPromptSection(cwd, flags.message || undefined)`
  와이어링.
- `test/memory-search-okf.test.ts` — 로드/스코어/검색/예산 선택/core 우선/폴백/
  펜스 중화(8 pass). `test/memory-distill-okf.test.ts`에 index 설명 회귀 추가.

## 미해결 이슈

- 없음. (검색은 1차 in-memory 스코어링이며, graphify 그래프 기반 강화는
  Sprint 04 범위. 현재 점수는 키워드 substring 매칭 — 형태소/동의어 미지원.)

## 검증 증거

- `bun run typecheck`: 통과(에러 0).
- `bun test`: 1547 pass / 0 fail (193 files). 메모리 스위트
  `test/memory-search-okf.test.ts`(8) + `test/memory-distill-okf.test.ts` +
  `test/memory.test.ts` + `test/memory-okf.test.ts` = 42 pass / 0 fail.
- `jeo --tmux` 실검증: smoke OK(클린 부팅·렌더), battery 6/6 PASS.
