<h1 align="center">jeo-code 사용 가이드</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  인터뷰 → 검토된 계획 → 게이트된 실행 → 정직한 검증까지, Bun 기반 AI 코딩 에이전트 CLI를 실제로 쓰는 방법.
</p>

<p align="center">
  <a href="../README.md">English README</a> ·
  <a href="../README.ko.md">한국어 README</a> ·
  <a href="../CHANGELOG.md">변경 이력</a>
</p>

---

## 데모 영상

<video src="https://raw.githubusercontent.com/akillness/jeo-code/main/docs/jeo-code-promo.mp4" controls muted playsinline width="100%"></video>

> 위 플레이어가 보이지 않으면 ▶ **[데모 영상 재생/다운로드](jeo-code-promo.mp4)** 를 눌러 직접 재생하세요.
> (GitHub에서는 `<video>` 태그가 인라인 재생되고, 일부 뷰어에서는 아래 링크로 열립니다.)

---

## 1. 설치

Bun `1.3.14+` 가 필요합니다.

```bash
bun install -g jeo-code
jeo --version
```

업데이트는 `jeo update` (최신 릴리스를 직접 설치), 상태만 확인하려면 `jeo update --check`.

## 2. 빠른 시작

```bash
jeo                                       # 현재 저장소에서 대화형 에이전트
jeo "README 정리하고 테스트 돌려줘"        # 한 번에 실행(one-shot)
jeo doctor                                # 설정 + 모델 연결 점검
jeo setup                                 # API 키 / OAuth / 로컬 모델 설정
jeo --tmux                                # 격리된 tmux 세션에서 실행
```

저장소 안에서 `jeo`를 실행하면 파일을 읽고, 편집하고, 명령을 실행하며 작업을 끝까지 끌고 갑니다 — 모든 단계가 스크롤백 친화적인 인라인 TUI에 실시간으로 흐릅니다.

## 3. 키 설정 (provider / 모델)

- 입력창에서 `/provider login <anthropic|openai|gemini|antigravity>` 로 OAuth 로그인, `/logout` 로 로그아웃.
- 환경변수로도 설정 가능:

```bash
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=...
JEO_DEFAULT_MODEL=...            # 예: ollama/qwen2.5:0.5b
```

- `/model` 로 모델/Provider를 고르면 그 선택이 새 기본값으로 저장(MRU)됩니다.

## 4. 대화형 TUI 핵심 조작

| 동작 | 방법 |
| --- | --- |
| 슬래시 팔레트 | `/` 입력 → Tab 자동완성 |
| 워크플로 스킬 실행 | `$<skill> [intent]` — 예: `$team "리팩터링"`, `$ultragoal` |
| 셸 명령 직접 실행 | `!<command>` — 에이전트/히스토리 건드리지 않고 실행 |
| **이전 쿼리 불러오기** | **↑ / ↓** — 같은 워크스페이스에서 이전에 쓴 쿼리를 런치 간에도 호출 (`.jeo/input-history`에 영속) |
| **응답 펼쳐 보기** | **Ctrl+O** — 마지막 응답 전체를 펼침. 턴 중에는 스크롤 가능 패널(↑/↓·PgUp/PgDn), 입력 대기 중에는 스크롤백으로 출력 |
| 클립보드 이미지 첨부 | Ctrl+V (다음 메시지에 이미지 첨부) |
| 현재 턴 취소 | ESC |
| 종료 | `/exit` 또는 `/quit` |

> ↑로 이전 쿼리를 불러오는 기능은 새 런치에서도, `/resume` 로 세션을 복원한 뒤에도 동작합니다.

## 5. 자주 쓰는 슬래시 명령

| 명령 | 설명 |
| --- | --- |
| `/model` · `/provider` | 모델/Provider 선택, 역할별 배지 표시 |
| `/agents [role]` · `/subagent` | 역할별(executor/planner/architect/critic) 모델·thinking·step 설정 |
| `/thinking [level]` · `/fast` | 기본 추론 예산(low…xhigh) · 빠른 사고 토글 |
| `/view` · `/diff` · `/find` · `/search` | 코드 보기 · git diff · 파일/패턴 검색 |
| `/new` · `/resume` · `/sessions` | 세션 관리 (`/resume`는 화살표 피커로 복원) |
| `/history [n\|all]` · `/export` | 작업 히스토리 재출력 · 트랜스크립트 내보내기 |
| `/usage` · `/context` · `/compact` | 토큰 사용량 · 컨텍스트 분석 · 수동 압축 |
| `/theme` · `/config` · `/help` | 테마 · 런타임 설정 · 도움말 |

## 6. 세션 복원 (`/resume`)

- `/resume` 를 입력하면 히스토리가 있는 세션을 화살표 피커로 고를 수 있습니다(↑↓ 이동, Enter 복원, Esc 취소).
- 복원 시 화면을 깔끔히 다시 그린 뒤 트랜스크립트를 재생하므로 이전 화면과 겹쳐 깨지지 않습니다.
- 복원된 트랜스크립트의 툴 호출은 원시 JSON이 아니라 `✔ 제목` 카드로 렌더됩니다.
- 복원 후 **↑** 를 누르면 그 세션에서 이전에 사용한 쿼리를 그대로 다시 불러올 수 있습니다.

## 7. 스펙 우선 워크플로 (게이트가 있는 자동화)

요구사항 → 계획 → 승인 → 실행 → 검증을 `.jeo/state/` 로 이어가며, 각 단계마다 **실제로 막는 게이트**가 있습니다.

```bash
jeo deep-interview "무엇을 만들지 설명"   # 모호성 점수가 충분히 낮을 때만 시드 동결
jeo ralplan                              # 저장소 기반 critic 게이트 ([OKAY]/[ITERATE]/[REJECT])
jeo approve <plan-path>                   # team이 실행할 계약 검증 + [OKAY] 합의 필요
jeo team                                  # 락 + 태스크별 서브에이전트 계약으로 직렬 실행
jeo ultragoal                             # 정직한 검증(스위트는 전역 신호로 1회 실행)
```

스킬은 TUI 안에서 `$deep-interview`, `$ralplan`, `$team`, `$ultragoal` 처럼 `$`로도 호출할 수 있습니다.

## 8. 자기 교정 검증 훅

편집 후 검사(타입체크/린트/테스트)를 걸어두면 에이전트가 진단을 *직접 보고* 루프 안에서 고칩니다. 빨간 훅은 `done` 을 막습니다.

```jsonc
// .jeo/hooks.json
{
  "enabled": true,
  "hooks": [
    { "event": "post-turn", "match": { "tool": "edit|write" }, "run": "bun x tsc --noEmit" }
  ]
}
```

전역으로 한 번 켜기: `~/.jeo/config.json` 에 `"hooks": { "enabled": true }`.

## 9. 로컬 모델 (Ollama)

```bash
ollama pull qwen2.5:0.5b
export JEO_DEFAULT_MODEL=ollama/qwen2.5:0.5b
jeo doctor && jeo
```

## 10. 설정 한눈에

- 전역 설정: `~/.jeo/config.json` (모델 선택은 MRU로 저장)
- 프로젝트 상태/세션: `<project>/.jeo/`

```bash
JEO_TUI_THEME=cosmic            # cosmic/matrix/solar/red-claw/blue-crab/mono/aurora/synthwave/sakura/gruvbox-dark
JEO_STEP_BASE=24                # 동적 step 예산 기준
JEO_STEP_HARD_CAP=600           # 절대 종료 보장
JEO_TOOL_OUTPUT_MAX=4000        # 모델에 보이는 툴 출력 상한(전체는 아티팩트로)
```


## 11. 원격 모니터링 (Telegram & Discord & Slack)

백그라운드 데몬이 subagent 상태 변화(시작 → 완료/실패/취소)를 Telegram, Discord, 또는 Slack으로 전송합니다.

```bash
# 설정 (한 번만)
jeo notify setup [--provider telegram|discord|slack] [--token-env 환경변수명] [--app-token-env 환경변수명] [--chat-id <ID>] [--channel-id <ID>] [--allowed-user-ids <ID1,ID2,...>]

# 상태 확인 (읽기 전용)
jeo notify status [--provider telegram|discord|slack]              # 로컬 설정 및 데몬 상태만
jeo notify health [--provider telegram|discord|slack]              # 봇 identity & destination 접근 성공 여부 (read-only, Gateway/poll/send 권한 미테스트)
jeo notify test [--provider telegram|discord|slack]               # 명시적 테스트 메시지 전송

# 데몬 관리
jeo daemon start                # 시작 (이미 실행 중이면 성공; 초기화 중 owner는 nonzero 반환)
jeo daemon stop                 # 중지 (pending acknowledgement 타이머 정리 및 미응답 명령 처리; 이미 실행된 명령은 되돌릴 수 없음)
jeo daemon status               # 상태 확인 (platform connectivity not checked)
jeo daemon reload               # 설정 다시 읽기
```

**Initial Connection Boundary:**
- `jeo notify status`: 로컬 설정만 읽기; provider 접근 테스트 없음
- `jeo daemon start` → `initialized`: 프로세스 시작 및 transport 초기화만; Gateway/poll/send 권한 미테스트
- `jeo notify health`: 봇 identity & destination 존재 확인 (read-only REST calls); Gateway reconnect 또는 polling poll connectivity, send 권한 미포함
- `jeo notify test`: 명시적 메시지 송신 (outbound 권한 증명)
- Manual `/help` + `/subagents` + `/steer`: 완전한 양방향 roundtrip (daemon inbound receive + session acknowledgment)

**Telegram 설정:**
- `jeo notify setup --provider telegram` 을 실행하면 challenge가 나타남
- 그 문자를 봇에 정확히 보내면 120초 내에 자동 페어링됨
- 또는 `--chat-id <ID>` 로 직접 지정
- 그룹은 `--allowed-user-ids <ID1,ID2,...>` 로 허용할 Telegram 사용자 ID 명시 필요
- **Destination-scoped 권한화**: 같은 bot + chat 조합은 설정 보존 (token rotation 포함); 다른 bot/chat은 allowlist 초기화
- **Topic cache 스코핑**: bot ID + chat ID 단위로 topic 설정 보존; 레거시 미스코핑은 재생성

**Discord 설정:**
- `jeo notify setup --provider discord --channel-id <채널ID> --allowed-user-ids <ID1,ID2,...>`
- 봇에 `Message Content` intent와 채널 권한(View Channel, Send Messages, Send Messages in Threads) 필요
- **명령어는 literal 텍스트** (native Discord slash 명령 등록 안 함): `/help`, `/sessions`, `/subagents`, `/send`, `/steer`, `/cancel`
- **In-memory 응답 매핑만** (daemon reload 시 리셋); per-session thread 자동 생성 없음; optional existing thread as destination
- **Allowlist-scoped**: 권한 있는 user ID만; `/steer`와 `/cancel`은 세션의 typed control 직접 실행, 별도 승인 없음

**Slack 설정:**
- `jeo notify setup --provider slack --token-env SLACK_BOT_TOKEN --app-token-env SLACK_APP_TOKEN --channel-id <채널ID> --allowed-user-ids <ID1,ID2,...>`
- xoxb (봇) + xapp (앱) 토큰, Socket Mode 활성화 필수
- 봇에 `chat:write`, `users:read` 스코프와 message/app_mention 이벤트 구독 필요
- **명령어는 literal 텍스트**: `/help`, `/sessions`, `/subagents`, `/send`, `/steer`, `/cancel` (native Slack slash 명령 등록 안 함)
- **Thread reply mapping**: 설정된 채널에서의 reply는 해당 세션으로 라우팅; thread 자동 생성 없음
- **Allowlist-scoped**: 권한 있는 user ID만; `/steer`와 `/cancel`은 세션의 typed control 직접 실행, 별도 승인 없음
- **Credential & destination reset**: **Telegram**: bot ID + chat ID pairing determines settings persistence; same numeric bot ID + chat ID preserves topic/allowlist (including token rotation). Changing bot ID or chat ID clears inherited owners, topic routing, session topics — groups require explicit `--allowed-user-ids` for new destination. **Discord**: same exact token + channel retains current allowlist; ANY token change (including rotation of same bot) or channel change requires explicit `--allowed-user-ids`. **Slack**: same exact tokens (bot + app) + channel retains current allowlist; ANY token change (including rotation) or channel change requires explicit `--allowed-user-ids`.
자격증명은 `~/.jeo/config.json` 의 `notifications.telegram.botToken` / `notifications.discord.botToken` / `notifications.slack.botToken` + `notifications.slack.appToken` 에 평문으로 저장됩니다 (private storage only). 토큰은 공식 API 인증용으로만 해당 서비스에 전송되며, 채팅 출력이나 로그에는 포함되지 않습니다.

**필수 권한 및 스코프:**
- **Telegram**: 봇 계정
- **Discord**: 봇 `Message Content` intent, `View Channel`/`Send Messages`/`Send Messages in Threads` 채널 권한
- **Slack**: 봇 토큰 스코프 `chat:write`, `users:read` + 채널 읽기/이력 권한; 앱 토큰 스코프 `connections:write` (Socket Mode)


## 12. 기타 문제 해결

- 연결/설정 점검: `jeo doctor`
- 화면이 이상할 때: `/clear` 로 화면+스크롤백 초기화 후 다시 시작
- 안전한 라이브 점검: `bun run verify:tmux smoke` (격리 tmux 부팅 + 렌더 확인)

---

더 자세한 내용은 [README](../README.md) 와 [CHANGELOG](../CHANGELOG.md) 를 참고하세요.
