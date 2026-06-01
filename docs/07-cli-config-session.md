# 07 — CLI, Configuration, and Session Setup Spec

본 문서는 `gajae-code` (`gjc`)의 CLI 명령어 구조, 설정(Configuration) 파일의 포맷 및 스키마, `setup` 흐름, 그리고 에이전트 세션의 생성 및 조립 메커니즘을 심층 분석하고, 이를 새롭게 구현할 `jeo-code` (`jeoc`) 에이전트 엔진이 참고할 수 있도록 아키텍처와 구현 설계 명세를 한국어로 정리한다.

---

## 1. 개요 (Overview)

`gajae-code` 에이전트 프레임워크는 강력한 사용자 설정 지향성(Configuration-Driven)과 독립적인 세션 분리(Session Isolation)를 지원하도록 설계되었다. 사용자의 로컬 환경설정 및 모델/프로바이더 크리덴셜은 다양한 수준(전역 및 프로젝트 레벨)에서 체계적으로 관리되며, 에이전트가 실행될 때 이 모든 설정 요소들이 동적으로 수집되어 하나의 완성된 세션 객체로 유기적으로 조립된다.

### 핵심 소스 코드 경로 (1차 레퍼런스)
- **CLI 진입점 및 기본 명령어 실행 경로**:
  - `@gajae-code/coding-agent/src/cli.ts` (CLI 진입 및 기본 launch 라우팅)
  - `@gajae-code/coding-agent/src/cli/args.ts` (인자 파싱 규약)
  - `@gajae-code/coding-agent/src/commands/launch.ts` (런치 옵션 및 실행 조율)
- **설정 디렉터리 및 스키마 정의**:
  - `@gajae-code/coding-agent/src/config.ts` (전역/프로젝트 디렉터리 우선순위 검색)
  - `@gajae-code/coding-agent/src/config/config-file.ts` (JSON-to-YAML 자동 마이그레이션 및 파싱)
  - `@gajae-code/coding-agent/src/config/settings.ts` (설정 싱글톤 인스턴스 제어)
  - `@gajae-code/coding-agent/src/config/settings-schema.ts` (전역/로컬 설정 스키마 및 기본값 정의)
  - `@gajae-code/coding-agent/src/config/models-config-schema.ts` (프로바이더 및 모델 스토리지 정의)
  - `@gajae-code/coding-agent/src/config/model-registry.ts` (인증 정보 기반 모델 리스트 인스턴스 관리)
- **프로바이더 및 모델 초기설정 (`setup`)**:
  - `@gajae-code/coding-agent/src/cli/setup-cli.ts` (setup CLI 서브커맨드)
  - `@gajae-code/coding-agent/src/setup/provider-onboarding.ts` (API 호환 프로바이더 등록 및 덮어쓰기 로직)
- **에이전트 세션의 핵심 빌더**:
  - `@gajae-code/coding-agent/src/sdk.ts` (`createAgentSession` 세션 어셈블리 파이프라인)

---

## 2. 설정(Configuration) 위치 및 스키마 명세

`gajae-code`는 사용자 설정 파일이 전역(User-level) 및 프로젝트(Project-level) 수준에서 중첩되어 병합될 수 있도록 설계되었다. 이를 위해 디렉터리 탐색 우선순위와 JSON-to-YAML 파싱 추상화 클래스를 사용한다.

### 2.1 설정 파일 위치 및 디렉터리 우선순위

사용자의 환경 설정 파일(`config.yml`)과 커스텀 모델 설정 파일(`models.yml`)이 저장되는 우선순위 경로는 다음과 같다. (기본적으로 `~/.gjc/agent` 디렉터리가 활용된다.)

| 레벨 (Level) | 우선순위 경로 (Priority Paths) | 역할 (Role) |
| :--- | :--- | :--- |
| **전역 (User-level)** | 1. `~/.gjc/agent/`<br>2. `~/.gemini/` | 전역 테마, 기본 모델 에이전트 역할 바인딩, 개인화된 프로바이더 API 키 및 가상 엔드포인트 관리 |
| **프로젝트 (Project-level)** | 1. `{projectDir}/.gjc/`<br>2. `{projectDir}/.gemini/` | 특정 프로젝트/레포지토리 단위의 모델 세팅 오버라이드, 도구 보안 제한 설정 |

설정 파일을 적재할 때, `config-file.ts` 파일의 `migrateJsonToYml` 기능은 하위 호환성을 위해 `.json` 설정이 감지될 경우 자동으로 이를 파싱하여 동일한 경로에 `.yml` 포맷으로 자동 변환(YAML 직렬화) 및 마이그레이션한다.

### 2.2 설정 데이터 스키마 (Configuration Schema)

설정 스키마는 크게 일반 기능 설정을 다루는 **Settings Schema**와 모델/인프라 설정을 다루는 **Models Config Schema**로 양분된다.

#### A. Settings 스키마 명세 (`settings-schema.ts`)
에이전트 제어와 사용자 경험에 관련된 전역/로컬 변수를 정의하며, 기본적으로 Zod 또는 타입 매핑을 이용해 검증된다.

```yaml
# config.yml 예시
theme.dark: "red-claw"        # 터미널 어두운 테마 프리셋
defaultThinkingLevel: "medium" # reasoning 모델의 기본 사고 강도 설정
enabledModels: []              # 에이전트 실행에 허용되는 활성화 모델 패턴 리스트
disabledProviders: []          # 로드 및 추론 시 비활성화할 프로바이더
modelRoles:                    # 특정 상황(Default, Smol, Slow, Plan)에 부여할 모델 지정
  default: "anthropic/claude-3-5-sonnet"
  smol: "openai/gpt-4o-mini"
  slow: "anthropic/claude-3-opus"
  plan: "anthropic/claude-3-5-sonnet"
```

#### B. Models Config 스키마 명세 (`models-config-schema.ts`)
외부 추론 API 엔드포인트와 API 인증키, 자체 호스팅 모델 정보를 기록하며, Zod 스키마인 `ModelsConfigSchema`를 통해 동적 검증이 이루어진다.

```typescript
// ModelsConfigSchema Zod 스키마 구조의 주요 구성 필드
export const ModelsConfigSchema = z.object({
  providers: z.record(z.string(), z.object({
    baseUrl: z.string().url().optional(),      // 외부 게이트웨이 또는 로컬 API 엔드포인트 URL
    api: z.enum([                              // API 프로토콜 규격
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
      "ollama-chat"
    ]).optional(),
    auth: z.enum(["apiKey", "none", "oauth"]).optional(), // 인증 모델 유형
    apiKey: z.string().optional(),              // 문자열 형태의 API 키 (리터럴 저장 시)
    apiKeyEnv: z.string().optional(),           // API 키를 주입받을 환경변수 이름 지정 (권장)
    models: z.array(z.object({                 // 공급자가 제공하는 커스텀 모델 리스트
      id: z.string(),
      name: z.string().optional(),
      reasoning: z.boolean().optional(),       // 추론 모델(o1, o3, claude-thinking) 여부
      contextWindow: z.number().optional(),    // 입력 컨텍스트 윈도우 크기 제한
      maxTokens: z.number().optional()         // 최대 출력 토큰 제한
    })).optional()
  })).optional()
}).strict();
```

### 2.3 실행 보안 권한 규약 (Execution Permission Contract)

에이전트가 로컬 환경을 훼손할 위험이 있는 도구(Destructive Tools)를 실행할 때, `gjc`는 단순 모델 추론 영역 밖에서 보안 차단 장치를 제공한다.

1. **대상 도구 제한**: `PERMISSION_REQUIRED_TOOLS = ["bash", "edit", "delete", "move"]` (`agent-session.ts`)
2. **ACP(Agent Connection Protocol) 권한 위임**:
   - 에이전트가 ACP 클라이언트(VS Code 등의 IDE 플러그인 또는 호스트 통신 브릿지)와 연동되어 실행 중일 때, 상기 명시된 4개 도구 호출은 실행 직전 클라이언트 측에 `session/request_permission` 요청을 발송한다.
   - 사용자 동의 여부에 따라 `allow_always`, `allow_once`, `reject_once`, `reject_always` 등의 피드백이 결정되고, `allow` 상태에서만 파일 쓰기나 PTY 명령어 샐행이 허용된다. 거부될 경우 즉시 `ToolError`가 발생해 실행이 롤백된다.

---

## 3. Setup 커맨드 및 프로바이더/인증 온보딩 흐름

`gjc setup` 서브커맨드는 사용자가 일일이 YAML 파일을 편집하지 않고도 신규 OpenAI 호환 프로바이더 및 모델 인증을 로컬 환경에 온전하게 온보딩하고 지속(Persist)할 수 있는 가이드라인을 제공한다.

### 3.1 Setup CLI 명령어 규격
```bash
gjc setup provider \
  --compat openai \
  --provider local-vllm \
  --base-url http://localhost:8000/v1 \
  --api-key-env LOCAL_VLLM_API_KEY \
  --model deepseek-r1,llama-3 \
  --force
```

### 3.2 Setup 모델 및 인증 해결 흐름

`addApiCompatibleProvider` 함수(`provider-onboarding.ts`) 내부에서 공급자 및 인증 정보가 안전하게 적재되는 단계는 다음과 같다.

```text
  [사용자 입력 인자] --compat, --provider, --base-url, --api-key-env, --model
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  1. 인자 유효성 검증 (Validation) │
        │  - providerId 정규식 확인        │
        │  - Base URL 프로토콜 및 호스트 검증 │
        └──────────────────────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │   2. 기존 models.yml 파일 적재    │
        │   - YAML 파싱 및 Zod 스키마 검증 │
        └──────────────────────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │     3. 공급자 세부 사양 변환     │
        │  - openai -> openai-responses    │
        │  - anthropic -> anthropic-msg    │
        └──────────────────────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  4. providers 맵 병합 및 마스킹  │
        │  - 중복 체크 (force 옵션 제어)   │
        │  - API key 마스킹 (4글자 보존)   │
        └──────────────────────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  5. 파일시스템에 models.yml 저장 │
        │   - Zod 최종 검증 및 YAML 직렬화  │
        └──────────────────────────────────┘
```

1. **입력 유효성 검증**:
   - `providerId`는 `^[a-z0-9][a-z0-9._-]*$` 소문자 기반 정규식 형태만 가질 수 있다.
   - `baseUrl`은 반드시 HTTPS 체계를 지켜야 하며, 예외적으로 로컬 루프백 호스트(`localhost`, `127.0.0.1`, `::1` 등)로 식별될 경우에만 일반 HTTP 전송 프로토콜을 통과시킨다.
   - raw API Key를 CLI 옵션으로 직접 전달하는 방식은 보안 유출 위험으로 거부되며, 오직 API 키가 위치한 환경변수 식별자(`--api-key-env`)만을 인자로 수용한다.
2. **기존 구성 로드**:
   - `modelsPath`를 전역 경로(`~/.gjc/agent/models.yml`)에서 로드한다. 파일이 부재하다면 빈 설정 객체(`{}`)를 인메모리에 생성하고, 존재할 경우 `ModelsConfigSchema` 기반으로 적재를 보장한다.
3. **병합 및 검증**:
   - 설정하고자 하는 공급자 식별자가 이미 파일 내에 등록되어 있고 `--force` 플래그가 꺼져 있을 경우 프로세스를 즉시 종료하여 기존 정보를 방어한다.
   - 호환 타입에 대응하여 API 규격을 자동 변경하고(예: `openai` 규격은 `"openai-responses"`로 변환), 모델 식별자들을 구조체 배열`{ id }` 형태로 래핑한다.
4. **암호화 정보 마스킹 및 저장**:
   - 로그 출력 시 보안 안전망 확보를 위해 API 키 문자열은 전면 마스킹 처리된다. (`redactSecret`에 의해 첫 4글자와 마지막 4글자만 보존: `sk-a…1234`).
   - 가공 완료된 최종 데이터 구조는 다시 한 번 `ModelsConfigSchema` 무결성 스키마 진단을 마친 뒤 전역 디렉터리에 YAML 직렬화 과정을 거쳐 지속 영속화된다.

---

## 4. `sdk.ts` 에이전트 세션 조립(Assembly) 파이프라인

에이전트가 기동될 때 호출되는 `createAgentSession`(`sdk.ts`)은 에이전트 기동에 필요한 다양한 자원(설정, 크리덴셜, 파일시스템 정보, 시스템 프롬프트, 도구군)을 하나로 수렴하고 조립하는 파이프라인 구조를 띠고 있다.

```text
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │ 1. 디렉터리  │   │  2. 설정 및  │   │  3. 크리덴셜 │   │ 4. 백그라운드│
 │   기초 설정  ├──►│  인프라 로딩 ├──►│  저장소 준비 ├──►│   탐색 개시  │
 └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
                                                                 │
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐          ▼
 │ 8. 세션 생성 │   │  7. 에이전트 │   │6. 도구/프롬프│   ┌──────────────┐
 │  및 메모리   │◀──│   코어 조립  │◀──│트 결합/최적화│◀──│ 5. 모델 결정 │
 │   최종 바인딩│   │ (new Agent)  │   │ (SysPrompt)  │   │  및 preconnect│
 └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
```

### 1단계: 디렉터리 및 옵션 기초 설정
에이전트가 작업을 수행할 로컬 경로(`cwd`, 기본값: 프로젝트 루트 디렉터리)와 설정 저장소 디렉터리(`agentDir`, 기본값: `~/.gjc/agent`)를 설정한다. 이어서 작업 공유 전파용 전역 `EventBus`를 수립하고 비동기 프로세스 소멸자 자원들(SSH, Python 커널 세션 청소용 콜백 등)을 레지스트리에 선제 가입시킨다.

### 2단계: 크리덴셜 저장소 및 모델 라이브러리 준비
사전 빌드된 크리덴셜 및 모델 레지스트리가 없을 경우, 로컬 호스트 영역의 인증키들을 로드하는 `discoverAuthStorage` 모듈을 실행해 `AuthStorage` 싱글톤 객체를 생성한다. 이후 모델 레지스트리 `ModelRegistry`가 이를 래핑하여 인프라 준비 상태를 갖춘다.

### 3단계: 환경 설정 및 로컬 기능 로딩
`Settings.init`이 기동되며, 전역 YAML 파일(`config.yml`)을 적재하고 동시에 프로젝트 경로 상에서 가용한 도구 및 에이전트 행동 지침(Capability 모델 기반 `settingsCapability.id` 로더 탐색)을 병합한다. 이후 테마 및 출력 프리셋, 검색 엔진 기본 타겟을 파싱한다.

### 4단계: 비동기 백그라운드 탐색 개시
로딩 시간 지연으로 인한 에이전트 스타트업 병목을 극복하기 위해, 프로젝트 파일 트리 스캔(`buildWorkspaceTree`, 최대 5초 타임아웃 제한), 컨텍스트 메타데이터 파일(`AGENTS.md`) 탐색, 프롬프트 템플릿 적재 절차가 인메모리 Promise 상태로 동시에 실행된다.

### 5단계: 세션 컨텍스트 식별 및 모델 결정
- 실행 매개변수 상에 명시적 `--model` 요청이 없을 경우, 세션 이력 데이터(Session log) 복구를 우선적으로 검토하여 기존 사용 모델로 바인딩한다.
- 기존 이력이 전무할 경우 사용자의 `config.yml` 내 `modelRoles.default` 설정이 지정한 1순위 타겟 모델을 지정한다.
- 그마저도 획득할 수 없는 환경일 경우, 로드된 허용 모델 목록(`allowedModels`) 중 유효한 API Key를 공급하고 있는 첫 번째 활성 모델을 최종 낙점한다.
- 낙점 완료 시 첫 회차 모델 API 호출의 왕복 지연시간(RTT)을 축소할 목적으로 전송 계층 프로토콜 사전 연결(`preconnectModelHost`)을 백그라운드로 전송한다.

### 6단계: 시스템 프롬프트 및 도구 레지스트리 조립
- 도구 모음(`BUILTIN_TOOLS`)에서 필수 기본 도구(`read`, `write`, `bash`, `edit` 등) 인스턴스를 수립한다. 커스텀 도구 및 타사 확장 모듈 도구는 `ExtensionToolWrapper` 혹은 `CustomToolAdapter`에 의해 래핑되어 도구 레지스트리(`toolRegistry`)에 등재된다.
- 만약 설정의 `tools.discoveryMode`가 `"all"`인 경우, 모델이 필요할 때 검색(`search_tool_bm25`)하여 적재하도록 필수 도구군을 제외한 나머지는 가상 대기 영역에 배치한다.
- 시스템 프롬프트 어셈블러(`buildSystemPromptInternal`)가 구동되어 에이전트 정체성 설정 프롬프트, 도구별 구조적 사용 가이드라인, 워크플로우 전용 내장 스킬(`deep-interview`, `ralplan`, `ultragoal`, `team`), 그리고 프로젝트 규칙(`AGENTS.md`)을 하나의 통합 템플릿 텍스트로 합성한다.

### 7단계: 에이전트 코어 인스턴스화
추론 및 도구 조율 코어인 `Agent` 인스턴스를 빌드한다. 이 과정에서 토큰 유출 방어용 데이터 오버레이 필터(`convertToLlmFinal`), 토큰 누수 차단용 비공개 암호 마스킹 체인(`obfuscator`), 크리덴셜 회전 복구 콜백 함수, 그리고 에이전트 스티어링 정책 매핑이 완료된다.

### 8단계: 세션 래퍼 조립 및 기동
최종 결과물인 `AgentSession` 인스턴스를 메모리에 할당한다. 새롭게 생성된 에이전트 정보는 가상 IRC 피어 탐색 및 협업 전파망인 `AgentRegistry.global()` 레지스트리에 `"running"` 상태로 전격 가입 및 배포되어 즉각적인 다중 에이전트 프로세스 소통 공간을 개방한다.

---

## 5. 기본 모델 선택 메커니즘 (Cascading Model Choice)

사용자가 모델 정보를 제공하지 않았을 때 기동 시 동작할 모델을 선발하는 규약은 다음과 같이 캐스케이딩(Cascading) 순서대로 꼼꼼히 연쇄 수행된다.

```text
┌──────────────────────────────────────────────┐
│  1. CLI 명시적 파라미터 확인                   │
│     (--model, --provider 또는 env 환경변수)    │
└──────────────────────┬───────────────────────┘
                       │ [결정 불가]
                       ▼
┌──────────────────────────────────────────────┐
│  2. 기존 실행 세션(Session History) 모델 식별 │
│     (기존 대화 이력 내 마지막 활성 모델 복구)   │
└──────────────────────┬───────────────────────┘
                       │ [결정 불가]
                       ▼
┌──────────────────────────────────────────────┐
│  3. Settings 설정 상의 default 역할 확인       │
│     (config.yml -> modelRoles.default 맵)     │
└──────────────────────┬───────────────────────┘
                       │ [결정 불가]
                       ▼
┌──────────────────────────────────────────────┐
│  4. 가용 모델 목록(Allowed List) 스캔          │
│     (enabledModels에 있고 API key가 유효한 첫 모델)│
└──────────────────────────────────────────────┘
```

1. **CLI 직접 주입 여부 확인**:
   - `parsed.model` 혹은 `parsed.provider`로 명시적 모델이 넘어오거나, 특정 로컬 환경 변수(`GJC_SMOL_MODEL`, `GJC_SLOW_MODEL`, `GJC_PLAN_MODEL`)가 매칭되는 즉시 지정 모델이 최종 승인된다.
2. **세션 복구 탐색**:
   - 기존 진행 중이던 세션 식별자를 resume/continue 플래그를 통해 다시 적재할 경우, 해당 세션 파일(`session.jsonl`)의 역사적인 상태 메타데이터 블록에 접근하여 중단 시점에 물려 있던 기본 모델 사양(`existingSession.models.default`)을 역추적해 다시 기동한다.
3. **사용자 설정 상의 에이전트 default 역할 바인딩**:
   - 사용자가 전역 `config.yml` 파일 내부 `modelRoles` 레코드 맵 하위에 선언해 둔 `"default"` 바인딩 모델 사양(`activeSettings.getModelRole("default")`) 정보를 읽어들여 적용한다.
4. **가용 자원 스캔 최종 폴백**:
   - 위의 모든 조회가 결렬되는 극한 상황 시, 현재 레지스트리 환경에 허용 등록(`enabledModels`)되어 있는 전체 모델 후보를 일렬로 순회하여 크리덴셜 바인더가 온전하고 로컬 통신 준비가 입증된 첫 번째 가용 인스턴스를 무조건 채택하여 에이전트 기동 실패 문제를 격리 방어한다.

---

## 6. `jeoc` config/agent 최소 설계 (Minimal Design)

`jeo-code` (`jeoc`) 프로젝트가 `gjc`의 우수한 설정 관리 및 세션 수립 패러다임을 반영하면서도, 과도한 레이어 분리 없이 신속하고 안정되게 구동되도록 하는 미니멀 설계 사양을 제공한다.

### 6.1 설정 스토리지 및 최소 스키마 (`.jeoc/config.json`)

- **저장 위치**: `~/.jeoc/config.json` (전역 홈 디렉터리 하위 단일 JSON 구성)
- **최소 스키마 구조**:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "JeocConfigFileSchema",
  "type": "object",
  "properties": {
    "provider": {
      "type": "string",
      "enum": ["openai", "anthropic", "local"],
      "description": "API 호출을 처리할 크리덴셜 규격 프로바이더"
    },
    "model": {
      "type": "string",
      "description": "추론에 기동할 디폴트 모델 식별자 (예: gpt-4o, claude-3-5-sonnet, deepseek-r1)"
    },
    "apiKey": {
      "type": "string",
      "description": "리터럴 API 키 (직접 영속화가 필요한 환경용)"
    },
    "apiKeyEnv": {
      "type": "string",
      "description": "API 키를 동적으로 참조할 로컬 시스템 환경변수 식별자"
    }
  },
  "required": ["provider", "model"]
}
```

### 6.2 `jeoc` CLI 설정 제어 및 에이전트 구동 인터페이스

```text
 ┌─────────────────────────────────────────────────────────────┐
 │                       jeoc CLI Surface                      │
 └─────────────────────────────────────────────────────────────┘
          │                                           │
          ▼ (환경 설정 관리)                           ▼ (에이전트 구동)
 ┌───────────────────────────┐               ┌───────────────────────────┐
 │ jeoc config set <k> <v>   │               │ jeoc agent [prompt]       │
 │ jeoc config get <k>       │               └─────────────┬─────────────┘
 └─────────────┬─────────────┘                             │
               │                                           ▼
               │                            1. ~/.jeoc/config.json 로드
               ▼                            2. env 또는 apiKey로 인증키 획득
       [~/.jeoc/config.json]                3. SysPrompt 병합 및 기본 도구 바인딩
       (동적 쓰기 및 안전 검증)              4. Turn-Loop 개시 및 스트리밍 응답
```

#### A. 설정 조회/수정 명령어 규격
- **`jeoc config set <key> <value>`**:
  - 지정한 설정 값을 `~/.jeoc/config.json` 파일에 저장한다. 존재하지 않는 디렉터리일 경우 자동으로 디렉터리를 생성한다.
  - 예시:
    ```bash
    jeoc config set provider anthropic
    jeoc config set model claude-3-5-sonnet
    jeoc config set apiKeyEnv ANTHROPIC_API_KEY
    ```
- **`jeoc config get <key>`**:
  - `~/.jeoc/config.json`을 읽고 요청한 키 값을 표준 출력으로 프린트한다.
  - 예시:
    ```bash
    jeoc config get model
    # 출력: claude-3-5-sonnet
    ```

#### B. 에이전트 세션 구동 명령어 규격
- **`jeoc agent [prompt]`**:
  - 단일 명령어로 초경량 에이전트 인스턴스를 구축하고 세션을 조립하여 턴 루프(Turn-Loop)를 개시한다.
  - **작동 시나리오**:
    1. 홈 디렉터리의 `~/.jeoc/config.json` 설정 정보를 읽어들인다.
    2. 설정의 `apiKeyEnv` 변수에 기록된 환경변수를 통해 인증 토큰(예: `process.env.ANTHROPIC_API_KEY`)을 복구하며, 부재 시 리터럴 `apiKey` 항목을 획득한다. 모두 획득할 수 없는 위기 상황 시 콘솔 에러를 출력하고 온보딩 CLI(`jeoc config set`) 사용을 권고하는 에러 가이드를 배포한다.
    3. 에이전트 코어 조립 단계를 최단 거리로 연결하여, 기본 시스템 프롬프트와 4대 필수 기본 동작 도구(`read`, `write`, `bash`, `edit`) 인스턴스를 에이전트에 바인딩한다.
    4. 매개변수 상의 초기 프롬프트 텍스트(`prompt`)가 존재할 경우 이를 턴 루프 첫 입력으로 피딩(Feeding)하고 즉각적인 모델 스트리밍 결과 출력을 개시한다.
