# CLAUDE-FABLE-5 → jeo 워크플로우 프롬프트 강화 분석

> 출처: `elder-plinius/CL4R1T4S` `ANTHROPIC/CLAUDE-FABLE-5.md` (1597 lines, raw HTTP fetch).
> 대상: jeo의 5개 워크플로우 프롬프트 — loop / ralplan / ultragoal / deep-interview / approve.
> 방법: Fable-5의 *에이전트적으로 전이 가능한* 기법만 추출 → 각 워크플로우 현재 프롬프트와 대조 →
> 이미 동등(PARITY)한 것과 실제 공백(GAP)을 구분하고, 공백에 한해 적용 가능한 구체 델타를 제안.

## 0. Fable-5에서 전이 가능한 기법 (코딩 에이전트 관점)

Fable-5 본문의 절대다수는 소비자 챗 안전 정책(child-safety, wellbeing, copyright, MCP 앱 제안)이라
jeo와 무관하다. 코딩/에이전트 루프에 전이 가능한 핵심은 다음 9가지다.

1. **의도 선언 우선 (description-first).** 모든 도구 호출 스키마(`bash_tool`, `create_file`,
   `view`, `str_replace`)가 `description`("Why I'm running this command")을 **필수 + 첫 인자**로
   강제한다. 행동 전 의도를 텍스트로 못박게 만든다.
2. **편집 신선도 계약.** `str_replace`: "편집 직전에 파일을 보라; 성공한 str_replace 이후
   컨텍스트의 이전 view 출력은 stale이므로 재-view하라."
3. **복잡도에 맞춘 도구 호출 스케일 + 복잡 작업은 먼저 리서치 플랜.** "Intelligently scale the
   number of tool calls based on query complexity: for complex queries, first make a research plan."
4. **실질 답변 의무.** "Every query deserves a substantive response — avoid replying with just
   search offers or knowledge-cutoff disclaimers without providing an actual, useful answer first."
5. **'리프레이밍 = 신호' 자기탐지 휴리스틱.** child-safety 섹션의 일반화 가능한 메타 패턴:
   "If Claude finds itself mentally reframing a request to make it appropriate, that reframing is
   the signal to REFUSE, not a reason to proceed." — *금지 규칙*보다 *자기탐지 트리거*가 행동을 더 잘 바꾼다.
6. **불확정 가정 금지.** "MUST NOT supply unstated assumptions that make a request seem safer than
   it was as written." 요구사항 분석의 직접 유사물: 모호함을 편한 가정으로 메우지 말고 질문으로 표면화.
7. **결과는 믿되 보정된 회의.** 검색 결과는 놀라워도 믿되, 음모론/SEO/논쟁적 주제는 회의하고,
   **결과가 충돌·불완전하면 추가 검색으로 명확히 한다.**
8. **부재에 대한 과신 금지.** "does not make overconfident claims about the validity of search
   results or their absence" — 실패가 관측되지 않았다는 것이 충족의 증거는 아니다.
9. **스킬 먼저 읽기(하나만 읽지 말 것) / 역할 불일치 시 입장 보존.** 둘 다 이미 jeo에 존재(아래 참조).

---

## 1. loop (`src/agent/engine.ts`: TOOL_PROTOCOL / WORKING_DISCIPLINE / OUTPUT_DISCIPLINE / VERIFICATION_DIRECTIVE)

현 상태가 가장 성숙하다. `OUTPUT_DISCIPLINE` 주석부터 이미 "FABLE-5 tone"으로 명시되어 있고,
편집 신선도(기법 2)는 `≔12ab` 앵커 + `edit-freshness`/`hashline-remap` 테스트로 **기계적으로** 강제되어
프롬프트 문구보다 강력하다(PARITY+). 실수 소유(기법 5의 톤)·파일 존재 미가정(기법 6)·스킬 먼저
읽기(기법 9)도 거의 verbatim PARITY.

GAP (적용 권장, 위험 낮음):

- **G1 — 배치 호출의 per-call 의도 (기법 1).** jeo의 `reasoning`은 *턴당 한 문장*이고 선택적이다.
  `{"tools":[...]}` 배치에서는 개별 mutating 호출의 의도가 사라진다. Fable-5는 `create_file`/`str_replace`에
  `description`을 필수로 둔다. 제안: TOOL_PROTOCOL에 한 줄 — *"배치 안의 각 mutating 호출(write/edit/bash)에는
  자기 `reasoning`을 붙여 무엇을·왜 바꾸는지 밝혀라."* 스키마 변경 없이 프롬프트만으로 가능.
- **G2 — 복잡 작업은 행동 전 플랜 (기법 3).** `Tool calibration` 줄은 *호출 수* 스케일만 말하고,
  "복잡하면 먼저 todo/리서치 플랜"이라는 트리거가 없다. jeo엔 `todo` 도구가 있으나 프롬프트가 복잡도에서
  이를 강하게 당기지 않는다. 제안: *"다중 파일·다단계 작업은 첫 행동 전에 todo로 플랜을 세워라; 한 줄 변경은 곧장."*
- **G3 — 펀트 금지 (기법 4).** `OUTPUT_DISCIPLINE`은 "Lead with the answer"는 있으나
  "디스클레이머/검색 제안만으로 때우지 말라"는 anti-punt가 없다. 제안 한 줄을 OUTPUT_DISCIPLINE에 추가.
- **G4 — 검색 결과 충돌 해소 (기법 7·8).** `web_search reflex` 줄은 "부재가 비존재 증명 아님"까지 있으나
  "결과가 충돌/불완전하면 추가 검색으로 좁혀라"가 없다. 제안: web_search reflex에 반-문장 추가.

PARITY (변경 불필요): 편집 신선도, 실수 소유, 파일 미가정, 스킬-먼저, untrusted-data 주입 방어.

## 2. deep-interview (`src/commands/deep-interview.ts` Socratic Interviewer 시스템 프롬프트)

3차원(Goal Clarity / Constraint Completeness / Acceptance Criteria) 모호도 스코어링 + 테스트 가능한
수용기준이 채워지기 전 freeze 금지 — 구조적으로 견고하다. 라운드당 질문 1개(Fable-5 tone "avoids more
than one [question] per response"와 PARITY).

GAP (이 워크플로우에 가장 잘 맞는 강화):

- **G5 — 불확정 가정 금지 (기법 6).** Fable-5의 "unstated assumptions that make a request seem safer
  than written"의 요구사항 버전: *인터뷰어가 모호함을 편한 가정으로 메우면 ambiguityScore가 가짜로 떨어진다.*
  제안 시스템 프롬프트 추가: *"모호한 지점을 네 가정으로 채워 점수를 낮추지 말라 — 그 가정 자체를
  nextQuestion으로 표면화하라. 사용자가 쓰지 않은 것을 보충해 더 안전·단순해 보이게 만들지 말 것."*
- **G6 — '단순화 = 신호' 자기탐지 (기법 5).** *"사용자의 아이디어를 더 다루기 쉽게 좁히고 있다고 느껴지면,
  그 차원은 해소된 게 아니라 여전히 모호하다는 신호다 — 점수를 낮추지 말고 질문하라."*

이 둘은 deep-interview의 핵심 실패모드(조기 freeze)를 정확히 겨냥한다.

## 3. ralplan (`src/prompts/agents/{planner,architect,critic}.md` + ralplan SKILL)

severity 게이팅(architect: CRITICAL/HIGH면 APPROVE 금지), 입장 보존(SKILL: "do not collapse the split",
Fable-5 evenhandedness와 PARITY), 증거 기반("Ground important claims in inspected files") 모두 양호.

GAP:

- **G7 — critic의 '완화 = 신호' (기법 5).** critic.md에 자기탐지 트리거 추가:
  *"REJECT를 ITERATE로 누그러뜨려 차단을 피하고 있다고 느껴지면, 그 완화가 곧 그 공백이 실재한다는 신호다."*
  현재 "reject only with concrete gaps"는 무근거 거부는 막지만 *과소-거부*는 막지 못한다.
- **G8 — architect 부재 과신 금지 (기법 8).** *"문제를 못 찾았다는 것이 CLEAR의 근거는 아니다 — 점검한
  파일·경로를 명시해 무엇을 실제로 검증했는지로 판정을 뒷받침하라."* 출력계약에 `Inspected:` 한 줄 권장.

## 4. ultragoal (`src/agent/goal-verifier.ts` MET/NOT_MET/IMPOSSIBLE 검증자)

독립 검증자가 transcript로 목표 충족을 판정 — ultragoal의 정직성 핵심. Fable-5의 기법 4·5·8이 가장
직접적으로 적용되는 지점.

GAP:

- **G9 — 기준별 양성 증거 요구 (기법 8).** 검증자 시스템 프롬프트에:
  *"각 수용기준에 대해 그것이 충족되었음을 보여주는 양성 증거(실행된 명령·테스트·파일)를 인용하라.
  실패가 관측되지 않았다는 것만으로 MET을 내지 말 것."*
- **G10 — 기준 리프레이밍 금지 (기법 5·요구사항 대체 금지).** *"만들어진 결과에 맞춰 수용기준을 다시
  해석해 MET을 만들지 말라 — 기준이 쓰인 그대로 충족되지 않았다면 NOT_MET이고, missing을 적시하라."*
  이는 jeo의 "passing test ≠ met requirement" 철학을 검증자 측에 못박는다.

## 5. approve (`src/commands/approve.ts`)

결정론적 게이트(plan-path 일치 검증)로 LLM 프롬프트가 거의 없다 → Fable-5의 직접 기여 작음.
유일한 권장: ralplan이 보존한 contested decision(SKILL의 분기점)을 승인 직전 인간에게 **요약 표면화**해
"무엇을 승인하는지"를 명확히. 프롬프트 강화가 아니라 UX/게이트 보강 영역.

---

## 6. 권장 적용 우선순위

| ID | 대상 파일 | 변경 | 위험 | 가치 |
|----|-----------|------|------|------|
| G5 | deep-interview.ts | 불확정 가정 금지 한 문장 | 낮음 | 높음 (조기 freeze 방지) |
| G10 | goal-verifier.ts | 기준 리프레이밍 금지 | 낮음 | 높음 (검증 정직성) |
| G9 | goal-verifier.ts | 기준별 양성 증거 인용 | 낮음 | 높음 |
| G7 | critic.md | 완화=신호 트리거 | 낮음 | 중 |
| G1 | engine.ts TOOL_PROTOCOL | 배치 per-call reasoning | 낮음 | 중 |
| G3 | engine.ts OUTPUT_DISCIPLINE | anti-punt | 낮음 | 중 |
| G2 | engine.ts | 복잡 작업 plan-first | 중 (todo 행동 변화) | 중 |
| G8 | architect.md | Inspected 증거 | 낮음 | 중 |
| G6 | deep-interview.ts | 단순화=신호 | 낮음 | 중 |
| G4 | engine.ts web_search reflex | 충돌 해소 | 낮음 | 낮 |

**메타 결론:** jeo 루프 프롬프트는 이미 FABLE-5를 명시 반영해 동등성이 높다. 진짜 레버리지는
*loop*가 아니라 **검증·게이트 계층**(ultragoal 검증자, ralplan critic/architect)과 **deep-interview**에
Fable-5의 **'리프레이밍/단순화 = 신호' 자기탐지 패턴**과 **'양성 증거·불확정 가정 금지'**를 이식하는 것.
이는 jeo가 이미 가진 금지 규칙들을 *자기탐지 트리거*로 바꿔 행동 변화율을 높인다.

---

## 7. 적용 상태 (applied)

`$autopilot`로 G1·G3·G4·G2(loop), G5·G6(deep-interview), G7(critic), G8(architect),
G9·G10(goal-verifier) 모두 반영. **무한루프 안전장치 확인:** 루프 완료 게이트
(`VERIFICATION_DIRECTIVE`의 "do not call done")는 강화하지 않았고, ultragoal 검증자는
호출부(`launch.ts`의 `MAX_RE_BLOCKS = 2`)에서 2회 재차단 후 done을 자동 허용하므로 더 엄격한
판정도 영원히 반복될 수 없음. deep-interview는 "해소되면 점수를 내려라(인터뷰 연장 금지)" 수렴
가드를, critic은 "차단을 날조하지 말라 · 실행 가능하면 [OKAY]" 균형 조항을 함께 넣어 과잉 차단을 방지.
검증: `bun run typecheck` 통과, `bun test` 1982 pass / 0 fail.
