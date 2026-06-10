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

jeo-code () is an external coding-agent harness, a pure-TypeScript re-implementation of the [gajae-code](https://github.com/Yeachan-Heo/gajae-code) () spec-first workflow contract that runs on Bun with **zero native dependencies**. It follows a rigorous **deep-interview → ralplan → team → ultragoal** workflow so requirements are clarified and plans are critiqued before any code is mutated.



It is designed to be an external orchestrator that works beside your existing tools (Codex CLI, Claude Code, Gemini CLI), providing structured planning, persistent evidence under , and isolated worktree support.

## Install

요구사항: [Bun](https://bun.sh)  (Node.js 불필요 — Bun 전용 런타임)



### Bun global install (권장)



 바이너리가 에 노출됩니다(호환용 심링크  포함).

### 설치 스크립트



### 설치 확인 · 업데이트 · 제거



## Quick start



Inside a **joc** session, use the public workflow surface:



Add  only when coordinated tmux workers materially help.

## Core capabilities

- **Interview before guessing**:  turns vague requests into concrete requirements (ambiguity gate ≤ 20% before the MutationGuard unlocks code edits).
- **Plan before mutation**:  builds a Planner→Architect→Critic consensus plan that waits for .
- **Execute with evidence**:  tracks goals, revisions, checks, and completion evidence under .
- **Parallelize when useful**:  coordinates executor/planner/architect/critic subagents;  gives every run its own session.
- **Live visibility**: HUD phase row (), // rows with live token usage, step timeline with done-strikethrough, and an end-of-turn  phase report.
- **Skills**: bundled workflow skills + user skills from , , project dirs — invoked via , slash aliases, or  (Codex/gjc style).

## Workflow surface

jeo-code ships four default workflow skills:

| Skill            | What it does                                                           |
| ---------------- | ---------------------------------------------------------------------- |
|  | Clarifies ambiguous requirements before planning or code changes.      |
|         | Builds and critiques an implementation plan before mutation.           |
|       | Tracks goals through execution, revision, verification, and evidence.  |
|            | Coordinates subagent workers for parallel execution.                   |

And four bundled role agents:

| Agent       | What it does                                       |
| ----------- | -------------------------------------------------- |
|   | Bounded implementation, fixes, and refactors.      |
|  | Read-only architecture and code-review assessment. |
|    | Read-only sequencing and acceptance criteria.      |
|     | Read-only plan critique and actionability review.  |



## Providers & models

| Provider | API key | OAuth (subscription) | 권장 모델 |
| --- | --- | --- | --- |
| anthropic |  | Claude Pro/Max — Messages API 직접 호출 |  /  /  |
| openai |  (전체 모델) | ChatGPT/Codex — Codex Responses 백엔드 자동 라우팅 |  (별칭 ) |
| gemini |  (선택) | Gemini CLI OAuth — Cloud Code Assist 백엔드 + project 자동 발견 |  (별칭 ) |
| antigravity | — | 전용 Antigravity OAuth —  모델 (Gemini 3, Claude 등), 모델 목록은 라이브  |  |
| ollama | — (keyless local) | — |  (별칭 ) |



키 + OAuth가 둘 다 있으면 API 키가 우선합니다. 레이트리밋(429)은 서버 지연( 등)을 honor해 자동 재시도하고, usage/quota 한도 소진은 재시도 없이 즉시 모델 전환 안내로 끝납니다.

## Local models

Ollama를 사용하면 API 키 없이 로컬에서 실행할 수 있습니다.



## Configuration

Provider settings and retry budgets live in  (override dir with ); per-project state lives in  (, , , ).



주요 환경 변수:



## Core Engine & Hierarchy

jeo-code maintains a clear hierarchy between the **Core Engine (joc)** and the **Global Jeo-Code (gjc)** orchestrator:

- **joc (Core Engine)**: The minimal tool-use loop and agent runner. Refactored for modularity and visibility.
- **gjc (Guide/Global)**: The higher-level hierarchy for system-wide orchestration, session management, and multi-agent coordination.

## Development

Install dependencies and run from source:



Gates (no linter/formatter — these two are the bar):



To compile a standalone binary:



## Documentation

See hierarchical  files in each directory for detailed component documentation.

- [Core Engine](src/agent/AGENTS.md)
- [AI Providers](src/ai/AGENTS.md)
- [CLI Runner](src/cli/AGENTS.md)

## Publishing

Required npm token permissions:

- Use an npm **Granular Access Token** stored as .
- Token type: **Automation** so CI can publish with provenance.
- npm account/package settings must allow publish automation to **bypass 2FA** for the workflow.

---
*V2 Evolution Update: 2026-06-11 (Level 3 Evolution In Progress)*

## Monitoring HUD
 now features a Sovereign Monitoring HUD for real-time visibility:
- **Phase Tracking**: Thinking → Planning → Executing → Reporting → Done
- **Evolution Stages**: Primordial Cell to Singularity (based on tool usage)
- **Self-Analysis**: Automated detection of monolithic files and performance bottlenecks
- **Evolution Logs**: Detailed logs now stored in  for enhanced visibility.

Run  or use the  module in your TUI integrations.
