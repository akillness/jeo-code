<p align="center">
  <img src="assets/hero.png" alt="빛나는 판타지 풍경 속 jeo-code 붉은 가재 마법사와 봉제 인형 친구들" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  Bun 기반 AI 코딩 에이전트 CLI — 인터뷰, 검토된 플랜, 게이트된 실행, 증거 기반 점검.
</p>

<p align="center">
  <a href="#주요-기능-overview">주요 기능</a> ·
  <a href="#핵심-워크플로우">핵심 워크플로우</a> ·
  <a href="#슬래시-명령">슬래시 명령</a> ·
  <a href="#cli-명령">CLI 명령</a> ·
  <a href="#빠른-시작">빠른 시작</a>
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="zero native deps" src="https://img.shields.io/badge/native%20deps-0-blue?style=flat-square">
  <a href="https://buymeacoffee.com/akillness3q"><img alt="Buy Me a Coffee로 후원하기" src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-AC6415?style=flat-square&logo=buy-me-a-coffee"></a>
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

- [양방향 메신저 게이트웨이 (Discord, Telegram, Slack)](docs/integrations/messenger.md)

**메신저 게이트웨이** — `jeo messenger`는 알림 데몬과 별도로 허용된 Discord·Telegram·Slack 대화를 지원합니다. Discord는 명시적인 로컬 Docker 샌드박스가 필수이며, 설정된 도구는 호스트 데스크톱/셸이 아닌 Linux 게스트에서 실행됩니다. [메신저 가이드](docs/integrations/messenger.md)와 아래의 현재 제약을 참고하세요.

📖 **[사용 가이드](docs/usage-guide.md)** — 설치, TUI 조작(↑ 이전 쿼리, Ctrl+O, `!` 셸), 슬래시 명령, `/resume`, 스펙 우선 워크플로를 데모 영상과 함께 설명합니다.

<video src="https://raw.githubusercontent.com/akillness/jeo-code/main/docs/jeo-code-promo.mp4" controls muted playsinline width="100%"></video>

> 인라인 재생이 안 되면 ▶ [데모 영상 재생/다운로드](docs/jeo-code-promo.mp4).

## 주요 기능 (Overview)

jeo-code는 단순한 코드 완성을 넘어 실제 엔지니어링 사이클(인터뷰 → 계획 → 승인 → 서브에이전트 병렬/직렬 실행 → 자체 검증)을 안전하게 오케스트레이션하는 **로컬 우선 AI 코딩 에이전트 CLI**입니다.

### 1. 지능형 멀티 프로바이더 & 프롬프트 라우팅
- **통합 모델 게이트웨이**: Anthropic, OpenAI(+Codex), Gemini, Antigravity, Ollama, LM Studio 및 20여 종의 OpenAI/Anthropic 호환 클라우드 지원
- **커스텀 프록시 지원**: 자체 호스팅 vLLM, SGLang, LiteLLM 프록시, 기업 사내 게이트웨이를 정식 프로바이더(`jeo provider add`)로 즉시 등록
- **비용/크레덴셜 인식 라우팅**: 매 턴마다 작업 복잡도를 분석하여 등록된 활성 자격증명 내에서 최적의 모델/티어로 자동 라우팅 (`/route`)
- **지능형 폴백**: 레이트 리밋(429), 안전 분류기 오탐 거부 시 동일 티어의 대체 프로바이더 모델로 무중단 자동 전환

### 2. 코드 편집 무결성 및 자기수정 루프
- **콘텐츠 앵커 편집 (Anchor Edit)**: `read` 결과에 고유 콘텐츠 앵커(`42ab|`)가 부여되며, 파일 변경 및 줄 이동 시 자동 대조 및 거부 처리하여 코드 오염 방지
- **검증 훅 (Verification Hooks)**: 파일 수정 직후 post-edit 훅(타입체크 `tsc`, 린트 `eslint`, 단위 테스트)을 실행하여 에이전트가 에러를 직접 진단하고 루프 내에서 자체 수정
- **엄격한 Done 게이트**: 수정 사항이 남아있거나 검증 테스트가 누락/실패된 상태에서는 `done` 완료 호출을 차단

### 3. 멀티 에이전트 오케스트레이션 & 비동기 작업 관리
- **서브에이전트 역할 분담**: `planner`, `architect`, `executor`, `critic` 등 세분화된 역할군 모델 및 추론 예산 독립 구성 (`/agents`)
- **비동기 팬아웃 (`task` / `eval`)**: 턴을 블로킹하지 않고 독립 작업을 병렬로 분산 실행하며, 백그라운드 job/monitor를 통해 실시간 상태 추적
- **저비용 채점 라우팅**: 검증기(`/goal`), 비평기(`critic`), 배치 팬아웃 작업은 저비용 모델로 자동 라우팅하여 토큰 비용 최적화

### 4. 확장된 에이전트 기능 및 원격 제어
- **헤드리스 브라우저 도구**: Playwright Chromium 기반의 브라우저 상호작용(`open`, `act`, `observe`) 및 비전 모델을 활용한 자동 시각 QA 루프 완결
- **원격 알림 & 제어 데몬 (Telegram, Discord, Slack)**: 공유 데몬(`jeo daemon start`)을 통해 서브에이전트 상태 변화를 모바일/메신저로 실시간 수신하고, 양방향 명령(`/steer`, `/cancel`, `/sessions`) 전달
- **데스크톱 자동화 (Computer Use)**: 엄격한 킬스위치와 감독 하에 스크린샷 캡처, 클릭, 타이핑 등 GUI 조작 지원 (`/computer`)

---

## 핵심 하이라이트

- **멀티 프로바이더, 단일 루프** — Anthropic / OpenAI(+Codex) / Gemini / Antigravity / Ollama / LM Studio, 그리고 OpenAI·Anthropic 호환 클라우드 20종 이상(Groq, DeepSeek, Mistral, OpenRouter, xAI, Kimi, z.ai 등)까지 균일한 JSON 도구 루프 하나로 — **여기에 직접 등록한 엔드포인트까지**: `jeo provider add --id my-proxy --base-url https://…` (또는 `--preset litellm|vllm|sglang|azure-openai|…`)로 LiteLLM 프록시·자체 호스팅 vLLM·사내 Anthropic 게이트웨이가 내장 `openai` 프로바이더를 가로채지 않고 자기만의 라우팅 접두사·모델 목록·자격증명을 갖습니다. OAuth 로그인은 입력창에서 바로(`/provider login`), 모델 선택은 모두 새 기본값으로 영속되며, 프롬프트 라우팅은 실제 사용 가능한 자격증명 경로만 자동 선택합니다: Gemini OAuth는 provider-qualified `antigravity/*` 에이전트 세트를 **계정이 현재 실제로 제공하는 그대로** 사용하고(실시간 디스커버리 — 예: Gemini 3.6 Flash 등급, Gemini 3.1 Pro, Claude Sonnet/Opus 4.6; 비채팅·폐기된 id는 걸러내며, 목록이 비어 있어도 정적 카탈로그로 대체하지 않음), `GEMINI_API_KEY`가 필요한 public `google/gemini-*` 행은 절대 고르지 않습니다. 설정된 라우트가 준비되지 않은 프로바이더를 가리키면 jeo는 기본값으로 폴백하기 전에 동급 티어의 자격증명 있는 모델로 전환합니다.
- **편집 무결성** — read 출력에 콘텐츠 앵커(`42ab|`)가 붙고, 앵커 편집은 현재 파일과 대조 검증·줄 이동 시 자동 재매핑·불일치 시 최신 내용과 함께 거부 — 파일을 오염시키지 않습니다.
- **자기수정 검증 루프** — post-edit 훅(tsc / eslint / 테스트)을 설정하면 에이전트가 진단을 *직접 읽고* 루프 안에서 수정합니다. 훅이 빨간 상태면 `done`이 차단됩니다.
- **연극 없는 게이트** — `ralplan` 합의는 실제 저장소를 읽는 critic 서브에이전트이며 `[OKAY]` 평결이 영속되고 `jeo approve`가 이를 *요구*합니다. `ultragoal`은 스위트를 전역 신호로 1회 실행하며 기준별 통과 여부는 조작하지 않습니다. 이는 테스트 러너의 진위나 워크스페이스 정확성을 증명하지 않습니다.
- **크래시 내구·로컬 우선** — 모든 상태는 `.jeo/` 아래 원자적 쓰기, 크로스 프로세스 런 락, 실패 태스크 마커 + 재개 시 부분 편집 경고.
- **동적 스텝 버짓** — 최근 도구 호출이 새로운 진전을 보이는 동안 연장되고, 정체되면 정리 요약으로 수렴. 서브에이전트는 정확한 스텝 계약 유지.
- **인라인 TUI** — 완료된 작업은 실제 스크롤백으로 흘러가고(턴 중에도 tmux 휠 스크롤 가능), 에이전트가 실행 중이어도 기존 쿼리 입력창이 그대로 보이며 편집됩니다. Ctrl+O 상세 토글, 테마, 클립보드 이미지 붙여넣기(Ctrl+V), CJK/이모지 안전 폭 계산.
- **브라우저 도구** — Playwright 기반 헤드리스 Chromium 자동화가 1급 에이전트 도구로 포함: 이름 붙은 탭을 재사용하며 `open`/`close`/`run`/`act`, 스크린샷보다 `observe`로 태깅된 요소 id를 우선 사용. `act {verb:"verify", goal, ...}`는 비주얼 QA 루프를 완결시킵니다: 페이지를 스크린샷으로 찍고 독립적인 비전 지원 모델에게 평이한 언어의 목표와 대조해 판단하도록 요청해(`{verdict:"PASS"|"MISMATCH", detail}`), 사람(또는 같은 에이전트)이 저장된 PNG를 직접 눈으로 확인할 필요를 없앱니다. `npx playwright install chromium`을 한 번 실행해야 함(번들 아님 — jeo 자체는 여전히 네이티브 의존성 0, 브라우저 바이너리는 Playwright의 별도 다운로드).
- **누적되는 스킬** — 정체된 턴은 이제 그 막다른 지점을 바로 그 스킬의 프로젝트 레벨 파일(`.jeo/skills/<name>.md`, 첫 작성 시 번들 스킬로 시드, 결정론적 키워드 매칭, LLM 미사용)에 기록하므로, 다음 세션의 `$<skill>` 호출은 번들 문서가 영원히 정적으로 남는 대신 누적된 "Known Failure Modes"/"Anti-Patterns" 지식을 함께 가져갑니다. 수동 항목은 `jeo skills lesson <skill> <failure|anti-pattern> "<title>" "<detail>"`로; `jeo skills eval <skill>`은 기록된 각 교훈이 스킬의 현재 가이던스로 여전히 커버되는지 아니면 낡았는지를 실제 LLM 판단으로 확인합니다.
- **저비용 등급 채점 라우팅** — `/goal` 검증기, `critic` 서브에이전트 역할, 그리고 고정되지 않은 `task` 팬아웃 배치는 채점·실행 대상인 작업과 같은 풀프라이스 모델에 조용히 편승하는 대신 기본적으로 저비용 크레덴셜 모델을 사용합니다(`resolveVerifierModel`, 브라우저 `verify` 액션에 대해서는 비전 능력으로 필터링되어 텍스트 전용 저비용 모델이 첨부된 스크린샷을 조용히 누락시키지 않도록 합니다).
- **`jeo routine init`** — 스케줄/이슈/PR 트리거에서 jeo를 헤드리스로 실행하는(`jeo "<prompt>" -p`) GitHub Actions 워크플로를 생성합니다, GitHub 자체 러너 위에서 — 노트북이 필요 없고, jeo 내부에 새로운 공격 표면도 전혀 추가되지 않습니다(인프로세스 스케줄러도 웹훅 리스너도 없음). `--dry-run`으로 미리보기, `--no-pr`로 기본값인 실행당 PR 대신 직접 커밋.
- **원격 모니터링 & 제어(Telegram, Discord, Slack)** — 봇을 한 번 페어링(`jeo notify setup --provider telegram|discord|slack`)하면, 공유 `jeo daemon start` 하나가 모든 활성 세션에 걸쳐 서브에이전트 상태 전환(시작 → 완료/실패/취소)마다 메시지를 보내고, 사람 allowlist로부터 `/subagents`, `/steer`, `/cancel`(Discord/Slack에서는 `/sessions`, `/send` 추가)을 되받습니다. Telegram은 포럼 토픽·인라인 키보드·이미지 첨부를 더하고, Discord는 REST + Gateway WebSocket, Slack은 Web API + Socket Mode를 사용합니다. 플랫폼별 상세 가이드 및 설치 가능한 에이전트 스킬(`channel-notify`)을 제공합니다.
- **범위가 있는 워크플로 게이트, 증명은 아님** — `approve`는 승인 대상 플랜의 정확한 다이제스트를 재검증하고 `team`은 검토 후 다이제스트가 바뀐 플랜을 거부합니다. `done`에서는 현재 턴의 변경·검증 신호가 완료를 차단하거나 낮출 수 있고, `/goal`은 대화/도구 이력에 대한 별도 LLM 판단과 결정론적 증거 게이트를 더합니다. 어느 쪽도 워크스페이스를 독립적으로 다시 읽지 않으며, 도구·테스트 출력은 증거이지 실행기나 결과가 신뢰 가능하다는 증명은 아닙니다. 이 검사는 턴이 끝난 뒤 백그라운드 작업이 파일을 바꾸지 않는다는 보장도 아닙니다. `autopilot` ratchet은 실패한 롤백을 `rollback_failed`로 기록하고 0이 아닌 코드로 중단합니다.
- **턴을 막지 않는 세션 범위 비동기 실행** — `task` 도구의 실제 `tasks` 배열로 독립 작업을 팬아웃해 부모 턴을 막지 않습니다. detached 서브에이전트, 백그라운드 job, 줄 단위 monitor는 이후 턴에서도 `subagent`/`job`/`monitor`의 `list`, `inspect`, `await`, `cancel`, `tail`로 계속 제어할 수 있습니다. 인라인 TUI는 각 워커의 실시간 activity를 별도 슬롯에 표시하고 세션 종료 또는 Ctrl-C에서 모든 레지스트리를 정리합니다.
- **실제로 강제되는 독립 검증자** — 플랜은 이제 architect/critic 단계를 건너뛸 수 없습니다: `PlanSchema`는 미검증 변이로 끝나는 모든 플랜을 거부하며(검증 대상 변이보다 앞에 배치된 검증자도 인정하지 않음), `ralplan` 드래프트 시점과 `team`/`approve` 실행 시점 양쪽 모두에 적용됩니다. 모든 architect/critic 평결도 실제 증거를 제시해야 하며, 관찰된 `read`/`search`/`find`/`ast_grep`/`lsp` 호출이 0건이면 텍스트가 무엇을 주장하든 평결이 차단됩니다.
- **안전 경계 자동 모델 폴백** — 미분류 안전 거부(실제 콘텐츠 정책 위반이 아니라 분류기의 오탐일 가능성)가 발생하면 이제 같은 모델에서 영원히 물러서는 대신 실제로 다른 프로바이더의 모델로 전환합니다 — 기존 rate-limit 빠른 폴백과 동일한 방식입니다. `Refusal (<category>)` 형태의 결정론적 거부는 영향받지 않고 여전히 폴백 없이 하드 실패합니다.
- **메모리: 획득한 신뢰** — 개념의 검증 날짜는 이제 모든 쓰기 시점이 아니라 증류 패스가 명시적으로 검증됨으로 표시할 때만 기록됩니다. `isConceptStale`은 수동적인 타임스탬프를 신뢰하는 대신 미검증(또는 30일 초과) 개념을 재검증이 필요한 것으로 처리합니다.
- **동적 워크플로(`eval` 도구)** — `task(role, taskText, context?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `log(message)`로 JS 흐름을 구성합니다. 세션 샌드박스가 없으면 Worker 스레드의 타임아웃은 보안 경계가 아닙니다. 샌드박스에서는 eval이 Linux 게스트에서 실행되며 task/parallel/pipeline 위임 헬퍼는 지원하지 않으므로 부모 `task` 도구로 위임하세요.
- **끊긴 출력 파이프에서 조용히 종료** — 읽기를 일찍 멈추는 명령으로 파이프할 때(`jeo --help | head`, 사라진 원격 피어) 더 이상 원시 `EPIPE` 스택을 덤프하지 않습니다 — 셸이 SIGPIPE로 종료된 파이프라인 생산자에게 보고하는 것과 동일한 코드(141)로 조용히 종료됩니다. 실제 크래시는 영향받지 않고 여전히 명확하게 드러납니다.
- **macOS 낮은 파일 디스크립터 한도 경고** — 낮은 `ulimit -n`(BSD 기본값 256/1024)은 파일 감시, 브라우저 도구, 넓은 리포지토리 스캔에서 불명확한 `EMFILE` 실패를 유발할 수 있습니다 — jeo는 이제 실행 시 한 번(stderr로만, 파이프되는 `-p` 출력은 오염시키지 않음) `ulimit`/`launchctl` 구체적인 안내와 함께 경고합니다. `JEO_SKIP_NOFILE_CHECK=1`로 옵트아웃할 수 있습니다.


## 설치

Bun `1.3.14+` 필요.

```bash
bun install -g jeo-code
jeo --version
```


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
| `/model` · `/provider` | 모델/프로바이더 선택; `/model`에서 기본/역할 배지, Ralph식 중첩 Set-as-role thinking 선택, OpenAI Codex 역할 프리셋을 한 흐름으로 설정 |
| `/provider login <name>` · `/logout` | 입력창에서 OAuth 로그인/로그아웃 |
| `/provider add` · `list` · `remove` · `presets` | OpenAI/Anthropic 호환 엔드포인트를 정식 프로바이더로 등록 (게이트웨이 프리셋 15종) |
| `/agents [role]` · `/subagent` | 역할별(executor/planner/architect/critic) 모델·thinking·스텝 구성 |
| `/thinking [level]` | 기본 추론 예산(low…xhigh) 조회/설정 |
| `/route [status\|on\|off\|why\|history [n]]` | 이 세션의 프롬프트 기반 모델 라우팅 켜기/끄기 · 마지막 라우팅 결정 설명 · `history [n]`은 이번 세션의 최근 n개(기본 10개) 라우팅 결정 표시(설정된 자격증명 — OAuth 또는 API 키 — 이 실제로 서비스하는 모델 안에서 매 턴 티어에 맞는 모델로 자동 라우팅하고, 설정된 라우트가 준비되지 않았으면 동급 티어 모델로 전환) |
| `/fast [on\|off\|status]` | 현재 모델이 low 추론을 지원하면 fast thinking 모드를 켜고 끔 |
| `/skill` · `$<skill> [intent]` | 워크플로 스킬 목록/실행(`$team "task"` 스타일) |
| `/view` · `/diff` · `/find` · `/search` | 코드 보기, git diff, 파일/패턴 검색 |
| `/computer [status\|on\|off]` | 이 세션의 fail-closed 데스크톱 자동화 도구 켜기/끄기 |
| `/new` · `/sessions` | 새 세션 시작 또는 저장된 세션 목록 표시 |
| `/resume [id\|gajae:<session-id>[#<leaf>]] [--any-cwd]` | Jeo 세션을 재개하거나 읽기 전용 정확 버전 GJC v5 브랜치를 새 Jeo 세션으로 가져오기 |
| `/changelog [--full]` · `/jobs [list\|tail\|await\|cancel]` | 릴리스 노트 표시 · 이 세션의 백그라운드 job 조회·대기·취소 |
| `/history [n\|all]` · `/export` | 작업 활동 히스토리를 읽기 좋게 스크롤백에 재출력 · 트랜스크립트 내보내기 |
| `/retry` · `/btw <q>` | 마지막 요청 재시도 · 히스토리에 안 남는 사이드 질문 |
| `/usage` · `/context` · `/compact` | 토큰 사용량, 컨텍스트 내역, 수동 컴팩션 |
| `/theme` · `/config` · `/help` | 테마, 런타임 설정, 도움말 |

> [!CAUTION]
> **`/model <name>`으로 특정 모델을 수동 지정하면 그 세션 동안 라우팅이 고정됩니다.** 프롬프트 라우팅(`/route`)은 모델이 수동으로 고정되지 않은 동안만 매 턴 재평가됩니다. `/model <name>`으로 특정 모델을 선택하면 그 선택이 그대로 고정되며, `/model auto`(핀을 완전히 해제)를 실행하거나 `/route on`(핀을 지우지 않고 그보다 우선순위를 높임 — `/route off` 하는 즉시 핀이 다시 살아남)을 실행하기 전까지는 라우팅이 다시 전환되지 않습니다. `roles.*` 항목 미설정 시 `defaultModel`로 확정 폴백되는 건 `standard` 티어뿐이며, `high`/`complex` 티어는 보통 폴백 전에 실시간으로 크레덴셜된 가장 강력한 모델을 먼저 탐색하므로, 설정이 없어도 매 턴 다른 모델로 갈 수 있습니다. **예외:** Antigravity 또는 Gemini OAuth로 크레덴셜된 세션은 하나의 크레덴셜로 Anthropic/Google/OpenAI 모델을 함께 재노출하는데, 이 경우 `high`/`complex`는 (항상 최강 모델이 아니라) 회사당 모델 1개로 세션-안정적으로 분산되어, 턴마다 바뀌지 않고 해당 세션 내내 고정됩니다.
### Antigravity 계정 모델과 공식 agy 브리지

**Cloud Code Assist (`antigravity/<CCA-id>`)** — `/model provider antigravity`와 `/agents <역할> provider antigravity`는 선택한 jeo OAuth 계정에 대해 Cloud Code Assist가 반환한 모델을 보여줍니다. 디스커버리는 `agentModelSorts`, `tieredModelIds`, `defaultAgentModelId`를 합치며, 계정별 캐시는 리프레시 후에도 서로 격리됩니다. 빈 목록이나 디스커버리 실패는 정적 카탈로그로 대체하지 않고 그대로 보고합니다. CLI 모델 슬러그는 CCA 통신용 ID가 아니며, CLI에서 이용 가능하다고 해서 CCA를 통한 Argon 직접 호출이 지원된다는 뜻은 아닙니다.

**CCA 예시:** `jeo auth login antigravity`로 해당 계정의 모델을 발견하고 캐시합니다. `/model antigravity/<CCA-id>` 또는 `/agents executor provider antigravity`로 선택하거나 `/model save antigravity/<CCA-id>`로 기본값을 저장합니다.

**공식 CLI (`agy/<official-cli-slug>`)** — `PATH`에 설치된 `agy` 실행 파일을 사용하는 별도의 전체 에이전트 백엔드를 명시적으로 선택합니다. 인증은 공식 CLI가 지원하는 자체 절차로 진행하며, jeo는 그 자격 증명을 관리하거나 가져오지 않습니다. `agy models`가 실제 목록과 정확한 슬러그를 제공하며, 정적 카탈로그나 CCA 별칭을 사용하지 않습니다. CLI 세션·계정과 jeo OAuth 계정이 같다고 가정하지 않으며, CLI 모델 목록은 jeo의 계정별 디스크 캐시 대신 현재 프로세스에만 보관합니다. 빈 목록은 빈 상태로, 디스커버리 실패는 오류로 보고하며 모델을 만들어 넣지 않습니다.

```sh
agy models
jeo launch --model agy/gemini-4-argon-low --plan --no-tui --no-session --no-skills "Explain this repository"
```

자신의 CLI가 실제로 반환한 슬러그를 사용하세요. 대화형 jeo 세션에서 목록을 보고 선택한 뒤, 필요하면 영구 기본값으로 저장합니다:

```text
/model provider agy
/model agy/gemini-4-argon-low
/model save agy/gemini-4-argon-low
```

> [!WARNING]
> **공식 agy 에이전트가 자체 도구·샌드박스·권한·대화를 관리합니다. jeo의 승인은 그 내부 도구 호출을 중재하지 않습니다.** `--plan`은 CLI의 계획 모드를 선택할 뿐, 도구 승인 권한을 jeo로 넘기지 않습니다. 이 브리지는 명시적 선택이 필요한 텍스트 전용 기능이며, 자동 원시 모델·서브에이전트 라우팅에서 제외됩니다. 이미지 첨부와 강제할 수 없는 jeo 전용 도구·시스템·단계 수·thinking 제어는 거부합니다.

jeo 세션 저장이 켜져 있으면 재개 시 해당 세션에 저장된 CLI 대화 ID를 사용하며, 무관한 CLI 최신 대화를 이어받지 않습니다. 취소와 제한된 타임아웃은 CLI 턴을 중단합니다. 선택한 정확한 모델과 쿼터 오류를 포함한 상위 CLI 오류를 보존하며, CCA·다른 모델·다른 계정으로 조용히 폴백하지 않습니다.

## CLI 명령

`jeo --help`가 공식 목록이며, 자주 쓰게 될 것들은 다음과 같습니다:

| 명령 | 용도 |
| --- | --- |
| `jeo [prompt] [--resume [id]] [--tmux] [--worktree <path>] [-p] [-q]` | 대화형 에이전트(기본); `-p`/`--print`는 헤드리스 1회성 출력, `--worktree`는 격리된 형제 체크아웃 |
| `jeo setup` · `jeo auth login\|logout\|refresh\|status [provider]` · `jeo doctor` | 프로바이더, 자동 갱신되는 OAuth(PKCE) 토큰, 실시간 연결 + stale 핀 점검 |
| `jeo provider list\|add\|remove\|presets\|test` | 이름 붙인 커스텀 OpenAI/Anthropic 호환 프로바이더(`/provider`와 같은 플래너) |
| `jeo deep-interview` → `ralplan` → `approve` → `team` → `ultragoal` | Spec-first 워크플로(아래 참조); `jeo state <skill> read\|write\|clear\|handoff`로 기록(receipt)을 확인 |
| `jeo notify setup\|status\|health\|test` · `jeo daemon start\|stop\|status\|reload` | Telegram / Discord / Slack 알림과 공유 제어 데몬 |
| `jeo autopilot <subcommand>` · `jeo ledger <subcommand>` | 점수 ratchet이 있는 자율 빌드 루프(`status`는 방향, keep/revert 횟수, 다음 액션 표시) · 플랜 간 append-only 원장 |
| `jeo routine init …` | 스케줄 또는 저장소 이벤트에서 jeo를 헤드리스로 실행하는 GitHub Actions 워크플로 생성 |
| `jeo skills list\|read\|sync\|lesson\|eval` | 번들·사용자·프로젝트 스킬; 드리프트 점검; 기록된 레슨 |
| `jeo mcp serve\|tools` · `jeo computer <action>` | 외부 컨트롤러용 MCP stdio 서버 · 데스크톱 자동화 액션 |
| `jeo session list\|attach\|rm` · `jeo export [id]` · `jeo chat "<msg>"` | tmux 세션 관리 · 트랜스크립트 내보내기 · 도구 없는 스트리밍 채팅 |
| `jeo update [--check]` · `jeo whats-new` · `jeo memory-migrate` | npm 자가 업데이트 · 번들 릴리스 노트 · 레거시 `MEMORY.md` → OKF 번들 |

## 핵심 워크플로우 (Core Workflows)

jeo-code는 작업의 규모와 신뢰 수준에 따라 3가지 주요 워크플로우를 제공합니다.

### 워크플로우 1: 대화형 원샷 및 빠른 개발 루프 (Interactive / One-shot)
일상적인 버그 수정, 함수 작성, 리팩토링에 사용하는 가장 빠른 워크플로우입니다.
```bash
jeo                             # 대화형 TUI 세션 시작
jeo "로그인 API에 rate limiting 적용해줘"   # 원샷 자동 실행
```
- **흐름**: 사용자 요청 → 컨텍스트 검색(`search`, `find`, `read`) → 앵커 편집(`edit`, `write`) → 검증 훅(`post-turn`) 자동 실행 → 자체 수정 → `done`

### 워크플로우 2: Spec-First 단계별 엔지니어링 파이프라인 (권장)
대규모 기능 개발, 아키텍처 개편 시 모호성을 사전에 제거하고 검증된 계획대로 실행하는 엔터프라이즈급 워크플로우입니다.

요구사항 → 계획 수립 → 계획 검토/승인 → 직렬/병렬 실행 → 종합 검증이 `.jeo/state/` 상태 파일로 안전하게 연결됩니다.

```bash
jeo deep-interview "새로운 결제 웹훅 시스템 구축"  # 1. 요구사항 소크라테스 인터뷰
jeo ralplan                                        # 2. 비평가(Critic) 검증 기반 계획 수립
jeo approve .jeo/state/plan-*.json                 # 3. 계획 다이제스트 해시 무결성 검증 및 승인
jeo team                                           # 4. 역할별 서브에이전트 파이프라인 실행
jeo ultragoal                                      # 5. 최종 증거 기반 종합 검증 및 보고
```
![Interview → reviewed plan → approval → execution → verification](assets/workflow.svg)

```
  ┌──────────────────────┐
  │   deep-interview     │  모호성 제거 인터뷰 (Socratic Ambiguity Gate) · 구체화 시 시드 고정
  └──────────┬───────────┘
             │ .jeo/state/<seed>.json
             ▼
  ┌──────────────────────┐
  │       ralplan        │  초안 작성 + 실제 저장소 기반 Critic 검증 → [OKAY] 평결 영속화
  └──────────┬───────────┘
             │ [OKAY] 평결 및 다이제스트 일치 필수
             ▼
  ┌──────────────────────┐
  │       approve        │  스키마 검증 + 역할 배정 + [OKAY] 승인 확인 → 실행 락 해제
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │        team          │  직렬/병렬 서브에이전트 실행기 · 프로세스 락 · 부모 변이 감사
  └──────────┬───────────┘
             │ 모든 하위 태스크 완료 시
             ▼
  ┌──────────────────────┐
  │      ultragoal       │  증거 기반 종합 검증 — 스위트 실행 및 통과 기준 정직한 보고
  └──────────────────────┘
```

#### Spec-First 각 단계별 역할 및 게이트
- **`deep-interview`**: 소크라테스식 대화로 모호성을 평가하고 명확한 기준이 도출될 때까지 요구사항을 구체화(seed 고정). 새 아이디어가 완료된 인터뷰를 조용히 재사용하지 않습니다.
- **`ralplan`**: 초안 작성 + 저장소 실코드를 직접 읽는 `critic` 서브에이전트 게이트 통과(`[OKAY]` 평결 강제 영속화). 무효 플랜(스키마, 미지 역할)은 complete로 마킹되지 않습니다.
- **`approve`**: 계획 스키마, 서브에이전트 역할, 다이제스트 해시 무결성 및 `[OKAY]` 평결 검증 후 실행 승인.
- **`team`**: 직렬/병렬 플랜 실행기 (크로스 프로세스 런 락, Stale 상태 리셋, 파일 쓰기 변이 감사, 실패 시 롤백/부분 편집 경고. 같은 `parallel_group`의 연속된 단계는 별도 Git 워크트리에서 병렬 실행하고 순서대로 병합).
- **`ultragoal`**: 완료 후 전체 검증 스위트를 1회 실행하여 기준 통과 여부를 증거 기반으로 정직하게 보고.

### 워크플로우 3: 자율 빌드 및 점진적 루프 (Autopilot & Routine)
사람의 지속적인 개입 없이 벤치마크나 점수 기반으로 점진적 개선을 시도하거나 CI/CD에서 무인 실행할 때 사용합니다.
- **`jeo autopilot`**: 점수 래칫(Score Ratchet) 기반으로 테스트 점수가 향상될 때만 커밋을 유지(`keep`)하고, 퇴보하면 안전하게 롤백(`revert`)하는 자율 탐색 루프
- **`jeo routine init`**: GitHub Actions 워크플로를 생성하여 cron 일정이나 GitHub Issue/PR 생성 시 jeo를 헤드리스(`-p`)로 자동 실행하고 완료 시 PR 자동 생성

`/goal`은 대화와 기록된 도구 이력을 별도 LLM 호출로 판단하고, 현재 턴의 변경·최신 검증 증거를 결정론적으로 게이트합니다. 워크스페이스를 다시 읽거나 테스트 출력의 진위를 확인하지 않으며, launch 완료 게이트는 진행 중인 백그라운드 작업도 검사하지 않습니다.

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

### 프롬프트·턴 훅과 사용자 레지스트리

도구 루프 이벤트 외에 턴마다 한 번씩 발생하는 이벤트가 둘 더 있습니다:

| 이벤트 | 시점 | 페이로드(stdin JSON) | 훅 출력 |
| ------ | ---- | -------------------- | ------- |
| `pre-prompt` | 입력한 프롬프트를 모델이 보기 전 | `{event, hook_event_name: "UserPromptSubmit", session_id, cwd, prompt}` | stdout 텍스트 또는 JSON `hookSpecificOutput.additionalContext` / `additionalContext` / `context`가 `[pre-prompt hook context]` 블록으로 프롬프트 메시지 뒤에 붙습니다(프롬프트 카드와 히스토리 제목에는 사용자가 쓴 말만 남음) |
| `turn-end` | 최종 답변 직후 | `{event, hook_event_name: "Stop", session_id, cwd, prompt, response, last_assistant_message, done, steps, model}` | 무시 |

둘 다 권고(advisory)용입니다: 비정상 종료·타임아웃·중단은 알림만 출력하고 프롬프트를 막지 않습니다(기본 타임아웃 10초 / 30초). `$skill` 실행과 메신저 literal 세션은 건너뛰며, `agy/` 모델은 공식 CLI가 프롬프트를 소유하므로 `pre-prompt`는 건너뛰고 `turn-end`는 실행됩니다. `pre-tool` 훅은 exit 0으로 `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"…"}}`를 출력해 거부(`ask`는 deny로 처리)하거나 `additionalContext`를 출력해 해당 도구 결과에 덧붙일 수 있으며, 일반 stdout은 계속 무시됩니다. 모든 페이로드에 `hook_event_name`, `session_id`, `cwd`(도구 이벤트는 `tool_name`/`tool_input` 추가)가 들어 있어 Claude Code / Codex 훅 스크립트를 수정 없이 쓸 수 있습니다 — 호스트 세션 한정이며 샌드박스 훅은 기존 페이로드를 받습니다.

**사용자 레지스트리.** `~/.jeo/hooks.json`(`.jeo/hooks.json`과 같은 형식, `JEO_CONFIG_DIR`을 따름)은 jeo-skills의 프롬프트 라우팅·지식 파이프라인처럼 훅을 대신 설치하는 도구를 위한 훅 전용 파일이며, 자격 증명이 다시 쓰이지 않도록 `config.json`과 분리되어 있습니다. 우선순위: `config.json`의 `"hooks": { "enabled": false }`는 모든 훅을 끄고, 프로젝트 `.jeo/hooks.json`의 `"enabled": false`는 그 프로젝트만 제외하며, 그 외에는 `hooks.enabled: true` 없이도 레지스트리가 설정된 훅보다 먼저 실행됩니다. 프로젝트 자체 `hooks` 목록은 `config.json` 목록만 대체하고 레지스트리는 대체하지 않으며, 프로젝트 / `config.json` 훅은 여전히 `hooks.enabled: true`일 때만 실행됩니다. 샌드박스 세션은 레지스트리를 건너뜁니다.

`jeo doctor` 는 지금 실행되는 훅을 `[hooks]` 줄(`--json` 에서는 `hooks`)로 보여 주고, 레지스트리/프로젝트 파일을 읽을 수 없거나 항목이 잘못되어 무시되었거나 전역 스위치·프로젝트 opt-out 이 모든 훅을 끈 경우 경고합니다.

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

## 원격 모니터링 & 제어 (Telegram, Discord & Slack)

옵트인: 공유 데몬 하나가 머신의 모든 활성 `jeo` 세션을 지켜보다가 **서브에이전트 상태 전환**(시작 → 완료/실패/취소)마다 메시지를 보내고, 세션 식별 헤더, 턴 시작/종료 요약, 확정된 턴 텍스트도 함께 전송합니다 — "여전히 실행 중" 반복 핑은 절대 보내지 않습니다. allowlist에 등록된 사람은 채팅에서 목록 조회·전송·조종·취소를 할 수 있고, 모든 제어는 로컬 세션으로 중계되어 **확인 응답됨(수락됨, 완료 아님)** 또는 **확인 응답 안 됨**으로 보고됩니다 — 데몬은 명령이 실행됐다고 절대 주장하지 않습니다.

### Discord 세션과 샌드박스 경계

Discord 스레드 하나는 발신자·메시지와 무관하게 하나의 영속 세션을 유지합니다. 같은 스레드는 FIFO로 처리하고 다른 세션은 동시에 실행할 수 있습니다. 선택한 워크스페이스를 공유하며 세션별 Git worktree를 만들지 않으므로 파일 수정은 충돌할 수 있습니다.

메신저 설정에 `sandbox`를 지정하세요. `~/.jeo/config.json`에도 같은 형식으로 설정하면 터미널 세션을 격리합니다:

```json
{
  "sandbox": {
    "image": "oven/bun:1.3.14",
    "limits": { "memoryBytes": 268435456, "pids": 64, "cpus": 1 }
  }
}
```

전체 메신저 프로필이 아닌 샌드박스 부분 예시입니다. 기존 `platforms` 허용 목록과 자격증명 환경변수 이름은 유지하세요. Linux Bun 이미지는 로컬 Docker 데몬에 이미 있어야 합니다. 백엔드는 불변 이미지 ID를 확인하고 `--pull=never`로 실행하며 이미지 pull·의존성 설치·원격 Docker·호스트 실행 폴백을 하지 않습니다. Mac/Windows에서도 호스트 셸이 아닌 **Linux 게스트 셸**입니다. 네트워크는 `none`, `/workspace`는 읽기/쓰기이며 추가 경로는 세션별 `ro`/`rw` 승인이 필요합니다. 전체 홈·비공개 제어 경로·제어 소켓은 허용할 수 없습니다. 호스트 운영자와 Docker 데몬은 신뢰 대상입니다.

접근 결정은 부모에 직접 제출한 사람의 `/sandbox status`, `/sandbox approve <requestId>`, `/sandbox deny <requestId>`, `/sandbox revoke`만 처리합니다. 모델의 `sandbox_request {host, mode:'ro'|'rw'}`는 요청 전용이며 자체 승인할 수 없습니다. 인증된 행위자 자신의 세션과 현재 요청 revision이 필요하며, 오래되거나 다른 세션의 요청은 거부합니다. 기존 터미널 Discord 제어도 샌드박스가 필수입니다. 로컬 `/discord control on --allow-full-control`로 켜고 `/discord control off`로 끄며, 원격 턴은 로컬 입력 초안을 보존합니다.

`independentSessions`는 런타임에서 거부하며 명시적인 `jeo messenger setup` 마이그레이션이 제거합니다. `sessionDir`는 워크스페이스 밖의 서로 겹치지 않는 비공개 경로여야 합니다. 워크스페이스 안의 구형 `.jeo/sessions`·`.jeo/messenger-sessions`·`.jeo/memory/raw` 기록 저장소는 이동 안내와 함께 시작을 차단합니다. 재시작 전 직접 옮겨야 하며 자동 복사·삭제하지 않습니다. 전체 대화 이력은 부모 전용 저장소에만 두고 증류된 프로젝트 학습은 공유합니다. 기존 ECC 스킬/워크플로 설치를 재사용하며 전역 재설치는 하지 않았습니다. 보호된 전역 스킬 내용은 실행 전 스냅샷으로 고정하고 워크스페이스/승인 문서는 게스트를 통해 읽습니다.

**검증 범위(2026-11-03):** 실제 macOS 실제 Docker 검증기(`bun run verify:sandbox`)가 **행동 계약 20개**를 통과했고 소스 단독 빌드도 통과했습니다. 복사한 단독 바이너리는 실제 PTY FIFO, 부모 `sandbox_request`와 실제 Linux 게스트 도구, 전체 이력 비공개, 부모가 생성한 stderr 종료 nonce와 일치하는 ACK, 실제 워커 종료(143), Docker 컨테이너 부재를 다루는 제한된 범위의 검증을 통과했습니다. 현재 소스 래퍼는 teardown 정리 소유자, 제한된 종료 대기, 사람의 세션별 승인, 영속 스레드/FIFO 하나, 공유 워크스페이스를 유지합니다. 이는 전체 테스트 스위트·크로스 플랫폼·프로덕션 검증이 아닙니다. 전체 `bun test`는 시간 초과로 **통과가 아니며**, 일반 집중 스위트에는 낡은 픽스처 실패가 남아 수정 중입니다. 네이티브 Linux·Windows 호스트 검증은 불가능한 상태이며 실제 Discord 전송은 하지 않았습니다. macOS의 Linux 게스트는 호스트 검증이 아닙니다. `bun run build:hands`는 워커 빌드, `bun run verify:sandbox`는 사전 조건을 설치하지 않는 실제 Docker 검사입니다. 워커/컨테이너 정리는 확인되어야 하며 오류·제거 미확인을 성공으로 보고하지 않습니다.

플랫폼별 상세 단독 가이드:
- 📖 [채널 연동 개요 & 아키텍처](docs/integrations/README.md) — 기능 매트릭스 및 구조 개요
- 📱 [Telegram 연동 상세 가이드](docs/integrations/telegram.md) — 내장 백그라운드 데몬, BotFather 대화형 페어링, 포럼 토픽, `/steer` 원격 명령
- 🎮 [Discord 연동 상세 가이드](docs/integrations/discord.md) — 즉각적인 채널 알림을 위한 웹훅, 양방향 상호작용을 위한 봇 및 임베드 카드 포맷
- 💬 [Slack 연동 상세 가이드](docs/integrations/slack.md) — 워크스페이스 알림용 Incoming Webhook, 팀 협업용 Slack App / Socket Mode, Block Kit 카드
- 🧩 [에이전트 스킬 설치 가이드](docs/integrations/agent-skills.md) — `jeo`, Claude Code, Cursor, Codex 등 다양한 에이전트에 채널 알림 스킬 설치하기

```bash
jeo notify setup  [--provider telegram|discord|slack] [--token-env NAME] [--app-token-env NAME] [--chat-id ID | --channel-id ID] [--allowed-user-ids ID,ID,...]
jeo notify status [--provider …]   # 마스킹된 토큰, 목적지, allowlist, 데몬 상태 (stopped / stale / initializing / initialized / pairing)
jeo notify health [--provider …]   # 읽기 전용: 봇 신원 + 목적지 접근 검증, 아무것도 보내지 않음
jeo notify test   [--provider …]   # 실제 테스트 메시지 1건 전송
jeo daemon start|stop|status|reload   # 공유 데몬에는 프로바이더 선택자가 없음
```

| | Telegram (기본) | Discord | Slack |
| --- | --- | --- | --- |
| 자격증명 | 봇 토큰(`JEO_TELEGRAM_BOT_TOKEN` 또는 `--token-env`) | 봇 토큰(`JEO_DISCORD_BOT_TOKEN` 또는 `--token-env`) + **Message Content** intent | 봇 `xoxb` 토큰(`JEO_SLACK_BOT_TOKEN` 또는 `--token-env`) + 앱 `xapp` 토큰(`SLACK_APP_TOKEN` 또는 `--app-token-env`), Socket Mode 활성화 |
| 목적지 | challenge 페어링으로 개인 채팅(표시된 `/start jeo_<code>`를 120초 내에 봇에 전송) 또는 명시적 `--chat-id`; 그룹은 `--allowed-user-ids` 필요 | 명시적 `--channel-id`(텍스트 채널, DM, 공지 채널, 또는 기존 스레드) | 봇이 참여한 명시적 `--channel-id`(`C…`); 워크스페이스는 토큰의 팀에 고정 |
| Allowlist | 개인 채팅은 선택, 그룹은 필수 | 필수(사람 사용자 ID; 봇은 무시) | 필수(사람 사용자 ID) |
| 전송 방식 | Bot API `getUpdates` 직접 long-poll, 봇 토큰당 poll owner 하나 | 송신은 REST, 수신은 Gateway WebSocket | 송신은 Web API, 수신은 Socket Mode WebSocket |
| 추가 기능 | 포럼 토픽, 인라인 취소 버튼, 이미지 첨부, 선택적 세션별 토픽(`notifications.telegram.perSessionTopics`, Threaded Mode가 켜진 개인 채팅만) | 세션 알림에 답글을 달면 그 세션에 텍스트 전송(24시간) | 세션 알림의 스레드에 답글을 달면 그 세션에 텍스트 전송(24시간); 등록된 Slack 슬래시 명령과 `@bot /command` 모두 동작 |
| 명령 | `/subagents` `/steer <session> <subagent> <msg>` `/cancel <session> <subagent>` `/help` | `/sessions` `/subagents` `/send <session> <text>` `/steer …` `/cancel …` `/help` | Discord와 동일 |

이 단어들은 서로 바꿔 쓸 수 없으므로, 각각의 의미를 정확히 짚어 둡니다:

- **Setup**은 공식 API로 봇 신원과 목적지 접근을 검증하고(Telegram `getMe`, Discord 봇 + 채널 조회, Slack `auth.test`/`bots.info`/`conversations.info`와 Socket Mode URL) 결과를 `~/.jeo/config.json`의 `notifications.<provider>` 아래에 저장합니다 — **평문**이므로 그 파일은 비공개로 유지하세요. 메시지를 보내지도, 소켓을 열지도 않습니다.
- **`initialized`**(`jeo daemon status`)는 데몬 프로세스가 락을 소유하고 전송 계층을 시작했다는 뜻이지, Telegram poll·Discord Gateway 핸드셰이크·Slack Socket Mode 연결이 성공했다는 증거가 아닙니다. 그 확인에는 `notify health` / `notify test`를 사용하세요.
- **토큰이나 목적지를 바꾸면** Discord와 Slack은 allowlist가 초기화되고(`--allowed-user-ids`를 다시 넘겨야 함), Telegram은 세션별 토픽 맵이 초기화됩니다. 정확히 같은 자격증명과 목적지로 setup을 다시 실행하면 그대로 유지됩니다.
- **원격 명령은 리터럴 텍스트**(`/subagents`, …)이며 설정된 채팅/채널과 allowlist에만 인가됩니다. Slack은 같은 이름의 등록된 슬래시 명령도 받습니다. Discord 터미널 제어는 기본 꺼짐이며 샌드박스 세션에서 로컬 `/discord control on --allow-full-control`로 켜고 `/discord control off`로 해제합니다. 위의 샌드박스·사람 승인 경계를 따르며 채팅에 자격증명을 넣지 마세요.
- **재시도는 프로바이더별로 상한이 있습니다**: Telegram은 429의 `retry_after` 쿨다운(1초–1시간으로 클램프)을 poll 백오프와 별도로 지키고, Discord와 Slack은 429에 대해 서버의 `Retry-After`를 따라 최대 3회만 재시도하며, 결과를 알 수 없는 POST는 절대 재전송하지 않습니다(플랫폼이 이미 받았을 수 있음).
- **고아 복구**: 데몬이 크래시하면 락이 `stale`이 되고, 다음 `jeo daemon start`가 회수합니다. `jeo daemon stop`은 호스트가 프로세스 시작 시각을 보고할 수 있으면 재활용된 PID에 시그널을 보내기를 거부하고, 보고할 수 없으면 그 사실을 알립니다.
- **지금까지 검증된 범위**: Telegram은 엔드투엔드(실제 전송, 폴링, 깔끔한 종료). Discord와 Slack은 같은 데몬 뒤에 오프라인 전송/배선 테스트와 코드·보안·타입 리뷰로 구현되어 있으며, 실제 봇/앱 자격증명으로 라이브 연결은 아직 실행하지 않았습니다.

```
┌─────────────────────┐        ┌──────────────────┐        ┌───────────────────────────┐
│   interactive turn  │◄──ws──►│  notify daemon   │◄──────►│ Telegram Bot API (poll)   │
│  SubagentRegistry   │  (one  │   (singleton)    │        │ Discord REST + Gateway WS │
│  session endpoint   │  per   │                  │        │ Slack Web API + Socket WS │
└─────────────────────┘ session└──────────────────┘        └───────────────────────────┘
```


### Discord & Slack (웹훅 & 봇 앱)

팀 워크스페이스를 위해 표준 웹훅 또는 봇 자격증명을 환경 변수로 설정합니다:

```bash
# Discord Webhook
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."

# Slack Incoming Webhook
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
```

작업 상태, 소요 시간, 커밋 및 PR 링크가 포함된 풍부한 임베드(Discord) 및 Block Kit 카드(Slack)를 전송할 수 있습니다. 페이로드 스키마와 CI 자동화 스니펫은 [Discord 가이드](docs/integrations/discord.md) 및 [Slack 가이드](docs/integrations/slack.md)를 참고하세요.

### 에이전트 스킬로 설치

표준 [Agent Skills](https://agentskills.io) CLI를 사용하여 `jeo` 및 다른 AI 코딩 에이전트에 채널 알림 스킬을 즉시 설치할 수 있습니다:

```bash
# 현재 저장소에 channel-notify 스킬 설치:
npx skills add akillness/jeo-code --skill channel-notify

# 또는 모든 프로젝트에서 사용하도록 전역(-g) 설치:
npx skills add akillness/jeo-code --skill channel-notify -g
```

설치 후 에이전트는 작업 수행 중 자동으로 상태를 브로드캐스트할 수 있습니다:
```bash
# jeo에서 원샷 호출:
jeo $channel-notify "테스트 47개 전수 통과 완료. 리뷰 준비됨."

# Claude Code에서 호출:
/channel-notify "빌드 성공. PR: https://github.com/..."
```

## 루틴 (GitHub Actions)

```bash
jeo routine init --trigger schedule --cron "0 7 * * *" --prompt "Re-run the eval suite and post a digest" --dry-run
jeo routine init --trigger issues --prompt "Triage this issue" --name "issue-triage"
```

GitHub Actions 워크플로(`.github/workflows/<name>.yml`)를 생성해 GitHub 호스팅 러너에서 jeo를 설치하고 `schedule` / `issues` / `pull_request`로 헤드리스 실행합니다(`jeo "<prompt>" -p`). 수동 실행용 `workflow_dispatch`도 포함합니다. 트리거는 GitHub가 담당하며 루틴은 인프로세스 스케줄러나 웹훅 리스너를 추가하지 않습니다. 세션 샌드박스는 위 로컬 사전 조건이 필요한 별도 명시적 설정이며 루틴 생성이 설치해 주지 않습니다. 기본값은 변경 PR 생성(`peter-evans/create-pull-request`, 빈 diff는 no-op), `--no-pr`은 트리거 브랜치에 커밋합니다. `--dry-run`은 YAML 출력만 하며 기존 `--out` 덮어쓰기는 `--force`가 필요합니다. 첫 실제 실행 전 저장소 시크릿 `ANTHROPIC_API_KEY`(또는 `--api-key-env <VAR>`)를 설정하세요.

## 로컬 모델

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor && jeo
```

## 설정

- 전역 설정: `~/.jeo/config.json` (모델 선택은 MRU 영속)
- 프로젝트 상태: `<project>/.jeo/`; 샌드박스 대화 기록은 워크스페이스 밖에 보관합니다(위 Discord 세션 경계 참고).

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

### 커스텀 프로바이더

```jsonc
{
  "customProviders": {
    "my-proxy": {
      "baseUrl": "https://gateway.internal/v1",
      "protocol": "openai",            // 또는 "anthropic" (/v1/messages 와이어 포맷)
      "apiKeyEnv": "MY_PROXY_API_KEY", // 기본값: <ID>_API_KEY
      "models": ["fast", "smart"]      // 오프라인 목록. 라이브 /models 가 우선합니다
    }
  }
}
```

셸(`jeo provider add|list|remove|presets|test`)에서도, 입력창(`/provider add …`)에서도
같은 레지스트리를 다룹니다. `jeo provider test <id>`는 엔드포인트를 실제로 찔러보고
**자격증명 문제와 엔드포인트 문제를 따로** 보고하며, 실패 시 non-zero로 종료하므로
프로비저닝 스크립트에서 게이트로 쓸 수 있습니다.

### 서브에이전트 팬아웃 동시성

```jsonc
{ "subagentConcurrency": 2 }   // 기본 4, 1~16으로 클램프
```

Anthropic Tier-1 계정은 동시 스트림 4개에서 곧바로 레이트 리밋에 걸려, 팬아웃이
순차 실행보다 *느려지는* 백오프 폭풍이 됩니다. 레이트 리밋이 빡빡한 계정은 낮추고,
여유가 있으면 올리세요. `task` 도구의 `tasks[]` 배치와 `eval` 도구의
`parallel`/`pipeline` 헬퍼 양쪽 모두에 적용됩니다.

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

CI는 `.github/workflows/npm-publish.yml`로 배포합니다 — GitHub 릴리즈 게시 시 자동, 또는 `workflow_dispatch` 수동 실행(드라이런 옵션). 워크플로는 브라우저 하드 게이트·타입체크·테스트(브라우저 도구 테스트는 별도 프로세스)·`pack:check`·패키징된 tarball 부팅 스모크를 거친 뒤 `npm publish --provenance`를 실행합니다.

배포는 **npm trusted publishing(OIDC)** 을 사용합니다 — 교체·유출·2FA 예외가 필요한 `NPM_TOKEN` 시크릿이 없습니다(npm은 2026년 8월부터 2FA 우회 토큰을 제한하고 2027년 1월에 해당 토큰의 직접 배포를 종료합니다). npmjs.com에서 1회 설정: 패키지 `jeo-code` → Settings → Trusted Publisher → GitHub Actions, owner `akillness`, repository `jeo-code`, workflow `npm-publish.yml`, environment 비움. 잡에는 `permissions.id-token: write`와 npm ≥ 11.5.1이 필요합니다(워크플로가 npm을 직접 업그레이드).

## 감사의 말 (Acknowledgements)

[gajae-code](https://github.com/Yeachan-Heo/gajae-code)에 깊은 감사를 드립니다.

## 변경 이력 (Changelog)

<!-- CHANGELOG:START (auto-generated from CHANGELOG.md — run `bun run changelog:sync`) -->
- **[Unreleased]**
- **[0.12.28]** (2026-11-07)
- **[0.12.27]** (2026-11-06)
- **[0.12.26]** (2026-11-06)
- **[0.12.25]** (2026-11-06)

See [CHANGELOG.md](CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->
