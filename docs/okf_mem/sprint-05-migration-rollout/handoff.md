---
type: SprintHandoff
---

# Sprint 05 — 최종 인계 / 프로젝트 종료

> OKF 메모리 전환의 마지막 스프린트. 레거시 단일 `MEMORY.md`를 OKF 개념 번들로
> **무손실·멱등** 변환하는 마이그레이션과, 번들/레거시 폴백 통일 + 롤백 토글을
> 추가했다. 번들이 기본 읽기 경로이며 graphify 없이도 전부 동작한다(Sprint 04).

## 상태

- [x] 완료

## 최종 상태

- **기본 동작**: `memoryPromptSection`은 OKF 개념 번들을 1차로 읽는다(쿼리 인지
  예산 선택 + 1-hop 그래프 확장, Sprint 03/04). 번들에 개념이 없으면 레거시 단일
  `MEMORY.md`로 폴백 — 단일 폴백 경로로 통일.
- **마이그레이션** (`migrateLegacyMemory(cwd)`, `src/agent/memory.ts`):
  - 레거시 4-헤딩 `MEMORY.md`를 파싱(`parseLegacyMemory`) — `## 헤딩`→`type`
    (키워드 매칭: command/gotcha/pref/repo·fact, 미상은 RepoFact), 최상위 불릿→개념,
    `**title**: desc` 형태 분해, 들여쓴 연속 줄은 body. 무손실(plain 불릿은 전체를
    title로 보존).
  - 타입별 서브디렉터리(`facts/`·`commands/`·`gotchas/`·`preferences/`)에 개념 문서
    기록, `index.md`/`log.md` (재)생성. 모든 쓰기는 atomic(`*.tmp-<pid>`→rename).
  - **멱등**: 번들에 이미 개념이 있으면 no-op(skip). 안전 재실행.
  - 레거시 `MEMORY.md`는 `MEMORY.md.bak`으로 rename — 활성 읽기 경로에서 빠지되
    롤백용 사본 보존.
- **서브커맨드**: `jeo memory-migrate` (`src/commands/memory-migrate.ts`, runner
  와이어링). 1회성·멱등, 변환 수/백업 경로/skip 사유를 보고.
- **플래그**:
  - `JEO_NO_MEMORY=1` — 메모리 주입/증류 전체 비활성(기존, 최우선 — 토글보다 우선).
  - `JEO_MEMORY_LEGACY=1` — 롤백 토글(신규). 번들을 무시하고 레거시 `MEMORY.md`,
    없으면 `MEMORY.md.bak`을 읽는다. 동일한 injection-hardening(`frameMemory`) 적용.

## 롤백 방법

1. `JEO_MEMORY_LEGACY=1` 환경변수 — 번들을 무시하고 `MEMORY.md.bak`(마이그레이션이
   남긴 백업)을 다시 읽는다. 코드/번들 변경 없이 즉시 롤백.
2. 또는 `.jeo/memory/MEMORY.md.bak` → `MEMORY.md` 복원 후 번들 디렉터리 제거 —
   완전한 레거시 상태로 복귀.

## 남은 후속 작업 (선택)

- graphify 능동 연동(`graphify add <url>` URL 적재, `query`/`explain` 재발견) —
  대규모 번들에서만 선택적 토글로(Sprint 04 미해결 이슈 그대로).
- 프론트매터 `links:` 필드를 그래프 간선으로 병합(현재는 본문 마크다운 링크만).
- 원격 공유(OKF 번들 export/import).

## 검증 증거

- `bun run typecheck`: 통과(에러 0).
- `bun test`(전체): 1565 pass / 0 fail (195 files). 신규
  `test/memory-migration-okf.test.ts` 7 pass(legacy 파싱·무손실/멱등 변환·폴백·
  `JEO_MEMORY_LEGACY` 롤백·`JEO_NO_MEMORY` 우선).
- `jeo memory-migrate` 실검증: 라이브 `.jeo/memory/MEMORY.md`(33개념) → 번들 변환
  성공·백업 생성 확인 후 라이브 상태 원복(런타임 상태 비오염).
