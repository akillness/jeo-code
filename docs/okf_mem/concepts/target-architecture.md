---
type: Reference
title: 목표 아키텍처
description: OKF 번들 + index 점진적 공개 + 상호 링크 그래프로 재설계한 jeo 메모리.
tags: [okf, architecture, memory, design]
timestamp: 2026-06-17T00:00:00Z
---

# 개요

jeo 메모리를 단일 `MEMORY.md`에서 **OKF v0.1 적합 번들**로 전환한다.
llm-wiki의 적재/검색/참조 레이어링과 graphify의 그래프 레이어를 참고하되,
jeo의 로컬 우선·detached 증류·injection-hardening 강점은 그대로 보존한다.

# Schema (목표 번들 레이아웃)

```
.jeo/memory/                         # OKF 번들 루트
├── index.md                         # okf_version: "0.1", 점진적 공개 인덱스
├── log.md                           # 증류/갱신 이력 (ISO 8601)
├── facts/<slug>.md                  # type: RepoFact
├── commands/<slug>.md               # type: Command
├── gotchas/<slug>.md                # type: Gotcha
├── preferences/<slug>.md            # type: UserPreference
└── raw/                             # 불변 — pending-distill payload 원본 보관
```

현행 4개 헤딩(repo facts / commands / gotchas / user preferences)이 그대로
4개 개념 디렉토리 + `type` 값으로 승격된다. 개념 ID는 OKF 규칙대로 파일 경로
(`commands/bun-test`)다.

# 프론트매터 규약 (jeo 확장)

```yaml
---
type: Command                 # REQUIRED — RepoFact|Command|Gotcha|UserPreference|Reference
title: bun test               # 사람이 읽는 이름
description: 전체 테스트 스위트 실행
tags: [test, bun]
timestamp: 2026-06-17T00:00:00Z
confidence: high              # 확장 키: 증류 신뢰도
last_verified: 2026-06-17     # 확장 키: 마지막으로 실제 검증된 날짜
source_session: <id>          # 확장 키: 어느 세션에서 학습됐는지
---
```

소비자(주입 로직)는 모르는 확장 키를 거부하지 않고 보존한다(OKF 적합성).

# 데이터 흐름 (적재→관리→검색→참조)

1. **적재(distill)**: 세션 종료 시 detached 워커가 전사를 증류하되, 단일 문서
   merge 대신 **개념 단위로 upsert**한다. 영향받은 개념 문서 + `index.md` +
   `log.md`를 함께 갱신(llm-wiki의 ingest 5-touch 규칙 차용). payload 원본은
   `raw/`에 불변 보관.
2. **관리**: atomic write 유지. 개념별 `confidence`/`last_verified`로 stale
   판정, lint 패스에서 broken link·중복·모순 점검.
3. **검색**: `index.md`를 먼저 읽어 점진적 공개 → 관련 개념 문서 → 필요 시
   `raw/`. 상호 링크를 타입 없는 그래프 간선으로 순회.
4. **참조(주입)**: `memoryPromptSection`이 전체 문서 대신 **관련 개념을 선택**해
   주입 예산(`MEMORY_INJECT_MAX_CHARS`) 안에서 구성. injection-hardening 유지.

# 그래프 레이어

- 1차: 개념 간 마크다운 상호 링크 = 내장 그래프(추가 의존성 0).
- 2차(선택): graphify를 붙여 `query`/`explain`/`path`로 관련 개념 검색.
  graphify의 권위/구조 2-레이어 분리 원칙을 따르고, 코드 repo용 `update`가
  아니라 마크다운에 맞는 적재 경로를 쓴다.

# 호환성/안전

- `JEO_NO_MEMORY=1` 비활성화 유지.
- 기존 `.jeo/memory/MEMORY.md`는 마이그레이션 스텝에서 번들로 변환하고,
  변환 전까지는 폴백으로 읽을 수 있게 한다(점진 롤아웃).
- atomic write·detached 증류·펜스 중화는 회귀 금지.

# 관련 개념

- [OKF 명세 다이제스트](/concepts/okf-spec-digest.md)
- [jeo 현행 메모리 시스템](/concepts/jeo-memory-current.md)
- [graphify + llm-wiki 운영 패턴](/concepts/graphify-llm-wiki-patterns.md)
- 스프린트: [01](/sprint-01-format-foundation/index.md) · [02](/sprint-02-ingest-distill/index.md) · [03](/sprint-03-search-reference/index.md) · [04](/sprint-04-graph-layer/index.md) · [05](/sprint-05-migration-rollout/index.md)
