# LinkedIn Promo — jeo-code (dna*claw)

> 게시 대상: https://www.linkedin.com/feed/ · 동영상 첨부(데모) · 한/영 병기
> 프로젝트: https://github.com/akillness/jeo-code
> 모티브/감사: https://github.com/Yeachan-Heo/gajae-code (이재규 · 허예찬)

---

## 🇰🇷 한국어 본문

🧬 **나만의 개인 코딩 에이전트를 직접 만들었습니다 — jeo-code (dna\*claw)**

gajae-code를 바탕으로, 이재규 님과 허예찬 님의 인사이트와 개발 철학을 모티브 삼아
저만의 AI 코딩 에이전트 **jeo-code**를 오픈소스로 개발해볼 수 있었습니다.

jeo-code는 Bun 기반의 순수 TypeScript CLI 코딩 에이전트입니다(네이티브 의존성 0).
"검증 없는 완료 선언은 완료가 아니다"라는 철학을 코드로 강제하는 데 집중했습니다:

✅ **Spec-first 워크플로** — deep-interview(소크라테스식 요구사항 인터뷰) → ralplan(저장소를 직접 읽는 Critic 합의 게이트) → approve(평결 요구) → team(실행) → ultragoal(정직한 검증)까지, 모든 핸드오프에 실패 가능한 진짜 게이트
✅ **편집 무결성** — 콘텐츠 앵커(hashline) 검증·자동 재매핑으로 파일 오염 원천 차단
✅ **자기수정 루프** — post-edit 훅(tsc/테스트) 진단을 에이전트가 직접 읽고 done 전에 스스로 고침
✅ **멀티 프로바이더** — Anthropic / OpenAI / Gemini / Antigravity / Ollama를 단일 JSON 도구 루프로

가장 큰 배움은 "에이전트의 능력"보다 **"에이전트가 거짓말할 수 없게 만드는 구조"**가
실사용 품질을 결정한다는 것이었습니다. 이 관점 자체를 gajae-code의 설계에서 배웠습니다.

🙏 영감과 기반을 주신 이재규 님, 허예찬 님께 감사드립니다.
원작 오픈소스: https://github.com/Yeachan-Heo/gajae-code

🔗 jeo-code (dna\*claw): https://github.com/akillness/jeo-code
⭐ 피드백과 스타는 큰 힘이 됩니다!

#AI #CodingAgent #OpenSource #LLM #Bun #TypeScript #DevTools #jeo-code #gajaecode

---

## 🇺🇸 English Version

🧬 **I built my own personal coding agent — jeo-code (dna\*claw)**

Building on **gajae-code**, and inspired by the insights and engineering philosophy of
**Jaegyu Lee (이재규)** and **Yeachan Heo (허예찬)**, I was able to develop my own
open-source AI coding agent: **jeo-code**.

jeo-code is a pure-TypeScript, Bun-based CLI coding agent (zero native dependencies).
Its core obsession: *a completion claim without verification is not a completion* —
enforced in code, not in prose:

✅ **Spec-first workflow** — deep-interview (Socratic requirements) → ralplan (a repo-grounded
Critic consensus gate that can actually BLOCK) → approve (verdict required) → team (execution)
→ ultragoal (honest verification). Every handoff has a real, failable gate.
✅ **Edit integrity** — content-anchored (hashline) edits with verification and automatic
re-mapping, so the agent can never silently corrupt a file
✅ **Self-correcting loop** — post-edit hook diagnostics (tsc/tests) are fed back to the agent,
which fixes them before it is allowed to call done
✅ **Multi-provider** — Anthropic / OpenAI / Gemini / Antigravity / Ollama behind one uniform
JSON tool loop

My biggest takeaway: what determines real-world quality is not how capable the agent is,
but **how structurally impossible it is for the agent to lie about its work** — a perspective
I learned directly from gajae-code's design.

🙏 Huge thanks to Jaegyu Lee and Yeachan Heo for the inspiration and the foundation.
Original open source: https://github.com/Yeachan-Heo/gajae-code

🔗 jeo-code (dna\*claw): https://github.com/akillness/jeo-code
⭐ Stars and feedback are always appreciated!

#AI #CodingAgent #OpenSource #LLM #Bun #TypeScript #DevTools #jeo-code #gajaecode

---

## 게시 메모

- 동영상: `/skill:remotion-video-production`으로 제작한 데모(터미널 워크플로 데모 — 인터뷰→플랜→승인→실행→검증 체인과 자기수정 루프 하이라이트)를 첨부
- LinkedIn 초안: `/skill:browser-harness`로 https://www.linkedin.com/feed/ 에서 작성(게시 전 초안 상태로 저장)
- 멘션 대상(영문 프로필에 한글 이름 표기): **허예찬**, **이재규** — 작성 시 @멘션 검색은 한글 이름으로
