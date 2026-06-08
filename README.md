# jeo-code (`joc`)

Bun 기반 AI 코딩 에이전트 CLI입니다. 저장소 안에서 `joc`를 실행하면 파일을 읽고, 수정하고, 명령을 실행하며 작업을 끝까지 진행합니다.

## 설치

요구사항: Bun `1.3.14+`

```bash
bun install -g jeo-code
```

설치 확인:

```bash
joc --version
```

## 기본 사용법

```bash
# 대화형 코딩 에이전트 실행
joc

# 한 번의 요청을 바로 실행
joc "README를 정리하고 테스트를 실행해줘"

# 현재 설정과 모델 연결 상태 확인
joc doctor

# API 키 / OAuth / 로컬 모델 설정
joc setup
```

## 자주 쓰는 명령

```bash
# 저장된 세션 보기 / 재개
joc launch --list
joc launch --resume

# tmux 세션에서 실행
joc --tmux

# 별도 worktree에서 실행
joc --tmux --worktree ../joc-work

# 모델 목록 확인
joc models

# 인증 관리
joc auth login anthropic
joc auth status
```

## Spec-first 워크플로우

요구사항을 먼저 정리하고 계획, 실행, 검증까지 진행할 때 사용합니다.

```bash
joc deep-interview "만들고 싶은 기능 설명"
joc ralplan
joc approve <plan-path>
joc team
joc ultragoal
```

## 로컬 모델 사용

Ollama를 사용하면 API 키 없이 로컬에서 실행할 수 있습니다.

```bash
ollama pull qwen2.5:0.5b
export JOC_DEFAULT_MODEL=ollama/qwen2.5:0.5b
joc doctor
joc
```

## 설정 파일

- 전역 설정: `~/.joc/config.json`
- 프로젝트 상태/세션: `<project>/.joc/`

주요 환경 변수:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
JOC_DEFAULT_MODEL=...
OLLAMA_HOST=http://localhost:11434
```
