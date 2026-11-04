# [OMJ-2026] 사내 지식베이스 연동 AI Agent 및 슬라이드 팝업 인터페이스 설계서

**문서 상태:** 최종 타격 완료 (2026년 기준 딥리서치 반영)
**작성자:** Hermes (OMJ Control Tower)
**목적:** OMJ 사내 지식베이스(KB)와 연동되는 AI Agent의 아키텍처 및 웹/앱 이식이 가능한 슬라이드 팝업형 챗봇 인터페이스 설계

---

## 1. 2026년도 기준 AI Agent 핵심 설계 기조 (Deep Research Insights)

2026년 현재, 사내 지식베이스 연동 AI는 단순한 RAG(검색 증강 생성)를 넘어 **GraphRAG**와 **MCP(Model Context Protocol)** 기반의 능동형 에이전트로 진화했습니다. 프론트엔드는 무거운 JS 애니메이션 라이브러리 대신 브라우저 네이티브 기술을 활용하여 극단적인 경량화를 추구합니다.

*   **지식베이스 연동 표준:** [MCP 공식 문서](https://modelcontextprotocol.io) 기반의 플러그인 아키텍처 채택. 사내 위키, Jira, Slack 데이터를 실시간으로 안전하게 연결.
*   **Generative UI (생성형 UI):** 텍스트만 반환하는 것이 아니라, 상황에 맞는 조작 가능한 UI 컴포넌트(버튼, 폼, 차트)를 채팅창 내에 실시간 스트리밍.
*   **격리된 프론트엔드 환경:** 호스트 웹사이트의 CSS와 충돌하지 않도록 **Shadow DOM** 및 **Web Components** 활용 필수.

---

## 2. 아키텍처 설계 (Architecture Design)

### 2.1 Backend / Agent Layer (통제탑)
*   **라우팅 및 오케스트레이션:** 사용자 질의의 의도를 파악하여 일반 대화는 초경량 로컬/엣지 LLM으로 처리하고, 사내 문서가 필요한 경우 OMJ 메인 Knowledge Base로 라우팅.
*   **검색 및 추론 엔진 (GraphRAG):** 단순 벡터 유사도 검색의 한계를 극복하기 위해, 지식 그래프(Knowledge Graph)를 결합한 GraphRAG 아키텍처 구성. 문서 간의 관계를 추론하여 복합적인 질문에 답변.
*   **스트리밍 프로토콜:** WebSockets 대신 **SSE(Server-Sent Events)**를 사용하여 단방향 텍스트/UI 스트리밍 최적화 (연결 유지 비용 최소화).

### 2.2 Frontend Layer (슬라이드 팝업 UI)
*   **기술 스택:** React 19/20 (또는 Vanilla JS Web Components) + Shadow DOM.
*   **상태 관리:** 가벼운 Signals 패턴 활용. 챗봇의 열림/닫힘 상태, 메시지 히스토리, 스트리밍 상태를 전역적으로 관리.
*   **패키징:** 호스트 애플리케이션(기존 사내 시스템 등)에서 `<script src="https://omj.cdn/agent-widget.js"></script>` 한 줄로 삽입 가능하도록 번들링.

---

## 3. 슬라이드 팝업 인터페이스(UI/UX) 상세 설계

### 3.1 레이아웃 및 뷰포트
*   **위치:** 화면 우측 하단 (Z-index 최상단 유지).
*   **트리거 버튼:** Floating Action Button (FAB). 안 읽은 메시지 뱃지 및 상태(타이핑 중, 대기 중) 인디케이터 포함.
*   **팝업 패널:**
    *   모바일: 전체 화면(100vw, 100vh) 덮기.
    *   데스크톱: 폭 380px, 높이 70vh 내외의 둥근 모서리(border-radius) 패널.

### 3.2 애니메이션 및 성능 (2026 표준)
*   무거운 Framer Motion 등 서드파티 라이브러리 배제.
*   **브라우저 네이티브 API 활용:** CSS `@starting-style`과 `View Transitions API`를 사용하여 부드러운 Slide-in (우측에서 좌측으로) 및 Fade-in 효과 구현. 60fps 보장 및 메인 스레드 블로킹 방지.

### 3.3 사용자 경험 (UX) 기능
*   **Skeleton & Streaming:** 답변이 생성되는 동안 스켈레톤 UI를 보여주고, 첫 토큰 수신 시 즉각적인 타이핑 애니메이션 렌더링.
*   **Contextual Action (맥락 액션):** 답변 아래에 "이 문서 원문 보기", "관련 담당자 호출", "Jira 티켓 생성" 등의 액션 칩(Action Chip) 제공.
*   **접근성 (a11y):** ARIA Live Regions를 적용하여 스크린 리더가 실시간 생성 텍스트를 읽을 수 있도록 지원. Focus Trap을 적용해 팝업이 열려있을 때 탭 이동이 팝업 내부에 머물도록 설계.

---

## 4. 데이터 흐름도 (Data Flow)

1.  **Trigger:** 사용자가 우측 하단 위젯 아이콘 클릭 -> 슬라이드 팝업 오픈.
2.  **Query Input:** 사용자 질문 입력 및 전송.
3.  **Local Cache Check:** 브라우저 IndexedDB에서 유사 질문/최근 대화 캐시 확인 (빠른 응답).
4.  **Agent Request:** API Gateway를 거쳐 Agent Router로 SSE 요청 전송.
5.  **Context Retrieval:** MCP를 통해 OMJ 사내 지식베이스(Vector DB + Graph DB)에서 관련 컨텍스트 검색.
6.  **LLM Generation:** 컨텍스트를 프롬프트에 주입하여 LLM(제오/가재 코어 엔진)이 답변 생성.
7.  **Streaming Response:** 청크(Chunk) 단위로 텍스트와 UI 컴포넌트 마크업을 클라이언트로 스트리밍.
8.  **Render:** Shadow DOM 내부에 실시간 렌더링 및 자동 스크롤(Auto-scroll to bottom).

---

## 5. 보안 및 통합 고려사항

*   **인증 연동 (Auth):** 기존 사내 SSO(Single Sign-On) 토큰을 인터셉트하여 Agent API 요청 시 헤더에 자동 주입 (JWT/OIDC).
*   **권한 제어 (RBAC):** 사용자의 직급/부서에 따라 지식베이스에서 접근 가능한 문서 컨텍스트를 동적으로 필터링. (예: 경영진 전용 문서는 일반 사원에게 RAG 검색 대상에서 제외됨)
*   **데이터 비식별화:** 사내 PII(개인정보)가 외부 클라우드 LLM으로 전송되지 않도록, Agent Layer 도달 전 로컬/엣지 단에서 마스킹 처리(PII Scrubbing).