# 03 — jeo-code 방향성 / 차별화 / 로드맵

본 문서는 분석(01, 02)을 근거로 `jeo-code`의 포지션을 정의한다.
아직 **계획 단계**다(제품 코드 없음). 실행은 별도 승인 후.

## 1. 출발점: jeo 라인이란

`ooo`(Ouroboros) 스킬의 라우팅에서 `jeo`는 다음으로 정의된다:

> "통합 프로젝트 원장(ledger) + 계획 리뷰 + 정리(cleanup) 워크플로가 필요할 때 → `jeo`"

즉 jeo의 정체성은:
- **통합 원장**: 여러 골/세션/PR을 가로지르는 단일 진실 원천
- **계획 리뷰**: 실행 전 합의/비평 게이트
- **정리(cleanup)**: 실행 후 사후 정리/리팩터/스테일 제거 루프

gajae-code는 이 세 가지의 **부분집합**을 이미 가진다(ultragoal 원장, ralplan 리뷰, 완료 게이트의 cleanup 패스). jeo-code는 이것을 **1급 통합 워크플로**로 끌어올린다.

## 2. gajae-code vs jeo-code 포지셔닝

| 축 | gajae-code (GJC) | jeo-code (목표) |
| --- | --- | --- |
| 공개 표면 | 4 스킬 + 4 역할 (고정) | 동일 철학 유지 + `jeo` 통합 워크플로 1개 추가 |
| 원장 | ultragoal `ledger.jsonl` (단일 durable plan) | **크로스-plan/크로스-PR 원장** (프로젝트 레벨 집계) |
| 계획 리뷰 | ralplan (Planner/Architect/Critic 합의) | ralplan 재사용 + 리뷰 결과를 원장에 영구 첨부 |
| 정리 | 완료 게이트 내 cleanup 패스 | **명시적 cleanup 워크플로** (스테일 골/PR/세션 회수) |
| 실행 | team(tmux) + executor 위임 | 동일 엔진 재사용 (재발명 금지) |

핵심 결정: **재발명하지 않는다.** jeo-code는 GJC 위에 얹는 얇은 통합 레이어를 목표로 한다(별도 하드포크가 아니라 customDirectories 스킬 + 원장 도구).

## 3. 비-목표 (Non-goals)

- GJC의 런타임/네이티브/TUI를 다시 구현하지 않는다.
- 스킬 동물원을 만들지 않는다(GJC 철학 계승).
- 승인 전 제품 코드를 변경하지 않는다.

## 4. 차별화 가설 (검증 대상)

1. **단일 원장으로 다중 작업 추적이 실제로 가치 있는가?**
   - 검증: 2개 이상 동시 plan을 굴릴 때 ultragoal 단일 원장의 한계(스레드당 `/goal clear` 필요)가 마찰인지 측정.
2. **cleanup을 명시 워크플로로 분리하면 회수율이 오르는가?**
   - 검증: 완료 게이트 내장 cleanup vs 분리 cleanup의 스테일 잔존율 비교.
3. **GJC customDirectories에 무복사로 얹는 배포가 충분한가?**
   - 검증: `~/.agents/skills/jeo`로 설치 시 `/skill:jeo` 노출 + RULES.md 연동 동작.

## 5. 제안 아키텍처 (얇은 레이어)

```text
jeo-code (이 레포)
├─ skills/jeo/SKILL.md         # GJC customDirectories로 노출되는 통합 진입점
├─ ledger/                     # 크로스-plan 원장 스키마 + CLI (ultragoal ledger.jsonl 확장)
│   ├─ schema.md
│   └─ jeo-ledger.ts (예정)
└─ docs/                       # 본 분석 (현재 단계)
```

원장 스키마는 ultragoal `ledger.jsonl`(checkpoint/steering audit) 이벤트 모델을 상위 집계로 래핑:
- `plan_registered`, `plan_reviewed`, `goal_checkpointed`(GJC 위임), `cleanup_swept`, `pr_linked`.

## 6. 로드맵

- [x] **P0 분석** (현재): 아키텍처/표면 문서화, 레포 부트스트랩.
- [ ] **P1 스펙**: `deep-interview`로 jeo 통합 워크플로 모호성 제거 → `.gjc/specs/`.
- [ ] **P2 합의 계획**: `ralplan`으로 원장 스키마 + CLI 설계 합의 (pending 승인).
- [ ] **P3 MVP**: `skills/jeo/SKILL.md` + 최소 원장 CLI, GJC customDirectories 배포 검증.
- [ ] **P4 cleanup 루프**: 명시 cleanup 워크플로 + 회수율 측정.
- [ ] **P5 통합 검증**: ultragoal quality-gate 동형의 jeo 완료 게이트.

## 7. 즉시 다음 단계

P1 진입 전제: 본 분석 레포 커밋 + 원격 레포 생성. 그 다음 `deep-interview "jeo 통합 원장/리뷰/정리 워크플로"`로 스펙을 시작한다.

## 8. 참고

- 분석 1차 자료: `docs/01-architecture-analysis.md`, `docs/02-workflow-skill-surface.md`
- 원본: https://github.com/Yeachan-Heo/gajae-code (`docs/codebase-overview.md`)
- 라이선스: MIT (원본/본 분석 동일)
