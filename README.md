# jeo-code (`joc`)

Bun 기반 AI 코딩 에이전트 CLI입니다. 저장소 안에서 `joc`를 실행하면 파일을 읽고, 수정하고, 명령을 실행하며 작업을 끝까지 진행합니다.
진행 중에는 ASCII 진화 아트·스텝 타임라인·툴 forge 박스(bash/read/write/edit)·라이브 상태 푸터가 한 화면에 표시되고, 입력창에서 `/`로 시작하면 명령 미리보기가 하단에 노출됩니다.
TUI는 **차등(differential) 렌더러**로 화면을 제자리에서 갱신해 스크롤백을 늘리지 않고(턴당 최종 출력 1회만 기록), 화면 크기 변경 시 폭이 바뀌면 전체 재도색·idle 프롬프트에서도 리사이즈로 푸터 영역을 재동기화합니다. 스트림/툴 목록은 **고정 크기 링 버퍼**라 긴 세션에서도 메모리·프레임당 렌더 비용이 평탄하며(요약 LLM 실패 시에도 히스토리는 결정적으로 압축돼 무한 증가하지 않음), 진화 아트는 애니메이션 프레임 단위로 캐시돼 매 틱 재렌더하지 않습니다.

## 설치

요구사항: Bun `1.3.14+`

```bash
bun install -g jeo-code
```

설치 확인:

```bash
joc --version
```

## 기본 사용법

```bash
# 대화형 코딩 에이전트 실행
joc

# 한 번의 요청을 바로 실행
joc "README를 정리하고 테스트를 실행해줘"

# 현재 설정과 모델 연결 상태 확인 (실제 호출 경로로 점검: Anthropic=GET /v1/models, OpenAI OAuth=Codex 백엔드)
joc doctor

# API 키 / OAuth / 로컬 모델 설정
joc setup
```

## 대화형 슬래시 명령어

`joc` REPL 입력창에서 사용할 수 있는 명령입니다 (`<Tab>` 자동완성 지원).

| 명령 | 설명 |
| --- | --- |
| `/model [id\|#N\|save]` | 세션 모델 설정(라이브 #N 선택·퍼지 매칭·기본값 저장) |
| `/models [refresh\|caps\|catalog]` | 로그인된 OAuth/API 모델 목록(+capability/카탈로그 표) |
| `/provider [name] [model\|#N]` | 프로바이더 자격증명·전환, 해당 프로바이더 라이브 모델 목록 |
| `/provider login <name>` | **입력창에서 바로 OAuth 로그인** (anthropic/openai/gemini) |
| `/logout <name>` | 저장된 OAuth 토큰 제거 |
| `/agents [role] [model]` · `/subagent ...` · `/subagents ...` | 서브에이전트(executor/planner/architect/critic) 역할 모델 설정 |
| `/roles [tier model]` | 모델 역할 티어(smol/slow/plan) 표시·설정 |
| `/thinking [level]` | 사고 예산(minimal/low/medium/high/xhigh) |
| `/config` | 현재 런타임 설정 표시 |
| `/skill [name [intent]]` · `/speckit.plan` 등 | 워크플로우 skill 목록·표시·실행 (번들 + `~/.joc/skills`, `.joc/skills`, `~/.agents/skills/<name>/SKILL.md`의 사용자 SKILL.md) |
| `/view <file> [a-b]` · `/diff [file]` · `/find <glob>` · `/search <pat>` | 코드뷰 / git diff / 파일·패턴 검색 |
| `/sessions` · `/compact` · `/clear` · `/help` · `/exit` | 세션·컨텍스트 관리 |

TUI는 단계별 진행을 **스텝 타임라인**(번호·상태 색상·진행 애니메이션)과 푸터의 라이브 스텝 스트립·키 힌트 바로 표시합니다. 입력창에 `/`로 시작하는 키워드를 타이핑하면 일치하는 명령 목록이 **실시간 미리보기**로 아래에 표시되고, **방향키(↑/↓)로 선택**한 뒤 Enter로 실행할 수 있습니다(`❯` 표시). `/subagent `·`/provider login `처럼 공백 뒤 인자를 입력할 때도 사용 가능한 role/provider/subcommand 목록이 계속 보입니다. `/provider login`은 방향키 프로바이더 선택기를 열고, `/provider gemini` 또는 빈 `/model`은 화면 폭에 맞는 **방향키 모델 선택기**를 열어 Enter로 바로 모델을 설정합니다. `진행중/완료/subagent/tool/diff/file/command` 같은 UI 범주는 색인형 배지(`[AGENT]`, `[01:CMD]`, `[FILE]`, `[DIFF]`, `[STEP]`)로 구분되어 진행중 항목, 완료 항목, subagent 스트림, forge 박스, 코드뷰 헤더를 빠르게 스캔할 수 있습니다. 입력 중인 텍스트는 하단 푸터에서 **박스형 입력란**으로 미러링되며, 폭을 넘기면 자연스럽게 여러 줄로 감싸집니다. `@src/`처럼 입력하면 현재 워크스페이스 기준 상대 경로 후보가 `Paths:` 섹션에 표시되고, 폴더 경로는 `src/.../`처럼 슬래시로 구분됩니다. Skill 문서에서 선언/언급한 `/speckit.plan` 같은 직접 슬래시 별칭도 팔레트와 Tab 자동완성에 나타나며, Enter 실행 시 해당 skill 문서를 세션에 주입합니다.

대화형 에이전트는 내부 `todo` tool로 작업 계획을 선언하면 TUI에 **Plan 체크리스트**를 유지하고, `task` tool로 executor/planner/architect/critic 서브에이전트에 bounded 작업을 위임할 수 있습니다. planner/architect/critic은 read/find/search 전용이라 파일을 수정하지 못하며, role 오타는 mutating executor로 조용히 fallback되지 않고 실패합니다.

> **OpenAI(ChatGPT/Codex) OAuth로 실제 실행:** ChatGPT/Codex OAuth 토큰은 `api.openai.com/v1`(chat/completions·models)을 거부합니다. joc는 OpenAI가 **OAuth로만 로그인**된 경우(별도 API 키 없음) Codex 구독 백엔드(`chatgpt.com/backend-api/codex/responses`)로 turn 실행을 라우팅하고, 모델 discovery도 `chatgpt.com/backend-api/codex/models`를 직접 조회해 실제 Codex 구독 모델(`gpt-5.5`, `gpt-5.4` 등)을 표시합니다. `OPENAI_API_KEY`가 설정돼 있으면 표준 `api.openai.com/v1` 경로가 우선합니다.
> `OPENAI_API_KEY`가 설정돼 있으면 그 키(표준 `api.openai.com/v1`, 전체 모델)가 우선합니다. Gemini OAuth는 아직 호환 백엔드가 없어 `GEMINI_API_KEY`가 필요하며 picker에서 `OAuth (API key needed)`로 표시됩니다. 레이트리밋(HTTP 429)은 자동 재시도 후에도 지속되면 `/model`로 다른(로컬 ollama 등) 모델로 전환하라는 안내 메시지로 정리해 보여줍니다.

> **모델 목록은 채팅 가능한 모델만:** live discovery가 임베딩·TTS·이미지·moderation 같은 비대화 모델을 걸러냅니다(OpenAI 패밀리 denylist, Gemini는 `generateContent` 지원 + 이름 필터). 그래서 `/models`·`/provider <name>`·`#N` 선택 목록에는 실제로 대화에 쓸 수 있는 모델만 나옵니다.
>
> **모델 id 매핑(404 방지):** 별칭(`sonnet`/`opus`/`haiku`/`gpt`/`flash`)과 카탈로그 canonical은 호출 직전에 실제 provider 모델 id로 매핑됩니다 — 예: `sonnet` → `claude-sonnet-4-5` → 와이어 id `claude-sonnet-4-5-20250929`. 카탈로그/별칭은 현재 제공되는 모델로 유지되며, 구형 id를 직접 지정해 `model not found(404)`가 나오면 `/models` 또는 `/provider <name>`로 지금 사용 가능한 모델을 골라 `#N`으로 선택하세요(라이브 목록이 권위 소스).
>
> **코드뷰 안전:** `/view`·`/diff`는 파일/diff의 신뢰할 수 없는 제어 바이트(ANSI 이스케이프, `\r`, 탭, C0)를 렌더 전에 제거합니다 — 임의 파일을 열어도 화면이 깨지거나 커서가 튀지 않습니다.
>
> **파일 검색(`/find` · `find` tool):** 슬래시 없는 이름 패턴(`*.ts`, `engine.ts`)은 하위 디렉터리까지 재귀 basename 매칭이고, `/`나 `**`를 포함한 **경로 글로브**(`src/**/*.ts`, `src/agent/*.ts`, 정확한 상대경로 `src/skills/catalog.ts`)는 실제 glob 의미로 해석됩니다. 이전에는 `find -name`이 basename만 보기 때문에 경로 글로브가 항상 매칭 0건이었습니다(문서의 `/find src/**/*.ts` 예시조차 동작 안 함). `node_modules`/`.git`/`dist` 등 무시 디렉터리는 양쪽 경로 모두에서 제외됩니다.
>
> **사용자 skill 문서:** `~/.joc/skills`·`.joc/skills`의 평면 `<name>.md`와 `~/.agents/skills/<name>/SKILL.md`·`.agents/skills/<name>/SKILL.md` 폴더형 문서가 번들 skill과 병합되어 시스템 프롬프트, `/skill`, Tab 자동완성, `/speckit.*` 같은 직접 슬래시 별칭에 모두 반영됩니다(이름이 같으면 뒤쪽 문서가 우선). `aliases:`/`slash:` 헤더 또는 본문에 언급된 `/name.step` 패턴을 자동 인식합니다. SKILL.md 프런트매터 파서는 YAML 블록 스칼라(`description: >`/`|`, chomping `>-`/`|+` 포함)는 물론, 실제 스킬 파일에 흔한 비표준 `description: Use this skill when >` + 들여쓴 연속 블록 형태까지 접어서 한 줄 요약으로 만듭니다(이전에는 `Use this skill when >`라는 잘린 요약이 그대로 노출됨). `JOC_TUI_THEME=mono`는 푸터 색까지 완전한 무채색으로 출력합니다.

```bash
# REPL 안에서
/provider login gemini      # 브라우저 OAuth 로그인 → 토큰 저장 → 모델 목록 자동 갱신
/provider gemini            # ↑/↓로 실제 live model 선택 → Enter로 즉시 설정
/models caps                # 로그인된 프로바이더의 실제 모델 + capability
/model #3                   # 방금 표시된 목록에서 3번 모델 선택
/speckit.plan "OAuth 모델 표시 고장 수정"  # ~/.agents/skills/spec-kit/SKILL.md 별칭으로 skill 실행
review @src/commands/launch.ts and @src/tui/  # @ 입력 시 상대 경로 후보/폴더 경로 미리보기
```

## 인증 · 모델 빠른 안내

| Provider | API 키 | OAuth(구독) 로그인 | 현재 권장 모델 |
| --- | --- | --- | --- |
| anthropic | ✅ `ANTHROPIC_API_KEY` | ✅ Claude Pro/Max — Messages API 직접 호출 | `claude-sonnet-4-5` · `claude-opus-4-5` · `claude-haiku-4-5` (별칭 `sonnet`/`opus`/`haiku`) |
| openai | ✅ `OPENAI_API_KEY` (전체 모델) | ✅ ChatGPT/Codex — Codex Responses 백엔드 자동 라우팅 | OAuth는 Codex가 실제 서빙하는 `gpt-5.5` · `gpt-5.4`만 노출(별칭 `gpt`) |
| gemini | ✅ `GEMINI_API_KEY` (AI Studio, 무료) | ⚠️ Gemini CLI/Cloud Code Assist 토큰은 managed-project 온보딩이 필요해 joc 번들 어댑터가 아직 호출하지 않음 → **키 사용** | `gemini-2.5-flash` · `gemini-2.5-pro` (별칭 `flash`) |
| ollama | — | — (keyless 로컬, 레이트리밋 없음) | `ollama/qwen2.5:0.5b` (별칭 `fast`/`local`) |

- **키 + OAuth 둘 다 있으면 API 키가 우선**(표준 엔드포인트·전체 모델). OAuth 전용이면 위 백엔드로 동작합니다.
- 별칭/카탈로그 canonical은 호출 직전 실제 provider 모델 id로 매핑됩니다(예: `sonnet` → `claude-sonnet-4-5-20250929`).
- `model not found(404)`가 나면 모델 id가 구형일 수 있습니다 — `/models`·`/provider <name>`로 현재 모델을 확인해 `#N`으로 고르세요(라이브 목록이 권위 소스).
- 레이트리밋(HTTP 429)은 친절 안내로 정리되고, 서버가 본문에 준 재시도 지연(예: Gemini `retryDelay`/"retry in 8.6s")을 honor해 일시적 RPM 제한은 루프가 스스로 대기·복구합니다. 지속되면 `/model`로 다른 모델(로컬 ollama 등)로 전환하세요.
- 막힘은 명확히 알립니다: 모델이 유효한 tool 호출(JSON `tool` 필드)을 못 내면 "더 강한 모델로 전환(/model)" 안내로 중단합니다(약한 로컬 모델 대비).
- 연결 상태는 `joc doctor`가 **실제 호출 경로**로 점검합니다(anthropic=`GET /v1/models`, openai OAuth=Codex 백엔드 도달 확인, 크레딧 미소모).

## 자주 쓰는 명령

```bash
# 저장된 세션 보기 / 재개
joc launch --list
joc launch --resume

# tmux 세션에서 실행 (세션 이름은 작업 디렉터리별로 독립 — 같은 브랜치라도 다른 프로젝트/worktree는 별도 세션)
joc --tmux
joc --tmux --model gemini-2.5-flash --thinking high
joc --tmux --models --catalog gpt

# 별도 worktree에서 실행
joc --tmux --worktree ../joc-work

# 모델 목록 확인
joc models

# GJC 스타일 모델 카탈로그(정적 capability)
joc --list-models=gemini
joc --models --catalog gpt

# 실행 시 모델/프로바이더/사고 예산 지정
joc --model gemini-2.5-flash --thinking high "코드 분석해줘"
joc --provider gemini --plan "구현 계획 세워줘"
# 슬래시 명령어 팔레트
# REPL에서 "/" 또는 "/m"처럼 prefix를 입력하면 카테고리별 명령/옵션이 리스트업됩니다.
# subagent 설정은 /agents, /subagent, /subagents 모두 지원합니다.

# 인증 관리
joc auth login anthropic
joc auth status
```

## Spec-first 워크플로우

요구사항을 먼저 정리하고 계획, 실행, 검증까지 진행할 때 사용합니다. 단계는 상태(`.joc/state/`)로 이어지며 게이트가 있습니다: deep-interview가 **시드를 동결**(ambiguity ≤ 20%; `--auto`는 최선의 시드를 항상 동결)해야 MutationGuard가 코드 수정을 허용하고 ralplan이 진행됩니다 → ralplan은 **Planner→Architect→Critic 합의**(3단계 연쇄 패스)로 **승인 대기** 플랜을 만들고(스키마 자체검증·보정 포함) → `joc approve <plan>`로 승인해야 → team이 실행하며(손상된 team 상태는 무시하지 않고 거부, 알 수 없는 subagent role은 실행 전 거부, 동일한 task 이름도 step index 기준으로 올바른 role에 라우팅) → ultragoal이 team 실행을 검증합니다.

```bash
joc deep-interview "만들고 싶은 기능 설명"
joc ralplan
joc approve <plan-path>
joc team
joc ultragoal
```

## 로컬 모델 사용

Ollama를 사용하면 API 키 없이 로컬에서 실행할 수 있습니다.

```bash
ollama pull qwen2.5:0.5b
export JOC_DEFAULT_MODEL=ollama/qwen2.5:0.5b
joc doctor
joc
```

## 설정 파일

- 전역 설정: `~/.joc/config.json`
- 프로젝트 상태/세션: `<project>/.joc/`

주요 환경 변수:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JOC_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
```

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as `NPM_TOKEN`.
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.
