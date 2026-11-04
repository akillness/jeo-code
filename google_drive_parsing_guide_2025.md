# [OMJ 딥리서치 보고서] 2025-2026 구글 드라이브 문서 파싱(Parsing) 아키텍처

## 💡 [인사이트 (Insights)] : 투트랙(Two-Track) 파이프라인의 정착
2025~2026년의 문서 파싱 트렌드는 단일 툴로 구글 드라이브 인증과 파싱을 동시에 해결하려 하지 않습니다.
**[1단계: Drive API 기반 수집 및 Export]** ➜ **[2단계: LLM 친화적 Markdown/JSON 파서]**로 완전히 분리하여 정확도를 극대화하는 투트랙(Two-Track) 조합 구조가 표준(Standard)으로 자리 잡았습니다. 

## 🎯 [파급효과 (Implications)] : 단계별 최우수 오픈소스 및 방법론

### [Phase 1] 커넥터 및 수집 (구글 네이티브 ➜ 로컬 규격 변환)
*   **[LlamaIndex / LangChain Google Drive Loader](https://llamahub.ai/l/readers/llama-index-readers-google)**: 가장 표준적인 접근법입니다. Google Docs/Sheets/Slides를 단순 텍스트가 아닌 형태(PDF, Docx 등)로 API 단에서 즉시 Export하여 메모리에 올립니다.
*   **[googleworkspace/cli](https://github.com/googleworkspace/cli)**: 터미널 기반 자동화를 구성할 때 CLI 명령 한 줄로 특정 폴더나 문서를 대량으로 Export 할 수 있는 강력한 오픈소스입니다.
*   **[rclone](https://rclone.org/drive/)**: 거대한 드라이브 폴더 전체를 로컬 파일 시스템처럼 마운트(Mount)하거나 동기화해야 할 때 사용합니다.

### [Phase 2] LLM 친화적 구조화 파서 (최신 3대장 오픈소스)
*   **[MarkItDown (Microsoft)](https://github.com/microsoft/markitdown)**: 2024년 말 등장해 2025년 시장을 평정한 **초경량/초고속** 파서. 구글에서 Export된 워드, 엑셀, PPT를 압도적인 속도로 완벽한 마크다운으로 변환합니다.
*   **[Docling (IBM)](https://github.com/DS4SD/docling)**: 복잡한 레이아웃, 표, 차트가 섞인 구글 드라이브 PDF/문서를 다룰 때 최고의 정확도를 자랑하는 오픈소스(GenAI 특화)입니다.
*   **[MinerU (OpenDataLab)](https://github.com/opendatalab/MinerU)**: 수식, 다국어, 고난도 레이아웃이 포함된 문서(PDF/Office)를 RAG 및 에이전트 워크플로우에 맞게 Markdown/JSON으로 쪼개주는 강력한 파서입니다.

## 🚀 [전망 (Outlook)] : MCP(Model Context Protocol)로의 진화
앞으로의 구글 드라이브 파싱은 별도의 크롤링 봇을 거칠 필요가 없어집니다. `Google Drive Connector` + `MarkItDown`이 결합된 **MCP(Model Context Protocol) 서버**가 대세가 되고 있습니다. 형님께서 에이전트에게 "이 구글 닥스 링크 읽어봐"라고 지시하면, 에이전트가 백그라운드에서 즉시 문서를 Export하고 MarkItDown으로 파싱해 프롬프트 컨텍스트에 주입하는 **'실시간 스트리밍 파싱'** 구조로 AI RAG 아키텍처가 재편될 것입니다.

---

### 🛠 최단 경로 행동 제언(Next Step) 파이프라인
사내 지식베이스나 AI Agent에 연결하실 목적이시라면 다음 3단계 파이프라인을 추천합니다.
1. `googleworkspace/cli` 또는 `Google Drive API`로 Docs를 `.docx`로 일괄 다운로드하는 파이썬 스크립트 작성
2. 마이크로소프트의 **`MarkItDown`** 패키지를 파이프라인에 태워 즉각 Markdown으로 변환
3. `oh-my-jeo` RAG 큐에 적재