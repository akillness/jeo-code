# Spec — Inherit loop-engineering performance into JEO autopilot/status

> Document SSOT (spec-kit layer). The execution SSOT is the frozen seed at
> `.jeo/seeds/seed-autopilot-performance.yaml`. Direction is one-way:
> this spec → seed. If requirements change, edit this file first, then re-freeze.

## Constitution (non-negotiable principles)

1. **계승은 측정 가능한 병목에만 적용한다.** `docs/loop-engineering-report.md`의 철학은 코어 비대화가 아니라 반복 루프의 실제 비용을 줄이는 작은 변경으로 계승한다.
2. **Autopilot의 frozen/evaluate 계약은 보존한다.** 점수 산정, keep/revert, convergence 의미는 바뀌면 안 된다.
3. **성능 개선은 검증 가능한 표면을 가져야 한다.** 단순한 리팩터링이 아니라 테스트 가능한 함수/경로로 드러나야 하며 Bun 검증을 통과해야 한다.

## Background

`docs/loop-engineering-report.md`는 JEO가 pi-mono/nullclaw/zeroclaw/hermes/gjc 철학을 계승해 경량 루프, 로컬 상태, 검증 가드, 컨텍스트 효율을 얻었다고 정리한다. 이 중 현재 코드에 이미 적용된 항목은 다음과 같다.

| 제안 | 현재 적용 가능성 | 근거 |
|------|------------------|------|
| LSP-lite | 별도 설계 필요 | 편집 도구와 TypeScript 구문 사전 검증의 범위가 커서 이번 autopilot 성능 개선의 1차 후보에서 제외한다. |
| 3-way merge recovery | 별도 설계 필요 | `edit` 실패 복구와 hashline 앵커 정책을 바꾸므로 독립 seed가 필요하다. |
| Disjoint-file concurrency | 이미 engine에 상당 부분 적용 | `src/agent/engine.ts`는 read 그룹과 distinct-file write/edit 그룹을 `Promise.all`로 실행하고 post-turn hook을 batch 단위로 실행한다. |
| SQLite FTS5 memory | 별도 설계 필요 | 메모리 저장소/마이그레이션 범위가 커서 이번 seed에서 제외한다. |
| Detached subagents | 이미 runtime 도구가 존재하나 별도 UX/queue spec 필요 | 현재 task/subagent 경로와 겹치므로 별도 seed가 안전하다. |

따라서 이번 spec-stack 실행은 이미 사용자 intent에 포함된 `$autopilot jeo 성능개선`에 맞춰, autopilot/status의 append-only log 재스캔 비용을 줄이는 작은 hot-path 개선을 대상으로 한다.

## Scope

| In scope | Out of scope |
|----------|--------------|
| `src/autopilot.ts`의 log best-score fold 재사용 | edit tool 3-way merge 알고리즘 |
| `cmdStatus`가 이미 읽은 log를 재사용하도록 개선 | SQLite/FTS5 memory migration |
| Pure unit tests for fold semantics | Provider/API latency tuning |
| Spec/seed/evidence artifacts under `docs/spec-stack/` and `.jeo/seeds/` | Existing unrelated worktree changes |

## Requirements & machine-checkable acceptance criteria

### R1 — status avoids a second log read/reparse

- **R1.1** `src/autopilot.ts` exports `bestScoreFromLog(goal, log)`, a pure single-pass reducer for baseline + kept-step score folding.
- **R1.2** `cmdStatus` calls `readLog()` once and derives `best` from that in-memory log via `bestScoreFromLog(s.goal, log)`, not a second `currentBest(s)` file scan.

### R2 — ratchet semantics remain identical

- **R2.1** `bestScoreFromLog` ignores reverted steps and NaN scores.
- **R2.2** `min` returns the running minimum, `max` returns the running maximum, and `gate` tracks the last kept measurable score.
- **R2.3** Existing `foldBest`, `decideStep`, and convergence tests continue to pass.

### R3 — repository health remains green for the touched surface

- **R3.1** `bun test test/autopilot-engine.test.ts` exits 0.
- **R3.2** `bun run typecheck` exits 0.
- **R3.3** Because this touches exported TypeScript and a central CLI module, `bun test test/smoke.test.ts` exits 0.

## Tool constraints (the "hands")

- Harness is the native Bun toolchain: `bun test` and `bun run typecheck`.
- No external CLI-Hub backend is required for this code-only target.
- Existing user worktree changes must not be reverted or reformatted.

## Definition of done

All R1–R3 checks pass and observed evidence is recorded in `docs/spec-stack/autopilot-performance-verification.md`.
