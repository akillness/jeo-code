# jeo-code V2

`joc` is a pure-TypeScript AI coding agent that runs on Bun with zero native dependencies. V2 represents the "Level 2" evolution, focusing on modularity, visibility, and a spec-first workflow.

## Key Features

- **Core Engine Evolution**: Refactored `joc` with a robust, minimal tool-use loop and `gjc` (Global Jeo-Code) hierarchy for system-wide orchestration.
- **Spec-First Workflow**: Deep integration with `ooo` (Ouroboros) and `spec-kit` via .specify/ for rigorous requirement clarification.
- **Provider & Tool) Registry**: A modular architecture that decouples LLM providers and tool implementations, allowing for easy extensibility.
- **Interactive Dashboard**: Enhanced `joc status` command providing real-time visibility into agent progress with interactive bars and state tracking.
- **Performance Monitoring**: Automated capture of system health and execution efficiency stored in `.joc/state/performance-metrics.json`.

## Project Setup

### Prerequisites
- [Bun](https://bun.sh) runtime installed.

### Installation
Clone the repository and installe dependencies:
```bash
git clone <repository-url>
cd jeo-code bun install

```

### Configuration
1. **Environment Variables**: Create a .env file in the root directory and add your provider API keys:
   ```bash
   OPENAI_API_KEY=***   ANTHROPIC_API_KEY=***   ```J2. **Global Config**: Ensure `.joc/config.json` is configured for your environment (this is typically managed via `joc init`).

### Running the Agent
Launch the `joc` environment:
```bash
bun run joc launch
```

## Architecture

V2 introduces a decoupled architecture where the agent loop is separated from tool implementations and provider logic.

### Key Components
- **.specify**: Rigourous requirement clarification.
- **.ouroboros**: Self-analysis and improvement cycles.
- **Registry System**: Decoupled management of LLM providers and tools.

## Documentation

See hierarchical `AGENTS.md` files in each directory for detailed component documentation.

- [Core Engine](src/agent/AGENTS.md)
- [AI Providers](src/ai/AGENTS.md)
- [CLI Runner](src/cli/AGENTS.md)

---
*V2 Evolution Update: 2026-06-10 (Level 2 Finalized)*
