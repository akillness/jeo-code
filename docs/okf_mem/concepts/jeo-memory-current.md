---
type: Reference
title: jeo 현행 메모리 시스템
description: 지금의 .jeo/memory/MEMORY.md distill/inject 파이프라인의 실제 구현 지점과 제약.
resource: src/agent/memory.ts
tags: [jeo, memory, distill, baseline]
timestamp: 2026-06-17T00:00:00Z
---

# 개요

jeo는 hermes 스타일 "경험→증류" 학습 루프의 경량판을 구현한다
(`plan/gjc-inheritance.md` B6 참조). 세션 종료 시 전사(transcript)에서 durable
학습만 단일 문서 `.jeo/memory/MEMORY.md`로 증류하고, 다음 세션 시작 시 그 문서를
시스템 프롬프트에 다시 주입한다. 로컬 우선, 원격 백엔드 없음, `JEO_NO_MEMORY=1`로
비활성화.

# Schema (현행 구현 지점)

소스: [`src/agent/memory.ts`](../../../src/agent/memory.ts)

| 심볼 | 역할 |
|------|------|
| `MEMORY_MAX_CHARS = 6000` | 디스크 문서 상한(증류 프롬프트가 이 한도 준수 지시) |
| `MEMORY_INJECT_MAX_CHARS = 3000` | 세션당 프롬프트 주입 예산 |
| `TRANSCRIPT_MAX_CHARS = 12000` | 증류 호출에 먹이는 전사 슬라이스 |
| `MIN_HISTORY_MESSAGES = 4` | 이보다 짧은 세션은 학습할 게 없음 |
| `memoryFilePath(cwd)` | `<cwd>/.jeo/memory/MEMORY.md` 경로 |
| `loadMemory(cwd)` | 문서 읽기(없으면 "") |
| `memoryPromptSection(cwd)` | `<project_memory>` 블록 생성. 주입 한도 초과 시 절단, 펜스 태그 중화(injection-hardening) |
| `distillSessionMemory(history, cwd)` | 단일 LLM 호출로 기존 문서와 merge, atomic write(`.tmp` → rename) |
| `spawnDetachedDistill(...)` | exit 차단 방지용 detached 자식 프로세스로 증류 위임 |
| `runMemoryDistillCommand(args)` | detached 자식의 워커: payload JSON → distill → cleanup |
| `distillInvocation(...)` | 자식 self-invocation argv 빌더 |

증류 프롬프트는 학습을 **4개 헤딩**으로 강제한다: repo facts, commands that
work, gotchas (failures+fixes), user preferences. 세션 고유 잡음은 버린다.

# 와이어링 (호출 지점)

- `src/commands/launch.ts:397` — `memoryBlock = await memoryPromptSection(cwd)`
- `src/commands/launch.ts:419` — 시스템 프롬프트 끝에
  `(memoryBlock ? "\n\n" + memoryBlock : "")`로 첨부
- `src/commands/launch.ts:3817` — 세션 종료 시 `spawnDetachedDistill(history, cwd, sessionModel || defaultModel)`
- `src/cli/runner.ts:140` — `memory-distill <payload.json>` 서브커맨드 등록
- `test/memory.test.ts` — distill/inject/atomic-write/disable 단위 테스트

# 현행 한계 (OKF 전환 동기)

- **단일 파일 병목**: 모든 지식이 하나의 `MEMORY.md`에 merge → 6KB 상한에서
  오래된 사실이 밀려나고, 부분 참조/필터링이 불가능.
- **구조 없는 라우팅**: 4개 헤딩의 평문 불릿일 뿐, `type`별 라우팅·우선순위·
  주제별 검색이 불가.
- **상호 참조 없음**: 사실 간 관계(이 명령은 이 파일에 영향 등)를 표현 못 함.
- **점진적 공개 없음**: 주입 시 always 전체(또는 절단). 관련 개념만 골라
  주입하는 게 불가능.
- **그래프 부재**: graphify 같은 그래프 레이어와 연동할 구조적 표면이 없음.

# 보존해야 할 강점 (전환 후에도 유지)

- 로컬 우선, 원격 백엔드 없음, `JEO_NO_MEMORY=1` 비활성화.
- atomic write(`.tmp` → rename)로 크래시 시 문서 손상 없음.
- detached 증류로 `/exit`·^C가 즉시 끝남(사용자 시계 밖에서 학습).
- injection-hardening: 증류 내용은 DATA로 프레이밍, 펜스 태그 중화.

# 관련 개념

- [목표 아키텍처](/concepts/target-architecture.md)
- [OKF 명세 다이제스트](/concepts/okf-spec-digest.md)
