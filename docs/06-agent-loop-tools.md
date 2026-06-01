# 06 — Agent Loop & Tool Calling Spec

본 문서는 `gajae-code` (`gjc`)의 상태 보유 에이전트 런타임 내 핵심 동작 제어부인 **에이전트 루프(Agent Loop)**와 **도구 호출 규약(Tool Calling Contract)**을 심층 조사하고, 이를 새롭게 구현할 `jeo-code` (`jeoc`) 에이전트 엔진이 참고할 수 있도록 아키텍처 및 구현 명세를 한국어로 정리한다.

## 1. 개요 (Overview)

`gajae-code` 에이전트 아키텍처의 중심에는 상태와 히스토리를 유지하면서 LLM의 추론과 도구 실행을 반복 조율하는 **Turn-Loop** 메커니즘이 존재한다. 이 시스템은 각 회차(Turn)마다 컨텍스트 변환, 프로바이더 API 호출, 응답 스트리밍, 도구 파싱 및 실행, 실행 결과의 메시지 환류 및 상태 갱신을 수행한다.

### 핵심 소스 코드 경로 (1차 레퍼런스)
- **턴 루프 제어 및 도구 실행 분기**: `@gajae-code/agent-core/src/agent-loop.ts`
- **에이전트 인스턴스, 상태 및 생명주기 API**: `@gajae-code/agent-core/src/agent.ts`
- **메시지, 도구, 이벤트 타입 정의**: `@gajae-code/agent-core/src/types.ts`
- **도구 레지스트리 및 팩토리**: `@gajae-code/coding-agent/src/tools/index.ts`
- **실제 도구 구현**:
  - PTY/셸 명령어 실행: `@gajae-code/coding-agent/src/tools/bash.ts`
  - 파일 및 디렉터리 읽기: `@gajae-code/coding-agent/src/tools/read.ts`

---

## 2. 턴 루프(Turn-Loop) 프로세스 및 의사코드

에이전트 루프는 LLM과의 1회성 요청-응답 경계를 넘어, **"LLM의 도구 호출 -> 도구 실행 -> 결과 환류 -> LLM의 추가 추론"** 과정을 하나의 논리적 턴(Turn)으로 묶고, 외부 입력(사용자 제어 메시지, 백그라운드 이벤트)에 유연하게 대처할 수 있도록 이중 루프 구조를 취한다.

### 에이전트 루프 흐름도

```text
       [시작: agentLoop / agentLoopContinue]
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  Steering Messages 처리 및 주입   │ ◀──────┐ (사용자 중간 개입)
        └──────────────────────────────────┘        │
                         │                          │
                         ▼                          │
        ┌──────────────────────────────────┐        │
        │ syncContextBeforeModelCall 훅 실행 │        │
        └──────────────────────────────────┘        │
                         │                          │
                         ▼                          │
        ┌──────────────────────────────────┐        │
        │     streamAssistantResponse      │        │
        │ (AgentMessage[] ──► Message[])   │        │
        │     LLM 호출 및 응답 스트리밍    │        │
        └──────────────────────────────────┘        │
                         │                          │
                         ├──────────────────────────┼──────────────┐
                         ▼                          │              ▼
                  [도구 호출 존재?]                │       [비정상 종료?]
                     /       \                      │       (error/aborted)
                  YES         NO                    │              │
                   /           \                    │              ▼
                  ▼             └─────────┐         │    ┌──────────────────┐
        ┌──────────────────┐              │         │    │ Placeholder 도구 │
        │ executeToolCalls │              │         │    │  결과 생성/주입  │
        │  (도구 동시 실행) │              │         │    └──────────────────┘
        └──────────────────┘              │         │              │
                 │                        │         │              ▼
                 ▼                        ▼         │      [에이전트 종료]
        ┌──────────────────┐      ┌───────────────┐ │
        │  도구 결과 메시지 │      │ turn_end 이벤트│ │
        │  (`toolResult`)  │      └───────────────┘ │
        │   히스토리 환류  │              │         │
        └──────────────────┘              ▼         │
                 │               [중간 개입 메시지  │
                 └───────────────►  대기열 존재?] ──┘
                                      /       \
                                   YES         NO
                                    /           \
                                   ▼             ▼
                           (Turn 반복 실행)  ┌──────────────────┐
                                             │ onBeforeYield 훅 │
                                             └──────────────────┘
                                                      │
                                                      ▼
                                             [Follow-up 존재?]
                                               /           \
                                            YES             NO
                                            /                 \
                                           ▼                   ▼
                                    (외부 루프 계속)     [최종 에이전트 종료]
```

### Canonical Turn-Loop 의사코드 (Pseudocode)

아래 코드는 `agent-loop.ts`의 `runLoopBody` 및 `streamAssistantResponse`를 관통하는 핵심 로직을 표현한 것이다.

```typescript
// @gajae-code/agent-core/src/agent-loop.ts 기반 의사코드
import { AgentContext, AgentLoopConfig, AgentMessage, ToolResultMessage } from "./types";

async function runLoopBody(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>
): Promise<void> {
  let firstTurn = true;
  // (1) 중간 조향 메시지(Steering) 초기화 (대기열에서 꺼냄)
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

  // [Outer Loop]: 추가적인 follow-up 태스크가 들어오는 동안 반복
  while (true) {
    let hasMoreToolCalls = true;

    // [Inner Loop]: 도구 호출 흐름이 이어지거나 조향 메시지가 대기 중일 때 반복
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        stream.push({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      // (2) 중간 조향 메시지가 있다면 먼저 에이전트 히스토리에 삽입
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          stream.push({ type: "message_start", message });
          stream.push({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = []; // 처리 완료 후 비움
      }

      // (3) 모델 호출 전 컨텍스트와 도구 상태 동기화
      if (config.syncContextBeforeModelCall) {
        await config.syncContextBeforeModelCall(currentContext);
      }

      // (4) LLM 호출 및 스트리밍 응답 획득 (streamAssistantResponse)
      let message: AssistantMessage;
      try {
        message = await streamAssistantResponse(currentContext, config, signal, stream);
      } catch (err) {
        // 복구 불가능한 에러 시 루프 중단 및 전파
        throw err;
      }
      newMessages.push(message);

      // (5) LLM 요청이 취소되었거나 에러가 발생한 경우 예외 처리
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        // API 규격 준수를 위해 미완료 도구 호출들에 대한 placeholder 결과 강제 생성
        const toolCalls = message.content.filter(c => c.type === "toolCall");
        const toolResults: ToolResultMessage[] = [];
        for (const toolCall of toolCalls) {
          const result = createAbortedToolResult(toolCall, stream, message.stopReason, message.errorMessage);
          currentContext.messages.push(result);
          newMessages.push(result);
          toolResults.push(result);
        }
        stream.push({ type: "turn_end", message, toolResults });
        stream.push({ type: "agent_end" });
        return;
      }

      // (6) 도구 호출 존재 여부 분석
      const toolCalls = message.content.filter(c => c.type === "toolCall");
      hasMoreToolCalls = toolCalls.length > 0;
      let steeringMessagesFromExecution: AgentMessage[] | undefined;

      const toolResults: ToolResultMessage[] = [];
      if (hasMoreToolCalls) {
        // (7) 도구들을 동시성 규약에 맞게 스케줄링하여 실행 (executeToolCalls)
        const executionResult = await executeToolCalls(
          currentContext,
          message,
          signal,
          stream,
          config
        );
        toolResults.push(...executionResult.toolResults);
        steeringMessagesFromExecution = executionResult.steeringMessages;

        // 실행 결과를 에이전트 대화 히스토리에 공식 병합
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      // (8) 턴 종료 이벤트 발행
      stream.push({ type: "turn_end", message, toolResults });

      // (9) 실행 도중 접수된 조향 메시지 또는 폴링 획득
      pendingMessages = steeringMessagesFromExecution ?? ((await config.getSteeringMessages?.()) || []);
    }

    // [Inner Loop 종료]: 에이전트가 동작을 멈추기 전 정리 훅 호출
    await config.onBeforeYield?.();

    // [Follow-Up 검사]: 백그라운드 태스크 등 지속 루프 메시지 확인
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue; // Outer Loop 반복
    }

    break; // 더 이상 대기 메시지가 없다면 완전히 중단
  }

  stream.push({ type: "agent_end" });
}

// @gajae-code/agent-core/src/agent-loop.ts 의사코드
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>
): Promise<AssistantMessage> {
  // 1. 컨텍스트 필터링/압축 변환 적용 (예: 오래된 메시지 절삭)
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // 2. 에이전트 내부 메시지 구조(AgentMessage)를 LLM 호환 구조(Message)로 변환
  const llmMessages = await config.convertToLlm(messages);
  const normalizedMessages = normalizeMessagesForProvider(llmMessages, config.model);

  // 3. 프로바이더 컨텍스트 구성 (System Prompt, 대화 목록, 정규화된 도구 정보)
  const llmContext = {
    systemPrompt: context.systemPrompt,
    messages: normalizedMessages,
    tools: normalizeTools(context.tools, !!config.intentTracing),
  };

  // 4. 로컬 AI 패키지를 사용해 LLM 스트리밍 호출
  return await config.streamFn(llmContext, config, signal);
}
```

---

## 3. AgentTool 규약 및 도구 레지스트리 (AgentTool Contract)

gajae-code는 에이전트가 호출할 수 있는 기능을 **도구(Tool)**라는 일급 객체 규격으로 관리한다. 이 규격은 단순히 모델에 제공할 파라미터 스키마뿐만 아니라 실행 제어, 예외 완화, 사용자 UI 렌더링 방식까지 정의한다.

### AgentTool 인터페이스 사양
`@gajae-code/agent-core/src/types.ts`에 정의된 `AgentTool` 규약은 다음과 같다.

```typescript
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown>
  extends Tool<TParameters> {
  /** 모델이 식별할 고유 도구 이름 (예: "bash") */
  name: string;
  /** CLI / GUI UI에 표시될 인간 가독성 좋은 라벨 */
  label: string;
  /** 필수 로딩 대상 여부 ("essential" | "discoverable") */
  loadMode?: "essential" | "discoverable";
  /** 도구 쓰임새 요약 인덱스 */
  summary?: string;
  /** 입출력 파라미터의 JSON 스키마를 표현하는 Zod/TypeBox 스키마 */
  parameters: TParameters;
  /** 도구 실행 시 취소 신호(AbortSignal) 차단 여부 */
  nonAbortable?: boolean;
  /** 동시 실행 모드:
   * - "shared": 병렬로 함께 실행될 수 있음 (기본값)
   * - "exclusive": 1개씩만 순차 실행. 다른 도구들은 대기해야 함.
   */
  concurrency?: "shared" | "exclusive";
  /** 인자 검증 실패 시 즉시 LLM 에러 리턴 대신 유연하게 문자열 인자를 execute()로 보낼지 여부 */
  lenientArgValidation?: boolean;
  /** 의도 정보 (`_i`) 처리 모드 ("require" | "optional" | "omit" | 함수)
   * gjc는 에이전트의 자기 모니터링을 위해 도구 호출 목적을 `_i` 파라미터로 명시하도록 요구함.
   */
  intent?: "omit" | "optional" | "require" | ((args: Partial<Static<TParameters>>) => string | undefined);

  /** 실제 동작을 실행하는 메서드 */
  execute: AgentToolExecFn<TParameters, TDetails, TTheme>;

  /** UI 렌더링 콜백 */
  renderCall?: (args: Static<TParameters>, options: RenderResultOptions, theme: TTheme) => unknown;
  renderResult?: (result: AgentToolResult<TDetails, TParameters>, options: RenderResultOptions, theme: TTheme) => unknown;
}
```

### 도구 실행 결과 객체 (`AgentToolResult`)
도구 실행이 끝나면 LLM 반환 및 화면 출력을 위해 규격화된 결과를 제공해야 한다.
```typescript
export interface AgentToolResult<T = any, _TInput = unknown> {
  /** 텍스트 및 이미지 데이터 블록들의 배열 (LLM 전달용) */
  content: (TextContent | ImageContent)[];
  /** 상세 메타데이터나 내부 로그 (UI 출력 및 분석기용) */
  details?: T;
  /** 실행이 정상 흐름 내부에서 실패했음을 LLM에 나타내는 명시적 플래그 */
  isError?: boolean;
}
```

### 도구 레지스트리 아키텍처
`@gajae-code/coding-agent/src/tools/index.ts`는 가용한 모든 빌트인 도구를 중앙 관리한다.
- `BUILTIN_TOOLS`: `Record<string, ToolFactory>` 형태로 구성되며, `read`, `bash`, `edit`, `ast_grep`, `find`, `search` 등의 주력 도구가 포함된다.
- `HIDDEN_TOOLS`: 특수한 라이프사이클 도구인 `yield` (작업 완수 제출), `resolve` (보류된 조치 승인) 등이 포함된다.

---

### 대표적인 두 가지 구체적 도구 명세

#### 1) BashTool (`bash.ts`)
- **역할**: PTY 세션 또는 독립 프로세스 상에서 Bash 셸 명령어를 실행한다.
- **동시성 옵션**: `exclusive` (셸 환경이 서로 꼬이지 않도록 격리하여 하나씩 실행).
- **입력 스키마 (`bashSchemaBase`)**:
  ```json
  {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "command to execute" },
      "env": { "type": "object", "additionalProperties": { "type": "string" }, "description": "extra env vars" },
      "timeout": { "type": "number", "default": 300, "description": "timeout in seconds" },
      "cwd": { "type": "string", "description": "working directory" },
      "pty": { "type": "boolean", "description": "run in pty mode" }
    },
    "required": ["command"]
  }
  ```
- **출력 구성**:
  - 정상: 터미널 표준 출력/표준 에러 병합 텍스트를 `content` 블록에 담아 반환.
  - 비정상(0이 아닌 종료 코드): `ToolError` 예외를 발생시키거나 `isError: true`로 마크한 실패 원문 텍스트 반환.

#### 2) ReadTool (`read.ts`)
- **역할**: 로컬 파일, 아카이브(.zip 등), 데이터베이스(SQLite), URL 리소스를 읽고 가공한다.
- **동시성 옵션**: `shared` (파일 읽기 등은 병합에 악영향을 미치지 않으므로 동시 처리 가능).
- **입력 스키마 (`readSchema`)**:
  ```json
  {
    "type": "object",
    "properties": {
      "path": { 
        "type": "string", 
        "description": "path or url; append :<sel> for line ranges or raw mode (e.g. \"src/foo.ts:50-100\")" 
      }
    },
    "required": ["path"]
  }
  ```
- **특이 사항**:
  - `<path>:<line-range>` 파싱 지원 (예: `src/main.ts:20-50` 또는 `src/main.ts:raw`).
  - `.pdf`, `.docx`, `.xlsx` 등의 바이너리 오피스 포맷 발견 시 자체 내장 `markit` 인프라를 통해 Markdown 구조로 변환하여 텍스트로 조회.
  - 대용량 파일 조회 시 토큰 폭발을 막기 위해 디폴트 라인 한계(예: 300라인)를 두어 자동 생략/축소(Truncation) 처리하고 메타 노티스 표시.

---

## 4. 도구 실행 흐름 및 메시지 피드백

모델이 생성한 결과 안에 `toolCall`이 있을 경우, 턴 루프는 이를 즉각적인 순서 제어 하에 가공하여 도구 인스턴스로 전달한다.

```text
모델 출력 ──► [toolCall 추출] ──► [인자 검증: validateToolArguments]
                                          │
                                          ▼
                                ┌──────────────────┐
                                │  beforeToolCall  │ ──► [사전 검증 및 차단 가능]
                                └──────────────────┘
                                          │
                                          ▼
                               [concurrency 스케줄링]
                                   /           \
                           (shared)             (exclusive)
                            /                     \
                           ▼                       ▼
                     [병렬 대기열]               [순차 대기열]
                           │                       │
                           └───────────┬───────────┘
                                       │
                                       ▼
                                [tool.execute()]
                                       │
                                       ▼
                                ┌──────────────────┐
                                │  afterToolCall   │ ──► [사후 가공 및 재포맷]
                                └──────────────────┘
                                          │
                                          ▼
                                 [ToolResultMessage]
                                (role: "toolResult")
                                          │
                                          ▼
                                 [에이전트 히스토리 환류]
```

### 상세 실행 메커니즘
1. **인자 정규화 및 검증**:
   - `intentTracing`이 켜져 있으면 인자 내에 숨어 있는 `_i` (의도 설명용 메타 필드) 값을 추출하여 `intent` 속성으로 격리하고 본래의 도구 인자에서 제거한다.
   - `validateToolArguments` 함수를 거쳐 도구에 구성된 Zod 파라미터 스키마로 검증을 통과시킨다. (단, `lenientArgValidation`이 설정된 경우 검증 실패를 예외로 처리하지 않고 원본 문자열을 넘겨 실행을 유도한다).

2. **동시성 큐 구성 (`concurrency` 제어)**:
   - 한 턴에 복수 개의 도구 호출이 동시에 반환되는 경우가 있다. (예: 3개 파일 동시 읽기 및 셸 명령 동시 실행).
   - 각 도구의 `concurrency` 속성이 `"exclusive"`인 경우 직전 도구 타스크들이 모두 해결될 때까지 `Promise.all` 스케줄링을 통해 차단 상태를 만든다.
   - `"shared"` 도구는 먼저 실행되어 대기열을 병렬로 통과한다.

3. **라이프사이클 훅 실행**:
   - **`beforeToolCall`**: 도구가 실제로 연동되기 직전에 인스턴스 정보와 인자를 들여다보고 강제로 실행을 차단(`block`)하거나 인자를 추가 변조할 수 있는 게이트 역할을 한다.
   - **`afterToolCall`**: 도구 실행 결과인 `AgentToolResult` 데이터를 사후 처리한다. 반환된 콘텐츠를 마스킹하거나 실패한 데이터를 에러 포맷으로 래핑할 수 있다.

4. **메시지 히스토리 피드백 구조**:
   - 도구 실행의 결과는 `ToolResultMessage` 타입의 독립적 객체로 전환된다.
   ```typescript
   const toolResultMessage: ToolResultMessage = {
     role: "toolResult",
     toolCallId: toolCall.id,
     toolName: toolCall.name,
     content: result.content,  // LLM에 들어갈 순수 텍스트/이미지 내용
     details: result.details,  // 상세 구조화 객체
     isError: isError,         // 실행 도중 에러가 났는지 여부
     timestamp: Date.now()
   };
   ```
   - 이 피드백 객체는 즉시 `currentContext.messages.push`를 통해 전체 대화 상태에 추가되며, 다음 LLM 프롬프트에 동반 전송된다.

5. **실패 및 예외 시의 플레이스홀더 처리**:
   - 만약 도구 실행 중 타임아웃, 중단(Abort), 예상하지 못한 에러가 나면 턴 루프는 이를 완전히 무시하고 건너뛰는 것이 아니라 `createAbortedToolResult` 또는 `createSkippedToolResult` 등을 생성해 LLM 규격을 깨지 않는다. (LLM은 자신이 요청한 모든 `toolCallId`에 매칭되는 `toolResult`를 반드시 받아야 정상 파싱 가능함).

---

## 5. 루프 중단 조건 (Stop Conditions)

에이전트가 무한 루프에 빠져 크레딧을 조기 소진하는 일을 예방하고 제어 신호에 완벽하게 순응하기 위해 다음 4가지 루프 중단 수단을 탑재한다.

| 중단 사유 | 검증 로직 | 설명 |
| :--- | :--- | :--- |
| **1. 도구 호출 미발생** | `toolCalls.length === 0` | LLM이 더 이상 도구(Tool Call)를 쓰지 않고 일반 텍스트 응답만 줄 때 종료를 의미한다. (단, 대기 중인 Steering/Follow-Up 메시지가 없어야 함). |
| **2. 최대 턴 수 초과** | `stepCounter.count >= config.maxTurns` | 설정된 회차 한도(예: 30회)를 넘을 경우 루프를 강제 차단하여 API 소진을 차단한다. |
| **3. 외부 중단 신호** | `signal?.aborted` | 외부 사용자 인터페이스에서 캔슬이나 리셋을 누를 때 발생하며, `AbortSignal`이 전파되어 현재 가동 중인 하위 셸이나 파일 핸들까지 전파해 중단한다. |
| **4. 프로바이더 수준 취소** | `message.stopReason === "error" \|\| "aborted"` | LLM API 측에서 토큰 한계(Max Token Limit) 도달이나 세션 중단으로 강제 에러 종료된 경우로, 플레이스홀더 결과를 주입해 최소한의 응답을 갈무리한 후 반환한다. |

---

## 6. jeoc 최소 에이전트 루프 (jeoc 최소 에이전트 루프)

`jeo-code` (`jeoc`)가 GJC의 아키텍처 철학을 계승하여 동작하는 데 필요한 **가장 핵심적이고 경량화된 형태의 최소 에이전트 루프** 명세이다.

### 1) 통합 입출력 JSON 형태 명세

#### 요청 (LLM API 호출 시)
```json
{
  "model": "gemini-2.5-flash",
  "system_instruction": "You are a pragmatic coding agent. Utilize tools to satisfy the goal.",
  "messages": [
    {
      "role": "user",
      "content": [{ "type": "text", "text": "Read the file 'src/index.ts' and execute build." }]
    }
  ],
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "read",
          "description": "Read file contents",
          "parameters": {
            "type": "OBJECT",
            "properties": {
              "path": { "type": "STRING", "description": "file path to read" }
            },
            "required": ["path"]
          }
        },
        {
          "name": "bash",
          "description": "Run shell command",
          "parameters": {
            "type": "OBJECT",
            "properties": {
              "command": { "type": "STRING", "description": "shell command to run" }
            },
            "required": ["command"]
          }
        }
      ]
    }
  ]
}
```

#### 응답 (LLM의 도구 호출 반환)
```json
{
  "content": {
    "parts": [
      {
        "functionCall": {
          "name": "read",
          "args": { "path": "src/index.ts" }
        }
      }
    ]
  },
  "finishReason": "STOP"
}
```

---

### 2) TypeScript 기반 최소 에이전트 루프 소스 코드 명세
`jeoc` CLI 바이너리가 이식할 핵심 엔진 파일 `src/autopilot.ts` 등에 이식하기 적합한 최소 코드는 다음과 같다.

```typescript
// jeoc/src/autopilot.ts - 최소 지향 에이전트 루프 구현체 예시
import { GoogleGenAI } from "@google/genai"; // Gemini SDK 예시
import * as fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// 1. 최소 사양 도구 정의
const minimialTools = {
  read: async (args: { path: string }) => {
    try {
      const data = await fs.readFile(args.path, "utf-8");
      return { content: `[FILE: ${args.path}]\n${data}` };
    } catch (e: any) {
      return { content: `Failed to read ${args.path}: ${e.message}`, isError: true };
    }
  },
  bash: async (args: { command: string }) => {
    try {
      const { stdout, stderr } = await execAsync(args.command);
      return { content: stdout || stderr || "(no output)" };
    } catch (e: any) {
      return { content: `Command failed: ${e.message}`, isError: true };
    }
  }
};

// 2. 루프를 구동하기 위한 상태 및 인터페이스
interface ChatMessage {
  role: "user" | "model" | "function";
  parts: any[];
}

export async function runJeocMinimalLoop(
  userPrompt: string,
  maxTurns = 10
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const modelName = "gemini-2.5-flash";

  // 시스템 지침 정의
  const systemInstruction = "You are jeoc, a lightweight coding agent. Call tools when needed.";

  // 대화 기록 초기화
  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ text: userPrompt }]
    }
  ];

  // 도구 명세 준비
  const toolDeclarations = [
    {
      functionDeclarations: [
        {
          name: "read",
          description: "Read text files from disk",
          parameters: {
            type: "OBJECT",
            properties: {
              path: { type: "STRING" }
            },
            required: ["path"]
          }
        },
        {
          name: "bash",
          description: "Execute terminal shell command",
          parameters: {
            type: "OBJECT",
            properties: {
              command: { type: "STRING" }
            },
            required: ["command"]
          }
        }
      ]
    }
  ];

  let turn = 0;
  while (turn < maxTurns) {
    turn++;
    console.log(`[jeoc Loop] Turn ${turn}/${maxTurns} - Model 호출 대기 중...`);

    // (A) Gemini API 호출
    const response = await ai.models.generateContent({
      model: modelName,
      contents: messages as any,
      config: {
        systemInstruction,
        tools: toolDeclarations
      }
    });

    const candidate = response.candidates?.[0];
    const responseParts = candidate?.content?.parts || [];

    // 모델의 응답을 대화 기록에 임시 추가
    messages.push({
      role: "model",
      parts: responseParts
    });

    // (B) 도구 호출(functionCalls) 목록 필터링
    const functionCalls = responseParts.filter(part => part.functionCall);

    if (functionCalls.length === 0) {
      // 도구 호출이 없다면 에이전트 최종 목적 달성 또는 단순 응답 상태
      console.log("[jeoc Loop] 에이전트 목표 수립 완료.");
      return response.text || "완료되었습니다.";
    }

    // (C) 각 도구 호출 처리 및 결과 대입
    for (const call of functionCalls) {
      const { name, args, id } = call.functionCall;
      console.log(`[jeoc Loop] 도구 실행 지시 감지: ${name}(${JSON.stringify(args)})`);

      let toolResultText = "";
      if (name in minimialTools) {
        const handler = minimialTools[name as keyof typeof minimialTools];
        const res = await handler(args as any);
        toolResultText = res.content;
      } else {
        toolResultText = `Error: Tool '${name}' is not supported in jeoc minimal engine.`;
      }

      // (D) 도구 결과를 function 타입 메시지로 대화 이력에 푸시 (환류 단계)
      messages.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name,
              response: { result: toolResultText }
            }
          }
        ]
      });
    }
  }

  throw new Error(`Max turns reached (${maxTurns}) without completing task.`);
}
```

### 3) 주요 환경 변수 명세
`jeoc` 런타임 가동을 위한 최소 환경 변수는 다음과 같다.

- `GEMINI_API_KEY`: Google Gemini API 연결 및 요금 결제를 위한 인증 토큰. (필수)
- `JEOC_CWD`: 에이전트 도구 실행 시 기본 작업 디렉터리로 삼을 경로. 기본값은 현재 프로세스 실행 경로.
- `JEOC_MAX_TURNS`: 무한 루프를 회피하기 위해 기본 차단할 최대 회차 한계 설정치. (기본값: 15)
