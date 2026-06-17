---
type: Sprint
title: Sprint 02 — 적재/증류 (Ingest & Distill)
description: 세션 증류를 단일 MEMORY.md merge에서 개념 단위 OKF 문서 upsert로 전환한다.
tags: [sprint, distill, ingest, okf]
timestamp: 2026-06-17T00:00:00Z
---

# 목표

세션 종료 증류를 **개념 단위 upsert**로 바꾼다. 단일 `MEMORY.md` merge 대신
영향받은 개념 문서 + `index.md` + `log.md`를 함께 갱신하는 llm-wiki의
ingest 다중-touch 규칙을 차용한다.

# 선행 입력

- [Sprint 01 handoff](/sprint-01-format-foundation/handoff.md) — 스키마/파서/
  검증기/`type` 어휘.
- [jeo 현행 메모리 시스템](/concepts/jeo-memory-current.md) — distill 호출 지점.
- [graphify + llm-wiki 운영 패턴](/concepts/graphify-llm-wiki-patterns.md) —
  적재 파이프라인.

# 범위 (In scope)

- 증류 프롬프트 재설계: 4개 헤딩 평문 → **개념 목록**(각 항목에 `type`,
  `title`, 본문, 선택적 상호 링크) 산출. JSON 모드로 구조화 권장.
- `distillSessionMemory`(또는 신규 `distillToBundle`): 산출된 개념을 OKF
  문서로 upsert. 동일 개념 ID는 덮어쓰되 `confidence`/`last_verified` 갱신.
- 다중-touch: 개념 문서 + `index.md` 섹션 + `log.md` 항목을 한 트랜잭션에 갱신.
- payload 원본을 `.jeo/memory/raw/`에 불변 보관(현행 `pending-distill-*.json`
  정리 정책 포함).
- atomic write·detached 워커·injection-hardening **회귀 금지**.

# 범위 밖

- 주입 선택 로직(Sprint 03), 그래프(Sprint 04), 기존 단일 문서 변환(Sprint 05).

# 산출물

- `src/agent/memory.ts` 또는 신규 모듈에 `distillToBundle` 구현 + 와이어링
  (`launch.ts:3817` detached 경로, `runMemoryDistillCommand`).
- `test/memory-distill-okf.test.ts`: 증류 산출→개념 upsert, 다중-touch, atomic,
  raw 보관, 비활성화 플래그.

# 완료 기준 (Definition of Done)

1. 모의 LLM 산출로 개념 문서들이 OKF 적합하게 생성/갱신된다(Sprint 01 검증기 통과).
2. 같은 세션 재증류가 개념을 중복 생성하지 않고 upsert 한다.
3. 증류 1회가 개념 문서 + `index.md` + `log.md`를 모두 갱신한다.
4. atomic write·detached 동작·`JEO_NO_MEMORY=1`가 기존 `test/memory.test.ts`와
   동등하게 유지된다(회귀 테스트 그린).
5. `bun run typecheck` · `bun test` 그린.

# 인계

[handoff.md](handoff.md)에 개념 문서 산출 스키마(필드/본문 규약), `index.md`
갱신 형식, raw 보관 정책을 기록한다 — Sprint 03이 이를 읽고 주입을 설계한다.

# 작업

* [tasks.md](tasks.md)
