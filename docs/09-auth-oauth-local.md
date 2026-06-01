# 09 — OAuth 인증 + 로컬 Provider (jeoc)

gjc의 인증 레이어(`@gajae-code/ai/auth-broker/*`, `providers/google-auth.ts`, `providers/openai-codex`)와
로컬 provider(`providers/ollama.ts`)를 분석해 jeoc에 반영한 결과. v0.3.0에서 추가.

## 1. gjc 인증 모델 (요약)

- `auth-broker/`: `client.ts`(토큰 획득) · `refresher.ts`(만료 갱신) · `remote-store.ts`/`server.ts`(저장/콜백) · `wire-schemas.ts`(Zod).
- 두 자격증명 종류: **API key**(헤더/쿼리)와 **OAuth access token**(`Authorization: Bearer`).
- OAuth 흐름은 provider별로 다름: Anthropic claude.ai(PKCE), Google(OAuth2), OpenAI Codex 등. 브라우저/PKCE/디바이스 코드가 필요.

## 2. jeoc 인증 표면 (구현됨)

자격증명 해석 우선순위(`src/config.ts resolveConfig`):

```text
authMode = local  (provider ∈ {mock, ollama})
         | apikey (config.apiKey > env[GEMINI/ANTHROPIC/OPENAI_API_KEY])
         | oauth  (env[*_OAUTH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN] > ~/.jeoc/auth.json)
         | none
```

- `jeoc auth login --provider <anthropic|gemini|openai> --token <T> [--refresh R]` → `~/.jeoc/auth.json`(chmod 600)에 저장.
- `jeoc auth status` → provider별 토큰 출처(env/stored) 마스킹 표시.
- `jeoc auth logout [--provider P]` → 삭제.
- OAuth 토큰이 있으면 **API key보다 우선**, 요청은 `Authorization: Bearer`로 전송:
  - Anthropic: `authorization: Bearer` + `anthropic-version` + `anthropic-beta: oauth-2025-04-20` (x-api-key 대신).
  - OpenAI: `authorization: Bearer <oauth|apiKey>`.
  - Gemini: `authorization: Bearer` 헤더 + URL의 `?key=` 제거.

### 토큰 획득 (브라우저 흐름 — 외부 단계)

토큰 자체를 얻는 PKCE/디바이스 흐름은 클라이언트 시크릿·브라우저가 필요하므로 jeoc는 **저장·사용**만 담당한다. 예:
- Anthropic: `claude setup-token` 또는 claude.ai OAuth → access token → `jeoc auth login --provider anthropic --token <T>`.
- Google: OAuth2 access token → `jeoc auth login --provider gemini --token <T>` (또는 `GEMINI_OAUTH_TOKEN`).

검증(테스트): auth login/status/logout 라운드트립, `--dry`에서 `authMode=oauth`, anthropic 요청이 `Bearer`+`anthropic-beta` 사용(x-api-key 없음) — 모두 hermetic 테스트로 커버.

## 3. 로컬 Provider — ollama (구현·실증)

- provider `ollama`, 기본 baseUrl `http://localhost:11434`, 기본 모델 `qwen2.5:0.5b`, **키 불필요**(`authMode=local`).
- 네이티브 `/api/chat` 사용: `{ model, messages, stream:false, tools:[{type:"function",function:{name,description,parameters}}] }`.
- 응답 `message.tool_calls[].function.{name,arguments(object)}` → jeoc ToolCall로 파싱.
- `jeoc doctor`(provider=ollama): `/api/tags`로 서버 가동·모델 pull 여부 점검 → READY/NOT READY.

```sh
jeoc setup --provider ollama                 # 기본 모델 qwen2.5:0.5b
ollama pull qwen2.5:0.5b
jeoc doctor                                  # ollama 서버/모델 확인 → READY
jeoc agent "write local.txt with made-locally" --provider ollama
```

### 실증 (v0.3.0)

- `jeoc doctor` → `ollama server up (1 models)` / `model pull available` / `status READY`.
- `jeoc agent --provider ollama --model qwen2.5:0.5b`: 로컬 모델이 실제 `write_file` tool_call을 내고, 에이전트가 디스패치해 **12바이트 파일("made-locally")을 디스크에 기록** → 전체 tool-calling 루프가 로컬에서 동작.
- 주의: 0.5B 초소형 모델은 tool 인자 품질이 낮다(빈/Windows형 경로 등). 인프라는 정상이며, 더 큰 로컬 모델(`llama3.2:1b`, `qwen2.5-coder`)일수록 인자 정확도가 오른다.

## 4. jeoc 자격증명 매트릭스

| provider | authMode | 자격증명 | 전송 방식 |
| --- | --- | --- | --- |
| mock | local | 없음 | — (결정적) |
| ollama | local | 없음 | 로컬 HTTP `/api/chat` |
| gemini | apikey/oauth | `GEMINI_API_KEY` / OAuth | `?key=` 또는 `Bearer` |
| anthropic | apikey/oauth | `ANTHROPIC_API_KEY` / OAuth | `x-api-key` 또는 `Bearer`+oauth-beta |
| openai | apikey/oauth | `OPENAI_API_KEY` / OAuth | `Bearer` |
