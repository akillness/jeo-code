---
type: SprintHandoff
---

# Sprint 01 → 02 인계

> 스프린트 완료 시 채운다. 다음 스프린트는 이 파일을 먼저 읽는다.

## 상태

- [x] 완료 (2026-06-17)

## 확정된 사실 (다음 스프린트가 가정해도 됨)

`src/agent/memory-okf.ts` export 표면 (Sprint 02~05가 의존하는 계약):

- `JEO_TYPES` / `JeoType` — `type` 어휘: `RepoFact`, `Command`, `Gotcha`,
  `UserPreference`, `Reference`. (4개 현행 헤딩 → 앞 4개 + 메타 문서용 `Reference`.)
- `RESERVED_FILES` — `["index.md", "log.md"]`. `isReservedFile(path)`로 basename
  판정(대소문자 무시).
- `conceptId(bundleRelativePath)` — `.md` 제거 + `/` 정규화
  (`commands/bun-test.md` → `commands/bun-test`). OKF 규칙 충족.
- `slugify(title)` — kebab-case, 빈 입력은 `untitled`. **slug 규칙 확정**:
  소문자화 → 비영숫자 `-` 치환 → 양끝/중복 `-` 정리. 충돌 회피(디렉토리 내
  유니크 보장)는 생산자(Sprint 02 upsert)가 suffix로 처리.
- `parseConcept(text) → { frontmatter, body, hasFrontmatter }` — 관대한 파서.
  프론트매터 없으면 `hasFrontmatter:false` + 전체를 body로.
- `serializeConcept(frontmatter, body)` — 키 순서 보존, 확장 키 round-trip,
  멱등. 따옴표 스칼라(`"0.1"`)는 문자열로, 숫자/불리언은 JS 타입 유지.
- `validateFile(file) → ConformanceIssue[]` / `validateBundle(files) → ConformanceReport`
  — error(거부): 개념 문서 프론트매터 부재, `type` 누락/빈값, `log.md` 비-ISO
  날짜 헤딩. warning(관용, 거부 안 함): 모르는 `type`, 권장 필드(`title`/
  `description`) 누락. 깨진 링크·`index.md` 부재는 거부 안 함.

## 산출물 경로

- `src/agent/memory-okf.ts` (신규, 순수 포맷 레이어 — `memory.ts` 미변경)
- `test/memory-okf.test.ts` (18 테스트)

## 미해결 이슈 / 결정 필요

- YAML 파서는 **OKF 프론트매터 서브셋 전용**(평면 `key: value`, 인라인
  `[a, b]` 리스트). 블록 리스트(`- item`)나 중첩 맵은 미지원 — OKF 권장
  필드엔 불필요하나, Sprint 02가 더 복잡한 값이 필요하면 여기서 확장.
- 인라인 리스트 항목은 문자열로만 파싱(숫자 리스트 비대상). 현 어휘엔 충분.

## 검증 증거

- `bun run typecheck`: PASS (tsc --noEmit, 무에러)
- `bun test test/memory-okf.test.ts`: PASS — 18 pass / 0 fail / 54 expect
