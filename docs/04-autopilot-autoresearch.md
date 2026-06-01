# 04 — autopilot × autoresearch (jeoc CLI)

`jeoc autopilot` 분기 설계. `/skill:autopilot`(end-to-end 빌드 루프)에 `/skill:autoresearch`의
래칫 규율을 이식해 정밀하게 작성한 결과다. 동작하는 CLI(`bin/jeoc.ts` + `src/autopilot.ts`)로 구현.

## 1. 네이밍 맵 (리브랜드)

| upstream | jeo-code |
| --- | --- |
| `gjc` (바이너리) | **`jeoc`** |
| `gajae-code` (제품/레포) | **`jeo-code`** |
| `.gjc/` (상태) | **`.jeoc/`** |

> 주의: `docs/01`·`docs/02`는 **실제 upstream gajae-code**(바이너리 `gjc`)에 대한 사실 분석이므로
> 이름을 그대로 둔다. 리브랜드는 jeo-code가 만들어 내는 산출물(CLI/상태/스킬)에만 적용한다.

## 2. 두 스킬에서 가져온 것

| 출처 | 가져온 핵심 |
| --- | --- |
| `/skill:autopilot` | plan → implement → verify → stop, 실패 증거 보존, 반복 실패 중단 |
| `/skill:autoresearch` | **평가기 고정**, baseline 우선, **한 번에 한 변경**, **개선 시 keep / 아니면 revert**, append-only 로그, 수렴/중단 |

plain autopilot은 "QA 통과 → 완료"였다. jeoc autopilot은 "각 변경이 **고정된 점수**를 개선했음을
증명하거나 revert하고, 증거를 남긴다".

## 3. 개선점 반영 (autopilot에 적용한 autoresearch 규율)

1. **평가기 고정(frozen evaluator)** — `init` 시 eval 명령 + goal을 `session.json`에 기록, 세션 동안 불변. 변경하려면 새 세션(`--force`). *(plain autopilot에 없던 핵심)*
2. **baseline 우선** — min/max goal은 step 전에 baseline 점수 필수.
3. **한 번에 한 변경** — runner는 매 iteration 정확히 한 변경만. 다중 변경 영웅 리라이트 금지.
4. **점수 기반 keep/revert 래칫** — min(낮을수록↑)/max(높을수록↑)/gate(exit code). 비개선·무점수는 revert.
5. **append-only 로그** — `.jeoc/autopilot/log.jsonl`. revert된 시도도 증거로 보존.
6. **수렴/중단 조건** — `patience` 스텝 동안 무개선 → 수렴 중단. runner 실패 / max 도달도 중단. autopilot의 "3회 실패"와 autoresearch의 plateau를 통합.

추가 안전장치(개선):
- 엔진은 **결정 + 원장(ratchet brain)만 소유**. 파괴적 git 작업은 operator의 `--on-revert` 훅으로만 실행 → 안전·테스트 가능.
- 점수 파싱은 `score: <num>` 마지막 매치. gate goal은 exit code.

## 4. 루프 계약

```text
init (freeze eval) → baseline → [ mutate(한 변경) → eval → score
                                  → 개선? keep : revert(+on-revert 훅)
                                  → append log ] → converge / stop
```

## 5. CLI 표면

```sh
jeoc autopilot init --task <t> --eval <cmd> [--goal min|max|gate] [--timeout S] [--patience N]
jeoc autopilot baseline
jeoc autopilot step --change <desc> [--on-revert <cmd>]
jeoc autopilot loop --runner <cmd> [--max N] [--on-revert <cmd>]
jeoc autopilot status [--json]
```

- 구현: `bin/jeoc.ts`(umbrella) → `src/autopilot.ts`(`runAutopilot`). 외부 의존성 0(Node stdlib).
- 상태: `.jeoc/autopilot/{session.json, log.jsonl}`.

## 6. 검증 (실제 실행)

| 항목 | 결과 |
| --- | --- |
| min loop: baseline 10 → 9·8·7·6·5 KEEP → plateau REVERT×3 → 수렴 중단 | ✅ best=5, kept=5, reverted=3, converged=true |
| 평가기 고정: `--force` 없이 재-init 거부 | ✅ exit=1 |
| 회귀 revert + `--on-revert` 훅 실행 | ✅ 마커 생성, 이후 개선 KEEP |
| gate goal: 플래그 없음 REVERT → 생성 후 KEEP | ✅ |
| 리브랜드: `jeoc ledger`가 `.jeoc/ledger.jsonl`에서 verdict=verified | ✅ |

## 7. ledger와의 관계

`jeoc ledger`(크로스-plan 원장)와 `jeoc autopilot`(빌드 래칫)은 같은 `jeoc` CLI의 두 그룹.
autopilot 세션의 최종 결과를 ledger의 `checkpoint`/`sweep` 증거로 넘길 수 있다(향후 통합 지점).
