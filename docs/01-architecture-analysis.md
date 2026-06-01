# 01 — gajae-code 아키텍처 분석

분석 대상: `gajae-code` (`gjc`), TypeScript + Rust, MIT, Stars 227.
1차 자료: 원본 `docs/codebase-overview.md` + 로컬 설치본 `@gajae-code/coding-agent@0.2.2`.

## 1. 제품 형태 (Product shape)

- 중심 패키지는 `packages/coding-agent/`. CLI 바이너리 `gjc`는 `src/cli.ts`, SDK 배럴은 `src/index.ts`.
- **공개 표면을 의도적으로 고정**: 4개의 소스 번들 워크플로 스킬 + 4개의 공개 역할 서브에이전트.
- 런타임 상태(specs/plans/goals/team state/local overrides)는 전부 `.gjc/` 아래.
- 기본 워크플로 정의는 **커밋된 `.gjc` 복사본이 아니라 소스에서 임베드**:
  - 스킬: `packages/coding-agent/src/defaults/gjc/skills/<name>/SKILL.md`
  - 역할 프롬프트: `packages/coding-agent/src/prompts/agents/<role>.md`
- 따라서 프로젝트에 `.gjc`가 없어도 기본 워크플로 표면이 사라지지 않는다. (프로젝트/유저 오버라이드는 추가 디스커버리)

## 2. 모노레포 패키지 경계

| 패키지 | 책임 |
| --- | --- |
| `packages/coding-agent/` | `gjc` CLI + 제품 런타임 (명령, 모드, 도구 레지스트리, 기본 스킬/에이전트 임베드) |
| `packages/ai/` | 프로바이더/모델 경계 — 모델 레지스트리, 스트리밍, auth broker/gateway/storage, OAuth, retry/overflow |
| `packages/agent/` (`@gajae-code/agent-core`) | 상태 보유 에이전트 런타임 — turn loop, append-only context, compaction, telemetry |
| `packages/tui/` | 터미널 UI 프레임워크 — 컴포넌트, 키바인딩, 자동완성, 이미지, Kitty 프로토콜 |
| `packages/natives/` + `crates/` | N-API 네이티브 레이어 (Rust) |
| `packages/utils/` | 공유 TS 유틸 (async, glob, frontmatter, JSON, logging, ptree/procmgr) |
| `packages/stats/` | 로컬 관측 대시보드 `gjc-stats` (SQLite 집계 + SPA 서버) |
| `packages/swarm-extension/` | 선택적 YAML/DAG 멀티에이전트 확장 (`gjc-swarm`, `/swarm`) — 고정 표면 바깥 |
| `packages/typescript-edit-benchmark/` | 비공개 TS 편집 벤치마크 |

### 의존성 관찰 (`@gajae-code/coding-agent@0.2.2`)

- 런타임 deps 23개. 내부 워크스페이스 패키지(`@gajae-code/{agent-core,ai,natives,tui,utils,stats}`)로 핵심을 구성.
- 외부 의존성은 **얇게**: `zod`(검증), `handlebars`(프롬프트 렌더), `puppeteer-core`+`@puppeteer/browsers`(브라우저 도구), `@babel/parser`(AST), `@mozilla/readability`+`turndown`+`linkedom`(웹→마크다운), `markit-ai`, `chalk`, `diff`, `lru-cache`, `fflate`, `@xterm/headless`, `@agentclientprotocol/sdk`(ACP).
- 무거운 작업(AST 검색/편집, grep/glob, 하이라이팅, 토큰 카운팅, 셸/PTY, HTML→MD)은 **Rust 네이티브로 내려** TS 의존성을 줄임.

## 3. 네이티브 레이어 (Rust crates)

- `crates/pi-natives/src/lib.rs` — N-API 루트: appearance, AST search/edit, clipboard, FS scan/cache, grep/glob, syntax highlight, HTML→Markdown, keyboard parsing, process/PTY/shell, SIXEL, code summarization, token counting, text measure/wrap/truncate, workspace scan, power assertions, isolation.
- `crates/pi-shell/` — brush 기반 셸 실행: 영구/일회성 실행, 스트리밍, env, 취소, 출력 minimizer 텔레메트리, 보수적 AST 기반 bash fixup(`fixup.rs`).
- `crates/brush-*-vendored` — bash 빌트인 셸을 Rust로 벤더링 (alias/cd/echo/export/... 50+ 빌트인). 외부 셸 의존 없이 일관된 셸 동작 제공.
- `crates/pi-natives/src/pty.rs` — 인터랙티브 PTY 세션.

> 설계 시그널: "에이전트 도구는 작게, 그 주변 런타임은 단단하게." 토큰 카운팅·셸·AST를 네이티브로 내려 성능/일관성을 확보.

## 4. 런타임 플로우

```text
cli.ts (명령 등록: setup, deep-interview, ralplan, ultragoal, team, launch)
   -> main.ts (CLI 옵션 -> CreateAgentSessionOptions, 모드 디스패치)
      -> sdk.ts (createAgentSession: settings/model/auth/workspace/context
                 + skills + rules + tools + system-prompt + agent-core 인스턴스)
         -> agent-loop (context transform -> model stream -> tool exec
                        -> append tool results -> lifecycle events)
            -> mode: interactive TUI | print | rpc | rpc-ui | acp
```

- `src/main.ts`가 interactive/print/RPC/RPC-UI/ACP 5개 모드를 분기.
- `src/sdk.ts`가 조립 지점(assembly point): 디스커버리 + 도구 + 시스템 프롬프트 + 에이전트 코어.

## 5. src/ 하위 구조 (LOC 프록시, `.ts` 파일 수)

설치본 기준 상위 디렉토리:

| 디렉토리 | ts 파일 | 역할(추정) |
| --- | --- | --- |
| `modes` | 104 | 실행 모드(interactive/print/rpc/rpc-ui/acp) + 컨트롤러 |
| `web` | 101 | 웹 fetch/reader/turndown 파이프라인 |
| `tools` | 81 | 내장 도구 레지스트리 (read/bash/edit/ast/eval/find/search/lsp/browser/task/...) |
| `extensibility` | 43 | 스킬/확장 로딩 (`skills.ts`의 `expandTilde`, `requireDescription`) |
| `commit` | 40 | 커밋/SCM 보조 |
| `commands` | 26 | CLI 서브커맨드 |
| `eval` | 23 | py/js 커널 평가 도구 |
| `discovery` | 19 | 룰/스킬/컨텍스트 디스커버리 (`builtin.ts`, `cursor.ts`, `cline.ts`, `windsurf.ts`) |
| `capability` | 17 | rule/capability 정규화 파이프라인 |
| `session` | 16 | 세션 매니저/상태 |
| `task` | 14 | 서브에이전트(task) + 번들 에이전트 프롬프트 |
| `gjc-runtime` | 11 | deep-interview/ralplan/ultragoal/team 런타임 |
| `goals` | 4 | goal 도구 상태 (ultragoal 원장 연동) |

(그 외 autoresearch, plan-mode, secrets, dap, lsp, ssh, stt, vim, hindsight, memory-backend 등 다수의 작은 모듈)

## 6. 디스커버리/확장 메커니즘 (직접 검증)

- **스킬 customDirectories**: `extensibility/skills.ts`에서 `expandTilde(dir)`로 `~` 확장 후 스캔. `requireDescription: true` — frontmatter `description` 없는 스킬은 스킵. 기본 discovery는 `skills.enabled: false`로 OFF.
- **룰 디스커버리**: `discovery/builtin.ts` `loadRules` — `.agent/rules`, `.agents/rules` (프로젝트 walk-up + 유저 홈). 추가로 최상위 `RULES.md`는 **sticky always-apply 룰**:
  - 유저 스코프: `~/.gjc/agent/RULES.md`
  - 프로젝트 스코프: cwd→repoRoot 위로 가장 가까운 `.gjc/RULES.md`
  - `loadStickyRulesFile`가 `alwaysApply: true` 강제 (매 턴 재주입).
- **멀티 에디터 호환**: cursor/cline/windsurf 룰 포맷 로더를 각각 제공 → 기존 에디터 룰 자산 재사용.

## 7. 보조 표면 (Python)

- `python/gjc-rpc/` — `gjc --mode rpc`용 타입드 Python 클라이언트 (stdio, 이벤트 리스너, host-owned tools/URI).
- `python/robogjc/` — `gjc --mode rpc`를 구동하는 셀프호스팅 GitHub triage/fix 봇 (FastAPI 웹훅 → worktree → gjc, GitHub 사이드카 신뢰경계, per-issue 영구 세션, 감사 로그).

## 8. 검증 게이트

```sh
bun scripts/check-visible-definitions.ts      # 공개 정의 표면 고정 확인
bun scripts/verify-g002-gates.ts              # g002 게이트
bun scripts/rebrand-inventory.ts --strict     # 리브랜드 표면 일관성
bun test packages/coding-agent/test/default-gjc-definitions.test.ts
bun run check:ts                              # tsc 직접 사용 금지
```

> 시사점: "공개 표면을 고정"하는 것을 **테스트/게이트로 강제**한다. 스킬 4개·에이전트 4개가 늘어나지 않도록 CI가 지킨다.

## 9. 핵심 설계 원칙 요약

1. **작은 공개 표면, 단단한 런타임.** 스킬 4 + 역할 4로 고정, CI 게이트로 방어.
2. **소스 임베드 기본값.** `.gjc` 부재가 기본 워크플로를 무너뜨리지 않음.
3. **네이티브로 무거운 일 위임.** 셸/AST/토큰/하이라이트를 Rust로.
4. **얇은 외부 의존성.** 내부 워크스페이스 패키지로 코어 구성.
5. **멀티 모드/멀티 에디터.** TUI/print/rpc/rpc-ui/acp + cursor/cline/windsurf 룰 호환.
6. **증거 기반 완료.** ultragoal 원장 + quality-gate JSON으로 "검증 후 완료" 강제.
