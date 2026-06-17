---
type: Sprint
title: Sprint 03 — 검색/참조 (Search & Reference)
description: index.md 점진적 공개와 관련 개념 선택 주입으로 memoryPromptSection을 재설계한다.
tags: [sprint, search, inject, retrieval, okf]
timestamp: 2026-06-17T00:00:00Z
---

# 목표

주입(참조)을 "전체 문서 또는 절단"에서 **관련 개념 선택 주입**으로 바꾼다.
llm-wiki의 검색 순서(index → 개념 → 원본)를 차용해 주입 예산 안에서 가장
관련 있는 개념만 시스템 프롬프트에 싣는다.

# 선행 입력

- [Sprint 02 handoff](/sprint-02-ingest-distill/handoff.md) — 개념 산출 스키마,
  `index.md` 형식.
- [graphify + llm-wiki 운영 패턴](/concepts/graphify-llm-wiki-patterns.md) —
  검색/참조 순서.

# 범위 (In scope)

- `index.md` 점진적 공개 생성/유지(섹션별 개념 목록 + 짧은 설명).
- 검색 함수: 번들에서 개념을 `type`/`tags`/`title`/본문 키워드로 조회.
  소~중 규모이므로 1차는 grep/in-memory 스코어링(외부 의존성 0).
- `memoryPromptSection` 재설계: 항상 전체 대신
  (a) 항상 싣는 high-confidence 핵심 + (b) 현재 작업/프롬프트와 관련된 개념을
  `MEMORY_INJECT_MAX_CHARS` 안에서 선택. injection-hardening 유지.
- 폴백: 번들이 없으면 기존 단일 `MEMORY.md`를 읽어 주입(Sprint 05 전 호환).

# 범위 밖

- graphify 그래프 기반 검색(Sprint 04), 기존 데이터 변환(Sprint 05).

# 산출물

- 검색/주입 모듈 + `launch.ts:397/419` 와이어링 갱신.
- `test/memory-search-okf.test.ts`: index 생성, 키워드/type 조회, 예산 준수
  선택, 폴백, 펜스 중화.

# 완료 기준 (Definition of Done)

1. `index.md`가 개념 추가/삭제에 따라 정확히 갱신된다.
2. 검색이 주어진 쿼리에 대해 관련 개념을 점수순으로 반환한다.
3. 주입이 `MEMORY_INJECT_MAX_CHARS`를 절대 넘지 않고, 핵심 개념을 우선 포함한다.
4. 번들 부재 시 단일 `MEMORY.md` 폴백 주입이 동작한다.
5. injection-hardening(DATA 프레이밍, 펜스 중화) 회귀 없음.
6. `bun run typecheck` · `bun test` 그린.

# 인계

[handoff.md](handoff.md)에 검색 API와 주입 선택 정책(핵심/관련 비율, 점수
기준)을 기록한다 — Sprint 04가 graphify로 검색을 강화할 때 참조한다.

# 작업

* [tasks.md](tasks.md)
