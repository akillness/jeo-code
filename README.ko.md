<p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code (jeo)</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  Bun 기반 AI 코딩 에이전트 CLI — interviews, reviewed plans, tmux-native execution, durable verification.
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

Bun 기반 AI 코딩 에이전트 CLI입니다. 저장소 안에서 `jeo`를 실행하면 파일을 읽고, 수정하고, 명령을 실행하며 작업을 끝까지 진행합니다.
진행 중에는 gjc 스타일의 평평한 인라인 스택이 표시됩니다: 완료된 작업은 `✓/✗` 한 줄 레저와 테두리 툴 카드(bash는 `✗ Bash` 제목 · `$ 명령` 에코 · `── Output ──` 구분선 · 출력 본문 · 말미의 `Command exited with code N`이 합쳐진 단일 카드, read/find/search는 `✓ Read path:lines` 한 줄)로 스크롤백에 흘러 올라가고, 그 아래에 실제 진행 대상을 보여주는 스피너 상태 한 줄(step · 경과 · 토큰 · 라이브 `$` 비용), `Todos` 체크리스트, `◆ hud` 줄, 배경색 모델 상태 바(모델(프로바이더) · thinking / `branch ?N` / cwd · `⤴ N/s` · `ctx%`)가 핀 고정됩니다. 입력창(`> Type your message...`, 테마 액센트 테두리)에서 `/`로 시작하면 명령 미리보기가 하단에 노출됩니다.

상태 줄은 매 틱 바뀌는 장식 문구 대신 **지금 실제로 하는 일**(진행 중인 파일·명령, 활성 plan 단계, plan 진행도, 레이트리밋 백오프 중에는 `rate limited (HTTP 429) — auto-retry #2 in 4s` 카운트다운)을 현재 step 경과와 함께 보여줍니다. 인라인 턴에서 진화 정체성은 마지막 `Evolved to: …` 요약 한 줄로만 남고, ASCII 아트 헤더는 레거시 `JEO_TUI_ALT_SCREEN=1` 박스 모드에 유지됩니다. `task`로 위임된 **서브에이전트의 진행 상황**(할당·`step N/M`·중첩 툴 호출의 실제 대상 `read src/x.ts`·`bash: …`·결과 요약)도 gjc처럼 스트림에 실시간 표시됩니다.

`jeo "요청"`처럼 cmd 인자로 한 번에 실행해도 TTY에서는 같은 라이브 TUI가 뜨고, `--no-tui`/파이프 모드에서는 `[step N/M] <tool target>` + 결과 라인이 스트리밍되어 전체 동작 흐름이 보입니다.

TUI는 **차등(differential) 렌더러**로 화면을 제자리에서 갱신해 스크롤백을 늘리지 않고(완료된 레저 줄과 툴 카드는 발생 즉시 스크롤백으로 흘려보내 tmux/마우스 휠로 턴 중에도 과거 진행을 볼 수 있음), 화면 크기 변경 시 폭이 바뀌면 전체 재도색·idle 프롬프트에서도 리사이즈로 푸터 영역을 재동기화합니다. 스트림/툴 목록은 **고정 크기 링 버퍼**라 긴 세션에서도 메모리·프레임당 렌더 비용이 평탄합니다(요약 LLM 실패 시에도 히스토리는 결정적으로 압축돼 무한 증가하지 않음). 화면이 짧아 모든 섹션이 다 들어가지 못할 때는 **상태 줄·Todos·hud·모델 바를 항상 먼저 확보**하고, 남는 행만 진행 중인 툴 카드에 씁니다.

 forge 박스는 테두리가 있어 **통째로 들어갈 때만**(최근 것 우선) 표시하고 반쪽짜리 박스를 만들지 않습니다.

## 설치

요구사항: Bun `1.3.14+`

> **리네임 안내**: 바이너리 이름이 `jeo`로 변경되었습니다(이전 `joc`). `joc` 명령은 호환 별칭으로 계속 동작하며, 레거시 `JOC_*` 환경변수도 그대로 인식됩니다(`JEO_*` 표기 권장). 기존 `~/.joc` / `.joc` 런타임 상태는 그대로 사용됩니다.

**투톤 패널 깊이감**: 모든 보더 패널(JEO forge 웰컴 박스, 라이브 상태 박스, 도구/forge 카드, 외곽 프레임, 입력 박스)이 밝은 상단/좌측 엣지(테마 액센트)와 어두운 하단/우측 엣지(디밍 액센트)로 렌더링되고 타이틀은 볼드로 대비되어, 평평한 외곽선이 아닌 입체 패널처럼 보입니다.

**기본값은 항상 최근 선택을 따릅니다(모든 세션 공유)**: 모델/provider를 선택하면(`/model …`, `/provider <name> …`, 피커) 즉시 `~/.joc/config.json`에 저장됩니다 — 가장 최근 선택이 모든 미래 세션의 `defaultModel`이 되고, `recentModels`가 최신순 MRU 회전을 유지해 `/model`에서 다시 보여줍니다.

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
jeo "README를 정리하고 테스트를 실행해줘"

# 현재 설정과 모델 연결 상태 확인 (실제 호출 경로로 점검: Anthropic=GET /v1/models, OpenAI OAuth=Codex 백엔드, Gemini OAuth=Cloud Code Assist loadCodeAssist)
jeo doctor

# API 키 / OAuth / 로컬 모델 설정
jeo setup
```

## 대화형 슬래시 명령어

`jeo` REPL 입력창에서 사용할 수 있는 명령입니다 (`<Tab>` 자동완성 지원).

| 명령 | 설명 |
| --- | --- |
| `/model [id\|#N\|save]` | 모델 설정(라이브 #N 선택·퍼지 매칭). **선택 즉시 자동 저장** — 가장 최근 선택이 모든 새 세션의 기본값이 되고, `recentModels`가 최신순 회전 목록을 유지(`/model` 단독 실행 시 표시). `save`는 명시적 별칭으로 유지 |
| `/models [refresh\|caps\|catalog]` | 로그인된 OAuth/API 모델 목록(+capability/카탈로그 표) |
| `/provider [name] [model\|#N]` | 프로바이더 자격증명·전환, 해당 프로바이더 라이브 모델 목록(회사명 병기) |
| `/provider login <name>` | **입력창에서 바로 OAuth 로그인** (anthropic/openai/gemini/antigravity; antigravity가 권장, gemini는 fallback) |
| `/login [name]` · `/logout <name>` | OAuth 로그인 별칭(`/provider login`) · 저장된 OAuth 토큰 제거 |
| `/agents [role] [model\|#N]` · `/agents <role> provider <name> [model]` · `/model subagent <role> [model\|#N]` | 서브에이전트(executor/planner/architect/critic) 역할 모델/프로바이더 설정(저장 즉시 현재 세션의 `task` 위임에도 반영; 모델 선택 중에도 role target을 준비 가능) |
| `/roles [tier model]` | 모델 역할 티어(smol/slow/plan) 표시·설정 |
| `/thinking [level]` | 사고 예산(minimal/low/medium/high/xhigh) |
| `/config` | 현재 런타임 설정 표시 |
| `/skill [name [intent]]` · `$<skill> [intent]` · `/speckit.plan` 등 | 워크플로우 skill 목록·표시·실행 — `$team "작업"` 처럼 **`$스킬명`으로 직접 호출**(Codex/gjc 스타일, Tab 자동완성) (사용자 SKILL.md는 **명시적 호출일 때만** 실행) |
| `/view <file> [a-b]` · `/diff [file]` · `/find <glob>` · `/search <pat>` | 코드뷰 / git diff / 파일·패턴 검색 |
| `/new` · `/drop` · `/session [info\|delete]` · `/rename <title>` · `/resume [id]` | 세션 시작/삭제/정보/이름변경/재개 (gjc parity) |
| `/retry` · `/btw <question>` | 마지막 요청 재시도 · 히스토리를 건드리지 않는 사이드 질문 |
| `/export [path] [json]` · `/dump` | 세션 트랜스크립트 파일 내보내기 · 클립보드 복사 |
| `/usage` · `/context` · `/tools` · `/hotkeys` | 누적 토큰 사용량 · 컨텍스트 토큰 분해 · 노출 tool 목록 · 단축키 |
| `/theme [name]` · `/settings` | TUI 테마(cosmic/matrix/solar/red-claw/blue-crab/mono) · 런타임 설정(=`/config`) |
| `/sessions` · `/compact` · `/clear` · `/help` · `/exit` | 세션·컨텍스트 관리 |

## 자주 쓰는 명령

```bash
# 저장된 세션 보기 / 재개
jeo launch --list
jeo launch --resume

# tmux 세션에서 실행 — 매 실행마다 독립 세션 (같은 디렉터리·브랜치에서 동시에 여러 번 띄워도 base, base-2, base-3 …로 분리)
jeo --tmux
jeo --tmux --model gemini-2.5-flash --thinking high
jeo --tmux --models --catalog gpt

# 별도 worktree에서 실행
jeo --tmux --worktree ../jeo-work

# 모델 목록 확인
jeo models

# GJC 스타일 모델 카탈로그(정적 capability)
jeo --list-models=gemini
jeo --models --catalog gpt

# 실행 시 모델/프로바이더/사고 예산 지정
jeo --model gemini-2.5-flash --thinking high "코드 분석해줘"
jeo --provider gemini --plan "구현 계획 세워줘"
# 슬래시 명령어 팔레트
# REPL에서 "/" 또는 "/m"처럼 prefix를 입력하면 카테고리별 명령/옵션이 리스트업됩니다.
# subagent 설정은 /agents 와 /model subagent <role> ... 로 지원합니다.

# 인증 관리
jeo auth login anthropic
jeo auth status
```

## Spec-first 워크플로우

요구사항을 먼저 정리하고 계획, 실행, 검증까지 진행할 때 사용합니다. 단계는 상태(`.joc/state/`)로 이어지며 게이트가 있습니다: deep-interview가 먼저 **top-level topology를 확인**하고, 입력 언어(한국어/영어/일본어/중국어)를 보존해 질문·평가·인수 기준을 작성하며, brownfield 요청이면 **repo marker + path evidence**를 수집한 뒤, 그 다음 **시드를 동결**(ambiguity ≤ 20%; `--auto`/non-TTY도 이 게이트를 우회하지 못하며, 기준 미달이면 시드를 동결하지 않음)해야 MutationGuard가 코드 수정을 허용하고 ralplan이 진행됩니다 → ralplan은 **Planner→Architect→Critic 합의**(3단계 연쇄 패스)로 **승인 대기** 플랜을 만들고(스키마 자체검증·보정 포함) → `jeo approve <plan>`로 승인해야 → team이 실행하며(손상된 team 상태는 무시하지 않고 거부, 알 수 없는 subagent role은 실행 전 거부, 동일한 task 이름도 step index 기준으로 올바른 role에 라우팅, planner/architect/critic report가 계약을 못 지키거나 architect가 `BLOCK`/`REQUEST CHANGES`, critic이 `[REJECT]`/`[ITERATE]`를 내면 즉시 중단) → ultragoal이 team 실행을 검증합니다.

```bash
jeo deep-interview "만들고 싶은 기능 설명"
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
- 모델 선택은 MRU로 영속화: `defaultModel`은 항상 가장 최근 선택, `recentModels`는 최신순 최대 10개 유지
- 프로젝트 상태/세션: `<project>/.joc/`

주요 환경 변수:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
JEO_TUI_THEME=cosmic        # TUI 테마 (cosmic/matrix/solar/red-claw/blue-crab/mono)
JEO_TUI_ALT_SCREEN=1        # 레거시 alt-screen 라이브 턴으로 복귀 (기본: 메인 버퍼 인라인 + tmux 휠 스크롤백)
JEO_STEP_EXTENSIONS=2       # 턴당 step 예산 연장 횟수 (0 = 기존 고정 카운터)
JEO_STEP_EXTENSION_SIZE=10  # 연장 1회당 부여 step 수 (기본: 기본 예산의 절반, 최소 4)
JEO_STEP_HARD_CAP=75        # 절대 step 상한 (기본: 기본 예산의 3배)
JEO_STEP_WINDOW=8           # 진행도 판정에 쓰는 최근 툴 호출 윈도
```

### Step 예산 (retry 플로우)

턴당 step 제한은 단순 카운터가 아니라 유연한 **예산**입니다(gjc retry-flow 패리티). 카운터가 현재 한도에 닿으면 엔진이 최근 툴 호출 윈도를 채점해, 실제로 진전 중이면(최근 호출의 50% 이상 성공 + 2개 이상의 서로 다른 대상) 예산을 **스스로 연장**합니다 — `JEO_STEP_EXTENSIONS`(기본 2회)와 절대 상한 `JEO_STEP_HARD_CAP`(기본 3배)으로 제한되며, `↻ step budget extended to M` 레저 줄과 함께 라이브 `step N/M` 분모도 갱신됩니다. 정체된 윈도(대부분 실패하거나 같은 호출만 반복)는 연장 대신 **fail-fast**로 통합 마무리(consolidation)에 들어가고, 거절 사유가 최종 메시지에 명시됩니다. 기존 가드(동일 호출 3회, 연속 실패 5회, parse-bounce 샐비지)는 그대로입니다. 서브에이전트 위임(`task`, `jeo team`)은 정확한 step 계약을 유지합니다 — 연장은 비활성화되고 재시도 권한은 부모에게 있습니다.

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as `NPM_TOKEN`.
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.
