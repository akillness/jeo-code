---
type: Reference
title: OKF v0.1 명세 다이제스트
description: Open Knowledge Format v0.1의 핵심 규칙을 jeo 메모리 설계 관점에서 요약.
resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
tags: [okf, spec, format]
timestamp: 2026-06-17T00:00:00Z
---

# 개요

OKF는 Google Cloud 데이터 클라우드 팀이 공개한 개방형 명세로, 지식을
**"YAML 프론트매터가 붙은 마크다운 파일들의 디렉토리"** 로 표현한다.
스키마 레지스트리도 중앙 권한도 필수 툴링도 없다. `cat`으로 읽을 수 있으면
OKF를 읽을 수 있고, `git clone`으로 받을 수 있으면 배포할 수 있다.

핵심 출처: [PyTorchKR 정리 글](https://discuss.pytorch.kr/t/open-knowledge-format-okf-google-ai-feat-llm-wiki/10701),
[Karpathy LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

# Schema

OKF 구조의 핵심 규칙(jeo 적용에 직접 영향):

| 요소 | 규칙 |
|------|------|
| 번들(bundle) | 마크다운 파일 디렉토리 = 배포 단위. git repo/하위 디렉토리/tarball |
| 개념(concept) | 파일 1개 = 개념 1개. **개념 ID = `.md`를 뗀 번들 기준 경로** (`tables/users.md` → `tables/users`) |
| 프론트매터 | `---`로 구분된 YAML. **필수는 `type` 하나** |
| 권장 필드 | 우선순위순 `title`, `description`, `resource`, `tags`, `timestamp`(ISO 8601) |
| 확장 키 | 생산자가 임의 키 추가 가능. 소비자는 모르는 키를 거부 말고 round-trip 보존 |
| 본문 | 표준 마크다운. 자유 산문보다 헤딩/리스트/표/코드 블록 선호 |
| 관례적 헤딩 | `# Schema`, `# Examples`, `# Citations` (해당 시 사용) |

# 상호 링크 (Cross-linking)

- **절대(번들 기준) 링크**: `/`로 시작, 번들 루트 기준 해석. 문서 이동에
  안정적이라 **권장**. 예: `[customers](/tables/customers.md)`.
- **상대 링크**: `./other.md` 같은 표준 마크다운 상대 경로.
- 링크는 *관계*만 주장하고 관계의 종류(부모/참조/조인/의존)는 **주변 산문**이
  전달한다. 소비자는 보통 모든 링크를 타입 없는 방향성 간선으로 취급한다.
- **깨진 링크는 관용**한다 — 아직 작성 안 된 지식일 수 있다.

# 예약 파일 (index.md / log.md)

- `index.md`: 어느 디렉토리에든 둘 수 있는 디렉토리 목록. **프론트매터 없음**.
  헤딩 아래 항목을 묶어 점진적 공개(progressive disclosure)를 지원.
  루트 `index.md`는 `okf_version: "0.1"` 선언 가능.
- `log.md`: 계층 어느 수준에든 둘 수 있는 변경 이력. 날짜 헤딩은 반드시
  ISO 8601 `YYYY-MM-DD`, 최신 항목이 위로.
- 이 둘은 개념 문서로 쓸 수 없는 예약 파일명. 그 외 모든 `.md`는 개념 문서.

# Citations 관례

본문이 외부 출처 주장을 담으면 하단 `# Citations` 아래 번호로 나열한다.
인용 링크는 절대 URL, 번들 기준 경로, 또는 외부 자료를 일급 개념으로 미러링한
`references/` 하위 경로일 수 있다.

# 적합성 (Conformance) — v0.1

번들이 적합하려면:
1. 모든 비예약 `.md`가 파싱 가능한 YAML 프론트매터를 가진다.
2. 모든 프론트매터가 비어 있지 않은 `type` 필드를 가진다.
3. 예약 파일명이 있으면 정해진 구조를 따른다.

그 외 모든 제약은 소비자가 *느슨한 가이드*로 취급한다. 소비자는 선택 필드 누락,
모르는 `type`, 모르는 추가 키, 깨진 링크, `index.md` 부재를 이유로 번들을
거부해서는 안 된다(관대한 소비 모델).

# jeo 설계에 주는 함의

- 현행 단일 `MEMORY.md`는 **여러 개념 문서로 분해**될 수 있다 — 개념 ID가
  파일 경로이므로 안정적 식별·라우팅·필터링이 가능해진다.
- 프론트매터 `type`(예: `RepoFact`, `Command`, `Gotcha`, `UserPreference`)으로
  주입 시 필터링/우선순위가 가능해진다.
- 상호 링크 + `index.md`가 graphify 그래프와 점진적 공개의 토대가 된다.

# Citations

[1] [Open Knowledge Format(OKF) 소개 — PyTorchKR](https://discuss.pytorch.kr/t/open-knowledge-format-okf-google-ai-feat-llm-wiki/10701)
[2] [okf/SPEC.md — GoogleCloudPlatform/knowledge-catalog](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
[3] [Karpathy LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
