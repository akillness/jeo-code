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
  <img src="assets/character.gif" alt="움직이는 jeo-code 붉은 가재 마스코트" width="320" />
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

- **멀티 프로바이더, 단일 루프** — Anthropic / OpenAI(+Codex) / Gemini / Antigravity / Ollama / LM Studio, 그리고 OpenAI·Anthropic 호환 클라우드 20종 이상(Groq, DeepSeek, Mistral, OpenRouter, xAI, Kimi, z.ai 등)까지 균일한 JSON 도구 루프로. 입력창에서 바로 OAuth 로그인(`/provider login`), 모델 선택은 즉시 기본값으로 영속.
- **편집 무결성** — read 출력에 콘텐츠 앵커(`42ab|`)가 붙고, 앵커 편집은 현재 파일과 대조 검증·줄 이동 시 자동 재매핑·불일치 시 최신 내용과 함께 거부 — 파일을 오염시키지 않습니다.
- **자기수정 검증 루프** — post-edit 훅(tsc / eslint / 테스트)을 설정하면 에이전트가 진단을 *직접 읽고* 루프 안에서 수정합니다. 훅이 빨간 상태면 `done`이 차단됩니다.
- **연극 없는 진짜 게이트** — `ralplan` 합의는 실제 저장소를 읽는 critic 서브에이전트이며 `[OKAY]` 평결이 영속되고 `jeo approve`가 이를 *요구*합니다. `ultragoal`은 정직하게 보고합니다(스위트 1회 실행은 전역 신호일 뿐, 기준별 통과를 조작하지 않음).
- **크래시 내구·로컬 우선** — 모든 상태는 `.jeo/` 아래 원자적 쓰기, 크로스 프로세스 런 락, 실패 태스크 마커 + 재개 시 부분 편집 경고.
- **동적 스텝 버짓** — 최근 도구 호출이 새로운 진전을 보이는 동안 연장되고, 정체되면 정리 요약으로 수렴. 서브에이전트는 정확한 스텝 계약 유지.
- **인라인 TUI** — 완료된 작업은 실제 스크롤백으로 흘러가고(턴 중에도 tmux 휠 스크롤 가능), 에이전트가 실행 중이어도 기존 쿼리 입력창이 그대로 보이며 편집됩니다. Ctrl+O 상세 토글, 테마, 클립보드 이미지 붙여넣기(Ctrl+V), CJK/이모지 안전 폭 계산.
- **브라우저 도구** — Playwright 기반 헤드리스 Chromium 자동화가 1급 에이전트 도구로 포함: 이름 붙은 탭을 재사용하며 `open`/`close`/`run`/`act`, 스크린샷보다 `observe`로 태깅된 요소 id를 우선 사용. `npx playwright install chromium`을 한 번 실행해야 함(번들 아님 — jeo 자체는 여전히 네이티브 의존성 0, 브라우저 바이너리는 Playwright의 별도 다운로드).
- **원격 서브에이전트 가시성(Telegram)** — 봇을 한 번 페어링(`jeo notify setup`)하면, `jeo daemon start`가 서브에이전트 상태 전환(시작 → 완료/실패/취소)마다 메시지를 보내고 `/subagents`, `/steer <id> <subagentId> <msg>`, `/cancel <id> <subagentId>`를 되받습니다 — 명령은 페어링된 채팅에서만 허용됩니다.

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
| `/thinking [level]` | 기본 추론 예산(minimal…xhigh) 조회/설정 |
| `/fast [on|off|status]` | 현재 모델이 minimal/low 추론을 지원하면 fast thinking 모드를 켜고 끔 |
| `/skill` · `$<skill> [intent]` | 워크플로 스킬 목록/실행(`$team "작업"` 스타일) |
| `/view` · `/diff` · `/find` · `/search` | 코드 보기, git diff, 파일/패턴 검색 |
| `/new` · `/resume` · `/sessions` | 세션 관리 |
| `/history [n|all]` · `/export` | 작업 활동 히스토리를 읽기 좋게 스크롤백에 재출력 · 트랜스크립트 내보내기 |
| `/retry` · `/btw <질문>` | 마지막 요청 재시도 · 히스토리에 안 남는 사이드 질문 |
| `/usage` · `/context` · `/compact` | 토큰 사용량, 컨텍스트 내역, 수동 컴팩션 |
| `/theme` · `/config` · `/help` | 테마, 런타임 설정, 도움말 |
| `jeo autopilot status` | 점수 방향, keep/revert 횟수, 다음 액션을 보여주는 ratchet 상태 필드 |

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

옵트인이며 지연 바인딩됩니다: `notifications.enabled`가 설정되고 detached 서브에이전트(`task {detached:true}`)가 실제로 실행되어야만 동작합니다. 데몬은 살아있는 세션 디스커버리 파일을 스캔해 세션별로 루프백 WebSocket을 연결하고, 서브에이전트 상태 *전환* 시점(시작 → 완료/실패/취소)에만 메시지를 보냅니다 — "여전히 실행 중" 같은 반복 알림은 없습니다. 수신되는 Telegram 명령은 페어링된 채팅에서만 허용되며, 그 외는 조용히 무시됩니다.

| 명령 | 동작 |
| --- | --- |
| `/subagents` | 연결된 모든 세션의 실행 중/최근 서브에이전트 목록 |
| `/steer <sessionId> <subagentId> <message>` | 실행 중인 서브에이전트에 실시간 메시지 전송 |
| `/cancel <sessionId> <subagentId>` | 실행 중인 서브에이전트 취소 |
| `/help` | 명령 안내 표시 |

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
JEO_STREAM_MAX_MS=300000        # 옵트인 전체 스트림 데드라인(기본 off; 슬로우드립 차단)
JEO_STREAM_IDLE_MS=300000       # 청크당 유휴 타임아웃(기본 300초); 첫 토큰 전 침묵이 긴 느린/로컬 백엔드는 값을 높이세요
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
- **[0.7.47]** (2026-07-06) — PromptRouter (gjc-inspired, jeo-native design — NOT a port of katanemo/plano, whose always-on proxy-orchestrator architecture doesn't fit an interactive CLI's per-turn latency budget): jeo already had static, role-based model mapping (`resolveSubagentModel`/`resolveRoleModel`) but zero logic that varied the model by what THIS turn's prompt actually asks for. Adds an opt-in (default OFF), heuristic-first, fail-open per-turn router: a bilingual regex classifier scores a prompt into trivial/standard/complex, escalating to one cheap LLM call ONLY when the heuristic is genuinely ambiguous (confidence below a configurable threshold — most turns never escalate), and an explicit `/model` pin always wins over routing. No new plumbing: reuses `resolveRoleModel`, `callLlm`, `jsonMode`, `catalogMetadata`, `tryExtractJsonObject`, and the existing `onNotice` transparency pattern.
- **[0.7.46]** (2026-07-06) — Registry-only correction: `npm publish` packs the working-tree filesystem, not the git commit — a concurrent, unrelated, uncommitted feature-in-progress from another session sharing this checkout (`src/agent/prompt-router.ts`, `src/commands/launch/route-slash.ts`, and edits to `config-schema.ts`/`state.ts`/`launch.ts`/`slash.ts`) was physically present on disk during the 0.7.45 `npm publish` and got bundled into that tarball even though it was never committed to git and is absent from the `0.7.45` git tag/branch. Unpublished `jeo-code@0.7.45` from the registry within minutes (npm then permanently blocks republishing that exact version number, hence the bump to 0.7.46) and republished from a verified-clean working tree (`git stash` of the foreign files, `npm pack --dry-run` confirmed their absence, then restored the stash afterward so the other session's in-progress work was never touched or lost). No functional change versus the intended 0.7.45 content — see that entry below.
- **[0.7.45]** (2026-07-06) — gjc parity: jeo's subagent `task {tasks:[...]}` fan-out batches now visibly run as PARALLEL processes the way gjc's own task tool does, instead of quietly forcing the mutating executor role to serialize. Two compounding bugs made a batch of independent subagent tasks look and behave sequential even though the read-only roles were already technically concurrent: (1) the executor role's fan-out was hard-coded to concurrency 1 regardless of batch size, and (2) the TUI's live status line tracked ONE shared string clobbered by whichever worker's event landed last — worse, ANY single worker reaching "done" cleared the whole `(sub)` marker even while its siblings were still actively running.
- **[0.7.44]** (2026-07-06) — Root-caused a real production hang reported from `jeo`'s OpenAI Codex OAuth subagent path: after roughly 20-30 minutes of active streamed traffic, `chatgpt.com`'s backend severs the live SSE connection mid-response (an infra connection-duration cap, not a broken network) and Bun's fetch/undici surfaces it as `Error: The socket connection was closed unexpectedly …`. `retryableStream` (model-manager.ts) only auto-retries losing the FIRST streamed chunk — once any chunk had reached the caller it deliberately stopped retrying (a full re-call would replay already-emitted content) — so this class of drop propagated straight out of the engine as a raw, unretried turn-ending error every time, even though nothing had been committed to history yet and a plain resend is exactly as safe as a fresh call.
- **[0.7.43]** (2026-07-06) — TUI inline image DISPLAY (gjc TUI-image parity): jeo could already ATTACH an image to a turn (clipboard paste, drag-drop, `@path`) but never rendered it back — the transcript only ever showed a `⧉ N image(s) attached` count. On a terminal that speaks the kitty graphics protocol (kitty/ghostty/wezterm) or iTerm2's OSC 1337 inline-image protocol, a submitted image now renders as an actual picture directly under the `user` card; every other terminal (Terminal.app, plain xterm, CI/non-TTY) keeps today's text-only behavior unchanged. No native/binary dependency added — Sixel was deliberately left out because producing a sixel stream from arbitrary PNG/JPEG bytes needs a pixel quantizer jeo doesn't have; both implemented protocols decode compressed image bytes themselves.

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
