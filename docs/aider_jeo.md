# Aider vs. jeo — 워크플로우 비교

> AI 페어 프로그래밍 CLI 두 가지의 워크플로우, 철학, 특장점을 비교한다.
> `aider`는 본 저장소에 설치되어 있지 않으므로(이 문서 작성 시점 `aider: command not found`),
> Aider 항목은 공식 문서(https://aider.chat/, https://github.com/Aider-AI/aider) 기준이며
> jeo 항목은 이 저장소(`jeo-code`)의 README / 소스 기준이다.

## 한눈에 보기

| 구분 | **Aider** | **jeo (jeo-code)** |
|------|-----------|--------------------|
| 한 줄 정의 | Git 친화적 터미널 AI 페어 프로그래머 | 인터뷰 → 계획 → 승인 → 실행 → 검증을 게이트로 잇는 Spec-first 코딩 에이전트 |
| 런타임 | Python (`pip`/`pipx`) | Bun ≥ 1.3.14, 순수 TypeScript, **네이티브 의존성 0** |
| 핵심 루프 | 채팅 기반 edit/diff 루프 | JSON 도구 루프(read·write·edit·bash…) + 단계 예산(step budget) |
| 인터페이스 | 라인 기반 채팅 REPL | 인라인 스크롤백 친화 TUI(틴맥스 휠 지원, Ctrl+O 상세, 테마) |
| 편집 적용 방식 | LLM diff/edit-block을 파일에 적용 | 콘텐츠 앵커(`42ab\|`) 기반 앵커드 편집 — 라인 이동 시 재매핑, 불일치 시 손상 대신 거부 |
| 버전관리 통합 | **변경마다 자동 커밋**, `/undo`로 되돌림 | 커밋 자동화 아님; `.jeo/` 상태에 원자적 기록 + 실패 마커, git은 사용자 통제 |
| 컨텍스트 관리 | 사용자가 `/add`로 파일을 명시 추가, repo-map 자동 생성 | 자동 파일 탐색 + 컨텍스트 압축(`/compact`)·토큰 사용량 추적(`/usage`) |
| 멀티 프로바이더 | OpenAI/Anthropic/다수 모델(LiteLLM 경유) | Anthropic/OpenAI(+Codex)/Gemini/Antigravity/Ollama를 단일 JSON 루프로, OAuth 로그인 내장 |
| 검증/품질 게이트 | 사용자가 `/test`·`/lint` 명령 지정(자동 수정 옵션) | post-edit 훅(tsc/eslint/test)을 에이전트가 **직접 보고 루프 내 수정**, red면 `done` 차단 |
| 서브에이전트/역할 | 단일 에이전트(architect 모드 등 변형) | executor·planner·architect·critic 역할별 모델·thinking·예산 + 부모 측 mutation 감사 |
| 계획·합의 단계 | 명시적 단계 없음(architect 모드가 유사) | `ralplan` repo-grounded critic가 `[OKAY]/[ITERATE]/[REJECT]` 판정, `approve`가 합의 verdict 요구 |
| 상태 지속성 | git 커밋 히스토리 | `.jeo/` 원자적 쓰기, 크로스 프로세스 run lock, 실패-태스크 마커 + 부분편집 경고 |
| 워크플로우 스킬 | 없음(단일 작업 중심) | `$team`, `deep-interview`, `ultragoal` 등 다단계 스킬 + 슬래시 팔레트 |

## 워크플로우 흐름 비교

### Aider — 테스트 기준 편집 루프 (scope-locked)

1) 전제 확인:  git rev-parse --show-toplevel · aider --version · 테스트 명령 확보
2) 스코프 고정: 한 번에 작업 1개 + 대상 파일 범위 + 수용 기준 + 검증 명령
3) 편집 루프:  baseline 테스트 → aider 수정 → 테스트 재실행 → diff 확인 → 필요 시 반복
4) 커밋 위생:  git add -p 로 범위 검토 → 의도+검증 포함 커밋 → 리스크 명시
5) 폴백:       변경이 퍼지면 즉시 범위 축소; 테스트가 반복 깨지면 자동 루프 중단→원인 분석

특징: **사람이 스코프·파일·커밋을 운전**하고 Aider는 그 안에서 빠르게 편집한다. git 자동 커밋으로 각 단계가 되돌릴 수 있는 체크포인트가 된다.

### jeo — Spec-first 게이트 파이프라인

jeo deep-interview "무엇을 만들지 기술"   # 모호성 점수화, 구체적일 때만 seed 동결
jeo ralplan                              # 초안 + repo-grounded critic 게이트([OKAY] 필요)
jeo approve <plan-path>                  # 스키마·역할 + 지속된 합의 verdict 검증
jeo team                                 # 직렬 실행 + run lock + 태스크별 서브에이전트 계약 + mutation 감사
jeo ultragoal                            # 정직한 검증(스위트 1회 실행을 전역 신호로, 가짜 통과 없음)

특징: **에이전트가 단계마다 차단형(blocking) 게이트를 통과**해야 다음으로 간다. 모호한 요구는 거부, 미합의 계획은 실행 불가, 검증은 조작 불가.

## 특장점 요약

### Aider가 강한 지점
- **즉시성·경량성** — 설치 후 바로 채팅하며 편집, 단발 버그/소기능에 마찰 최소.
- **git 네이티브** — 변경마다 자동 커밋 + `/undo`로 안전한 실험·롤백.
- **명시적 컨텍스트 제어** — `/add`로 사람이 파일 범위를 직접 통제, repo-map으로 큰 저장소 탐색.
- **언어·생태계 폭** — Python 기반 + LiteLLM으로 모델·언어 선택지가 넓음.

### jeo가 강한 지점
- **게이트형 Spec-first** — 인터뷰·계획·합의·검증이 실제 차단 게이트라 "계획 없는 폭주"를 구조적으로 방지.
- **편집 무결성** — 콘텐츠 앵커 기반 편집으로 라인 드리프트 시 손상 대신 거부/재매핑.
- **자기교정 검증 루프** — 훅(tsc/eslint/test) 결과를 에이전트가 직접 읽고 루프 내에서 고치며, red면 `done` 차단.
- **역할 분리 + 감사** — executor/planner/architect/critic 분리, "변경 0인데 완료"라는 빈 작업을 부모가 감지.
- **크래시 내성·로컬 우선** — `.jeo/` 원자적 쓰기·run lock·실패 마커로 중단 후 재개가 안전.
- **인라인 TUI** — 작업이 실제 스크롤백으로 flush(틴맥스 휠 작동), 입력창 상시 편집 가능, CJK/이모지 폭 안전.
- **제로 네이티브 의존성** — Bun 단일 런타임으로 배포·실행이 단순.

## 언제 무엇을 쓰나
- **빠른 단발 버그픽스/소기능을, 사람이 직접 파일·커밋을 운전하며** → Aider 루프가 마찰이 적다.
- **요구 정의가 모호하거나, 다단계 작업을 합의된 계획·검증 게이트로 안전하게 끌고 가야 할 때** → jeo의 Spec-first 파이프라인이 맞다.
- 둘은 배타적이지 않다: jeo로 계획·게이트를 세우고, 좁은 편집 구간에서 Aider식 "테스트 기준 scope-lock 루프"를 차용하면 상호 보완적이다.

## 참고
- Aider: https://github.com/Aider-AI/aider · https://aider.chat/
- jeo: 본 저장소 `README.md`(Spec-first workflow, Verification hooks 섹션), `docs/usage-guide.md`
