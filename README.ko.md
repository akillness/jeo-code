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
  <img src="assets/character.png" alt="jeo-code 캐릭터 마스코트" width="320" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <b>한국어</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh.md">中文</a>
</p>

저장소 안에서 `jeo`를 실행하면 파일을 읽고, 수정하고, 명령을 실행하며 작업을 완료까지 끌고 갑니다 — 모든 스텝이 스크롤백 친화적인 인라인 TUI로 실시간 스트리밍됩니다.

## 하이라이트

- **멀티 프로바이더, 단일 루프** — Anthropic / OpenAI(+Codex) / Gemini / Antigravity / Ollama를 균일한 JSON 도구 루프로. 입력창에서 바로 OAuth 로그인(`/provider login`), 모델 선택은 즉시 기본값으로 영속.
- **편집 무결성** — read 출력에 콘텐츠 앵커(`42ab|`)가 붙고, 앵커 편집은 현재 파일과 대조 검증·줄 이동 시 자동 재매핑·불일치 시 최신 내용과 함께 거부 — 파일을 오염시키지 않습니다.
- **자기수정 검증 루프** — post-edit 훅(tsc / eslint / 테스트)을 설정하면 에이전트가 진단을 *직접 읽고* 루프 안에서 수정합니다. 훅이 빨간 상태면 `done`이 차단됩니다.
- **연극 없는 진짜 게이트** — `ralplan` 합의는 실제 저장소를 읽는 critic 서브에이전트이며 `[OKAY]` 평결이 영속되고 `jeo approve`가 이를 *요구*합니다. `ultragoal`은 정직하게 보고합니다(스위트 1회 실행은 전역 신호일 뿐, 기준별 통과를 조작하지 않음).
- **크래시 내구·로컬 우선** — 모든 상태는 `.jeo/` 아래 원자적 쓰기, 크로스 프로세스 런 락, 실패 태스크 마커 + 재개 시 부분 편집 경고.
- **동적 스텝 버짓** — 최근 도구 호출이 새로운 진전을 보이는 동안 연장되고, 정체되면 정리 요약으로 수렴. 서브에이전트는 정확한 스텝 계약 유지.
- **인라인 TUI** — 완료된 작업은 실제 스크롤백으로 흘러가고(턴 중에도 tmux 휠 스크롤 가능), 상태 줄은 실제 진행 대상을 표시. 테마, 클립보드 이미지 붙여넣기(Ctrl+V), CJK/이모지 안전 폭 계산.

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
| `/model` · `/models` · `/provider` | 모델/프로바이더 선택(3단계: 모델 → 적용 대상 → 추론 레벨), 선택 즉시 영속 |
| `/provider login <name>` · `/logout` | 입력창에서 OAuth 로그인/로그아웃 |
| `/agents [role]` · `/subagent` | 역할별(executor/planner/architect/critic) 모델·thinking·스텝 구성 |
| `/thinking [level]` | 추론 예산(minimal…xhigh) |
| `/skill` · `$<skill> [intent]` | 워크플로 스킬 목록/실행(`$team "작업"` 스타일) |
| `/view` · `/diff` · `/find` · `/search` | 코드 보기, git diff, 파일/패턴 검색 |
| `/new` · `/resume` · `/sessions` · `/export` | 세션 관리·트랜스크립트 내보내기 |
| `/retry` · `/btw <질문>` | 마지막 요청 재시도 · 히스토리에 안 남는 사이드 질문 |
| `/usage` · `/context` · `/compact` | 토큰 사용량, 컨텍스트 내역, 수동 컴팩션 |
| `/theme` · `/config` · `/help` | 테마, 런타임 설정, 도움말 |

## Spec-first 워크플로

요구사항 → 플랜 → 승인 → 실행 → 검증이 `.jeo/state/`로 이어지며, 모든 핸드오프에 **차단 가능한 진짜 게이트**가 있습니다:

```bash
jeo deep-interview "만들고 싶은 것을 설명"
jeo ralplan
jeo approve <플랜경로>
jeo team
jeo ultragoal
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
JEO_TUI_THEME=cosmic            # cosmic/matrix/solar/red-claw/blue-crab/mono/aurora/synthwave/sakura
JEO_TUI_ALT_SCREEN=1            # 레거시 alt-screen 턴(기본: 인라인 스크롤백)
JEO_STEP_BASE=24                # 동적 스텝 버짓의 롤링 베이스
JEO_STEP_HARD_CAP=600           # 절대 종료 보증
JEO_STREAM_MAX_MS=300000        # 옵트인 전체 스트림 데드라인(기본 off; 슬로우드립 차단)
JEO_TOOL_OUTPUT_MAX=4000        # 모델 가시 도구 출력 캡(전체는 아티팩트로 스필)
```

재시도 동작은 `~/.jeo/config.json`의 `retry`로 조정합니다(`requestMaxRetries`, `streamMaxRetries`, `rateLimitRetries`, `failFastStatuses`, …). 스텝 버짓은 기본 동적 — 새로운 진전이 보이는 동안 연장되고 정체 시 요약으로 수렴하며, `--max-steps N`이면 유한 플로로 복귀합니다. 레거시 `JEO_*` 환경변수도 계속 지원됩니다.

## 배포 (Publishing)

CI는 `.github/workflows/npm-publish.yml`로 배포합니다 — GitHub 릴리즈 게시 시 자동, 또는 `workflow_dispatch` 수동 실행(드라이런 옵션). 워크플로는 타입체크·테스트·토큰 검증(`npm whoami`) 후 `npm publish --provenance`를 실행합니다.

필요한 npm 토큰 권한(저장소 시크릿 `NPM_TOKEN`):

- `jeo-code` 패키지에 Read/Write 권한이 있는 **Granular Access Token**, 또는 클래식 **Automation** 토큰
- "배포 시 **bypass 2FA**" 허용 필수 — Automation 토큰은 항상 우회, granular 토큰은 옵션 활성화 필요
