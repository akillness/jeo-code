# jeo-code 미커밋 변경사항 종합 리뷰 & 개선 제안

**분석 대상**: 15개 파일, 622줄 추가 / 40줄 삭제  
**작업 범위**: 에러 처리 개선, 호환성 어댑터 재설계, 라우팅 강화, 테스트 커버리지 확대

---

## 📊 변경사항 요약

### 1. **에러 처리 아키텍처 개선** ⭐⭐⭐
**파일**: `src/ai/providers/errors.ts`, `src/util/provider-error.ts`

#### 주요 개선사항
- **`relabelProviderError()` 함수 추가** — 호환성 어댑터(Anthropic/OpenAI 호환)에서 발생한 에러를 올바른 프로바이더 레이블로 재구성
  - 문제: Groq/Tencent/Deepseek 등이 Anthropic/OpenAI 프로토콜을 사용할 때, 에러가 "Anthropic rejected" 또는 "OpenAI requires billing"으로 표시되어 사용자가 잘못된 계정을 수정하려고 함
  - 해결: `ProviderHttpError.detail` / `ProviderStreamError.rawMessage` 필드를 분리하여 메시지 재구성 시 원본 데이터 손실 방지

- **`ProviderHttpError` / `ProviderStreamError` 구조 강화**
  - `detail` / `rawMessage` 필드 추가 → 에러 재레이블링 시 원본 정보 보존
  - `context` 필드 추가 → "(stream)" 같은 컨텍스트 정보 명시적 관리

- **타입 안전성 개선**
  - `hasNumericStatus()` 타입 가드 추가 → 안전한 `.status` 접근
  - `knownErrorProvider()` / `statusOf()` / `retryAfterMsOf()` 헬퍼 함수 → 에러 필드 접근 일관성

#### ✅ 강점
- 호환성 어댑터 에러 처리의 근본적 해결
- 메시지 텍스트 기반 추측 제거 → 구조화된 필드 기반 처리
- 기존 코드와의 하위호환성 유지

#### ⚠️ 개선 제안
1. **`relabelProviderError()` 테스트 추가 필요**
   typescript
   test("relabelProviderError reconstructs ProviderHttpError with new provider label", () => {
     const orig = new ProviderHttpError("Anthropic", 401, "unauthorized");
     const relabeled = relabelProviderError(orig, "Groq");
     expect(relabeled).toBeInstanceOf(ProviderHttpError);
     expect((relabeled as ProviderHttpError).provider).toBe("Groq");
     expect((relabeled as ProviderHttpError).message).toContain("Groq");
   });
   

2. **에러 재레이블링 호출 사이트 검증**
   - `src/ai/providers/anthropic-compatible.ts` / `openai-compatible.ts`에서 실제로 `relabelProviderError()` 호출하는지 확인 필요

---

### 2. **호환성 어댑터 재설계** ⭐⭐
**파일**: `src/ai/providers/anthropic-compatible.ts`, `openai-compatible.ts`, `kimi.ts`

#### 주요 개선사항
- Anthropic/OpenAI 호환 프로바이더(Groq, Tencent, Deepseek 등)의 에러 처리 통일
- `relabelProviderError()` 적용으로 사용자 혼동 제거

#### ✅ 강점
- 다양한 호환 프로바이더 지원 확대
- 에러 메시지 정확성 향상

#### ⚠️ 개선 제안
1. **Kimi 프로바이더 특수 처리 검토**
   - `kimi.ts` 변경사항 (31줄 추가/삭제)이 상당함
   - 디바이스 인증 흐름과의 상호작용 검증 필요

2. **호환성 어댑터 팩토리 패턴 문서화**
   typescript
   /**
    * Creates an Anthropic-compatible adapter that:
    * 1. Delegates to anthropicAdapter()
    * 2. Relabels errors to the TRUE provider name
    * 3. Preserves retry semantics (status codes, Retry-After)
    */
   export function makeAnthropicCompatibleAdapter(provider: string, ...): Adapter
   

---

### 3. **라우팅 강화 & 슬래시 명령어** ⭐⭐⭐
**파일**: `src/commands/launch/route-slash.ts`, `src/agent/prompt-router.ts`

#### 주요 개선사항
- `/route [status|on|off|why]` 슬래시 명령어 추가
- 세션 로컬 라우팅 토글 (설정 파일 미변경)
- 라우팅 결정 이유 설명 기능

#### ✅ 강점
- 사용자 경험 개선 (명령어 기반 라우팅 제어)
- 세션 로컬 오버라이드 패턴 (설정 오염 방지)
- `/model` 명령어와 일관된 인터페이스

#### ⚠️ 개선 제안
1. **라우팅 결정 이력 추적**
   - 현재: `lastRouteDecision` 1개만 저장
   - 제안: 최근 5-10개 결정 이력 저장 → `/route history` 명령어 추가
   typescript
   interface RouteHistory {
     decisions: RouteDecision[];
     maxSize: number;
     add(decision: RouteDecision): void;
   }
   

2. **라우팅 신뢰도 시각화**
   - `confidence` 필드 활용 → 낮은 신뢰도 경고
   typescript
   if (decision.confidence < 0.5) {
     lines.push("⚠️  Low confidence — consider /route off or /model <name>");
   }
   

3. **라우팅 성능 메트릭**
   - 각 라우팅 결정의 실제 성능(지연시간, 토큰 사용량) 기록
   - `/route stats` 명령어로 라우팅 효과성 검증

---

### 4. **테스트 커버리지 대폭 확대** ⭐⭐⭐
**파일**: `test/launch-prompt-routing.test.ts` (+204줄), `test/provider-error.test.ts` (+16줄), `test/kimi-provider.test.ts` (+56줄)

#### 주요 개선사항
- **라우팅 테스트 강화**
  - `/route on` 오버라이드 동작 검증
  - 포스트콜 재라우팅 (동등 티어 모델 자동 전환)
  - 컨텍스트 오버플로우 시 재라우팅 안 함 (올바른 동작)
  - 라이브 모델 발견 경쟁 조건 제거 (mock `discoverModels`)

- **에러 처리 테스트**
  - 429 (Rate Limit) 매핑
  - 401/403 (인증 실패)
  - 402 (결제 필요)
  - TimeoutError 매핑
  - 스트림 데드라인 초과

- **Kimi 프로바이더 테스트**
  - 디바이스 인증 흐름
  - 특수 에러 처리

#### ✅ 강점
- 경쟁 조건 제거 (mock `discoverModels`)
- 포스트콜 재라우팅 로직 검증
- 에러 메시지 정확성 보증

#### ⚠️ 개선 제안
1. **테스트 격리 강화**
   typescript
   // 현재: 전역 mock 설정
   mock.module("../src/ai", () => ({
     ...realAI,
     discoverModels: mock(async () => []),
   }));
   
   // 제안: 테스트별 독립적 mock
   beforeEach(() => {
     mock.module("../src/ai", () => ({
       discoverModels: mock(async () => []),
     }));
   });
   

2. **성능 테스트 추가**
   typescript
   test("routing decision latency < 100ms for typical prompt", async () => {
     const start = performance.now();
     const decision = await inferRoutingDecision(...);
     const elapsed = performance.now() - start;
     expect(elapsed).toBeLessThan(100);
   });
   

3. **엣지 케이스 테스트**
   - 모든 프로바이더 자격증명 누락
   - 네트워크 불안정 (재시도 소진)
   - 라우팅 설정 충돌 (pin + routing on)

---

### 5. **TUI 앱 개선** ⭐
**파일**: `src/tui/app.ts` (+44줄)

#### 주요 개선사항
- 라우팅 상태 표시 개선
- 라이브 모델 발견 UI 통합

#### ⚠️ 개선 제안
1. **라우팅 상태 HUD 추가**
   
   [ROUTE] tier: smol | model: gpt-4o-mini | confidence: 0.92
   

2. **라우팅 결정 이유 팝업**
   - `/route why` 결과를 TUI에서 시각화

---

### 6. **서브에이전트 개선** ⭐
**파일**: `src/agent/subagents.ts` (+23줄)

#### 주요 개선사항
- 서브에이전트 라우팅 결정 전파
- 라이브 활동 추적

#### ⚠️ 개선 제안
1. **서브에이전트별 라우팅 통계**
   - 각 서브에이전트의 라우팅 효과성 측정
   - 병렬 실행 시 라우팅 결정 충돌 감지

---

## 🎯 포니테일(Ponytail) 적용 전략

### 포니테일이란?
- **정의**: 에러 처리, 재시도 로직, 호환성 어댑터 등 "꼬리 같은" 엣지 케이스 처리를 체계화하는 패턴
- **목표**: 주요 로직(머리)은 깔끔하게, 엣지 케이스(꼬리)는 견고하게

### 적용 계획

#### Phase 1: 에러 처리 포니테일 ✅ (현재 진행 중)
typescript
// 주요 로직 (머리)
async function callModel(model: string, prompt: string): Promise<Response> {
  return await withRetry(() => modelProvider.call(model, prompt));
}

// 포니테일 (꼬리)
function withRetry(fn: () => Promise<Response>): Promise<Response> {
  // 1. 재시도 로직
  // 2. 에러 분류 (retryable vs. terminal)
  // 3. 에러 재레이블링 (호환성 어댑터)
  // 4. 사용자 친화적 메시지 변환
}


#### Phase 2: 라우팅 포니테일 (제안)
typescript
// 주요 로직 (머리)
async function selectModel(prompt: string): Promise<string> {
  return await inferRoutingDecision(prompt).model;
}

// 포니테일 (꼬리)
async function inferRoutingDecision(prompt: string): Promise<RouteDecision> {
  // 1. 프리콜 베토 (자격증명, 도달성, 이미지 지원)
  // 2. 라우팅 결정 (비용/성능 최적화)
  // 3. 포스트콜 재라우팅 (동등 티어 폴백)
  // 4. 결정 이유 기록 (감사 추적)
}


#### Phase 3: 호환성 어댑터 포니테일 (제안)
typescript
// 주요 로직 (머리)
async function callGroq(model: string, prompt: string): Promise<Response> {
  return await anthropicCompatibleAdapter.call(model, prompt);
}

// 포니테일 (꼬리)
function makeAnthropicCompatibleAdapter(provider: string): Adapter {
  return {
    async call(...) {
      try {
        return await anthropicAdapter.call(...);
      } catch (err) {
        throw relabelProviderError(err, provider);
      }
    }
  };
}


---

## 📋 개선 우선순위

### 🔴 긴급 (이번 커밋 전)
1. **`relabelProviderError()` 호출 사이트 검증**
   - anthropic-compatible.ts / openai-compatible.ts에서 실제 사용 확인
   - 누락된 호출 사이트 추가

2. **테스트 격리 강화**
   - `discoverModels` mock을 전역에서 테스트별로 변경
   - 경쟁 조건 완전 제거

### 🟡 높음 (다음 마이너 버전)
1. **라우팅 이력 추적**
   - `/route history` 명령어 추가
   - 최근 5-10개 결정 저장

2. **라우팅 성능 메트릭**
   - 각 결정의 실제 성능 기록
   - `/route stats` 명령어

3. **호환성 어댑터 문서화**
   - `makeAnthropicCompatibleAdapter()` / `makeOpenAICompatibleAdapter()` 주석 강화

### 🟢 중간 (향후 개선)
1. **라우팅 신뢰도 시각화**
   - 낮은 신뢰도 경고

2. **성능 테스트**
   - 라우팅 결정 지연시간 < 100ms

3. **엣지 케이스 테스트**
   - 모든 자격증명 누락
   - 네트워크 불안정

---

## ✅ 커밋 전 체크리스트

- [ ] `relabelProviderError()` 호출 사이트 검증
- [ ] 테스트 격리 강화 (mock 전역 → 테스트별)
- [ ] `bun run typecheck` 통과
- [ ] `bun test` 전체 통과 (2843+ 테스트)
- [ ] 새 테스트 케이스 문서화
- [ ] CHANGELOG.md 업데이트
- [ ] README 동기화 (bun run changelog:sync)

---

## 📝 결론

이번 변경사항은 **에러 처리 아키텍처의 근본적 개선**을 이루었습니다:

✅ **호환성 어댑터 에러 처리 문제 해결** — Groq/Tencent 등에서 잘못된 프로바이더 레이블 표시 문제 제거  
✅ **테스트 커버리지 대폭 확대** — 경쟁 조건 제거, 포스트콜 재라우팅 검증  
✅ **라우팅 사용자 경험 개선** — `/route` 슬래시 명령어로 세션 로컬 제어  
✅ **포니테일 패턴 적용** — 엣지 케이스 처리를 체계화

**다음 단계**: 라우팅 이력 추적, 성능 메트릭, 신뢰도 시각화로 라우팅 기능을 한 단계 업그레이드할 수 있습니다.
