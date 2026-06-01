# 02 — 워크플로 / 스킬 / 도구 표면 분석

gajae-code의 "공개 표면"을 그대로 해부한다. 모든 항목은 설치본 소스로 교차 검증.

## 1. 단일 유용 루프

```text
deep interview  ->  ralplan  ->  team execution  ->  ultragoal verification
   (모호성 제거)     (계획+비평)     (tmux 병렬 실행)      (durable 검증/증거)
```

GJC의 철학: "스킬 동물원(skill zoo)을 만들지 않는다. 이 작은 메서드를 더 좋게 만들어 개선한다."

## 2. 4개 기본 워크플로 스킬 (소스 임베드)

위치: `src/defaults/gjc/skills/<name>/SKILL.md` — 설치본에서 4개 확인.

| 스킬 | 진입점 | 역할 | 산출물 위치 |
| --- | --- | --- | --- |
| `deep-interview` | `/skill:deep-interview`, `gjc deep-interview` | 모호한 아이디어를 Socratic 인터뷰 + 수학적 모호성 점수로 명세화. 제품 코드 변경 금지. | `.gjc/specs/` |
| `ralplan` | `/skill:ralplan`, `gjc ralplan` | Planner/Architect/Critic 합의 계획. 승인 전까지 pending. | `.gjc/plans/` |
| `team` | `/skill:team`, `gjc team` | tmux 백엔드 워커 조율, 공유 상태, 메일박스/디스패치, worktree, 검증 레인. | `.gjc/state/team/` |
| `ultragoal` | `/skill:ultragoal`, `gjc ultragoal` | durable 멀티골 실행 원장, 체크포인트, 증거 추적. | `.gjc/ultragoal/{brief.md,goals.json,ledger.jsonl}` |

핸드오프 표준: `deep-interview 스펙 -> ralplan 합의 -> pending 승인 -> 승인 후 실행`.
계획 워크플로는 **승인 전 제품 소스 편집/뮤테이션/커밋/PR/위임 금지**.

## 3. 4개 공개 역할 에이전트 (task 서브에이전트)

위치: `src/prompts/agents/<role>.md`. 공개 계약은 4개; 그 외(`explore`, `init`, `reviewer`, `task`, `frontmatter`, `plan`)는 내부/런타임 유틸.

| 에이전트 | 모드 | 용도 |
| --- | --- | --- |
| `executor` | 구현 | 경계가 있는 구현/리팩터/수정 슬라이스. 대규모 작업은 슬라이스로 위임. |
| `architect` | 읽기전용 | 아키텍처/코드리뷰 평가, 상태 `CLEAR`/`WATCH`/`BLOCK` + 심각도 |
| `planner` | 읽기전용 | 시퀀싱, 수용 기준, 리스크 매핑, 핸드오프 형태 |
| `critic` | 읽기전용 | 계획 비평 — 추측 없이 실행 가능 + 검증 구체적일 때만 승인 |

라우팅 원칙(시스템 프롬프트에서 확인):
- 명확/저위험 구현 → 직접 실행 + 집중 검증
- 모호한 요구 → `deep-interview`
- 명확하나 아키텍처/시퀀스 위험 → `ralplan` (pending 승인에서 정지)
- durable 골 원장 필요 → `ultragoal` (승인된 계획 없으면 `ralplan` 먼저)
- 승인된 작업 + 영구 워커 → `team`
- 충분히 큰 구현 → `executor`에 슬라이스 위임

## 4. 도구 표면 (`src/tools/`, 81 ts 파일)

내장 도구는 작지만 강하게 묶여 있다. 주요 카테고리:

| 카테고리 | 도구 |
| --- | --- |
| 파일/검색 | `read`, `write`, `edit`, `find`, `search`(+ `search-tool-bm25`), `archive-reader`, `sqlite-reader` |
| 코드 인텔리전스 | `ast-grep`, `ast-edit`, `lsp`, `review` |
| 실행 | `bash`(+ `bash-interactive`, `bash-pty-selection`, `bash-command-fixup`, `bash-interceptor`), `eval`(py/js 커널), `calculator`, `debug`(DAP) |
| 웹/렌더 | `fetch`, `browser`(puppeteer), `render-mermaid`, `image-gen`, `inspect-image` |
| 오케스트레이션 | `subagent`, `job`, `irc`(에이전트 간 라이브 메시징), `todo-write`, `checkpoint`, `recipe` |
| 메모리/회고 | `hindsight-recall`/`-reflect`/`-retain`, `memory-backend`, `context` |
| SCM/GitHub | `gh`(+ `gh-format`, `gh-renderer`, `github-cache`), `commit` |
| 가드 | `plan-mode-guard`, `auto-generated-guard`, `conflict-detect`, `resolve` |

특이점:
- **`irc`**: 서브에이전트끼리 라이브 프로즈 메시지 교환 (await timeout은 실패가 아님).
- **`hindsight-*`**: 회상/반성/보존 — 세션 간 학습 메모리.
- **`recipe`**: 재사용 절차.
- **`bash-command-fixup`** + Rust `fixup.rs`: 보수적 AST 기반 bash 수정.

## 5. 디스커버리 계약 (재사용 자산 호환)

- **스킬**: `native` 프로바이더(`.gjc/skills`, `~/.gjc/agent/skills`) + `customDirectories`(틸드 확장, `requireDescription`). 기본 OFF(`skills.enabled: false`).
- **룰**: `.agent/rules` / `.agents/rules` (프로젝트 walk-up + 유저 홈) + 멀티에디터 로더(cursor/cline/windsurf).
- **sticky RULES.md**: `~/.gjc/agent/RULES.md`(유저), 가장 가까운 `.gjc/RULES.md`(프로젝트) → 매 턴 `alwaysApply` 재주입.
- 스킬은 세션 내 `/skill:<name>`로 노출. `gjc skills list`는 **번들 4개만** 표시(외부 스킬 미표시).

## 6. 모드 표면 (`src/modes/`, 104 ts)

`interactive`(TUI) · `print`(-p, 비대화형) · `rpc`(JSONL stdio) · `rpc-ui` · `acp`(Agent Client Protocol).
RPC 모드는 워크플로 변경 설정(todo/task/async/bash.autoBackground)을 기본값으로 리셋, 세션 타이틀 생성 비활성.

## 7. 관측/검증

- `packages/stats` (`gjc-stats`): SQLite 집계 + 로컬 SPA 대시보드.
- ultragoal 완료는 **quality-gate JSON 강제**: `architectReview`(architecture/product/code = CLEAR + APPROVE) + `executorQa`(e2e/red-team passed) + `iteration`(fullRerun). 셸/훅은 goal 상태를 뮤테이트하지 못함(읽기전용 스냅샷 reconciliation).

## 8. jeo-code 관점 시사점

- **표면 고정 + 게이트 강제**가 핵심 자산. jeo-code도 표면을 늘리기보다 "원장/리뷰/정리" 한 축을 깊게.
- `irc` + `subagent` + `team`의 조합이 멀티에이전트 실행의 실제 엔진. jeo의 통합 원장은 ultragoal `ledger.jsonl`을 1급 시민으로 확장하는 방향이 자연스럽다.
- 디스커버리가 멀티에디터/멀티런타임 호환 → jeo-code 자산을 GJC에 무복사로 얹기 쉬움(customDirectories).
