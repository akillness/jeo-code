---
type: SprintHandoff
---

# Sprint 02 → 03 인계

> Sprint 02 완료. 세션 증류가 단일 `MEMORY.md` merge에서 개념 단위 OKF 문서
> upsert로 전환되었다.

## 상태

- [x] 완료

## 확정된 사실

- **개념 문서 산출 스키마** (`distillSessionMemory`의 JSON 프롬프트): 모델은
  `{ "concepts": [...] }`를 산출하며, 각 개념은 `type`(RepoFact/Command/Gotcha/
  UserPreference), `title`, `description`, `body`, 선택 `tags[]`/`confidence`
  (high/medium/low)/`links[]`을 가진다. 텍스트 전용 프로바이더가 프롬프트/펜스로
  감싸는 경우를 대비해 `tryExtractJsonObject`(src/agent/json.ts)로 첫 균형 객체를
  복원하고, 복원 실패 시 기존 평문 `MEMORY.md` 폴백을 유지한다.
- **개념 파일 배치**: `type`→디렉터리 매핑(RepoFact→`facts/`, Command→`commands/`,
  Gotcha→`gotchas/`, UserPreference→`preferences/`), 파일명은 `slugify(title).md`.
  동일 `title`이면 같은 파일을 덮어쓰고(upsert), 슬러그 충돌(다른 title)만 `-N`
  접미사로 분기한다. 프론트매터는 기존 값에 머지하되 `type`/`title`/`description`/
  `tags`/`timestamp`/`confidence`/`last_verified`/`links`를 매 증류마다 갱신한다.
- **`index.md` 갱신 형식**: `okf_version: "0.1"` 프론트매터 + `## Repo Facts`/
  `## Commands`/`## Gotchas`/`## User Preferences` 섹션, 각 항목은
  `- [title](/<relpath>.md)` 절대 링크. 매 증류 후 전체 재생성(rebuildIndex).
- **`log.md` 갱신 형식**: ISO 8601 `## YYYY-MM-DD` 헤딩(최신 상단), 갱신된 개념을
  `* **<type>**: <title>`로 당일 헤딩 아래 삽입.
- **raw 보관/정리 정책**: 디테치드 워커가 증류 전 payload를
  `.jeo/memory/raw/session-<ts>-<pid>.json`으로 불변 보관(saveRawPayload). 증류
  성공 시 `pending-distill-*.json` 중 24h 초과분을 정리(cleanupStalePendingFiles).
- **atomic write**: 모든 쓰기는 `*.tmp-<pid>` → `rename`. detached 워커·
  `JEO_NO_MEMORY=1` 게이트·injection-hardening은 회귀 없이 유지.

## 산출물 경로

- `src/agent/memory.ts` — `distillSessionMemory`(개념 upsert + 다중-touch),
  `findMarkdownFiles`/`rebuildIndex`/`updateLog`/`saveRawPayload`/
  `cleanupStalePendingFiles`, `runMemoryDistillCommand`(raw 보관 추가).
- `test/memory-distill-okf.test.ts` — upsert/다중-touch/raw 보관/NO_MEMORY/
  중복-금지 재증류 + Sprint 01 검증기(`validateBundle`) 통과 검증.

## 미해결 이슈

- 없음. (주입 선택 로직은 Sprint 03 범위 — 현행 `memoryPromptSection`은 여전히
  단일 `MEMORY.md`만 읽으므로, 개념 번들 주입은 Sprint 03에서 설계한다.)

## 검증 증거

- `bun run typecheck`: 통과(에러 0).
- `bun test`: 1526 pass / 0 fail (192 files). 메모리 스위트
  `test/memory.test.ts`·`test/memory-distill-okf.test.ts`·
  `test/memory-okf.test.ts` 30 pass / 0 fail.
