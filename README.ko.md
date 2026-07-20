<p align="center">
  <img src="assets/hero.png" alt="jeo-code 자율 코딩 에이전트 히어로 일러스트" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  Bun 기반 AI 코딩 에이전트 CLI — 인터뷰, 검토된 플랜, 게이트된 실행, 정직한 검증.
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="zero native deps" src="https://img.shields.io/badge/native%20deps-0-blue?style=flat-square">
</p>

<p align="center">
  <img src="assets/character.gif" alt="가장 저렴한 프로바이더로 프롬프트를 스마트하게 라우팅하며 동전을 모으는 움직이는 jeo-code 붉은 가재 마스코트" width="320" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <b>한국어</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh.md">中文</a>
</p>

저장소 안에서 `jeo`를 실행하면 파일을 읽고, 수정하고, 명령을 실행하며 작업을 완료까지 끌고 갑니다 — 모든 스텝이 스크롤백 친화적인 인라인 TUI로 실시간 스트리밍됩니다.

## 문서

📖 **[사용 가이드](docs/usage-guide.md)** — 설치, TUI 조작(↑ 이전 쿼리, Ctrl+O, `!` 셸), 슬래시 명령, `/resume`, 스펙 우선 워크플로를 데모 영상과 함께 설명합니다.

<video src="https://raw.githubusercontent.com/akillness/jeo-code/main/docs/jeo-code-promo.mp4" controls muted playsinline width="100%"></video>

> 인라인 재생이 안 되면 ▶ [데모 영상 재생/다운로드](docs/jeo-code-promo.mp4).

## 하이라이트

- **멀티 프로바이더, 단일 루프** — Anthropic / OpenAI(+Codex) / Gemini / Antigravity / Ollama / LM Studio, 그리고 OpenAI·Anthropic 호환 클라우드 20종 이상(Groq, DeepSeek, Mistral, OpenRouter, xAI, Kimi, z.ai 등)까지 균일한 JSON 도구 루프로. 입력창에서 바로 OAuth 로그인(`/provider login`), 모델 선택은 즉시 기본값으로 영속됩니다. 프롬프트 라우팅은 실제 사용 가능한 인증 경로만 자동 선택합니다: Gemini OAuth는 provider-qualified `antigravity/*` 에이전트 세트(Gemini 3.5 Flash 등급, Gemini 3.1 Pro, Claude Sonnet/Opus 4.6)로만 가고, `GEMINI_API_KEY`가 필요한 public `google/gemini-*` 행은 고르지 않습니다.
- **편집 무결성** — read 출력에 콘텐츠 앵커(`42ab|`)가 붙고, 앵커 편집은 현재 파일과 대조 검증·줄 이동 시 자동 재매핑·불일치 시 최신 내용과 함께 거부 — 파일을 오염시키지 않습니다.
- **자기수정 검증 루프** — post-edit 훅(tsc / eslint / 테스트)을 설정하면 에이전트가 진단을 *직접 읽고* 루프 안에서 수정합니다. 훅이 빨간 상태면 `done`이 차단됩니다.
- **연극 없는 진짜 게이트** — `ralplan` 합의는 실제 저장소를 읽는 critic 서브에이전트이며 `[OKAY]` 평결이 영속되고 `jeo approve`가 이를 *요구*합니다. `ultragoal`은 정직하게 보고합니다(스위트 1회 실행은 전역 신호일 뿐, 기준별 통과를 조작하지 않음).
- **크래시 내구·로컬 우선** — 모든 상태는 `.jeo/` 아래 원자적 쓰기, 크로스 프로세스 런 락, 실패 태스크 마커 + 재개 시 부분 편집 경고.
- **동적 스텝 버짓** — 최근 도구 호출이 새로운 진전을 보이는 동안 연장되고, 정체되면 정리 요약으로 수렴. 서브에이전트는 정확한 스텝 계약 유지.
- **인라인 TUI** — 완료된 작업은 실제 스크롤백으로 흘러가고(턴 중에도 tmux 휠 스크롤 가능), 에이전트가 실행 중이어도 기존 쿼리 입력창이 그대로 보이며 편집됩니다. Ctrl+O 상세 토글, 테마, 클립보드 이미지 붙여넣기(Ctrl+V), CJK/이모지 안전 폭 계산.
- **브라우저 도구** — Playwright 기반 헤드리스 Chromium 자동화가 1급 에이전트 도구로 포함: 이름 붙은 탭을 재사용하며 `open`/`close`/`run`/`act`, 스크린샷보다 `observe`로 태깅된 요소 id를 우선 사용. `act {verb:"verify", goal, ...}`는 비주얼 QA 루프를 완결시킵니다: 페이지를 스크린샷으로 찍고 독립적인 비전 지원 모델에게 평이한 언어의 목표와 대조해 판단하도록 요청해(`{verdict:"PASS"|"MISMATCH", detail}`), 사람(또는 같은 에이전트)이 저장된 PNG를 직접 눈으로 확인할 필요를 없앱니다. `npx playwright install chromium`을 한 번 실행해야 함(번들 아님 — jeo 자체는 여전히 네이티브 의존성 0, 브라우저 바이너리는 Playwright의 별도 다운로드).
- **누적되는 스킬** — 정체된 턴은 이제 그 막다른 지점을 바로 그 스킬의 프로젝트 레벨 파일(`.jeo/skills/<name>.md`, 첫 작성 시 번들 스킬로 시드, 결정론적 키워드 매칭, LLM 미사용)에 기록하므로, 다음 세션의 `$<skill>` 호출은 번들 문서가 영원히 정적으로 남는 대신 누적된 "Known Failure Modes"/"Anti-Patterns" 지식을 함께 가져갑니다. 수동 항목은 `jeo skills lesson <skill> <failure|anti-pattern> "<title>" "<detail>"`로; `jeo skills eval <skill>`은 기록된 각 교훈이 스킬의 현재 가이던스로 여전히 커버되는지 아니면 낡았는지를 실제 LLM 판단으로 확인합니다.
- **저비용 등급 채점 라우팅** — `/goal` 검증기, `critic` 서브에이전트 역할, 그리고 고정되지 않은 `task` 팬아웃 배치는 채점·실행 대상인 작업과 같은 풀프라이스 모델에 조용히 편승하는 대신 기본적으로 저비용 크레덴셜 모델을 사용합니다(`resolveVerifierModel`, 브라우저 `verify` 액션에 대해서는 비전 능력으로 필터링되어 텍스트 전용 저비용 모델이 첨부된 스크린샷을 조용히 누락시키지 않도록 합니다).
- **`jeo routine init`** — 스케줄/이슈/PR 트리거에서 jeo를 헤드리스로 실행하는(`jeo "<prompt>" -p`) GitHub Actions 워크플로를 생성합니다, GitHub 자체 러너 위에서 — 노트북이 필요 없고, jeo 내부에 새로운 공격 표면도 전혀 추가되지 않습니다(인프로세스 스케줄러도 웹훅 리스너도 없음). `--dry-run`으로 미리보기, `--no-pr`로 기본값인 실행당 PR 대신 직접 커밋.
- **원격 서브에이전트 가시성(Telegram)** — 봇을 한 번 페어링(`jeo notify setup`)하면, `jeo daemon start`가 서브에이전트 상태 전환(시작 → 완료/실패/취소)마다 메시지를 보내고 `/subagents`, `/steer <id> <subagentId> <msg>`, `/cancel <id> <subagentId>`를 되받습니다. 이제 Telegram 포럼 토픽, 인라인 키보드, 이미지 첨부 파일 지원 등 `gjc`와의 완전한 패리티를 제공하며, 명령은 페어링된 채팅에서만 허용됩니다.
- **실제로 강제되는 독립 검증자** — 플랜은 이제 architect/critic 단계를 건너뛸 수 없습니다: `PlanSchema`는 미검증 변이로 끝나는 모든 플랜을 거부하며(검증 대상 변이보다 앞에 배치된 검증자도 인정하지 않음), `ralplan` 드래프트 시점과 `team`/`approve` 실행 시점 양쪽 모두에 적용됩니다. 모든 architect/critic 평결도 실제 증거를 제시해야 하며, 관찰된 `read`/`search`/`find`/`ast_grep`/`lsp` 호출이 0건이면 텍스트가 무엇을 주장하든 평결이 차단됩니다.
- **안전 경계 자동 모델 폴백** — 미분류 안전 거부(실제 콘텐츠 정책 위반이 아니라 분류기의 오탐일 가능성)가 발생하면 이제 같은 모델에서 영원히 물러서는 대신 실제로 다른 프로바이더의 모델로 전환합니다 — 기존 rate-limit 빠른 폴백과 동일한 방식입니다. `Refusal (<category>)` 형태의 결정론적 거부는 영향받지 않고 여전히 폴백 없이 하드 실패합니다.
- **메모리: 획득한 신뢰** — 개념의 검증 날짜는 이제 모든 쓰기 시점이 아니라 증류 패스가 명시적으로 검증됨으로 표시할 때만 기록됩니다. `isConceptStale`은 수동적인 타임스탬프를 신뢰하는 대신 미검증(또는 30일 초과) 개념을 재검증이 필요한 것으로 처리합니다.
- **동적 워크플로(`eval` 도구)** — 서브에이전트 디스패치 주변에 실제 JS 제어 흐름을 작성합니다: `task(role, taskText, context?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `log(message)`로 `task`의 단일 스테이지 `tasks[]` 배치로는 표현할 수 없는 순차/분기 오케스트레이션을 구성합니다. 격리된 Worker 스레드에서 진정한 선점형 타임아웃(같은 프로세스 내 경쟁이 아닌 `worker.terminate()`)으로 실행되며 — `bash`와 동일한 풀프로세스 신뢰 수준으로, 샌드박스인 척하지 않고, 동일한 인터뷰 변이 락으로 게이트됩니다.
- **끊긴 출력 파이프에서 조용히 종료** — 읽기를 일찍 멈추는 명령으로 파이프할 때(`jeo --help | head`, 사라진 원격 피어) 더 이상 원시 `EPIPE` 스택을 덤프하지 않습니다 — 셸이 SIGPIPE로 종료된 파이프라인 생산자에게 보고하는 것과 동일한 코드(141)로 조용히 종료됩니다. 실제 크래시는 영향받지 않고 여전히 명확하게 드러납니다.
- **macOS 낮은 파일 디스크립터 한도 경고** — 낮은 `ulimit -n`(BSD 기본값 256/1024)은 파일 감시, 브라우저 도구, 넓은 리포지토리 스캔에서 불명확한 `EMFILE` 실패를 유발할 수 있습니다 — jeo는 이제 실행 시 한 번(stderr로만, 파이프되는 `-p` 출력은 오염시키지 않음) `ulimit`/`launchctl` 구체적인 안내와 함께 경고합니다. `JEO_SKIP_NOFILE_CHECK=1`로 옵트아웃할 수 있습니다.


## 설치

Bun `1.3.14+` 필요.

```bash
bun install -g jeo-code
jeo --version
```

> 이름 변경 이전 버전에서 업그레이드하시나요? 이전 CLI 이름이었던 `joc` 바이너리는 이제 `scripts/install.sh` / `scripts/uninstall.sh`가 자동으로 제거합니다. 수동 제거: `rm -f ~/.local/bin/joc ~/.bun/bin/joc`.

## 빠른 시작

```bash
jeo                      # 현재 저장소에서 대화형 에이전트
jeo "README 정리하고 테스트 돌려줘"   # 원샷 요청
jeo doctor               # 설정 + 라이브 모델 연결 점검
jeo setup                # API 키 / OAuth / 로컬 모델 설정
jeo --tmux               # 독립 tmux 세션에서 실행
```

## 슬래시 명령

`jeo` REPL 안에서 사용(Tab 자동완성, `/` 입력 시 팔레트).

| 명령 | 설명 |
| --- | --- |
| `/model` · `/provider` | 모델/프로바이더 선택; `/model`에서 기본/역할 배지, Ralph식 하위 리스트 역할·thinking 선택, OpenAI Codex 역할 프리셋을 한 흐름으로 설정 |
| `/provider login <name>` · `/logout` | 입력창에서 OAuth 로그인/로그아웃 |
| `/agents [role]` · `/subagent` | 역할별(executor/planner/architect/critic) 모델·thinking·스텝 구성 |
| `/thinking [level]` | 기본 추론 예산(low…xhigh) 조회/설정 |
| `/route [status\|on\|off\|why\|history [n]]` | 세션별 프롬프트 기반 모델 라우팅 켜기/끄기 · 마지막 라우팅 결정 설명 · `history [n]`은 이번 세션의 최근 n개(기본 10개) 라우팅 결정 표시(설정된 자격증명 — OAuth 또는 API 키 — 이 실제로 서비스하는 모델 안에서만 자동 라우팅) |
| `/fast [on\|off\|status]` | 현재 모델이 low 추론을 지원하면 fast thinking 모드를 켜고 끔 |
| `/skill` · `$<skill> [intent]` | 워크플로 스킬 목록/실행(`$team "작업"` 스타일) |
| `/view` · `/diff` · `/find` · `/search` | 코드 보기, git diff, 파일/패턴 검색 |
| `/new` · `/resume` · `/sessions` | 세션 관리 |
| `/history [n\|all]` · `/export` | 작업 활동 히스토리를 읽기 좋게 스크롤백에 재출력 · 트랜스크립트 내보내기 |
| `/retry` · `/btw <질문>` | 마지막 요청 재시도 · 히스토리에 안 남는 사이드 질문 |
| `/usage` · `/context` · `/compact` | 토큰 사용량, 컨텍스트 내역, 수동 컴팩션 |
| `/theme` · `/config` · `/help` | 테마, 런타임 설정, 도움말 |
| `jeo autopilot status` | 점수 방향, keep/revert 횟수, 다음 액션을 보여주는 ratchet 상태 필드 |

> [!CAUTION]
> **`/model <name>`으로 특정 모델을 수동 지정하면 그 세션 동안 라우팅이 고정됩니다.** 프롬프트 라우팅(`/route`)은 모델이 수동으로 고정되지 않은 동안만 매 턴 재평가됩니다. `/model <name>`으로 특정 모델을 선택하면 그 선택이 그대로 고정되며, `/model auto`(핀을 완전히 해제)를 실행하거나 `/route on`(핀을 지우지 않고 그보다 우선순위를 높임 — `/route off` 하는 즉시 핀이 다시 살아남)을 실행하기 전까지는 라우팅이 다시 전환되지 않습니다. `roles.*` 항목 미설정 시 `defaultModel`로 확정 폴백되는 건 `standard` 티어뿐이며, `high`/`complex` 티어는 보통 폴백 전에 실시간으로 크레덴셜된 가장 강력한 모델을 먼저 탐색하므로, 설정이 없어도 매 턴 다른 모델로 갈 수 있습니다. **예외:** Antigravity 또는 Gemini OAuth로 크레덴셜된 세션은 하나의 크레덴셜로 Anthropic/Google/OpenAI 모델을 함께 재노출하는데, 이 경우 `high`/`complex`는 (항상 최강 모델이 아니라) 회사당 모델 1개로 세션-안정적으로 분산되어, 턴마다 바뀌지 않고 해당 세션 내내 고정됩니다.

## Spec-first 워크플로

요구사항 → 플랜 → 승인 → 실행 → 검증이 `.jeo/state/`로 이어지며, 모든 핸드오프에 **차단 가능한 진짜 게이트**가 있습니다:

```bash
jeo deep-interview "만들고 싶은 것을 설명"
jeo ralplan
jeo approve <플랜경로>
jeo team
jeo ultragoal
```
```
  ┌──────────────────────┐
  │   deep-interview     │  Socratic ambiguity gate · seed frozen when concrete
  └──────────┬───────────┘
             │ .jeo/state/<seed>.json
             ▼
  ┌──────────────────────┐
  │       ralplan        │  Draft + repo-grounded critic → [OKAY] persisted
  └──────────┬───────────┘
             │ requires [OKAY] verdict
             ▼
  ┌──────────────────────┐
  │       approve        │  Schema + roles + [OKAY] — unlocks execution
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │        team          │  Serial executor · run lock · mutation audit
  └──────────┬───────────┘
             │ all tasks done
             ▼
  ┌──────────────────────┐
  │      ultragoal       │  Honest verification — suite once, no fabrication
  └──────────────────────┘
```

- **deep-interview** — 모호성 스코어링 기반 소크라테스 루프. 기준이 구체적일 때만 시드 동결(vague-only 기준은 거부), 시드는 자체 파서 라운드트립을 통과해야 합니다. 새 아이디어가 완료된 인터뷰를 조용히 재사용하지 않습니다.
- **ralplan** — 드래프팅 패스 + **저장소를 직접 읽는 critic 서브에이전트 게이트**: `[OKAY]`/`[ITERATE]`/`[REJECT]` 평결이 강제·영속됩니다. 무효 플랜(스키마·미지 역할)은 complete로 마킹되지 않습니다.
- **approve** — `team`이 실행하는 계약(스키마+역할)을 검증하고 영속된 `[OKAY]` 평결까지 요구합니다.
- **team** — 직렬 플랜 실행기: 크로스 프로세스 런 락, stale 플랜 리셋, 태스크별 서브에이전트 계약, 부모측 변이 감사(쓰기 0건의 "완료"는 플래그), 실패 마커 + 재개 시 부분 편집 경고.
- **ultragoal** — 정직한 검증: 스위트는 전역 신호로 1회 실행, 기준은 기록될 뿐 개별 통과로 조작되지 않습니다.

## 검증 훅 (자기수정)

전역에서 한 번 활성화(`~/.jeo/config.json`에 `"hooks": { "enabled": true }`)한 뒤 프로젝트별 post-edit 검사를 추가하면, 에이전트가 실패를 읽고 `done` 전에 고칩니다:

```jsonc
// .jeo/hooks.json
{
  "enabled": true,
  "hooks": [
    { "event": "post-turn", "match": { "tool": "edit|write" }, "run": "bun x tsc --noEmit" }
  ]
}
```

비정상 종료한 훅의 출력은 모델이 읽는 도구 결과에 첨부되고(배치 내 중복 제거), 훅이 빨간 채로 `done`을 부르면 훅 이름과 함께 푸시백됩니다.

## 메모리 흐름

`jeo`는 `.jeo/memory/` 아래에 **로컬 우선·증류된 프로젝트 메모리**를 둡니다(원격 백엔드 없음, 네이티브 의존성 0). 지난 세션은 [OKF](docs/okf_mem/) 개념 번들로 증류되고, 다음 세션은 관련성 높은 예산 한도 내 일부만 시스템 프롬프트로 다시 주입합니다 — 지시가 아닌 DATA로 강화 처리됩니다. `JEO_NO_MEMORY=1`로 전체 비활성화.

**마이그레이션 (`jeo memory-migrate`, 1회성 · 멱등).** 레거시 단일 문서 `MEMORY.md`를 무손실로 번들로 변환합니다: `## 헤딩 → 타입`, 각 불릿 → 타입별 개념, 들여쓴 줄 → 본문; `index.md`/`log.md`를 재생성하고 원본은 `MEMORY.md.bak`으로 이름을 바꿉니다. 번들에 개념이 생긴 뒤 재실행은 no-op입니다. **롤백:** `JEO_MEMORY_LEGACY=1`은 번들을 무시하고 동일한 주입 강화 처리로 `MEMORY.md`/`.bak`를 읽습니다(`JEO_NO_MEMORY=1`이 모든 것에 우선).
## 기존 에이전트 또는 봇과 함께 작동 (Works beside your existing agent or bot)

| 도구 또는 봇 | 권장 jeo 명령 | 경계 |
| ----------- | ----------------------- | -------- |
| Codex CLI | `jeo --tmux --worktree <name>` 또는 `jeo` | `--worktree`는 jeo가 관리하는 형제 git worktree를 지정합니다(basename → 새 브랜치). 기존 경로는 먼저 `cd`로 이동하세요. |
| Claude Code | `jeo --tmux` 또는 `jeo --tmux --worktree <name>` | jeo는 Claude Code 확장 프로그램이 되지 않습니다. |
| OpenCode | `jeo` 또는 `jeo --tmux` | 현재는 외부 러너 워크플로만 지원합니다. |
| Claw Code | `jeo --tmux --worktree <name>` | jeo는 Claw Code에 설치되거나 대체되지 않습니다. |
| 외부 컨트롤러 / 봇 | `jeo mcp serve` (MCP stdio 서버) | 외부 컨트롤러는 스크롤백 스크래핑이 아니라 MCP 도구 계약을 통해 jeo를 구동합니다. |

`--worktree <name>`는 격리된 형제 git worktree에서 jeo를 실행하므로(경로가 있으면 재사용, 없으면 basename 브랜치로 생성) 위험하거나 검토가 필요한 작업이 메인 체크아웃을 건드리지 않습니다. `jeo mcp serve`는 stdio를 통해 MCP를 지원하는 모든 컨트롤러에 jeo의 도구를 노출합니다(`jeo mcp tools`로 목록 확인). `-q`/`--quiet` (또는 `JEO_QUIET=1`)를 추가하면 시작 배너, 환영 애니메이션, 릴리스 노트, 재개 힌트가 억제되어 jeo를 다른 에이전트와 나란히 실행하거나 봇으로 구동할 수 있습니다. `-p`/`--print`는 quiet를 함의합니다.

## 원격 모니터링 & 제어 (Telegram)

```bash
jeo notify setup        # BotFather 봇 한 번 페어링 (getMe 검증 + chat-id 페어링)
jeo notify status       # 마스킹된 토큰, 페어링된 chat id, 데몬 상태
jeo daemon start        # 싱글턴 백그라운드 데몬 실행
jeo daemon status       # 실행 여부 확인
jeo daemon stop         # SIGTERM으로 종료
```

```
┌─────────────────────┐        ┌─────────────────────┐         ┌─────────────────────┐
│   interactive turn  │◄──ws──►│    notify daemon    │◄─poll──►│     Telegram bot    │
│   SubagentRegistry  │        │     (singleton)     │         │    (paired chat)    │
└─────────────────────┘        └─────────────────────┘         └─────────────────────┘
```

옵트인이며 지연 바인딩됩니다: `notifications.enabled`가 설정되고 detached 서브에이전트(`task {detached:true}`)가 실제로 실행되어야만 동작합니다. 데몬은 살아있는 세션 디스커버리 파일을 스캔해 세션별로 루프백 WebSocket을 연결하고, 서브에이전트 상태 *전환* 시점(시작 → 완료/실패/취소)에만 메시지를 보냅니다 — "여전히 실행 중" 같은 반복 알림은 없습니다. 이제 Telegram 포럼 토픽, 인라인 키보드, 이미지 첨부 파일 지원 등 `gjc`와의 완전한 패리티를 제공합니다. 수신되는 Telegram 명령은 페어링된 채팅에서만 허용되며, 그 외는 조용히 무시됩니다.

| 명령 | 동작 |
| --- | --- |
| `/subagents` | 연결된 모든 세션의 실행 중/최근 서브에이전트 목록 |
| `/steer <sessionId> <subagentId> <message>` | 실행 중인 서브에이전트에 실시간 메시지 전송 |
| `/cancel <sessionId> <subagentId>` | 실행 중인 서브에이전트 취소 |
| `/help` | 명령 안내 표시 |

## 루틴 (GitHub Actions)

```bash
jeo routine init --trigger schedule --cron "0 7 * * *" --prompt "Re-run the eval suite and post a digest" --dry-run
jeo routine init --trigger issues --prompt "Triage this issue" --name "issue-triage"
```

GitHub Actions 워크플로(`.github/workflows/<name>.yml`)를 생성해 jeo를 설치하고 `schedule` / `issues` / `pull_request`에서 헤드리스로 실행합니다(`jeo "<prompt>" -p`) — 수동 테스트 실행을 위해 항상 `workflow_dispatch`와 함께 짝지어집니다 — GitHub 자체 호스팅 러너 위에서. 이것이 jeo의 "노트북 없이 동작"하는 이야기입니다: jeo 자체 내부에 인프로세스 스케줄러도, 웹훅 리스너도, 코드 실행 샌드박스도 없습니다 — GitHub의 인프라가 트리거를 담당하고, jeo는 기존 헤드리스 모드를 그대로 실행할 뿐입니다. 기본적으로 변경사항이 있으면 PR을 엽니다(`peter-evans/create-pull-request`, diff가 비어 있으면 안전하게 no-op); `--no-pr`은 대신 트리거한 브랜치에 직접 커밋합니다. `--dry-run`은 YAML을 작성하지 않고 출력만 합니다; 동일한 `--out` 경로에서 `jeo routine init`을 재실행하면 `--force` 없이는 덮어쓰기를 거부합니다. 워크플로의 첫 실제 실행 전에 저장소 시크릿 `ANTHROPIC_API_KEY`(또는 `--api-key-env <VAR>`)를 설정하세요.

## 로컬 모델

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor && jeo
```

## 설정

- 전역 설정: `~/.jeo/config.json` (모델 선택은 MRU 영속)
- 프로젝트 상태/세션: `<project>/.jeo/`

```bash
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...           # 예: ollama/qwen2.5:0.5b
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic            # cosmic/matrix/solar/red-claw/blue-crab/mono/aurora/synthwave/sakura/gruvbox-dark
JEO_TUI_ALT_SCREEN=1            # 레거시 alt-screen 턴(기본: 인라인 스크롤백)
JEO_STEP_BASE=24                # 동적 스텝 버짓의 롤링 베이스
JEO_STEP_HARD_CAP=600           # 절대 종료 보증
JEO_STREAM_MAX_MS=1800000       # 전체 스트림 데드라인(기본 30분; 슬로우드립 스트림 제한, 활성 스트림 자체를 끊기 위한 값은 아님); 0이면 비활성화
JEO_STREAM_IDLE_MS=300000       # 청크당 유휴 타임아웃(기본 300초); 첫 토큰 전 침묵이 긴 느린/로컬 백엔드는 값을 높이세요
JEO_CALL_TIMEOUT_MS=1800000     # 비스트리밍 호출 벽시계 제한(기본 30분; 컴팩션/서브에이전트/goal-verify)
JEO_TURN_MAX_MS=1800000         # 턴 정체 예산: 도구 진전이 없는 최대 시간(기본 30분); 0이면 비활성화
JEO_TOOL_OUTPUT_MAX=4000        # 모델 가시 도구 출력 캡(전체는 아티팩트로 스필)
```

재시도 동작은 `~/.jeo/config.json`의 `retry`로 조정합니다(`requestMaxRetries`, `streamMaxRetries`, `rateLimitRetries`, `failFastStatuses`, …). 스텝 버짓은 기본 동적 — 새로운 진전이 보이는 동안 연장되고 정체 시 요약으로 수렴하며, `--max-steps N`이면 유한 플로로 복귀합니다.

## 스킬 마이그레이션 및 번들 스킬 확인

워크플로를 jeo로 옮기기 전에, 무언가를 설치하거나 덮어쓰기 전에 먼저 번들 기본값을 확인하세요:

```bash
jeo skills list                 # 번들 + 사용자 + 프로젝트 스킬, 디스커버리 디렉터리 포함
jeo skills read ralplan         # 스킬 하나의 전체 SKILL.md 출력
jeo skills sync --check         # ~/.jeo/skills 대비 drift 리포트 (drift 시 non-zero exit)
```

`jeo skills sync`는 번들 워크플로 스킬(deep-interview, deep-dive, ralplan, team, ultragoal)을 `~/.jeo/skills`에 설치하며 **기본적으로 기존 로컬 파일을 보존**합니다 — 다른 로컬 사본은 덮어쓰지 않고 `preserved`로 보고됩니다. `--check`가 누락되거나 다른 파일을 플래그하면 먼저 `jeo skills read <name>`으로 비교하세요; 로컬 기본 워크플로 스킬 파일을 의도적으로 교체하고 싶을 때만 `jeo skills sync --force`를 사용하세요. 후행 경로 인자(또는 `JEO_CONFIG_DIR`)로 다른 디렉터리를 지정할 수 있고, `--json`으로 구조화된 `SkillSyncResult`를 받을 수 있습니다.

## 개발

jeo는 Bun 위의 순수 TypeScript이며 **네이티브 의존성이 0**이라, 전역 `jeo` 명령이 이 체크아웃의 소스를 직접 실행할 수 있습니다 — 빌드 단계 없이, 모든 수정이 즉시 반영됩니다.

```bash
bun install
bun run dev:link            # `jeo`를 <repo>/src/cli.ts에 심볼릭 링크 -> ~/.local/bin
bun run dev:doctor          # 전역 `jeo`가 이 소스를 실행하는지 보고(linked/drift/missing)
```

`dev:link`는 `PATH`에서 관리되는 링크보다 먼저 오는 다른 `jeo`가 있으면 진행을 거부하고(대상은 `JEO_DEV_LINK_DIR`로 재정의), `--version` 스모크 테스트를 실행합니다. `dev:doctor`는 해석된 `jeo`가 이 소스가 아니라 컴파일된 바이너리나 설치된 사본이면 non-zero로 종료합니다. 링크 없이 소스에서 바로 실행하려면 `bun src/cli.ts --help`. 번들 워크플로 스킬은 소스의 `src/prompts/skills/<name>/SKILL.md`에 있습니다; `bun run typecheck`와 `bun test`로 검증하세요.

## 배포 (Publishing)

CI는 `.github/workflows/npm-publish.yml`로 배포합니다 — GitHub 릴리즈 게시 시 자동, 또는 `workflow_dispatch` 수동 실행(드라이런 옵션). 워크플로는 타입체크·테스트·토큰 검증(`npm whoami`) 후 `npm publish --provenance`를 실행합니다.

필요한 npm 토큰 권한(저장소 시크릿 `NPM_TOKEN`):

- `jeo-code` 패키지에 Read/Write 권한이 있는 **Granular Access Token**, 또는 클래식 **Automation** 토큰
- "배포 시 **bypass 2FA**" 허용 필수 — Automation 토큰은 항상 우회, granular 토큰은 옵션 활성화 필요

## 감사의 말 (Acknowledgements)

[gajae-code](https://github.com/Yeachan-Heo/gajae-code)에 깊은 감사를 드립니다.

## 변경 이력 (Changelog)

<!-- CHANGELOG:START (auto-generated from CHANGELOG.md — run `bun run changelog:sync`) -->
- **[0.8.33]** (2026-07-20) — Real terminal-resize testing (repeated tmux resize-window + keystroke reproductions, byte-for-byte ANSI replay outside jeo/tmux to isolate root causes deterministically) uncovered and closed a progressive screen-corruption bug: resizing down to a narrow terminal (e.g. a ~20-column tmux pane) produced a growing stack of duplicate status-bar lines on every subsequent keystroke, and a separate, independently-reproducible scroll bug in the mid-turn live renderer.
- **[0.8.32]** (2026-07-20) — gjc parity: TUI display-width/wrapping is now grapheme-cluster-aware for emoji sequences (VS16 presentation, skin-tone modifiers, keycaps, ZWJ-joined emoji like family/profession glyphs), fixing box-border and wrap misalignment ("깨짐") that the old per-code-point width summation produced whenever such a sequence appeared in a message — Korean/CJK-only text was already correctly handled and is unaffected.
- **[0.8.31]** (2026-07-20) — `web_search` no longer silently degrades every non-Anthropic model to keyless DuckDuckGo scraping — OpenAI and Gemini sessions now get their own native, hosted search tool (matching the same active-model-gated, credential-required design Anthropic already had), with DuckDuckGo remaining the always-on terminal fallback for everyone else.
- **[0.8.30]** (2026-07-20) — `bun run build` (the host-only dev binary build) has been silently broken for every user who ran it — a drift between the plain `package.json` `build` script and the actual working release-binary build command (`scripts/ci-release-build-binaries.ts`), which had already documented and fixed the exact same crash.
- **[0.8.29]** (2026-07-20) — gajae-code (gjc) v0.10.2→v0.11.4 gap analysis: most of that range is gjc-specific architecture jeo intentionally does not replicate (SDK broker/session-index recovery, Gajae Pet, coordinator-mcp, Telegram/Discord rich-delivery internals, browser tab workers, worktree-subcommand removal, RPC durable model selection) — one genuinely applicable TUI bug was found and closed; the CLI empty-non-TTY-stdin fix (gjc #2586) was investigated and found already-correct by construction (jeo's one-shot gate forces true whenever stdin isn't a TTY, regardless of args, so the hang gjc fixed cannot occur here).

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
