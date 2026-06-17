---
okf_version: "0.1"
---

# okf_mem — jeo 메모리의 OKF 전환 계획 번들

이 디렉토리는 jeo의 로컬 경험 메모리(`.jeo/memory/MEMORY.md`)를
**Open Knowledge Format(OKF) v0.1** 기반의 번들로 재설계하기 위한 계획
번들입니다. 이 번들 자체도 OKF 관례(프론트매터 `type`, 예약 파일명
`index.md`/`log.md`, 번들 기준 상호 링크)를 따르며, 계획을 도그푸딩합니다.

작업은 5개의 스프린트로 나뉘며, 각 스프린트는 **별도 폴더**에서 진행하고
직전 스프린트의 `handoff.md`를 입력으로 받아 이어집니다. 진행하면서 각
스프린트 폴더의 `tasks.md`(체크리스트)와 `handoff.md`(다음 스프린트 인계)를
갱신하고, 번들 루트의 [log.md](/log.md)에 변경 이력을 추가합니다.

## 먼저 읽기 (Progressive disclosure)

* [README](README.md) - 번들 사용법, 작업 루프, 용어
* [log.md](log.md) - 변경 이력(ISO 8601, 최신 우선)

## 배경 개념 (Concepts)

* [OKF v0.1 명세 다이제스트](concepts/okf-spec-digest.md) - 포맷의 핵심 규칙 요약
* [jeo 현행 메모리 시스템](concepts/jeo-memory-current.md) - 지금의 distill/inject 파이프라인
* [graphify + llm-wiki 운영 패턴](concepts/graphify-llm-wiki-patterns.md) - 적재/관리/검색/참조 참고 모델
* [목표 아키텍처](concepts/target-architecture.md) - OKF 번들 + 그래프 레이어 합성 설계

## 스프린트 (순서대로 진행)

* [Sprint 01 — 포맷 기반(Format Foundation)](sprint-01-format-foundation/index.md) - OKF 번들 스키마와 디렉토리 레이아웃 확정
* [Sprint 02 — 적재/증류(Ingest & Distill)](sprint-02-ingest-distill/index.md) - 세션 증류를 단일 MEMORY.md → 개념 단위 OKF 문서로
* [Sprint 03 — 검색/참조(Search & Reference)](sprint-03-search-reference/index.md) - index.md 점진적 공개 + 프롬프트 주입 재설계
* [Sprint 04 — 그래프 레이어(Graph Layer)](sprint-04-graph-layer/index.md) - 상호 링크 그래프와 graphify 연동
* [Sprint 05 — 마이그레이션/롤아웃(Migration & Rollout)](sprint-05-migration-rollout/index.md) - 기존 메모리 변환, 호환성, 플래그
