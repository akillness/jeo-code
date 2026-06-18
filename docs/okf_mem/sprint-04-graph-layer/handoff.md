---
type: SprintHandoff
---

# Sprint 04 → 05 인계

> Sprint 04 완료. 개념 번들 위에 **의존성 0 상호 링크 그래프**를 1급으로 올렸다.
> 그래프는 검색을 1-hop 확장으로 보강하고, lint(orphan/broken/중복)를 제공하며,
> graphify 없이도 전부 동작한다(graphify는 선택적 enrichment 레이어).

## 상태

- [x] 완료

## 확정된 사실

- **그래프 API** (`src/agent/memory-graph.ts`, 모두 export):
  - `buildConceptGraph(concepts): ConceptGraph` — 노드=개념ID(`conceptId`로
    `.md` 제거한 번들 상대경로), 간선=본문의 마크다운 링크(`](target)`)가 가리키는
    다른 개념. `ConceptGraph = { nodes:Set, edges:Map<from,Set<to>>,
    broken:Map<from,Set<to>> }`. **깨진 링크는 throw가 아니라 `broken`에 보존**
    (lint가 보고) — OKF 관용 모델.
  - `resolveLinkTarget(fromId, rawTarget): string | null` — 링크 타깃을 개념ID로
    해석. bundle-absolute(`/commands/x.md`), 상대(`../facts/x.md`), 앵커/쿼리
    스트립 처리. external/protocol(`http:`, `mailto:`)·순수 앵커(`#..`)·번들
    탈출(`../../`)은 `null`.
  - `expandByGraph(seedIds, graph, hops=1): Set<string>` — 시드에서 무방향
    인접으로 `hops`만큼 확장. 노드에 없는 시드는 드롭.
  - `lintConceptGraph(concepts, graph): GraphLintReport` —
    `{ orphans:string[], brokenLinks:{from,to}[], duplicates:{title,ids[]}[] }`.
    orphan=in/out 간선 0, duplicate=대소문자 무시 동일 title.
  - `graphifyAvailable(detect?=Bun.which 기반): boolean` — PATH의 graphify 탐지.
    detector 주입 가능, 예외는 삼켜 `false`(graceful).
- **검색 통합** (`src/agent/memory.ts`):
  - `priorityOrder`가 쿼리 토큰이 있을 때 1-hop 그래프 확장을 적용 — 쿼리에
    **직접 적중한 개념의 링크 이웃**을 `related`로 표시해 무관 noise보다 우선.
    정렬 키: core(high-confidence) → score(쿼리 관련) → related(1-hop) → 입력순.
    예산(`MEMORY_INJECT_MAX_CHARS`=3000)은 그대로 준수.
  - `lintMemoryBundle(cwd): Promise<GraphLintReport>` 신규 export — 디스크
    번들을 적재해 lint. 번들 부재 시 빈 리포트.
- **graphify 연동/폴백**: 내장 그래프가 1차이자 전부. graphify(현재 환경 0.8.14
  설치)는 선택적 2차 — 부재해도 검색/주입/lint 전부 동작(graceful degradation,
  테스트로 고정). **마크다운 번들에 `graphify update` 금지**(코드 repo 전용) —
  연동은 권위/구조 그래프 분리 원칙 하에 향후 add/query 경로로만.

## 산출물 경로

- `src/agent/memory-graph.ts` — 그래프 빌더/확장/lint/graphify 탐지 (신규, 의존성 0).
- `src/agent/memory.ts` — `priorityOrder` 1-hop 확장 통합, `lintMemoryBundle`
  export 추가, `memory-graph` import.
- `test/memory-graph-okf.test.ts` — 링크 해석/그래프 구축/깨진 링크 관용/1·2-hop
  확장/lint/graphify 폴백/예산 내 이웃 주입 (8 pass).

## 미해결 이슈

- graphify 능동 연동(`graphify add <url>`로 URL 적재, `query`/`explain`로 재발견)은
  아직 미구현 — 내장 그래프로 충분한 소~중 규모에선 불필요. Sprint 05 롤아웃에서
  대규모 번들 시 선택적 토글로 검토.
- 링크 그래프는 본문 마크다운 링크만 본다. 프론트매터 `links:` 필드는 distiller가
  채우지만 아직 그래프 간선으로 병합하지 않음 — 필요 시 후속.

## 검증 증거

- `bun run typecheck`: 통과(에러 0).
- `bun test`: 1557 pass / 0 fail (194 files). 메모리 스위트
  `test/memory-graph-okf.test.ts`(8) 신규 + 기존 42 = 50 pass / 0 fail.
- `jeo --tmux` 실검증: smoke OK(클린 부팅·렌더), battery 6/6 PASS.
