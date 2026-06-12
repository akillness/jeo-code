# gjc 계승·발전 합의 문서 (living document)

> 마라톤 규약: 1 사이클 = 구현 → 개선 → 논의 → 합의 → 검증. 매 사이클 progress.txt에 기록.
> 증거: agent://0-GjcCoreLoop, agent://1-GjcVerifyExtend (gjc v0.4.3 소스 분석), pi-mono/hermes/nullclaw/zeroclaw 철학 리서치 (2026-06-12).

## 철학 종합 (4+1 프로젝트)

| 프로젝트 | 핵심 철학 | jeo가 가져갈 것 |
|---|---|---|
| **pi-mono** (Zechner) | 미니멀 코어(4 tools, <1K토큰 프롬프트). "코어에 더한 기능만큼 모델의 자유 추론이 줄어든다." 기능은 확장/CLI+README로. | 코어 비대화 거부 — gjc 계승 시 **선별** 원칙. 도구 수 최소 유지, 무거운 기능은 스킬/외부 CLI로. |
| **nullclaw** (Zig) | "as little as possible, as much as necessary". 단일 파일 구현으로 확장. SQLite 로컬 하이브리드 메모리. | 의존성 제로 유지(Bun 순수 TS). 메모리는 로컬 파일 기반. |
| **zeroclaw** (Rust) | local-first 주권, swappable 서브시스템, "전원 뽑으면 멈추고 다른 건 안 깨진다". | 상태는 전부 `.joc/` 로컬. 크래시 내구 상태 쓰기. |
| **hermes** (Nous) | 경험→스킬 증류: 태스크 완료 후 reusable skill 자동 추출, 세션 간 누적 학습. | 턴/세션 경계 학습 루프 (로컬 MEMORY 증류). |
| **gjc** (계승 대상) | "staff engineer" 규율: completion-contract, 검증 없는 done 금지, 편집 무결성(hashline), 구조적 능력 경계. | 아래 백로그. |

**jeo 노선 합의(초안)**: jeo는 pi-mono 계열의 *경량 JSON-루프* 에이전트로 남는다. gjc의 **정확성·검증·안전 메커니즘**을 경량 형태로 계승하되, 무거운 인프라 계층(plugins marketplace, 원격 hindsight, harness control-plane)은 도입하지 않거나 스킬/외부로 위임한다.

## 계승 백로그 (사이클 후보, 우선순위 순)

| # | 항목 | gjc 원본 | jeo 경량화 설계 | 효과/비용 |
|---|---|---|---|---|
| B1 | ~~Vercel/agent-skills 생태계 관용~~ | skills 디스커버리 | **완료 (cycle 1)** | — |
| B2 | **hashline-lite 편집 앵커** | hashline/ (647 단일토큰 바이그램, 콘텐츠 해시) | read 출력에 `N+hh\|` 앵커, edit `≔A..B`에 해시 검증 — mismatch 시 거부+현행 내용 재제시. 3-way 복구는 후속. | 편집 오염(최대 사고 원인) 차단 / 중간 |
| B3 | **completion-contract 프롬프트 이식** | system-prompt.md | executorSystemPrompt에 검증·완성 계약 문장 추가 (<300토큰) | 높음 / 매우 낮음 |
| B4 | **done 검증 가드(경량)** | ultragoal-guard, goal continuation | 엔진: 변이 도구(write/edit/bash) 사용 턴에서 검증 신호(테스트/실행) 없이 done 호출 시 1회 푸시백 | 높음 / 낮음 |
| B5 | **bashAllowedPrefixes 능력 경계** | task/types.ts AgentDefinition | subagent 역할별 bash 접두사 화이트리스트 (읽기전용 역할은 이미 도구 필터됨) | 중간 / 낮음 |
| B6 | **경험→스킬 증류(hermes 루프)** | memories/ 2-phase, hindsight | 세션 종료 시 `.joc/memory/MEMORY.md` 로컬 증류(요약 1콜), 다음 세션 시스템 프롬프트에 토큰 캡 주입 | 높음 / 중간 |
| B7 | **stale-read 가드** | edit/file-read-cache | edit 대상 파일이 마지막 read 이후 mtime 변경 시 경고/거부 | 중간 / 낮음 |
| B8 | **컴팩션 핸드오프/파일연산 보존** | agent-session compaction | 요약에 touched-files 목록 보존; (promotion/원격은 비도입) | 중간 / 중간 |
| B9 | **spawn-gate 경량판** | task/spawn-gate.ts | task 도구 N>4 fan-out 시 정당화 필드 요구 | 낮음 / 낮음 |
| B10 | **출력 spill 설정주도화** | output-meta.ts | 임계/head/tail 환경변수화 (+기존 minimizer 유지) | 낮음 / 낮음 |

## 비도입 합의(초안) — pi-mono 원칙 적용
- plugins/marketplace 계층 (스킬 디스커버리로 충분)
- 원격 hindsight/벡터 메모리 (로컬 MEMORY.md로 대체)
- harness control-plane (jeo 규모에 과잉)
- native tool-use API 전환 (JSON-in-text 루프가 jeo 정체성 — 멀티 프로바이더 균일성 이점 유지)

## 사이클 렛저
- cycle 1 (2026-06-12): B1 Vercel skills 관용 — 완료, 39 tests green, 라이브 검증.

## 합의 라운드 1 (critic ITERATE, 2026-06-12 — agent://2-InheritanceCritic)

**확정 실행 순서**: B3완성 → [B7+B3.5] → B4 → B2 → B6. B5는 보류(실 격차는 task-spawn 시 bashPrefixes 전달 — 역할 레지스트리만으론 가치 0), B9는 하드캡 대신 프로토콜 레벨 정당화 필드로 재설계.

- **B3 (부분완료)**: WORKING_DISCIPLINE은 engine.ts에 landed. 잔여: launch 인터랙티브 프롬프트 + executor 서브에이전트 템플릿 배선.
- **B3.5 (신규, 크리틱 발굴)**: edit SEARCH 매치 실패 시 자동 재제시 — 진단 문자열만이 아니라 현재 파일 내용(관련 구간)을 에러에 동봉. 실패 편집은 스텝버짓 낭비 1위.
- **B7 (승격)**: stale 감지 시 거부+현행 내용 재제시(recovery), 경고만으론 부족. read가 mtime/size 기록, edit/write가 검증. state.ts:213 패턴 복사.
- **B4 명세**: 변이 도구 사용 턴에서 검증 신호 없이 done → 1회 푸시백. 신호 = bash 성공 + 테스트러너 패턴(output-minimizer SUMMARY_PATTERNS 재사용). escape hatch = 푸시백 후 두 번째 done은 무조건 통과 (문서/설정 변경 오탐 대응).
- **B2 명세**: 해시 검증은 `≔A..B` 경로에만 적용. SEARCH/REPLACE 블록은 앵커 prefix(`N+hh|`) 유입 시 스트립하는 픽스업 추가(기존 whitespace near-miss 진단과 동급). 약한 모델의 해시 오타는 mismatch → 현행 재제시로 수렴.
- **native tool-use 비도입 근거 보강**: JSON-in-text의 parse-bounce 오버헤드(~수 스텝/턴)는 인정. 전환 비용 = 5개 프로바이더 어댑터 + 엔진 디스패치 전면 재작성 + 프로바이더 불문 균일 프롬프트 상실. 현 가드(MAX_PARSE_BOUNCES/salvage)로 완화된 상태에서 전환 편익이 비용을 하회 — 재평가 트리거: 신규 프로바이더의 JSON 모드 미지원.

## 사이클 렛저 (계속)
- cycle 2 (2026-06-12): B3 — WORKING_DISCIPLINE 3곳 배선(engine/launch/subagent). typecheck 0, suites green.
- cycle 3 (2026-06-12): B7+B3.5 — file-freshness guard(거부+재제시+스냅샷 갱신) + SEARCH mismatch 현행 발췌 동봉. 신규 테스트 5종.
- cycle 4 (2026-06-12): B4 — done-verification guard(1회 푸시백+escape hatch). 신규 테스트 4종. full 1128 pass / 0 fail.
- cycle 5 (2026-06-12): B2 hashline-lite — read `LINEhh|` 앵커 + ≔ 앵커 검증(거부+재제시) + SEARCH 앵커 스트립 픽스업. 신규 테스트 6종. full 1134 pass / 0 fail.
- cycle 6 (2026-06-12): B6 경험 증류 — src/agent/memory.ts(.joc/memory/MEMORY.md 증류+주입, JOC_NO_MEMORY 옵트아웃). 신규 테스트 3종.
- cycle 7 (2026-06-12): B8 — extractTouchedFiles로 컴팩션 요약에 변이 파일 목록 핀. 신규 테스트 2종. full 1139 pass / 0 fail.
- cycle 8 (2026-06-12): B9 spawn-gate lite(fan-out>4 정당화 강제) + B10 출력 캡 설정화(JOC_TOOL_OUTPUT_MAX). full 1141 pass / 0 fail.
- **라운드 1 종료** — 8사이클, 신규 테스트 25종, B1~B10 소진(B5는 critic 판정으로 라운드 2 재설계). 라운드 2 진입 시 critic 합의 라운드 2 선행: 후보 = task-spawn bashPrefixes(B5 재설계), 도구 동시성 확대(shared/exclusive), 컴팩션 핸드오프 전략, _i intent 텔레메트리, LSP-lite(편집 후 진단), 3-way merge 복구(hashline 후속).

## 합의 라운드 2 (critic, 2026-06-12 — agent ref 3-Round2Critic)

**확정 배치 (cycle 9~12)**:
- **cycle 9 (f) hashline 3-way 재매핑**: anchor mismatch 시 즉시 거부 대신 ±윈도 내 동일 anchor 라인 탐색(content-only 해시라 이동된 줄도 동일) — 유일 매치면 자동 재매핑+적용(범위는 양끝 동일 delta 요구), 충돌/미발견이면 기존 거부+재제시 fallback. 파일: tools.ts.
- **cycle 10 (a) B5 재설계**: SubagentRole.bashAllowedPrefixes — 설정 시 subagentToolset()이 bash를 prefix-검사 래퍼로 교체. 레지스트리 정의 = 런타임 제약(config 전달 불필요). 기존 역할 동작 불변.
- **cycle 11 (c) 컴팩션 핸드오프**: extractTouchedFiles에 bash 보수 패턴(/(?:created|wrote|written to|deleted)\s+([\w./-]+)/i) 확장 + 요약 앞 기계적 "Files touched:" 헤더 강제 + CompactionResult.touchedFiles 표면화.
- **cycle 12 (b) 쓰기 병렬화 — 조건부**: 다른 파일 대상 write/edit 배치 병렬화(파일 겹침 시 순차, bash는 항상 exclusive 유지). 실측 이득 미미하면 revert 허용.

**탈락**: (d) _i intent — jeo 프로토콜에 부재, 코어 비대화(pi-mono 위반); hooks가 이미 tool+args 관찰 가능. 재검토: 외부 텔레메트리 수집기 도입 시. (e) LSP-lite — 의존성 제로 원칙 충돌; done-guard+B3.5+minimizer가 동일 영역 커버. 재검토: Bun 내장 TS 진단 API / 의존성 정책 완화 / 편집 실패율 미개선 증거. 대안 후보(라운드 3): post-edit bash tsc 훅.

## 사이클 렛저 (라운드 2)
- cycle 9 (2026-06-12): hashline 3-way 재매핑 — anchor mismatch 시 ±64 윈도 유일매치 재매핑(범위는 양끝 동일 delta 강제), 충돌/미발견 시 기존 거부+재제시 fallback. **추가 발굴**: 전수치 anchor(`68` 등 ~7.7%)가 `≔1`+`68`→`≔168`로 병합돼 검증 무력화되던 잠재 사일런트 손상 버그 — lineAnchor를 letter-leading(a-z 선두)으로 변경해 근본 차단. 신규 테스트 7종(hashline-remap.test.ts).
- cycle 10 (2026-06-12): B5 재설계 — SubagentRole.bashAllowedPrefixes + subagentToolset() prefix-검사 래퍼(세그먼트 단위 `; && || |` 분해, env/sudo 스트립, 커맨드 치환 거부). bashCommandAllowed export. 번들 역할은 미옵트인(executor=full bash, RO=bash 제거) — 메커니즘+테스트 5종(subagent-bash-allowlist.test.ts).
- cycle 11 (2026-06-12): 컴팩션 핸드오프 — extractTouchedFiles에 `Tool [bash] result` 보수 패턴(created/wrote/written to/deleted/removed + path-shape 필터) 확장 + 요약 앞 "Files touched:" 헤더 강제 + CompactionResult.touchedFiles 표면화 + launch.ts 양 경로 소비(요약 실패 placeholder에 파일목록 보존). 신규 테스트 2종.
- cycle 12 (2026-06-12): 쓰기 병렬화 — 엔진 배치 그룹핑을 read/write/exclusive 3종으로 재설계. 서로 다른 파일 write/edit는 병렬, 같은 파일(또는 경로미상)은 순차 경계, bash는 항상 exclusive. read·write 그룹 분리로 read-write 레이스 불가. 신규 테스트 4종(write-parallel.test.ts).
- **라운드 2 종료** — 4사이클(+1 버그픽스), 신규 테스트 18종. full 1161 pass / 0 fail, typecheck 0. 라운드 3 후보: 전수치 anchor 픽스 외 잔여 hashline 강건성, post-edit bash tsc 훅(LSP-lite 대안), _i intent 외부 텔레메트리, 도구 동시성 추가 확대(cross-file read+write 혼합 그룹).

## 합의 라운드 3 (critic ITERATE→OKAY, 2026-06-12 — agent://4-Round3Critic)
**확정**: 단일 사이클 라운드. cycle 13만 실행, (b)(c)(d)는 정당화된 보류/탈락.
- **cycle 13 (post-turn 훅 진단 피드백, 후보 (a) 재구성)**: runPostTurnHooks가 비정상종료(exit≠0) 훅의 출력을 반환 → engine이 해당 도구 결과 블록에 `[post-turn hook "<run>" — exit N]:\n<output>`로 첨부(모델 가시). gjc post-edit 진단 가치를 **기존 hooks 확장점**으로 실현 — 신규 의존성/코어 변경 0 (pi-mono). critic 5개 명확화 반영: (A1) exit≠0에만 표면화(exit0 출력 폐기), (A2) 배치 내 동일 출력 엔진측 dedup(중복은 "same diagnostics as above" 교차참조), (A3) timeout/abort는 기존 notice만(부분출력 없음), (A4) JOC_TOOL_OUTPUT_MAX로 독립 truncate, (A5) match.tool은 정확일치(edit+write는 항목 2개). 가드: 훅 실패가 도구 ok/fail 불변·budget 중립.
- **보류/탈락 (critic 합의)**: (b) 잔여 hashline — cycle 9+letter-leading로 주요 사일런트 손상 차단, 잔여 실패 클래스 증거 無 → 보류. (c) _i intent — 코어 비대화, hooks가 tool+args 관찰 → 탈락. (d) cross-file read+write 혼합 동시성 — cycle 12가 distinct-file write 병렬화+read 격리 완료, 혼합은 read↔write 레이스 표면 생성 / 이득 미미 → 보류.

## 사이클 렛저 (라운드 3)
- cycle 13 (2026-06-12): post-turn 훅 진단 피드백 — hooks.ts PostTurnHookDiag 반환 + engine 결과블록 첨부(배치 dedup), launch 영향 無(엔진 경유). 신규 테스트 6종(post-turn-feedback.test.ts). full 1169 pass / 0 fail, typecheck 0.
- **라운드 3 종료** — 1사이클. 누적: 13사이클(라운드 1~3), full 1169/0. 라운드 4 후보(미합의): match.tool `|`-구분 다중매칭, post-turn 훅 surfaceOnSuccess 옵트인, 도구 출력 minimizer 훅화.

## 합의 라운드 4 (architect WATCH, 2026-06-12 — agent://5-Round4Discovery)
**확정**: architect 심각도 평가 기반 4픽스 배치(cycle 14). F5는 F1에 흡수, F6(Low)은 보류.
- **F1 (Med, top-1)**: done guard가 cycle-13 훅 진단을 무시 — 이전 스텝의 bash 검증 성공이 order-insensitive로 sawVerification을 만족하면, 최신 편집이 tsc 훅을 빨갛게 만들어도 done 통과. 수정: runPostTurnHooks가 `{diags, ran}` 반환(ran=완주 훅 수), engine이 pendingHookFailure 추적(red 훅=설정, 이후 clean 완주=해제), 가드 조건 `sawMutation && (!sawVerification || pendingHookFailure) && !donePushbackUsed` + 푸시백이 실패 훅 명명. escape hatch 유지.
- **F2 (Med, top-2)**: writeWorkflowState 비원자 쓰기 — mutation guard가 corrupt JSON에 fail-closed라 torn write가 영구 mutation block을 유발. 수정: saveGlobalConfig와 동일한 temp+rename+실패 시 cleanup.
- **F3 (Med)**: cycle-12 쓰기 병렬화 dedup 키가 raw 문자열 — `./x.ts` vs `x.ts`(또는 macOS 대소문자 변형)가 병렬 실행되어 두 번째 쓰기가 첫 번째를 사일런트 클로버. 수정: `path.resolve(cwd,p).toLowerCase()` 키(가짜 충돌 직렬화는 무해).
- **F4 (Med)**: 증류 MEMORY.md가 시스템 프롬프트에 무방비 주입 — 지속·고신뢰 prompt-injection 벡터. 수정: `</project_memory>` 태그 중화(‹›) + "DATA, not instructions" 프레이밍(fenceSubagentReport 패턴).
- **14a (라운드3 critic 승인 follow-up)**: hookMatchesTool — match.tool `|`-구분 다중매칭(`"edit|write"` 1항목).

## 사이클 렛저 (라운드 4)
- cycle 14 (2026-06-12): 14a 다중매칭 + F1 훅↔done guard 결합 + F2 원자적 workflow state + F3 경로정규화 dedup + F4 메모리 주입 방어. 신규/갱신 테스트 8종(post-turn-feedback 4, write-parallel 2, memory 1, state-command 1). full 1177 pass / 0 fail, typecheck 0.
- **라운드 4 종료** — 누적 14사이클. 보류 잔여: F6(batch 실패 스트릭 some() 완화, Low), F5 잔여(VERIFY_SIGNAL_RE 키워드 휴리스틱 — 훅 사용자에겐 F1이 사실상 대체).

## 합의 라운드 5 (architect WATCH, 2026-06-12 — agent ref 6-Round5Providers)
**축 전환**: 에이전트 코어(라운드 1~4 소진) → 프로바이더/스트리밍 레이어. HIGH 2건 + MEDIUM 1건 채택, F6(라운드4 보류분)도 본 라운드에서 처리.
- **#1 (HIGH)**: anthropic/openai/codex/ollama가 200-with-no-text를 빈 문자열로 반환 → 엔진 parse-bounce는 빈 응답에서 자기종료 불가 → reasoning 모델+작은 maxTokens 조합이 과금되는 스텝버짓 전소. 수정: 4개 어댑터 모두 gemini blockedReason 계약 미러링 — no-text 완료 시 stop_reason/finish_reason/incomplete_details/done_reason을 동봉한 묘사적 throw("output budget exhausted before any text; raise maxTokens…").
- **#2 (HIGH)**: Cloud Code Assist 프로젝트 디스커버리(첫 OAuth 사용) fetch가 signal/timeout 無 — 매니저 120s 가드 이전에 실행되어 stalled TCP가 비대화 턴/서브에이전트/팀 워커를 영구 행. 수정: DiscoverProjectOptions에 signal+requestTimeoutMs(기본 30s), boundedSignal(outer turn abort ∧ per-request timeout), 3개 fetch 전부 적용, antigravity/gemini 호출자가 options.signal 스레딩.
- **#3 (MED)**: anthropic 스트림 usage가 message_start+message_delta 2회 보고 → 누산 sink에서 input 2배 과대계상. 수정: message_start는 캐시만, message_delta에서 1회 보고(report-once — pre-first-chunk 재시도 리플레이도 무해화, #6 흡수).
- **F6 (라운드4 Low 보류분)**: 배치 스텝 성패를 non-trivial(비읽기) 콜로 판정 — read(ok)+edit(fail) 반복이 MAX_FAILURES를 영원히 우회하던 구멍 봉합.
- **보류**: #4 컨텍스트 오버플로 taxonomy+반응적 컴팩션(MED, 20-40 LoC — 라운드 6 후보), #5 stream_options 호환(LOW), #7 슬로우드립 전체 데드라인(LOW/WATCH).

## 사이클 렛저 (라운드 5)
- cycle 15 (2026-06-12): #1 빈완료 균일 계약(4 어댑터) + #2 디스커버리 데드라인 + #3 usage report-once + F6. 기존 테스트 1건이 옛 2회보고 계약 고정 → report-once로 갱신. 신규 테스트 11종(provider-empty-completion 9, engine-multitool F6 2). full 1190 pass / 0 fail, typecheck 0.
- **라운드 5 종료** — 누적 15사이클. 라운드 6 후보: #4 컨텍스트 오버플로 신호→반응적 컴팩션+재시도, model-not-found(404) taxonomy.

## 사이클 렛저 (라운드 6)
- cycle 16 (2026-06-12): #4 컨텍스트 오버플로 — isContextOverflowError(메시지 패턴+413) + friendlyProviderError에 overflow("/compact" 안내)·404(model-not-found, "/model" 안내) 케이스 + 엔진 1회 반응적 트림+재시도(provider 신호가 로컬 추정 우선; keepRecent 2로 공격적 트림, 스텝 미소모 free retry, 2번째 overflow는 friendly 에러 표면화). 신규 테스트 4종(provider-error-taxonomy.test.ts). full 1194 pass / 0 fail, typecheck 0.
- **라운드 6 종료** — 누적 16사이클. 잔여 보류: #5 stream_options 호환(LOW), #7 슬로우드립 데드라인(LOW/WATCH), F5 잔여.

## 합의 라운드 7 (architect REQUEST CHANGES, 2026-06-12 — agent ref 7-Round7Workflow)
**축 전환**: 워크플로/오케스트레이션(team/ultragoal/task-tool). 구조적 사실: `jeo team`은 tmux 워커풀이 아니라 직렬 플랜 실행기. HIGH 2건은 둘 다 completion-contract 직격(가짜 성공 보고).
- **#1 (HIGH)**: stale team-state 재사용 — plan A 완료 후 plan B 실행 시 pending=[]가 재사용되어 plan B가 **no-op으로 가짜 성공**(중간 잔존 시 plan-A 태스크를 plan-B 역할로 실행). 수정: plan_path/slug 불일치 시 새 플랜 태스크로 재초기화 + "New plan detected" 로그.
- **#2 (HIGH)**: ultragoal 검증 연극 — 기준마다 동일 글로벌 `bun test`(run/cli 포함 시 무조건 green인 `--help`)를 돌리고 조작된 기준별 ✅/❌ 매트릭스를 렛저에 기록. 수정: suite 1회 실행, 기준은 UNVERIFIED로 정직 기록(개별 검증 없는 SUCCESS 주장 불가), status SUITE_GREEN/FAILED + suite_green 필드, run/cli 루프홀 제거.
- **LOW 동반 수정**: team-state.active 완료 시 false 플립, ultragoal 리포트 temp+rename 원자 쓰기.
- **#5 (라운드5 보류 LOW)**: openai stream_options 400 호환 — OpenAI-호환 백엔드(llama.cpp/LM Studio)가 옵션 필드에 400 시 1회 스트립 재시도(무관한 400은 재시도 없음).
- **보류 (라운드 8 후보, MED)**: 부모의 Changed Files 실측 대조(서브에이전트 허위 성공), .joc/state 크로스 프로세스 락, 실패 태스크 마커+재개 경고.

## 사이클 렛저 (라운드 7)
- cycle 17 (2026-06-12): team stale-state 리셋 + ultragoal 정직 검증 + active 플립 + 리포트 원자쓰기 + stream_options 호환. WorkflowState.suite_green 신설. 신규 테스트 6종(workflow-integrity 4, provider-empty-completion +2). full 1202 pass / 0 fail, typecheck 0.
- **라운드 7 종료** — 누적 17사이클.

## 사이클 렛저 (라운드 8 — 라운드7 architect MED 보류분 소진)
- cycle 18 (2026-06-12): (A) 부모측 변이 감사 — task-tool/team이 서브에이전트의 성공한 write/edit/bash를 실측 카운트, mutating 역할이 0건 변이로 "완료" 시 "[parent audit] … UNVERIFIED" 주석/경고(보고서 마커는 형식 증명일 뿐 작업 증명이 아님). (B) 크로스 프로세스 런 락 — acquireWorkflowRunLock(O_EXCL+pid, 死pid stale 인수, 생존 보유자는 명확 거부), runTeamEngine 본문 try/finally 래핑(동시 team 런의 이중 실행/완료 소실 차단). (C) 실패 태스크 마커 — 실패 시 current_phase=failed+failed_task 영속, 다음 런이 부분 편집 경고 후 마커 해제. WorkflowState.failed_task 신설. 신규 테스트 3종(workflow-integrity: 락 수명주기/실패 마커+재개 경고/parent audit). full 1206 pass / 0 fail, typecheck 0.
- **라운드 8 종료** — 누적 18사이클. architect 발굴 백로그(라운드 4~7) 전부 소진(잔여는 LOW/WATCH뿐: 슬로우드립 데드라인, plan deps 거부, spawn-gate 주석).

## 사이클 렛저 (라운드 9 — 라이브 e2e 실증)
- cycle 19 (2026-06-12): **자기수정 루프 라이브 실증** — 샌드박스(/tmp, OAuth 사본 config + 즉시 폐기)에서 dist/jeo 실모델 런(antigravity/gemini-3.5-flash-low, --no-tui -p). 결정적 post-turn 훅(match.tool "edit|write", VERSION export 강제 grep)으로 검증: ① step2 편집 → 훅 RED(LINT-E001 advisory 발화) ② 모델이 훅 내용을 사전에 모름에도 진단만으로 step4에서 `export const VERSION = "1.0.0"` 정확 추가(cycle 13 피드백 실증) ③ 훅 GREEN → pendingHookFailure 해제(cycle 14 F1) ④ bash 검증 후 done 무푸시백 통과 ⑤ 동적 스텝버짓 novelty 연장("progress detected → extended to 15") 라이브 발화. 파일 결과 확인: greet 변경+VERSION 추가 모두 정확. 라운드 1~8 스택(훅 진단 피드백·다중매칭·done 가드·스텝버짓)이 실모델에서 합주 동작함을 증명.

## 합의 라운드 10 (architect BLOCK→fixed, 2026-06-12 — agent ref 8-Round10Planning)
**축**: 플래닝 프런트엔드(deep-interview→ralplan→approve). team의 실행시 게이트는 견고하나 그 상류가 전부 약했음 — HIGH 3건.
- **#2 (HIGH)**: ralplan write-time 검증이 team보다 약함 — role: "developer" 같은 흔한 LLM 편차가 write-time 통과 후 team에서야 abort(모델 부재 시점). 또한 전 패스 무효여도 WARNING만 내고 complete 마킹. 수정: isValidPlan에 role 검증(getSubagentRole), 무효 시 파일은 검토용 저장하되 complete 마킹 거부+ok:false.
- **#3 (HIGH)**: 완료된 인터뷰가 영구 active:true + 새 아이디어 인자 무시 — `jeo deep-interview "idea B"`가 idea A를 조용히 재사용해 체인 전체가 옛 아이디어를 실행. 수정: freezeSeed에서 active=false, 완료 상태+다른 새 아이디어면 clear 후 신규 인터뷰.
- **#4 (MED)**: approve가 고무도장 — 스키마/role 무검증 승인. 수정: 승인 전 team과 동일 계약(PlanSchema+role) 검증, 불합격 시 거부.
- **#1 (HIGH, 정직 리라벨만)**: ralplan "consensus"는 단일모델 3패스 프롬프트(critic 평결 게이트 없음 — 라운드7 ultragoal과 동형의 연극). 전면 수정(실 서브에이전트+평결 게이트, ~80-150 LoC)은 라운드 11 후보로 보류, 로그 문구를 실체대로 리라벨.
- **LOW 동반**: PlanSchema가 dependency-형 키(depends_on 등) 거부(직렬 실행기가 존중 못 하는 제약의 환상 차단), spawn-gate 동시성 주석.

## 사이클 렛저 (라운드 10)
- cycle 20 (2026-06-12): #2 write-time 패리티+refuse-complete, #3 stale 인터뷰 차단+active 플립, #4 approve 게이트화, #1 리라벨, deps 키 거부, 주석. 신규 테스트 5종(workflow-integrity 3, deep-interview 1, team-schema 1). full 1222 pass / 0 fail, typecheck 0.
- **라운드 10 종료** — 누적 20사이클. 라운드 11 후보: #1 전면(ralplan 실 서브에이전트 합의+critic 평결 게이트+평결 영속→approve가 평결 요구), #5 시드 기준 라운드트립 검증.

## 사이클 렛저 (라운드 11 — 합의의 실체화)
- cycle 21 (2026-06-12): **ralplan 실 합의 게이트** — runConsensusCriticGate: read-only critic 서브에이전트(repo 접근: read/search/find/ls)가 후보 플랜을 시드+실저장소 대조 검토, [OKAY]/[ITERATE]/[REJECT] 평결 강제(fail-closed: 계약 미충족=unverified=비승인). [ITERATE]는 1회 수정 라운드 후 재심. 평결+근거가 ralplan state에 영속(consensus/consensus_detail), [OKAY]만 complete. **approve가 영속 평결 요구** — consensus!=="okay"면 거부(구 상태는 ralplan 재실행으로 치유). 이로써 라운드 10 #1(합의 연극)의 전면 수정 완료: 드래프팅은 여전히 single-model이지만 **차단 가능한 게이트가 진짜**가 됐다. 신규/갱신 테스트 4종(critic OKAY 완료+평결 영속, REJECT 차단, approve 평결 거부, 기존 fixture 갱신). full 1224 pass / 0 fail, typecheck 0.
- **라운드 11 종료** — 누적 21사이클. 체인의 모든 게이트가 실체화됨: write-time(ralplan 스키마/role) → 합의(critic 평결) → 승인(스키마+role+평결) → 실행(team 게이트+락+감사) → 검증(ultragoal 정직 기록). 잔여: #5 시드 라운드트립(MED), LOW/WATCH 2건.

## 사이클 렛저 (라운드 12 — 시드 라운드트립)
- cycle 22 (2026-06-12): #5(MED, 마지막 잔여 MED) — src/agent/seed.ts 신설: yamlList(작성기)와 parseSeedAcceptanceCriteria/parseSeedList(파서)가 한 모듈·한 인코딩 공유(JSON encode→decode). 구 ultragoal 인라인 파서는 모든 큰따옴표를 strip해 `Display "Done" message` 류 기준을 사일런트 맹글링. deep-interview freezeSeed에 라운드트립 자기검증(불일치 시 freeze 거부 — 미래 포맷 드리프트의 시끄러운 실패), ultragoal은 공유 파서 사용(레거시 비인용 항목 관용 유지). 신규 테스트 4종(seed-roundtrip: 적대적 값 왕복/레거시 관용/섹션 경계/e2e 비맹글링). full 1228 pass / 0 fail, typecheck 0.
- **라운드 12 종료** — 누적 22사이클. **MED 이상 발굴 백로그 전부 소진.** 잔여는 LOW/WATCH 2건(슬로우드립 스트림 데드라인, deep-interview 기준 품질 휴리스틱)뿐.

## 사이클 렛저 (라운드 13 — 강화된 체인 라이브 풀 e2e)
- cycle 23 (2026-06-12): **deep-interview→ralplan→approve→team→ultragoal 전 체인 실모델 관통 런** (신선 빌드 dist/jeo = 라운드 10~12 게이트 포함, antigravity/gemini-3.5-flash 계열, /tmp 샌드박스, OAuth config 사본은 검증 직후 폐기). 과제: slugify 모듈+테스트 그린필드.
  - **deep-interview --auto**: 실 모호성 스코어링 라이브(60%→Q&A→10%), 시드 기준 JSON 인코딩(R12 작성기), freeze 시 active=false(R10). 6개 acceptance_criteria 동결.
  - **ralplan**: 드래프팅 3패스 + **critic 서브에이전트 게이트 라이브 [OKAY]** — justification이 "repo is nearly empty…"로 실저장소 열람 증명(R11). consensus/consensus_detail 영속.
  - **approve**: 스키마+role+평결 3중 게이트 전부 통과(R10/R11).
  - **team 1차**: task1이 20스텝 버짓 소진(작업은 완료됐으나 done 계약 미신고) → **fail-closed 정지 + failed_task 마커 영속**(R8). 2차: "[WARN] … may have left partial edits" 재개 경고 발화(R8) 후 4태스크 전부 완료.
  - **ultragoal**: Suite GREEN, 기준 6건 ⚠️ UNVERIFIED 정직 기록(R7), 따옴표 포함 기준이 리포트에 비맹글링 왕복(R12), suite_green/SUITE_GREEN 영속. 산출물 실검증: slugify 구현 정확(NFD 정규화·하이픈 붕괴·트림), bun test 6 pass / 0 fail.
- **라운드 13 종료** — 누적 23사이클. 라운드 7~12에서 실체화한 모든 게이트(합의·승인·실패마커·재개경고·정직검증·라운드트립)가 실모델 한 체인에서 합주 동작함을 증명. 마라톤의 양 축(메커니즘 구축 + 라이브 실증) 완결.
