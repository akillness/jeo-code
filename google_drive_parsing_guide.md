# [OMJ 딥리서치] 2025-2026 구글 드라이브 문서 파싱 아키텍처 및 오픈소스 가이드

## 1. 개요
최신(25~26년) 트렌드는 구글 드라이브 인증/연동과 문서 텍스트 추출(파싱)을 완전히 분리하는 **투트랙(Two-Track) 파이프라인**입니다. 단일 툴이 가지는 포맷 붕괴 한계를 극복하기 위해 가장 확실한 조합을 사용합니다.

## 2. [Phase 1] 커넥터 및 수집 (구글 네이티브 ➜ 로컬 포맷 Export)
*구글 Docs, Sheets, Slides를 로컬 Docx, Xlsx, PDF 형태로 메모리에 끌어오는 단계입니다.*

- **LlamaIndex / LangChain Google Drive Loader**
  - 링크: [LlamaIndex LlamaHub](https://llamahub.ai/) / [LangChain Google Drive](https://python.langchain.com/docs/integrations/document_loaders/google_drive)
  - 용도: AI 파이프라인에서 가장 표준적으로 사용되는 데이터 로더.
- **googleworkspace/cli**
  - 링크: [GitHub - googleworkspace/cli](https://github.com/googleworkspace/cli)
  - 용도: CLI 기반 쉘 자동화. 스크립트 한 줄로 특정 폴더 내 문서를 대량으로 Export 할 때 유용합니다.
- **rclone**
  - 링크: [rclone.org](https://rclone.org/)
  - 용도: 방대한 구글 드라이브 폴더 전체를 로컬 파일 시스템처럼 마운트하거나 동기화해야 할 때 필수적입니다.

## 3. [Phase 2] LLM 친화적 구조화 파서 (최신 3대장)
*다운로드 된 문서를 Markdown 또는 JSON으로 완벽히 쪼개어 AI가 읽기 쉽게 만드는 단계입니다.*

- **MarkItDown (Microsoft)** 🔥(최우선 추천)
  - 링크: [GitHub - microsoft/markitdown](https://github.com/microsoft/markitdown)
  - 특징: 초경량/초고속. 구글에서 Export된 워드, 엑셀, PPT를 압도적인 속도로 마크다운으로 변환합니다.
- **Docling (IBM / Docling Project)**
  - 링크: [GitHub - DS4SD/docling](https://github.com/DS4SD/docling)
  - 특징: 복잡한 레이아웃, 표, 차트가 섞여 Export된 PDF/문서의 RAG 파싱 시 최고의 정확도를 자랑합니다.
- **MinerU (OpenDataLab)**
  - 링크: [GitHub - opendatalab/MinerU](https://github.com/opendatalab/MinerU)
  - 특징: 수식, 다국어, 고난도 레이아웃을 마크다운/JSON으로 완벽히 쪼개줌.

## 4. OMJ 아키텍처 제언 (최단 경로)
1. **Google Drive API**를 통해 목표 문서를 `.docx` / `.xlsx` 포맷으로 임시 폴더에 다운로드
2. Microsoft **MarkItDown** 라이브러리를 호출하여 순식간에 `.md` 텍스트 포맷으로 변환
3. `oh-my-jeo` RAG 큐나 프롬프트 컨텍스트에 즉시 주입