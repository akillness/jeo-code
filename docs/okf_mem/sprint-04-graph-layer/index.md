---
type: Sprint
title: Sprint 04 — 그래프 레이어 (Graph Layer)
description: 개념 간 상호 링크 그래프를 구축하고 선택적으로 graphify와 연동한다.
tags: [sprint, graph, graphify, cross-link, okf]
timestamp: 2026-06-17T00:00:00Z
---

# 목표

개념 문서 간 **상호 링크를 1급 그래프**로 다루어 검색/참조를 강화한다.
1차는 내장 링크 그래프(의존성 0), 2차는 선택적 graphify 연동.

# 선행 입력

- [Sprint 03 handoff](/sprint-03-search-reference/handoff.md) — 검색 API/주입 정책.
- [graphify + llm-wiki 운영 패턴](/concepts/graphify-llm-wiki-patterns.md) —
  권위/구조 2-레이어 그래프 원칙.

# 범위 (In scope)

- 번들 스캔으로 개념 그래프 구축: 노드=개념ID, 간선=마크다운 링크(타입 없는
  방향성 간선, OKF 의미론). 깨진 링크 관용.
- 그래프 기반 검색 강화: 관련 개념 1-hop/2-hop 확장으로 주입 후보 보강.
- lint: orphan 개념, broken link, 중복/모순 후보 리포트(llm-wiki lint 차용).
- 선택적 graphify 연동(가용 시): 마크다운에 맞는 적재 경로 사용, 코드 repo용
  `graphify update` 금지. 권위/구조 그래프 분리 원칙 준수. graphify 부재 시
  내장 그래프로 완전 동작(graceful degradation).

# 범위 밖

- 기존 단일 문서 변환·플래그·롤아웃(Sprint 05).

# 산출물

- 그래프 빌더/lint 모듈 + Sprint 03 검색과의 통합.
- `test/memory-graph-okf.test.ts`: 그래프 구축, 깨진 링크 관용, 1-hop 확장,
  orphan/broken lint, graphify 부재 폴백.

# 완료 기준 (Definition of Done)

1. 번들에서 개념 그래프가 정확히 구축되고 깨진 링크에 죽지 않는다.
2. 그래프 확장이 검색 후보를 관련 개념으로 보강한다(주입 예산은 여전히 준수).
3. lint가 orphan/broken/중복 후보를 보고한다.
4. graphify 미설치 환경에서도 전체 기능이 내장 그래프로 동작한다.
5. `bun run typecheck` · `bun test` 그린.

# 인계

[handoff.md](handoff.md)에 그래프 API와 graphify 연동 토글/설정, lint 출력
형식을 기록한다 — Sprint 05가 롤아웃 시 참조.

# 작업

* [tasks.md](tasks.md)
