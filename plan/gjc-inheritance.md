# gjc 계승·발전 합의 문서 (living document)

> 마라톤 규약: 1 사이클 = 구현 → 개선 → 논의 → 합의 → 검증. 매 사이클 progress.txt에 기록.
> 증거: agent://0-GjcCoreLoop, agent://1-GjcVerifyExtend (gjc v0.4.3 소스 분석), pi-mono/hermes/nullclaw/zeroclaw 철학 리서치 (2026-06-12).

## 철학 종합 (4+1 프로젝트)

| 프로젝트 | 핵심 철학 | jeo가 가져갈 것 |
|---|---|---|
| **pi-mono** (Zechner) | 미니멀 코어(4 tools, <1K토큰 프롬프트). "코어에 더한 기능만큼 모델의 자유 추론이 줄어든다." 기능은 확장/CLI+README로. | 코어 비대화 거부 — gjc 계승 시 **선별** 원칙. 도구 수 최소 유지, 무거운 기능은 스킬/외부 CLI로. |
| **nullclaw** (Zig) | "as little as possible, as much as necessary". 단일 파일 구현으로 확장. SQLite 로컬 하이브리드 메모리. | 의존성 제로 유지(Bun 순수 TS). 메모리는 로컬 파일 기반. |
| **zeroclaw** (Rust) | local-first 주권, swappable 서브시스템, "전원 뽑으면 멈추고 다른 건 안 깨진다". | 상태는 전부 `.joc/` 로컬. 크래시 내구 상태 쓰기. |
| **hermes** (Nous) | 경험→스킬 증류: 태스크 완료 후 reusable skill 자동 추출, 세션 간 누적 학습. | 턴/세션 경계 학습 루프 (로컬 MEMORY 증류). |
| **gjc** (계승 대상) | "staff engineer" 규율: completion-contract, 검증 없는 done 금지, 편집 무결성(hashline), 구조적 능력 경계. | 아래 백로그. |

**jeo 노선 합의(초안)**: jeo는 pi-mono 계열의 *경량 JSON-루프* 에이전트로 남는다. gjc의 **정확성·검증·안전 메커니즘**을 경량 형태로 계승하되, 무거운 인프라 계층(plugins marketplace, 원격 hindsight, harness control-plane)은 도입하지 않거나 스킬/외부로 위임한다.

## 계승 백로그 (사이클 후보, 우선순위 순)

| # | 항목 | gjc 원본 | jeo 경량화 설계 | 효과/비용 |
|---|---|---|---|---|
| B1 | ~~Vercel/agent-skills 생태계 관용~~ | skills 디스커버리 | **완료 (cycle 1)** | — |
| B2 | **hashline-lite 편집 앵커** | hashline/ (647 단일토큰 바이그램, 콘텐츠 해시) | read 출력에 `N+hh\|` 앵커, edit `≔A..B`에 해시 검증 — mismatch 시 거부+현행 내용 재제시. 3-way 복구는 후속. | 편집 오염(최대 사고 원인) 차단 / 중간 |
| B3 | **completion-contract 프롬프트 이식** | system-prompt.md | executorSystemPrompt에 검증·완성 계약 문장 추가 (<300토큰) | 높음 / 매우 낮음 |
| B4 | **done 검증 가드(경량)** | ultragoal-guard, goal continuation | 엔진: 변이 도구(write/edit/bash) 사용 턴에서 검증 신호(테스트/실행) 없이 done 호출 시 1회 푸시백 | 높음 / 낮음 |
| B5 | **bashAllowedPrefixes 능력 경계** | task/types.ts AgentDefinition | subagent 역할별 bash 접두사 화이트리스트 (읽기전용 역할은 이미 도구 필터됨) | 중간 / 낮음 |
| B6 | **경험→스킬 증류(hermes 루프)** | memories/ 2-phase, hindsight | 세션 종료 시 `.joc/memory/MEMORY.md` 로컬 증류(요약 1콜), 다음 세션 시스템 프롬프트에 토큰 캡 주입 | 높음 / 중간 |
| B7 | **stale-read 가드** | edit/file-read-cache | edit 대상 파일이 마지막 read 이후 mtime 변경 시 경고/거부 | 중간 / 낮음 |
| B8 | **컴팩션 핸드오프/파일연산 보존** | agent-session compaction | 요약에 touched-files 목록 보존; (promotion/원격은 비도입) | 중간 / 중간 |
| B9 | **spawn-gate 경량판** | task/spawn-gate.ts | task 도구 N>4 fan-out 시 정당화 필드 요구 | 낮음 / 낮음 |
| B10 | **출력 spill 설정주도화** | output-meta.ts | 임계/head/tail 환경변수화 (+기존 minimizer 유지) | 낮음 / 낮음 |

## 비도입 합의(초안) — pi-mono 원칙 적용
- plugins/marketplace 계층 (스킬 디스커버리로 충분)
- 원격 hindsight/벡터 메모리 (로컬 MEMORY.md로 대체)
- harness control-plane (jeo 규모에 과잉)
- native tool-use API 전환 (JSON-in-text 루프가 jeo 정체성 — 멀티 프로바이더 균일성 이점 유지)

## 사이클 렛저
- cycle 1 (2026-06-12): B1 Vercel skills 관용 — 완료, 39 tests green, 라이브 검증.

## 합의 라운드 1 (critic ITERATE, 2026-06-12 — agent://2-InheritanceCritic)

**확정 실행 순서**: B3완성 → [B7+B3.5] → B4 → B2 → B6. B5는 보류(실 격차는 task-spawn 시 bashPrefixes 전달 — 역할 레지스트리만으론 가치 0), B9는 하드캡 대신 프로토콜 레벨 정당화 필드로 재설계.

- **B3 (부분완료)**: WORKING_DISCIPLINE은 engine.ts에 landed. 잔여: launch 인터랙티브 프롬프트 + executor 서브에이전트 템플릿 배선.
- **B3.5 (신규, 크리틱 발굴)**: edit SEARCH 매치 실패 시 자동 재제시 — 진단 문자열만이 아니라 현재 파일 내용(관련 구간)을 에러에 동봉. 실패 편집은 스텝버짓 낭비 1위.
- **B7 (승격)**: stale 감지 시 거부+현행 내용 재제시(recovery), 경고만으론 부족. read가 mtime/size 기록, edit/write가 검증. state.ts:213 패턴 복사.
- **B4 명세**: 변이 도구 사용 턴에서 검증 신호 없이 done → 1회 푸시백. 신호 = bash 성공 + 테스트러너 패턴(output-minimizer SUMMARY_PATTERNS 재사용). escape hatch = 푸시백 후 두 번째 done은 무조건 통과 (문서/설정 변경 오탐 대응).
- **B2 명세**: 해시 검증은 `≔A..B` 경로에만 적용. SEARCH/REPLACE 블록은 앵커 prefix(`N+hh|`) 유입 시 스트립하는 픽스업 추가(기존 whitespace near-miss 진단과 동급). 약한 모델의 해시 오타는 mismatch → 현행 재제시로 수렴.
- **native tool-use 비도입 근거 보강**: JSON-in-text의 parse-bounce 오버헤드(~수 스텝/턴)는 인정. 전환 비용 = 5개 프로바이더 어댑터 + 엔진 디스패치 전면 재작성 + 프로바이더 불문 균일 프롬프트 상실. 현 가드(MAX_PARSE_BOUNCES/salvage)로 완화된 상태에서 전환 편익이 비용을 하회 — 재평가 트리거: 신규 프로바이더의 JSON 모드 미지원.

## 사이클 렛저 (계속)
- cycle 2: B3 — WORKING_DISCIPLINE 엔진 landed + launch/subagent 배선. 검증: typecheck 0, 43 tests green.
