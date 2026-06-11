p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  Bun 기반 AI 코딩 에이전트 CLI — 인터뷰, 검토된 계획, tmux 네이티브 실행, 영구적 검증.
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="zero native deps" src="https://img.shields.io/badge/native%20deps-0-blue?style=flat-square">
</p>

<p align="center">
  <img src="assets/character.png" alt="jeo-code character mascot" width="320" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <b>한국어</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh.md">中文</a>
</p>

Bun 기반 AI 코딩 에이전트 CLI입니다. 저장소 내에서 `jeo`를 실행하면 파일을 읽고, 수정하고, 명령을 실행하며 작업을 완료할 때까지 진행합니다.

작업이 진행되는 동안, 라이브 턴은 gjc 스타일의 평평한 인라인 스택(flat inline stack)으로 렌더링됩니다. 완료된 작업은 기호로 시작하는 `✓/✗` 레저(ledger) 줄과 테두리가 있는 도구 카드(bash는 `✗ Bash` 타이틀, `$ command` 에코, `Output` 구분선, 출력 본문, 그리고 말미의 `Command exited with code N`이 합쳐진 단일 병합 카드로 표시되며, read/find/search는 한 줄짜리 `✓ Read path:lines`로 유지됨)로 스크롤백에 흘러 올라갑니다. 그 아래에는 실제 진행 중인 대상을 보여주는 스피너 상태 줄 한 줄과 컴팩트한 턴 통계(step · elapsed · tokens · live `$` 비용), `Todos` 체크리스트, `◆ hud` 줄, 배경색이 들어간 모델 상태 바(model (provider) · thinking / `branch ?N` dirty flag / cwd · 출력 토큰 속도 `⤴ N/s` · `ctx%`)가 핀으로 고정됩니다. 어시스턴트의 답변은 GFM 표를 상자 그림 표(box-drawn table)로 렌더링하며, 입력창(`> Type your message...`, 테마 액센트 테두리, 상단에 고정된 모델 바)에서 `/`를 입력하면 하단에 명령 미리보기(위치 카운터 `(i/total)` 포함)가 표시됩니다.

상태 줄은 매 틱마다 바뀌는 장식적인 텍스트 대신 **지금 실제로 수행 중인 작업**(진행 중인 파일/명령, 활성 plan 단계, plan 진행도, 그리고 레이트리밋 백오프 중에는 `rate limited (HTTP 429) — auto-retry #2 in 4s` 카운트다운)을 현재 step의 경과 시간과 함께 보여줍니다. 모델의 응답은 **실시간으로 스트리밍**됩니다. JSON 도구 호출이 형성되는 동안 추론 과정이 흐릿한 `💭` 행으로 표시되며, 완료되면 스크롤백에 `jeo · …` 줄로 한 번에 흘러 들어갑니다. **Ctrl+O**를 누르면 표가 온전히 렌더링되고 잘리지 않은 마지막 전체 응답을 스크롤백에 상세 보기로 덤프할 수 있습니다. 인라인 턴에서 진화 정체성(evolution identity)은 마지막 한 줄짜리 `Evolved to: …` 요약으로만 유지됩니다(ASCII 아트 헤더는 레거시 `JEO_TUI_ALT_SCREEN=1` 박스 모드에 남아있습니다). `task`를 통해 위임된 **서브에이전트의 진행 상황**(할당, `step N/M`, 중첩 도구 호출의 실제 대상인 `read src/x.ts`, `bash: …`, 결과 요약)도 gjc와 마찬가지로 실시간으로 스트리밍됩니다.

**클립보드 이미지 붙여넣기**: 입력창에서 **Ctrl+V**를 누르면 복사된 이미지(스크린샷, 브라우저 우클릭 복사 등)를 다음 메시지에 첨부할 수 있습니다. 커서 위치에 `[image #N]` 태그가 삽입되고, 입력창에는 `⧉ N image(s) attached` 힌트가 표시되며, 첨부된 이미지는 모든 프로바이더(Anthropic content blocks, OpenAI data URLs, Codex `input_image`, Gemini/Antigravity `inlineData`, Ollama `images[]`)에 실제 멀티모달 입력으로 전송됩니다. macOS에서는 `pngpaste`가 설치되어 있으면 이를 사용하고(설치되지 않은 경우 AppleScript 폴백 사용), Linux에서는 `wl-paste`/`xclip`을 사용합니다. 입력창 자체도 평평한 외곽선 대신 입체 패널처럼 보이도록 두 톤의 깊이감 힌트(밝은 상단/좌측 엣지와 어두운 하단/우측 엣지)로 렌더링됩니다.

**투톤 패널 깊이감**: 모든 보더 패널(JEO forge 웰컴 박스, 라이브 상태 박스, 도구/forge 카드, 외곽 alt-screen 프레임, 입력창)이 대비를 위한 볼드 타이틀과 함께 밝은 상단/좌측 엣지(테마 액센트)와 어두운 하단/우측 엣지(디밍 액센트)로 렌더링되어, 평평한 외곽선이 아닌 입체 패널처럼 보입니다.

**기본값은 모든 세션에서 항상 최근 선택을 따릅니다**: 모델이나 프로바이더를 선택하면(`/model …`, `/provider <name> …`, 피커) 즉시 `~/.joc/config.json`에 저장됩니다. 가장 최근에 선택한 항목이 모든 향후 세션의 `defaultModel`이 되며, `recentModels`가 최신순 회전 목록(최근 선택이 먼저)을 유지하여 `/model`에서 다시 보여줍니다.

명령어 인자로 단발성 요청을 바로 실행하는 경우(`jeo "요청"`)에도 TTY에서는 동일한 라이브 TUI가 표시되며, `--no-tui`/파이프 모드에서는 `[step N/M] <tool target>`과 결과 라인이 스트리밍되어 전체 흐름을 계속 확인할 수 있습니다.

TUI는 라이브 턴을 **메인 터미널 버퍼 내에 인라인으로 렌더링**합니다(gjc 스타일): 완료된 각 진행 줄(도구 결과, 서브에이전트 이벤트, 추론)과 종료된 도구 카드는 발생 즉시 일반 스크롤백으로 흘러 들어갑니다. 따라서 **턴이 진행되는 중에도 tmux 또는 터미널 마우스 휠을 사용하여 이전 진행 과정을 되돌아볼 수 있으며**, 하단에서는 컴팩트한 라이브 프레임이 계속해서 다시 그려집니다. 지우기 작업은 행 단위로 수행되며(`ESC[2K`, 스크롤백을 낭비하는 `ESC[0J`는 사용하지 않음), 각 플러시 및 재도색은 **DECSET 2026 동기화 업데이트**로 래핑되어 깜빡임이 없습니다. `JEO_TUI_ALT_SCREEN=1`로 설정하면 레거시의 스크롤 분리형 alt-screen 턴으로 복귀할 수 있습니다. 폭 계산은 처음부터 끝까지 **CJK/이모지 인식**을 거치므로 와이드 문자 입력과 상자가 보더 영역 밖으로 흘러넘치지 않습니다. 스트림/도구 목록은 **고정 크기 링 버퍼**이므로 긴 세션에서도 메모리와 프레임당 렌더링 비용이 일정하게 유지됩니다(요약 LLM이 실패하더라도 히스토리는 토크나이저 수준의 정밀한 예산에 맞추어 결정적으로 압축되므로 한계 없이 증가하지 않습니다). 화면이 너무 짧아 모든 섹션을 표시할 수 없을 때는 라이브 프레임 상단이 잘려 나가며, **상태 줄, Todos, hud, 모델 바는 항상 표시되도록 확보**됩니다.

Forge 박스에는 테두리가 있어 **상자가 온전히 들어갈 때만**(최근 것 우선) 표시되며, 반쪽짜리 박스는 렌더링되지 않습니다.

## 설치

요구사항: Bun `1.3.14+`

```bash
bun install -g jeo-code
```

설치 확인:

```bash
jeo --version
```

## 기본 사용법

```bash
# 대화형 코딩 에이전트 실행
jeo

# 한 번의 요청을 바로 실행
jeo "Tidy up the README and run the tests"

# 현재 설정과 모델 연결 상태 확인 (실제 호출 경로로 점검: Anthropic=GET /v1/models, OpenAI OAuth=Codex 백엔드, Gemini OAuth=Cloud Code Assist loadCodeAssist)
jeo doctor

# API 키 / OAuth / 로컬 모델 설정
jeo setup
```

## 대화형 슬래시 명령어

`jeo` REPL 입력창에서 사용할 수 있는 명령입니다 (`<Tab>` 자동완성 지원).

| 명령 | 설명 |
| --- | --- |
| `/model [id\|#N\|save]` | 모델 설정(라이브 `#N` 선택 · 퍼지 매칭). **선택 즉시 자동 저장** — 가장 최근 선택이 모든 새 세션의 기본값이 되고, `recentModels`가 최신순 회전 목록을 유지(`/model` 단독 실행 시 표시). `save`는 명시적 별칭으로 유지 |
| `/models [refresh\|caps\|catalog]` | 로그인된 OAuth/API 모델 목록 표시 (+capability/catalog 표) |
| `/provider [name] [model\|#N]` | 프로바이더 자격증명·전환, 해당 프로바이더의 라이브 모델 목록 표시 (회사명 병기) |
| `/provider login <name>` | **입력창에서 바로 OAuth 로그인** (anthropic/openai/gemini/antigravity; antigravity 권장, gemini는 fallback) |
| `/login [name]` · `/logout <name>` | OAuth 로그인 별칭 (`/provider login`) · 저장된 OAuth 토큰 제거 |
| `/agents [role] [model\|#N]` · `/agents <role> provider <name> [model]` · `/model subagent <role> [model\|#N]` | 서브에이전트 역할(executor/planner/architect/critic)의 모델/프로바이더 설정 — 저장 즉시 현재 세션의 `task` 위임에 적용되며, 모델을 선택하는 중에도 역할 대상(role target)을 준비할 수 있습니다. |
| `/roles [tier model]` | 모델 역할 티어(smol/slow/plan) 표시·설정 |
| `/thinking [level]` | 사고 예산 설정 (minimal/low/medium/high/xhigh) |
| `/config` | 현재 런타임 설정 표시 |
| `/skill [name [intent]]` · `$<skill> [intent]` · `/speckit.plan`, etc. | 워크플로우 skill 목록/표시/실행 — `$team "task"` 처럼 **`$<skill>`**로 직접 호출 (Codex/gjc 스타일, Tab 자동완성) (사용자 SKILL.md는 **명시적 호출 시에만** 실행됨) |
| `/view <file> [a-b]` · `/diff [file]` · `/find <glob>` · `/search <pat>` | 코드 뷰 / git diff / 파일 및 패턴 검색 |
| `/new` · `/drop` · `/session [info\|delete]` · `/rename <title>` · `/resume [id]` | 세션 시작/삭제/정보/이름 변경/재개 (gjc parity) |
| `/retry` · `/btw <question>` | 마지막 요청 재시도 · 히스토리를 변경하지 않는 사이드 질문 |
| `/export [path] [json]` · `/dump` | 세션 트랜스크립트를 파일로 내보내기 · 클립보드에 복사 |
| `/usage` · `/context` · `/tools` · `/hotkeys` | 누적 토큰 사용량 · 컨텍스트 토큰 구성 분석 · 노출된 도구 목록 · 단축키 |
| `/theme [name]` · `/settings` | TUI 테마 설정 (cosmic/matrix/solar/red-claw/blue-crab/mono) · 런타임 설정 (=`/config`) |
| `/sessions` · `/compact` · `/clear` · `/help` · `/exit` | 세션/컨텍스트 관리 |

## 자주 쓰는 명령

```bash
# 저장된 세션 보기 / 재개
jeo launch --list
jeo launch --resume

# tmux 세션에서 실행 — 실행할 때마다 독립 세션 (동일 디렉터리/브랜치에서 여러 번 실행하면 base, base-2, base-3 …로 분리)
jeo --tmux
jeo --tmux --model gemini-2.5-flash --thinking high
jeo --tmux --models --catalog gpt

# 별도 worktree에서 실행
jeo --tmux --worktree ../jeo-work

# 모델 목록 확인
jeo models

# GJC 스타일 모델 카탈로그 (정적 capability)
jeo --list-models=gemini
jeo --models --catalog gpt

# 실행 시 모델/프로바이더/사고 예산 지정
jeo --model gemini-2.5-flash --thinking high "Analyze this code"
jeo --provider gemini --plan "Draft an implementation plan"

# 슬래시 명령어 팔레트
# REPL에서 "/" 또는 "/m"처럼 prefix를 입력하면 카테고리별 명령/옵션이 리스트업됩니다.
# 서브에이전트 설정은 /agents 와 /model subagent <role> ... 로 지원합니다.

# 인증 관리
jeo auth login anthropic
jeo auth status
```

## Spec-first 워크플로우

요구사항을 먼저 명확히 하고 계획, 실행, 검증까지 진행할 때 이 워크플로우를 사용합니다. 단계들은 상태(`.joc/state/`)를 통해 전달되며 게이트로 제어됩니다: deep-interview는 먼저 **상위 수준 토폴로지(top-level topology)를 확인**하고, 질문, 평가 및 인수 기준을 작성할 때 입력 언어(한국어/영어/일본어/중국어)를 보존하며, 기존 코드베이스(brownfield) 요청의 경우 **저장소 마커 및 경로 증거(repo markers + path evidence)**를 수집합니다. 그 다음 MutationGuard가 코드 수정을 허용하고 ralplan이 진행되기 전에 반드시 **시드를 동결(freeze the seed)**해야 합니다(모호성 ambiguity ≤ 20%; `--auto`/비-TTY 환경에서도 이 게이트를 우회할 수 없으며, 기준을 충족하지 못하면 시드가 동결되지 않음) → ralplan은 **Planner→Architect→Critic 합의**(3단계 연쇄 패스, 스키마 자체 검증/복구 포함)를 통해 **승인 대기(approval-pending)** 상태의 계획을 구축합니다 → 해당 계획은 `jeo approve <plan>`로 승인되어야 합니다 → team이 실행을 수행하며(손상된 team 상태는 무시되는 대신 거부되고, 알 수 없는 서브에이전트 역할은 실행 전에 거부되며, 동일한 작업 이름은 step index 기준에 따라 올바른 역할로 라우팅되고, planner/architect/critic 보고서가 계약을 위반하거나 architect가 `BLOCK`/`REQUEST CHANGES` 또는 critic이 `[REJECT]`/`[ITERATE]`를 반환하는 경우 즉시 실행이 중단됨) → ultragoal이 team의 실행을 검증합니다.

```bash
jeo deep-interview "Describe the feature you want to build"
jeo ralplan
jeo approve <plan-path>
jeo team
jeo ultragoal
```

## 로컬 모델 사용

Ollama를 사용하면 API 키 없이 로컬에서 실행할 수 있습니다.

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor
jeo
```

## 설정 파일

- 전역 설정: `~/.joc/config.json`
- 모델 선택은 MRU로 영속화됨: `defaultModel`은 항상 가장 최근에 선택한 모델이며, `recentModels`는 최근 선택된 최대 10개의 ID를 유지(최근 선택이 먼저)
- 프로젝트 상태/세션: `<project>/.joc/`

주요 환경 변수:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic        # TUI 테마 (cosmic/matrix/solar/red-claw/blue-crab/mono)
JEO_TUI_ALT_SCREEN=1        # 레거시 alt-screen 라이브 턴으로 복귀 (기본값: 메인 버퍼 인라인 + tmux 마우스 휠 스크롤백)
JEO_STEP_BASE=24            # 동적 step 예산: 롤링 베이스 (`step N/M` 시드)
JEO_STEP_EXTENSIONS=2       # 턴당 예산 연장 횟수 제한 (기본값: 진행 중인 동안 제한 없음; 0 = 레거시 고정 카운터)
JEO_STEP_EXTENSION_SIZE=10  # 연장 1회당 부여되는 step 수 (기본값: 베이스의 절반, 최소 4)
JEO_STEP_HARD_CAP=75        # 절대 step 상한 (기본값: 600 — 작업 중단이 아닌 강제 종료 보장용)
JEO_STEP_WINDOW=8           # 진행 여부 판정에 사용되는 최근 도구 호출 윈도
```

```jsonc
{
  "retry": {
    "requestMaxRetries": 4,
    "streamMaxRetries": 2,
    "maxDelayMs": 8000,
    "rateLimitRetries": 6,
    "rateLimitMinDelayMs": 2000,
    "failFastStatuses": [503],
    "failFastPatterns": ["model not found", "context length exceeded"]
  }
}
```

### Step 예산 (동적 retry 플로우)

턴의 step 제한은 하드코딩된 카운터가 아니라 유연한 **예산**입니다. 기본적으로 이 예산은 **동적**입니다. 롤링 베이스(`JEO_STEP_BASE`, 기본값 24)에서 시작하여, 최근 도구 호출 윈도가 실제적이고 새로운 진전(최근 호출의 50% 이상 성공, 2개 이상의 서로 다른 대상, 그리고 지난 연장 이후 최소 하나의 처음 등장한 호출 존재)을 보여주는 한 예산을 **계속해서 스스로 연장**합니다 — 작업당 고정된 중단점은 없으며, `JEO_STEP_HARD_CAP`(기본값 600)은 비정상적인 루프(pathological spins)에 대한 강제 종료 보장용으로만 존재합니다. 예산이 연장될 때마다 `↻ step budget extended to M` 레저 줄을 남기고 라이브 `step N/M` 분모를 업데이트합니다. 진행이 정체된 윈도(대부분 실패하거나 이미 수행한 호출만 반복하는 경우)는 연장이 거부되고 루프가 대신 **통합 마무리(consolidation)**에 들어갑니다. 도구를 사용하지 않는 마지막 한 번의 모델 호출을 통해 수행된 작업, 주요 발견 사항, 그리고 남은 작업을 요약 정리하며 거부 사유가 메시지에 명시됩니다. 명시적인 `--max-steps N` 옵션을 전달하면 제한된 플로우(베이스 N + 캡이 씌워진 연장)로 복원됩니다. 기존 가드(동일 호출 3회, 연속 실패 5회, parse-bounce 구제)는 그대로 유지되며, 서브에이전트 위임(`task`, `jeo team`)은 정확한 step 계약을 유지합니다 — 여기서는 연장이 비활성화되고 재시도 권한은 부모가 갖습니다.

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as `NPM_TOKEN`.
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.
