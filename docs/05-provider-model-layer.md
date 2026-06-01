# 05 — Provider/Model Layer (프로바이더 및 모델 레이어)

본 문서는 `gajae-code` (`gjc`)의 `@gajae-code/ai` 패키지 소스 코드를 심층 분석하여, AI 프로바이더 통합, 모델 레지스트리, API 키 인증 및 관리 방식을 정리한 개발자 가이드이자 구현 명세서입니다. 별도 구현체인 `jeo-code` (`jeoc`)가 이 패턴을 완벽히 미러링하여 자체 에이전트 인프라로 기능할 수 있도록 실전적이고 명확한 명세를 제공합니다.

---

## 1. 아키텍처 및 핵심 파일 관계

`@gajae-code/ai` 패키지는 LLM 프로바이더별 통신 규격과 내부 에이전트 시스템 간의 추상화 경계를 정의합니다. 핵심 파일과 역할은 다음과 같습니다.

| 파일 경로 (Cite Path) | 설명 및 역할 |
| :--- | :--- |
| `src/types.ts` | `Model`, `Message` (User/Assistant/Developer/ToolResult), `ToolCall`, `Usage` 등 전체 시스템 계약 정의 |
| `src/stream.ts` | 프로바이더 매핑 및 환경변수를 활용한 기본 API 키 바인딩, 스트리밍 오케스트레이션 |
| `src/model-manager.ts` | 정적/동적 모델 수집 및 캐싱 전략 (`resolveProviderModels`) |
| `src/models.ts` | `models.json`에 정의된 정적 모델 명세를 데이터 구조로 로드 및 비용 계산 |
| `src/auth-storage.ts` | API 키와 OAuth 토큰의 SQLite 저장 및 라운드 로빈 선택 정책 (`AuthStorage`) |
| `src/providers/anthropic.ts` | Anthropic Messages API 프로바이더 구현 (도구 맵핑, 캐싱, 스태인리스 헤더, 스트림) |
| `src/providers/google-shared.ts` | Google Gemini와 Cloud Code Assist API의 공통 부분 구현 및 REST 페이로드 제어 |
| `src/providers/google-types.ts` | Gemini REST/SSE 전송을 위한 입출력 타입 정의 (`GenerateContentParameters`) |
| `src/providers/google.ts` | `google-shared`를 래핑하여 public Gemini API 통합 (v1beta 엔드포인트 연동) |
| `src/providers/openai-completions.ts` | OpenAI Chat Completions API 프로바이더 및 호환 게이트웨이(DeepSeek, Kimi, vLLM) 대응 |
| `src/providers/mock.ts` | 테스트를 위한 결정론적 모의(Mock) 프로바이더 구현 (`MockModel`) |

---

## 2. 모델 ID 및 API Key Resolution (해석과 바인딩)

### 2.1 모델 해석 (Model Resolution)
`src/models.ts` 및 `src/model-manager.ts`는 모델 식별자가 들어왔을 때 이를 해석하는 흐름을 담당합니다.
1. **정적 레지스트리**: `src/models.ts`가 가동 시 `src/models.json`을 파싱하여 메모리 맵 `modelRegistry`에 올립니다.
2. **Model 인터페이스**: `types.ts`에 정의된 `Model` 인스턴스는 다음과 같은 상세 메타데이터를 운반합니다.
   - `api`: 프로바이더가 소통해야 하는 API 스키마 규격 (`"anthropic-messages"`, `"google-generative-ai"`, `"openai-completions"` 등).
   - `provider`: 내부 식별용 프로바이더명 (`"anthropic"`, `"google"`, `"openai"`, `"mock"` 등).
   - `baseUrl`: 프로바이더 API 호출 기본 엔드포인트.
   - `wireModelId`: 내부 식별 아이디와 프로바이더 실제 서빙 모델명이 다를 때 사용하는 대체 필드.
   - `compat`: 게이트웨이나 호환 클라이언트 대응을 위한 미세 조정 플래그들의 모음.

### 2.2 API 키 검색 정책 (API Key Resolution)
`src/stream.ts`와 `src/auth-storage.ts`에 따라 API 키는 두 가지 경로로 조회됩니다.
1. **환경 변수 바인딩 (Environment Variables)**:
   기본적으로 외부 저장소 설정 없이 터미널 실행 환경변수로부터 직접 키를 바인딩하여 빠르게 구동합니다.
   - `openai` 계열: `process.env.OPENAI_API_KEY`
   - `google` 계열: `process.env.GEMINI_API_KEY`
   - `anthropic` 계열: `process.env.ANTHROPIC_API_KEY` 또는 `process.env.ANTHROPIC_OAUTH_TOKEN`
   - `deepseek`: `process.env.DEEPSEEK_API_KEY`
   - `xai`: `process.env.XAI_API_KEY`
2. **인증 디스크 저장소 (`AuthStorage`)**:
   `src/auth-storage.ts`는 로컬 SQLite 데이터베이스(`~/.gjc` 또는 `.gjc/` 디렉토리 하위의 `auth_credentials` 테이블)를 활용해 등록된 다중 API 키 및 OAuth 크리덴셜을 로드합니다.
   - **라운드 로빈 정책**: 다중 API 키가 등록된 경우, API 한도 관리(`UsageReport`)와 매칭하여 가용한 키들 간에 라운드 로빈 방식으로 사용 키를 결정합니다.
   - **Config Value Resolver**: 데이터베이스 저장 필드명이 실제 암호화값 또는 환경 변수 이름일 수 있으므로 `defaultConfigValueResolver`가 `process.env[config]` 조회를 병행하여 실제 토큰 스트링을 반환합니다.

---

## 3. 프로바이더별 입출력 스펙 (Wire-level Specs)

각 프로바이더가 사용하는 HTTP 요청 엔드포인트, 인증 스키마, 최소 요청 페이로드, 그리고 텍스트와 도구 호출(Tool calling)이 믹스된 스트리밍 출력 파싱 구조를 기술합니다.

### 3.1 Anthropic (Messages API)
- **파일**: `src/providers/anthropic.ts`
- **HTTP 엔드포인트**: `POST https://api.anthropic.com/v1/messages`
- **인증 헤더**:
  - API Key 직접 사용 시: `X-Api-Key: <API_KEY>`
  - OAuth/ Vertex AI 또는 Z.AI 등 호환 프록시 연동 시: `Authorization: Bearer <TOKEN>`
- **핵심 헤더**:
  - `Anthropic-Version: 2023-06-01`
  - `Anthropic-Dangerous-Direct-Browser-Access: true` (브라우저 직접 호출 허용)
  - `Anthropic-Beta: claude-code-20250219,oauth-2025-04-20,context-management-2025-06-27,prompt-caching-scope-2026-01-05`
  - `X-App: cli`

#### 3.1.1 Anthropic 최소 요청 JSON 스키마 (Tool-calling Chat Turn)
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [
    {
      "role": "user",
      "content": "Hello. Read package.json and let me know the name."
    }
  ],
  "max_tokens": 4096,
  "stream": true,
  "system": [
    {
      "type": "text",
      "text": "You are a senior developer agent."
    }
  ],
  "thinking": {
    "type": "enabled",
    "budget_tokens": 1024,
    "display": "summarized"
  },
  "tools": [
    {
      "name": "read_file",
      "description": "Reads contents of a file at path",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Path to the file to read"
          }
        },
        "required": ["path"]
      }
    }
  ],
  "tool_choice": {
    "type": "auto"
  }
}
```

#### 3.1.2 Anthropic 스트리밍 응답 (SSE 이벤트 분석)
서버는 표준 SSE 포맷(`event: ... \n data: { ... }`)으로 청크를 내보냅니다.

* **텍스트 및 생각(Reasoning) 청크**:
  `content_block_start` 이벤트로 새 블록의 타입을 특정하고, `content_block_delta`로 실제 텍스트 조각을 전달받습니다.
  ```json
  // Event: content_block_start
  {
    "type": "content_block_start",
    "index": 0,
    "content_block": {
      "type": "thinking" // 혹은 "text"
    }
  }
  
  // Event: content_block_delta (Thinking Delta)
  {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "thinking_delta",
      "thinking": "Analyzing file structure..."
    }
  }

  // Event: content_block_delta (Text Delta)
  {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "text_delta",
      "text": "I will read the file."
    }
  }
  ```

* **도구 호출(Tool Calling) 청크**:
  `content_block_start`에서 `tool_use` 타입으로 정의되며 파라미터 파싱을 위한 `id`와 `name`이 제공됩니다. 이후 `input_json_delta` 이벤트로 JSON 스트링 조각이 전달됩니다.
  ```json
  // Event: content_block_start (Tool Use Start)
  {
    "type": "content_block_start",
    "index": 1,
    "content_block": {
      "type": "tool_use",
      "id": "toolu_01A5C98bdfb",
      "name": "read_file",
      "input": {}
    }
  }

  // Event: content_block_delta (Tool Input Payload Delta)
  {
    "type": "content_block_delta",
    "index": 1,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "{\"path\": \"pa"
    }
  }
  ```

* **도구 수행 완료 피드백 (Tool Result Block)**:
  에이전트가 도구 수행 결과를 모델의 히스토리에 다시 입력할 때의 블록입니다. `gjc`는 연속된 도구 결과를 **하나의 `user` 롤 메시지 하위의 `parts` 배열로 수집하여 전송**합니다.
  ```json
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01A5C98bdfb",
        "content": [
          {
            "type": "text",
            "text": "{\"name\": \"jeo-code\"}"
          }
        ],
        "is_error": false
      }
    ]
  }
  ```

---

### 3.2 Google Gemini (Generative Language API)
- **파일**: `src/providers/google.ts`, `src/providers/google-shared.ts`, `src/providers/google-types.ts`
- **HTTP 엔드포인트**: `POST https://generativelanguage.googleapis.com/v1beta/models/{model_id}:streamGenerateContent?alt=sse`
- **인증 헤더**: `x-goog-api-key: <API_KEY>`

#### 3.2.1 Gemini 최소 요청 JSON 스키마
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Read the file package.json"
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an expert developer assistant."
      }
    ]
  },
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "read_file",
          "description": "Reads contents of a file at path",
          "parametersJsonSchema": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Path to the file to read"
              }
            },
            "required": ["path"]
          }
        }
      ]
    }
  ],
  "toolConfig": {
    "functionCallingConfig": {
      "mode": "AUTO"
    }
  },
  "generationConfig": {
    "temperature": 0.0,
    "maxOutputTokens": 4096,
    "thinkingConfig": {
      "includeThoughts": true,
      "thinkingBudget": 1024
    }
  }
}
```

#### 3.2.2 Gemini 스트리밍 응답 및 도구 피드백 (GenerateContentResponse)
Gemini 스트림은 전형적인 `GenerateContentResponse` JSON 조각이 행 단위로 전달되는 SSE 형식입니다.

* **텍스트 및 생각(Reasoning) 청크**:
  생각과 일반 텍스트는 `parts` 내부 객체의 속성에 따라 판별합니다. `thought: true` 상태이면 생각 블록으로 누적하고, 텍스트가 있으면 일반 텍스트로 축적합니다.
  ```json
  {
    "candidates": [
      {
        "content": {
          "role": "model",
          "parts": [
            {
              "text": "Let me read package.json first.",
              "thought": true,
              "thoughtSignature": "base64_opaque_signature_here"
            }
          ]
        }
      }
    ]
  }
  ```

* **도구 호출(Tool Calling) 청크**:
  `parts` 내부에 `functionCall` 오브젝트가 실려 반환됩니다.
  ```json
  {
    "candidates": [
      {
        "content": {
          "role": "model",
          "parts": [
            {
              "functionCall": {
                "name": "read_file",
                "args": {
                  "path": "package.json"
                },
                "id": "read_file_1718388484_1"
              }
            }
          ]
        }
      }
    ],
    "usageMetadata": {
      "promptTokenCount": 204,
      "candidatesTokenCount": 35,
      "thoughtsTokenCount": 12,
      "totalTokenCount": 239
    }
  }
  ```

* **도구 수행 완료 피드백 (Function Response Part)**:
  도구 결과는 `role: "user"` 하위 파트의 `functionResponse` 규격으로 제공되며, 여러 개의 도구 결과를 한 번의 턴(`contents` 엔트리 1개)에 묶어 보낼 수 있습니다.
  ```json
  {
    "role": "user",
    "parts": [
      {
        "functionResponse": {
          "name": "read_file",
          "response": {
            "output": "{\"name\": \"jeo-code\"}" // 성공 시
            // 에러 시: "error": "file not found"
          },
          "id": "read_file_1718388484_1"
        }
      }
    ]
  }
  ```

---

### 3.3 OpenAI (Chat Completions API)
- **파일**: `src/providers/openai-completions.ts`
- **HTTP 엔드포인트**: `POST https://api.openai.com/v1/chat/completions`
- **인증 헤더**: `Authorization: Bearer <API_KEY>`

#### 3.3.1 OpenAI 최소 요청 JSON 스키마
```json
{
  "model": "gpt-4o",
  "messages": [
    {
      "role": "user",
      "content": "Please read package.json file."
    }
  ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  },
  "max_completion_tokens": 4096,
  "reasoning_effort": "medium",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Reads contents of a file at path",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Path to the file to read"
            }
          },
          "required": ["path"]
        },
        "strict": true
      }
    }
  ],
  "tool_choice": "auto"
}
```

#### 3.3.2 OpenAI 스트리밍 응답 및 도구 피드백 (ChatCompletionChunk)
OpenAI 호환 API는 스트림 응답으로 `choices[].delta` 데이터 구조를 사용합니다.

* **텍스트 및 생각(Reasoning) 청크**:
  생각 전용 데이터(`reasoning_content` 혹은 DeepSeek 호환 등)와 출력 텍스트(`content`)가 서로 다른 속성명으로 유입됩니다.
  ```json
  // Reasoning content stream (e.g., DeepSeek, OpenAI o1/o3-mini)
  {
    "choices": [
      {
        "index": 0,
        "delta": {
          "reasoning_content": "We need to read the path."
        }
      }
    ]
  }
  
  // Normal content stream
  {
    "choices": [
      {
        "index": 0,
        "delta": {
          "content": "Running read_file tool..."
        }
      }
    ]
  }
  ```

* **도구 호출(Tool Calling) 청크**:
  `delta.tool_calls` 배열을 통해 점진적으로 도구 정보가 주입됩니다.
  ```json
  {
    "choices": [
      {
        "index": 0,
        "delta": {
          "tool_calls": [
            {
              "index": 0,
              "id": "call_9a8B7c6D",
              "type": "function",
              "function": {
                "name": "read_file",
                "arguments": "{\"path\":"
              }
            }
          ]
        }
      }
    ]
  }
  ```

* **도구 수행 완료 피드백 (Tool Message Param)**:
  OpenAI 프로바이더 규격에서는 각각의 도구 수행 결과를 별도의 독립된 `{ role: "tool", content, tool_call_id }` 메시지 형태로 히스토리 어레이에 플랫하게 덧붙여 전송합니다.
  ```json
  {
    "role": "tool",
    "tool_call_id": "call_9a8B7c6D",
    "content": "{\"name\": \"jeo-code\"}",
    "name": "read_file"
  }
  ```

---

### 3.4 Mock Provider (테스트 모의 프로바이더)
- **파일**: `src/providers/mock.ts`
- **역할**: 테스트 스위트 내에서 실제 HTTP 연결 없이 완벽히 결정론적으로 작동하는 가짜 모형입니다.
- **동작 방식**: 
  - `MockModel` 인스턴스에 사전에 스크립팅된 대답 리스트(`MockResponse[]`)를 주입합니다.
  - 실행 시 `streamMock` 핸들러가 네트워크 호출 없이 대기시간(`delayMs`) 정책을 적용하면서 로컬 메모리 스트림 구조(`AssistantMessageEventStream`)로 차례대로 이벤트를 푸시합니다.
  - 이를 통해 특정 도구 호출, stopReason 강제 수정, Usage 가상 기록, HTTP 400/500 등의 장애 시뮬레이션 상태를 단일 코드 경로로 완벽하게 재현합니다.

---

## 4. jeoc가 미러링할 최소 표면 (Minimal Surface to Mirror)

`jeo-code` (`jeoc`) 에이전트가 다른 외부 SDK 의존성 없이 순수 **zero-dependency `fetch`** 기반의 통신 레이어로 LLM 연동을 수행하기 위해 반드시 충족해야 하는 최소한의 핵심 로직 스펙을 단계별로 기술합니다.

### 4.1 1순위 타겟: Google Gemini 최소 통신 모듈 설계
Gemini의 경우 추가적인 철자 세팅이나 까다로운 Stainless 메타데이터 없이도 즉시 통신이 가능한 가장 정제된 API를 갖고 있습니다.

1. **엔드포인트 빌드**:
   `GEMINI_API_KEY` 환경변수를 얻어 REST 요청 URL을 조립합니다.
   ```ts
   const base = process.env.GEMINI_API_KEY_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
   const url = `${base}/models/${modelId}:streamGenerateContent?alt=sse`;
   const headers = {
     "Content-Type": "application/json",
     "x-goog-api-key": apiKey
   };
   ```

2. **메시지 컨버터 설계**:
   내부의 단순화된 히스토리 포맷을 Gemini의 `Content` 타입으로 재정렬합니다.
   - `user` 혹은 `developer` 롤은 -> `"role": "user"`로 맵핑.
   - `assistant` 롤은 -> `"role": "model"`로 맵핑.
   - 생각(Reasoning) 파트는 파트 항목 내 `{ thought: true, text: thinkingContent }` 형태로 구성.
   - 도구 사용 결과(`toolResult`)는 반드시 `"role": "user"` 메시지의 파트 안에 `{ functionResponse: { name, response: { output: string }, id } }` 형태로 병합 전송.

3. **SSE 파서 및 가속화**:
   행 단위로 유입되는 Chunk 텍스트를 파싱하여 다음 객체를 디코딩합니다.
   - `candidates[0].content.parts[].text`: 일반 텍스트 조각 혹은 생각 내용.
   - `candidates[0].content.parts[].functionCall`: 도구 호출 오브젝트.
   - `candidates[0].finishReason`: 최종 완료 시그널 및 정밀 StopReason 맵핑.
   - `usageMetadata`: 최종 청크에서 토큰 소모 통계를 캡처하여 반환.

---

### 4.2 2순위 타겟: Anthropic & OpenAI 확장 대응 설계

Gemini 모듈 구축이 정상 완료된 후 Anthropic과 OpenAI를 미러링하기 위한 최소 스펙 요건입니다.

#### 1. Anthropic 최소 구현 요건:
- **HTTP 엔드포인트**: `https://api.anthropic.com/v1/messages`
- **인증 헤더**: `"x-api-key": apiKey`
- **필수 헤더**: `"anthropic-version": "2023-06-01"`, `"content-type": "application/json"`
- **페이로드 구조**:
  ```json
  {
    "model": modelId,
    "messages": messages,
    "max_tokens": maxTokens,
    "stream": true,
    "tools": tools,
    "thinking": { "type": "enabled", "budget_tokens": 1024 }
  }
  ```
- **SSE 스트림 디코딩**: 
  - `event: content_block_delta` 하위의 `delta.thinking` (생각), `delta.text` (텍스트), `delta.partial_json` (도구 인수 스트리밍) 파싱 루프 구성.
  - `message_delta` 이벤트에서 `usage` 객체를 포착하여 비용/토큰 사용량 기록.

#### 2. OpenAI 최소 구현 요건:
- **HTTP 엔드포인트**: `https://api.openai.com/v1/chat/completions`
- **인증 헤더**: `"Authorization": "Bearer " + apiKey`
- **페이로드 구조**:
  ```json
  {
    "model": modelId,
    "messages": messages,
    "stream": true,
    "stream_options": { "include_usage": true },
    "max_completion_tokens": maxTokens,
    "tools": tools
  }
  ```
- **SSE 스트림 디코딩**:
  - `choices[0].delta`에 실려오는 `content` (텍스트), `reasoning_content` (생각), `tool_calls` (도구 정보) 조각을 받아 버퍼에 합산 및 스트림 이벤트 전파.
  - 마지막 청크의 `usage` 필드를 찾아 누적 토큰을 가산.
