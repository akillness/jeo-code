---
type: Reference
title: graphify + llm-wiki 운영 패턴
description: 적재/관리/검색/참조의 참고 모델 — llm-wiki vault 규약과 graphify 2-레이어 그래프.
resource: ~/vaults/llm-wiki/AGENTS.md
tags: [graphify, llm-wiki, ingest, search, graph]
timestamp: 2026-06-17T00:00:00Z
---

# 개요

`~/vaults/llm-wiki`는 LLM이 유지하는 영속 위키이며, 동시에 graphify 루트이자
obsidian-cli vault다(통합 루트, 절대 분리 금지). jeo 메모리의 적재·관리·검색·
참조 방식을 설계할 때 직접 참고할 검증된 패턴이다.

# Schema (역할 레이어)

| 레이어 | 경로/도구 | 역할 |
|--------|-----------|------|
| 불변 원천 | `raw/sources/`, `raw/assets/` | **immutable** — 절대 편집 금지. 캡처된 원본 |
| LLM 작업물 | `wiki/`, `index.md`, `log.md` | LLM이 유지하는 합성 산출물 |
| 합성 페이지 | `wiki/{concepts,entities,queries,reports,sources}/` | 주제별 durable 노트 |
| 권위 그래프 | `graphify-out/graph.json` | full-extraction 지식 그래프(`graphify extract`/`add`, `cluster-only`로 재클러스터) |
| 구조 그래프 | `graphify-out/prompts/graph.json` | 매 ingest마다 재빌드되는 per-prompt/output 구조 그래프 |
| 그래프 리포트 | `graphify-out/GRAPH_REPORT.md`, `graph.html` | 사람이 읽는 그래프 뷰 |

**불변 규칙**: 두 그래프를 절대 섞지 않는다 — 작은 구조 그래프로 권위
`graph.json`을 덮어쓰지 않는다.

# 적재 (Ingest) 파이프라인

모든 incoming prompt와 assistant output은:
1. **rtk-compress** — durable 지식이 되기 전 압축
2. **raw 캡처** — `raw/sources/prompts|outputs/`에 불변 원본 저장
3. **요약 + stub 작성** — 압축된 source summary + query/report stub
4. **graphify-refine** — 구조적 지식 그래프로 정제

매 ingest는 반드시: raw 캡처 → source summary → 영향받은 wiki 페이지 →
`index.md` → `log.md` 를 모두 건드린다.

# 검색/참조 (Search & Reference) 순서

1. `index.md`를 **먼저** 읽는다(점진적 공개).
2. 그다음 관련 `wiki/` 페이지를 읽는다.
3. grounding이 필요할 때만 `raw/` 원천을 연다.
4. graphify 그래프로 폭넓은 재발견 전에 `query`/`explain`/`path`를 쓴다.
5. durable 답변은 `wiki/queries/` 또는 `wiki/reports/`로 다시 파일링 →
   vault가 계속 성장.

```bash
graphify query "topic" --graph ~/vaults/llm-wiki/graphify-out/graph.json
graphify explain "topic" --graph .../graph.json
graphify cluster-only ~/vaults/llm-wiki   # 재클러스터(리포트/html 재생성, LLM 없음)
```

> 주의: `graphify update`는 **코드 저장소 전용** — 마크다운 위키는 색인하지
> 않는다. 위키는 `graphify add <url>`로 URL을 그래프에 적재하거나, 소~중 규모
> 에서는 `grep`/`index.md`로 검색.

# 관리 (Management) 규약

- kebab-case 파일명, 페이지당 단일 H1, 진짜 wiki 링크.
- grounded source note와 상위 synthesis를 구분.
- 페이지 경로/raw 경로/URL로 citation 보존.
- lint 패스에서 broken link, orphan page, stale claim, contradiction,
  missing-page 후보를 점검.

# jeo 메모리에 이식할 매핑

| llm-wiki 개념 | jeo OKF 메모리 대응 |
|---------------|---------------------|
| `raw/sources/` (불변) | 세션 전사/증류 payload 원본(현행 `pending-distill-*.json`) |
| `wiki/` 합성 페이지 | `.jeo/memory/` 아래 OKF 개념 문서 |
| `index.md` 점진적 공개 | 주입 시 관련 개념만 선택하는 인덱스 |
| graphify 권위/구조 2-레이어 | 개념 간 상호 링크 그래프 + 선택적 graphify 연동 |
| ingest 5-touch 규칙 | distill이 개념 문서 + index + log를 함께 갱신 |
| query→explain→path | 검색 시 index→개념→원본 순서 |

# 관련 개념

- [목표 아키텍처](/concepts/target-architecture.md)
- [jeo 현행 메모리 시스템](/concepts/jeo-memory-current.md)

# Citations

[1] `~/vaults/llm-wiki/AGENTS.md` — Wiki Schema invariants
[2] `~/vaults/llm-wiki/CLAUDE.md` — llm-wiki Operating Contract
[3] `~/.agents/rules/jeo-tool-flow.md` — graphify/llm-wiki tool flow rule
