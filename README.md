<p align="center">
  <img src="assets/hero.png" alt="jeo-code autonomous coding-agent hero illustration" width="100%" />
</p>

<h1 align="center">jeo-code</h1>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br />
  A focused coding-agent runner for interviews, reviewed plans, tmux-native execution, and durable verification.
</p>

<p align="center">
  <a href="https://github.com/akillness/jeo-code"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f9f1e1?style=flat-square&logo=bun&logoColor=black">
  <img alt="zero native deps" src="https://img.shields.io/badge/native%20deps-0-blue?style=flat-square">
</p>

<p align="center">
  <img src="assets/character.png" alt="jeo-code character mascot" width="320" />
</p>

> [!IMPORTANT]
> jeo-code is currently in V2 (Level 2) evolution. Expect active development and verify outputs before relying on it for critical production work.

## What is jeo-code?

jeo-code (`joc`) is an external coding-agent harness, a pure-TypeScript re-implementation of the [gajae-code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`) spec-first workflow contract that runs on Bun with **zero native dependencies**. It follows a rigorous **deep-interview → ralplan → team → ultragoal** workflow so requirements are clarified and plans are critiqued before any code is mutated.

```text
deep-interview -> ralplan -> (approve) -> team -> ultragoal
                                     └─ tmux-backed parallel execution when it helps
```

It is designed to be an external orchestrator that works beside your existing tools (Codex CLI, Claude Code, Gemini CLI), providing structured planning, persistent evidence under `.joc/`, and isolated worktree support.

## Install

요구사항: [Bun](https://bun.sh) `1.3.14+` (Node.js 불필요 — Bun 전용 런타임)

```bash
# Bun이 없다면 먼저 설치
curl -fsSL https://bun.sh/install | bash
```

### Bun global install (권장)

```bash
# npm 레지스트리에서
bun install -g jeo-code

# GitHub에서 바로
bun install -g github:akillness/jeo-code

# 명시적 Git URL / 태그 고정
bun install -g git+https://github.com/akillness/jeo-code.git
```

`joc` 바이너리가 `~/.bun/bin/joc`에 노출됩니다(호환용 심링크 `~/.local/bin/joc` 포함).

### 설치 스크립트

```bash
# 레지스트리 일회성 지정 (npm config 변경 없음)
sh scripts/install.sh --registry https://registry.npmjs.org/

# 특정 태그의 글로벌 설치 (--binary 로 컴파일 바이너리 설치)
sh scripts/install.sh --ref v0.1.0

# 클론에서 개발 설치 (= scripts/install.sh --local, bun link)
git clone https://github.com/akillness/jeo-code.git && cd jeo-code
./install.sh
```

### 설치 확인 · 업데이트 · 제거

```bash
joc --version     # 설치 확인
joc doctor        # 프로바이더 연결 상태 점검 (실제 호출 경로로 검사, --json/--strict 지원)
joc update        # 신규 릴리스 확인 (--install 로 즉시 업그레이드)
sh scripts/uninstall.sh --purge   # 바이너리 + ~/.joc/ 제거
```

## Quick start

```bash
# 대화형 코딩 에이전트 (라이브 TUI)
joc

# 한 번의 요청을 바로 실행
joc "README를 정리하고 테스트를 실행해줘"

# tmux-backed 독립 세션 / 격리된 worktree에서 실행
joc --tmux
joc --tmux --worktree ../my-task-worktree

# API 키 / OAuth / 로컬 모델 설정
joc setup
```

Inside a **joc** session, use the public workflow surface:

```text
/skill deep-interview 모호한 요구사항 명확화
/skill ralplan 구현 계획 수립·비평
$team "3개 레인으로 나눠 실행"        # $스킬명 직접 호출 (Tab 자동완성)
/speckit.plan "..."                   # 사용자 SKILL.md 의 슬래시 별칭 호출
```

Add `joc team` only when coordinated tmux workers materially help.

## Core capabilities

- **Interview before guessing**: `deep-interview` turns vague requests into concrete requirements (ambiguity gate ≤ 20% before the MutationGuard unlocks code edits).
- **Plan before mutation**: `ralplan` builds a Planner→Architect→Critic consensus plan that waits for `joc approve`.
- **Execute with evidence**: `ultragoal` tracks goals, revisions, checks, and completion evidence under `.joc/state/`.
- **Parallelize when useful**: `team` coordinates executor/planner/architect/critic subagents; `--tmux` gives every run its own session.
- **Live visibility**: HUD phase row (`thinking → planning → executing → reporting → done`), `[STEP]`/`[STATUS]`/`[TOOL]` rows with live token usage, step timeline with done-strikethrough, and an end-of-turn `[DONE]` phase report.
- **Skills**: bundled workflow skills + user skills from `~/.joc/skills`, `~/.agents/skills`, project dirs — invoked via `/skill`, slash aliases, or `$<skill>` (Codex/gjc style).

## Workflow surface

jeo-code ships four default workflow skills:

| Skill            | What it does                                                           |
| ---------------- | ---------------------------------------------------------------------- |
| `deep-interview` | Clarifies ambiguous requirements before planning or code changes.      |
| `ralplan`        | Builds and critiques an implementation plan before mutation.           |
| `ultragoal`      | Tracks goals through execution, revision, verification, and evidence.  |
| `team`           | Coordinates subagent workers for parallel execution.                   |

And four bundled role agents:

| Agent       | What it does                                       |
| ----------- | -------------------------------------------------- |
| `executor`  | Bounded implementation, fixes, and refactors.      |
| `architect` | Read-only architecture and code-review assessment. |
| `planner`   | Read-only sequencing and acceptance criteria.      |
| `critic`    | Read-only plan critique and actionability review.  |

```bash
joc deep-interview "만들고 싶은 기능 설명"
joc ralplan
joc approve <plan-path>
joc team
joc ultragoal
```

## Providers & models

| Provider | API key | OAuth (subscription) | 권장 모델 |
| --- | --- | --- | --- |
| anthropic | `ANTHROPIC_API_KEY` | Claude Pro/Max — Messages API 직접 호출 | `sonnet` / `opus` / `haiku` |
| openai | `OPENAI_API_KEY` (전체 모델) | ChatGPT/Codex — Codex Responses 백엔드 자동 라우팅 | `gpt-5.5` (별칭 `gpt`) |
| gemini | `GEMINI_API_KEY` (선택) | Gemini CLI OAuth — Cloud Code Assist 백엔드 + project 자동 발견 | `gemini-2.5-flash` (별칭 `flash`) |
| antigravity | — | 전용 Antigravity OAuth — `antigravity/*` 모델 (Gemini 3, Claude 등), 모델 목록은 라이브 `fetchAvailableModels` | `antigravity/gemini-3-flash` |
| ollama | — (keyless local) | — | `ollama/qwen2.5:0.5b` (별칭 `fast`) |

```bash
joc auth login anthropic     # 브라우저 PKCE OAuth
joc auth login antigravity   # Antigravity desktop-app OAuth client
joc auth import gemini       # ~/.gemini/oauth_creds.json (gemini-cli) 재사용
joc models                   # 별칭 + 라이브 모델 목록 (로그인된 프로바이더)
```

키 + OAuth가 둘 다 있으면 API 키가 우선합니다. 레이트리밋(429)은 서버 지연(`Retry-After` 등)을 honor해 자동 재시도하고, usage/quota 한도 소진은 재시도 없이 즉시 모델 전환 안내로 끝납니다.

## Local models

Ollama를 사용하면 API 키 없이 로컬에서 실행할 수 있습니다.

```bash
ollama pull qwen2.5:0.5b
export JOC_DEFAULT_MODEL=ollama/qwen2.5:0.5b
joc doctor
joc
```

## Configuration

Provider settings and retry budgets live in `~/.joc/config.json` (override dir with `JOC_CONFIG_DIR`); per-project state lives in `<project>/.joc/` (`seeds/`, `plans/`, `state/`, `sessions/`).

```json
{
  "defaultModel": "claude-sonnet-4-5",
  "retry": { "requestMaxRetries": 4, "maxDelayMs": 300000 }
}
```

주요 환경 변수:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JOC_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
```

## Core Engine & Hierarchy

jeo-code maintains a clear hierarchy between the **Core Engine (joc)** and the **Global Jeo-Code (gjc)** orchestrator:

- **joc (Core Engine)**: The minimal tool-use loop and agent runner. Refactored for modularity and visibility.
- **gjc (Guide/Global)**: The higher-level hierarchy for system-wide orchestration, session management, and multi-agent coordination.

## Development

Install dependencies and run from source:

```bash
bun install
bun run start --help        # = bun src/cli.ts --help
```

Gates (no linter/formatter — these two are the bar):

```bash
bun run typecheck           # tsc --noEmit → 0
bun test                    # full bun:test suite → all green
```

To compile a standalone binary:

```bash
bun run build               # bun build src/cli.ts --compile --outfile dist/joc
```

## Documentation

See hierarchical `AGENTS.md` files in each directory for detailed component documentation.

- [Core Engine](src/agent/AGENTS.md)
- [AI Providers](src/ai/AGENTS.md)
- [CLI Runner](src/cli/AGENTS.md)

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as `NPM_TOKEN`.
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.

---
*V2 Evolution Update: 2026-06-11 (Level 3 Evolution In Progress)*

## Monitoring HUD
 now features a Sovereign Monitoring HUD for real-time visibility:
- **Phase Tracking**: Thinking → Planning → Executing → Reporting → Done
- **Evolution Stages**: Primordial Cell to Singularity (based on tool usage)
- **Self-Analysis**: Automated detection of monolithic files and performance bottlenecks

Run  (future) or use the  module in your TUI integrations.
