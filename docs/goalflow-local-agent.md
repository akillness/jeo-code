# GoalFlow Local Agent Architecture & Inbound API Server

`jeo-code` provides a unified local agent execution architecture that bridges local LLM runtimes (`llama.cpp`, `Ollama`, `LM Studio`) with a deterministic, spec-first workflow engine powered by **GoalFlow**, **Karpathy Core Loop**, and **Harness² Evolution**.

---

## 1. Architecture Overview (Dual Topology)

The architecture operates in a **dual-topology**:
1. **Outbound Inference Topology**: Connects `jeo-code` to local model backends (`llama.cpp`, `Ollama`, `LM Studio`, OpenAI-compatible engines) with a dynamic 3-tier tool calling cascade (`native` -> `structured GBNF/JSON schema` -> `prose tool calling`).
2. **Inbound Agent Server Topology (`jeo serve`)**: Exposes an HTTP/SSE server offering both OpenAI-compatible Chat Completions (`/v1/chat/completions`) and native GoalFlow workflow orchestration endpoints (`/v1/workflows/run`, `/v1/workflows/resume`). External clients, IDEs, or pipelines can call this endpoint to drive the full `jeo-code` agent loop.

```
                      +----------------------------------------------+
                      |       Inbound Client / IDE / Webhook         |
                      +----------------------+-----------------------+
                                             | HTTP / SSE
                                             v
                      +----------------------------------------------+
                      |         jeo serve (Bun.serve API)            |
                      |  POST /v1/chat/completions                   |
                      |  POST /v1/workflows/run                      |
                      |  POST /v1/workflows/resume                   |
                      +----------------------+-----------------------+
                                             |
                                             v
+------------------------------------------------------------------------------------+
|                               GoalFlow Engine                                      |
|                                                                                    |
|  [Layer 1: StateGraph & Directed Graph Execution]                                  |
|   - FunctionNode, AgentBaseNode, fan-in barriers, Send[] concurrency               |
|   - FileCheckpointer & MemoryCheckpointer for Human-In-The-Loop (HITL)             |
|                                                                                    |
|  [Layer 2: Pipeline Middlewares & Jev Semantic Guard]                              |
|   - Control Phase: Jev destructive command gating, token context budget guard      |
|   - Enhancement Phase: Workspace prompts, system injections, trace metrics        |
|                                                                                    |
|  [Layer 3: StreamProcessor & DataAdapters]                                         |
|   - OpenAIDataAdapter: Formats chunks to OpenAI SSE and blocking JSON responses    |
|   - GoalFlowDataAdapter: Formats native workflow event stream and run summary      |
|   - Boundary-safe <think> reasoning tag streaming                                  |
+------------------------------------+-----------------------------------------------+
                                     |
                                     v
+------------------------------------------------------------------------------------+
|                         Outbound 3-Tier Tool Cascade                               |
|   1. Native Function Calling (/v1/chat/completions tools array)                    |
|   2. Structured Output Tier (GBNF grammar for llama.cpp, JSON Schema for Ollama)   |
|   3. Robust Prose Fallback (<tool_call> schema in system prompt)                   |
+------------------------------------------------------------------------------------+
```

---

## 2. Core Components

### 2.1 StateGraph Engine & Node Taxonomy
Defined in `src/agent/goalflow/`:
- `StateGraph<S>`: Directed execution graph supporting linear edges, conditional routing, and fan-in synchronization barriers.
- `AgentBaseNode<S>`: Specialized node encapsulating the Karpathy coding loop with middleware execution, step budgeting, and tool invocation.
- `Checkpointer<S>`: Supports durable state snapshotting (`FileCheckpointer`, `MemoryCheckpointer`) at HITL interrupt points (`InterruptError`).

### 2.2 Spec-First vs Direct Coding Workflows
- **`spec-first` workflow**:
  `deep_interview` -> `ralplan` -> `approve_gate` (interrupt / pause for human review) -> `team` (git worktree parallel execution) -> `ultragoal` (acceptance criteria verification).
- **`coding` workflow**:
  Single-stage Karpathy core loop with Jev runtime validation, bounded retries, and atomic edits.

### 2.3 Local Model Capabilities Probing (`src/ai/providers/local-capabilities.ts`)
- Probes llama.cpp `/props` and Ollama `/api/show` to discover context windows and tool calling template support.
- Implements tier memory: if a local backend rejects native tools (HTTP 400), it automatically falls back to GBNF/JSON schema or prose without interrupting the user.

### 2.4 Offline Harness² Evolution (`src/agent/dev/harness2-offline.ts`)
- `TraceCollector`: Records execution events (`parse_bounce`, `tool_failure`, `verification_signal`, `demote_tier`) into `.jeo/traces/traces-YYYY-MM-DD.jsonl`.
- `Propose-Probe-Compose`: Formulates dual-track rule candidates (workspace invariants and domain skills), enforces word/token budgets, and blind-selects high-performing candidates using the local Jev/Qev evaluator.

---

## 3. Inbound Server CLI (`jeo serve`)

Start the inbound agent server:

```bash
# Default coding workflow on port 8000
jeo serve

# Spec-first workflow with auto-approval on custom port
jeo serve --port 9000 --workflow spec-first --auto-approve

# Custom model and disabled Jev guard
jeo serve --model llama-cpp/qwen2.5-coder-7b --no-jev-guard
```

### CLI Flags
| Flag | Description | Default |
|---|---|---|
| `-p, --port <number>` | Port to bind server | `8000` |
| `--host <string>` | Hostname to bind | `127.0.0.1` |
| `-m, --model <string>` | Default model identifier | `jeo-coding` |
| `-w, --workflow <mode>` | Default workflow: `coding` or `spec-first` | `coding` |
| `--auto-approve` | Automatically approve HITL checkpoints | `false` |
| `--no-jev-guard` | Disable destructive command Jev validation | `false` |
| `--qev-url <url>` | Custom endpoint for local Qev evaluator | `http://127.0.0.1:8017/v1/systemone` |

---

## 4. API Reference & Examples

### 4.1 OpenAI Chat Completions (`POST /v1/chat/completions`)

#### Non-streaming JSON:
```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jeo-coding",
    "messages": [
      { "role": "user", "content": "Write a unit test for date formatting in TypeScript." }
    ],
    "stream": false
  }'
```

Response:
```json
{
  "id": "chatcmpl-a8f1...",
  "object": "chat.completion",
  "created": 1740000000,
  "model": "jeo-coding",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ]
}
```

#### Streaming SSE:
```bash
curl -N -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jeo-coding",
    "messages": [
      { "role": "user", "content": "Refactor auth middleware." }
    ],
    "stream": true
  }'
```

Chunks arrive as:
```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"Refactoring..."}}]}

data: [DONE]
```

---

### 4.2 Native GoalFlow Run (`POST /v1/workflows/run`)

```bash
curl -X POST http://127.0.0.1:8000/v1/workflows/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Build order payment processing system",
    "workflow": "spec-first",
    "autoApprove": false,
    "stream": false
  }'
```

If the workflow pauses for human approval, the server returns **`HTTP 202 Accepted`**:
```json
{
  "runId": "6c49e1e2-b1e8-4660-845f-dcf82d4c979d",
  "status": "interrupted",
  "currentNodeId": "deep_interview",
  "pendingInterrupt": {
    "prompt": "Seed requires clarification on database choice.",
    "kind": "interview_question",
    "allowedDecisions": ["approve", "reject"]
  }
}
```

---

### 4.3 Human-In-The-Loop Resume (`POST /v1/workflows/resume`)

Resume the paused run with client decision and user feedback:

```bash
curl -X POST http://127.0.0.1:8000/v1/workflows/resume \
  -H "Content-Type: application/json" \
  -d '{
    "runId": "6c49e1e2-b1e8-4660-845f-dcf82d4c979d",
    "decision": "approve",
    "input": "Use PostgreSQL with Drizzle ORM",
    "stream": false
  }'
```

The workflow resumes strictly from `deep_interview` and proceeds to `ralplan` without re-executing completed upstream nodes.
