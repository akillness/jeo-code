# jeo-code

Encode intention. Decode software.
A clean, highly optimized AI coding agent using a spec-first loop, tmux-native execution, and durable verification.

> [!IMPORTANT]
> jeo-code is currently in V2 (Level 2) evolution. Expect active development and verify outputs before relying on it for critical production work.

## What is jeo-code?

jeo-code (**joc**) is a pure-TypeScript coding-agent runner. It follows a rigorous **deep-interview -> ralplan -> ultragoal** workflow to ensure requirements are clarified and plans are critiqued before any code is mutated.

It is designed to be an external orchestrator that works beside your existing tools, providing structured planning, persistent evidence, and isolated worktree support.

## Install



The scoped package is also available as .

## Quick start



Inside a **joc** session, the public workflow surface is exposed:



## Core Engine & Hierarchy

jeo-code maintains a clear hierarchy between the **Core Engine (joc)** and the **Global Jeo-Code (gjc)** orchestrator:

- **joc (Core Engine)**: The minimal tool-use loop and agent runner. Refactored for modularity and visibility.
- **gjc (Guide/Global)**: The higher-level hierarchy for system-wide orchestration, session management, and multi-agent coordination.

## Core capabilities

- **Interview before guessing**:  turns vague requests into concrete requirements via .
- **Plan before mutation**:  reviews the approach before code changes.
- **Execute with evidence**:  tracks goals, revisions, checks, and completion evidence.
- **Interactive Visibility**: Real-time status dashboard with .
- **Registry System**: Decoupled management of LLM providers (OpenAI, Anthropic, Gemini, etc.) and tools.

## Workflow surface

| Skill | What it does |
| :--- | :--- |
| **deep-interview** | Clarifies ambiguous requirements before planning or code changes. |
| **ralplan** | Builds and critiques an implementation plan before mutation. |
| **ultragoal** | Tracks goals through execution, revision, verification, and evidence. |
| **team** | Coordinates tmux-backed workers for parallel execution. |

### Bundled role agents

- **executor**: Bounded implementation, fixes, and refactors.
- **architect**: Read-only architecture and code-review assessment.
- **planner**: Read-only sequencing and acceptance criteria.
- **critic**: Read-only plan critique and actionability review.

## Configuration

Provider settings and retry budgets live in  (or ):



## Development

Install dependencies and run from source:



To compile a standalone binary:


## Documentation

See hierarchical  files in each directory for detailed component documentation.

- [Core Engine](src/agent/AGENTS.md)
- [AI Providers](src/ai/AGENTS.md)
- [CLI Runner](src/cli/AGENTS.md)

---
*V2 Evolution Update: 2026-06-10 (Level 2 Finalized)*
